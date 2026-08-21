---
title: FastAPI in MVC layers — one model serving both a JSON API and an HTML view
date: 2026-08-21
domain: install
tags: [python, web, api, architecture]
stack: [fastapi, python, jinja2, sqlite, pytest]
summary: A notes CRUD split into model / view / controller in 205 lines, with sqlite3 from the standard library instead of an ORM. Clicked through in a real browser, which is the only way two of its guarantees — no duplicate on reload, and inert XSS payloads — can actually be observed. The layering earns its keep exactly once — the same Pydantic model validates a JSON body and an HTML form — and the browser form path was broken until a real form POST was tried, returning 500 where it owed a 422.
source: handson
env: FastAPI 0.141.1 · Jinja2 3.1.6 · python-multipart · pytest · sqlite3 (stdlib) · Python 3.13.0 on macOS 14.7.5. The HTML view was additionally driven in a real Chromium browser at 1280x720
verified: 2026-08-21
verifiability: lab
duration: 30–45 min
risk: low
---

> **Verified 2026-08-21.** Every response body below came from `curl` against a running uvicorn, the
> 29-test suite passes, and the HTML view was clicked through in a real browser — see
> [What only a browser could confirm](#what-only-a-browser-could-confirm) for the two guarantees
> neither curl nor `TestClient` can check. The 500 in [Where this bit us](#where-this-bit-us) is what the app
> actually returned before it was fixed.

**FastAPI is not an MVC framework, and pretending otherwise is how these projects bloat.** There is
no controller base class, no `views/` convention, no ORM in the box. What FastAPI has is a router, a
validation layer, and a template renderer — which is enough to arrange as MVC if you want the
separation, and cheap to skip if you do not.

This builds the separation deliberately, then measures where it paid for itself. One resource
(`notes`), two transports (JSON and HTML), one model layer underneath both.

```
app/models.py            Model       — the only file that knows SQL exists
app/controllers/notes.py Controller  — HTTP in, model calls out. No SQL, no HTML
app/templates/notes.html View        — Jinja2, no logic beyond a loop
app/main.py              wiring
```

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install fastapi "uvicorn[standard]" jinja2 python-multipart pytest httpx
```

`python-multipart` is not optional the moment an HTML `<form>` posts anything — FastAPI raises at
import time without it. `httpx` is what `TestClient` runs on.

**No ORM, no database driver.** `sqlite3` ships with Python. SQLAlchemy earns its place when you
have migrations, multiple backends, or relationship loading to worry about; for four queries it is a
dependency and a mental model bought for nothing.

## Model — the only layer that knows SQL exists

```python title="app/models.py"
import sqlite3
from pathlib import Path

from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent.parent / "notes.db"


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = ""


class NoteUpdate(BaseModel):
    """PATCH — every field optional, so "absent" is distinguishable from "set to empty"."""
    title: str | None = Field(default=None, min_length=1, max_length=120)
    body: str | None = None


class Note(NoteIn):
    id: int


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '')"
        )


def list_notes() -> list[Note]:
    with connect() as conn:
        return [Note(**dict(r)) for r in conn.execute("SELECT * FROM notes ORDER BY id")]


def get_note(note_id: int) -> Note | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return Note(**dict(row)) if row else None


def create_note(data: NoteIn) -> Note:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO notes (title, body) VALUES (?, ?)", (data.title, data.body)
        )
    return Note(id=cur.lastrowid, **data.model_dump())


def update_note(note_id: int, data: NoteIn) -> Note | None:
    """PUT is a full replace, so NoteIn is exactly the right shape — no new class."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE notes SET title = ?, body = ? WHERE id = ?",
            (data.title, data.body, note_id),
        )
    return Note(id=note_id, **data.model_dump()) if cur.rowcount else None


def patch_note(note_id: int, data: NoteUpdate) -> Note | None:
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        return get_note(note_id)
    # Column names come from NoteUpdate's declared fields, never from raw request
    # keys — Pydantic drops anything it does not declare, so this cannot be
    # steered by a caller. Values stay parameterised.
    assignments = ", ".join(f"{k} = ?" for k in fields)
    with connect() as conn:
        cur = conn.execute(
            f"UPDATE notes SET {assignments} WHERE id = ?", (*fields.values(), note_id)
        )
    return get_note(note_id) if cur.rowcount else None


def delete_note(note_id: int) -> bool:
    with connect() as conn:
        return conn.execute("DELETE FROM notes WHERE id = ?", (note_id,)).rowcount > 0
```

`NoteIn` is what a client may send; `Note` adds the `id` the database assigns. Splitting them is
what stops a caller from POSTing its own primary key. **Every query is parameterised (`?`)** — string
interpolation into SQL is the one shortcut this file must never take.

`row_factory = sqlite3.Row` is what makes `dict(r)` work, and therefore what makes `Note(**dict(r))`
a one-liner instead of a column-index unpacking.

## Controller — HTTP in, model calls out

```python title="app/controllers/notes.py"
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app import models

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")


@router.get("/api/notes", response_model=list[models.Note])
def api_list():
    return models.list_notes()


@router.get("/api/notes/{note_id}", response_model=models.Note)
def api_get(note_id: int):
    note = models.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    return note


@router.post("/api/notes", response_model=models.Note, status_code=201)
def api_create(data: models.NoteIn):
    return models.create_note(data)


@router.put("/api/notes/{note_id}", response_model=models.Note)
def api_update(note_id: int, data: models.NoteIn):
    note = models.update_note(note_id, data)
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    return note


@router.patch("/api/notes/{note_id}", response_model=models.Note)
def api_patch(note_id: int, data: models.NoteUpdate):
    note = models.patch_note(note_id, data)
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    return note


@router.delete("/api/notes/{note_id}", status_code=204)
def api_delete(note_id: int):
    if not models.delete_note(note_id):
        raise HTTPException(status_code=404, detail="note not found")


@router.get("/notes", response_class=HTMLResponse)
def page_list(request: Request):
    return templates.TemplateResponse(
        request=request, name="notes.html", context={"notes": models.list_notes()}
    )


@router.post("/notes")
def page_create(data: Annotated[models.NoteIn, Form()]):
    models.create_note(data)
    return RedirectResponse("/notes", status_code=303)


@router.post("/notes/{note_id}/edit")
def page_edit(note_id: int, data: Annotated[models.NoteIn, Form()]):
    """A form always sends every field, so this is a replace — update_note, not patch_note."""
    if models.update_note(note_id, data) is None:
        raise HTTPException(status_code=404, detail="note not found")
    return RedirectResponse("/notes", status_code=303)


@router.post("/notes/{note_id}/delete")
def page_delete(note_id: int):
    """Browsers cannot send DELETE from a form, so the view posts here instead."""
    if not models.delete_note(note_id):
        raise HTTPException(status_code=404, detail="note not found")
    return RedirectResponse("/notes", status_code=303)
```

**`Annotated[models.NoteIn, Form()]` is where the layering actually pays.** The identical model that
validates a JSON body also validates a URL-encoded form body — same `min_length=1`, same error
shape, no second schema, no hand-written form parsing. Without a model layer there would be two
copies of that rule, and they would drift.

`RedirectResponse(..., status_code=303)` is deliberate: **the default is 307, which preserves the
POST method** and makes the browser re-POST to `/notes` — a redirect loop. 303 is what turns a POST
into a follow-up GET, which is the whole point of post/redirect/get.

## View — a loop and nothing else

```html title="app/templates/notes.html"
<!doctype html>
<title>Notes</title>
<h1>Notes ({{ notes | length }})</h1>
<form method="post" action="/notes">
  <input name="title" placeholder="title" required>
  <input name="body" placeholder="body">
  <button>Add</button>
</form>
<ul>
  {% for n in notes %}
  <li>
    <form method="post" action="/notes/{{ n.id }}/edit" style="display:inline">
      <input name="title" value="{{ n.title }}" required>
      <input name="body" value="{{ n.body }}">
      <button>Save</button>
    </form>
    <form method="post" action="/notes/{{ n.id }}/delete" style="display:inline">
      <button>Delete</button>
    </form>
  </li>
  {% else %}
  <li><i>No notes yet.</i></li>
  {% endfor %}
</ul>
```

Jinja's `{% else %}` on a `for` loop is the empty-state branch — no `if notes` wrapper needed.

## Wiring

```python title="app/main.py"
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import models
from app.controllers import notes


@asynccontextmanager
async def lifespan(app: FastAPI):
    models.init_db()
    yield


app = FastAPI(title="notes-mvc", lifespan=lifespan)
app.include_router(notes.router)
```

The first draft used `@app.on_event("startup")`, which still works and prints a `DeprecationWarning`
naming `lifespan` as the replacement. Written the current way here rather than documenting the
deprecated form.

## Run it

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 18500
```

```bash
curl -sS -X POST localhost:18500/api/notes -H 'content-type: application/json' \
  -d '{"title":"read the model layer","body":"sqlite3 only lives here"}'
```

```json
{"title":"read the model layer","body":"sqlite3 only lives here","id":1}
```

```bash
curl -sS localhost:18500/notes
```

```html
<h1>Notes (2)</h1>
...
  <li><b>read the model layer</b> — sqlite3 only lives here</li>
  <li><b>controllers stay thin</b> — </li>
```

Same data, same model calls, two representations — which is the claim MVC is making and the one
worth actually checking rather than assuming.

## PUT replaces, it does not patch

`PUT` needed **no new schema** — the follow-up that asked for this predicted a `NoteUpdate` class,
and that prediction was wrong. `PUT` means *replace the resource with this representation*, so the
body a client sends is exactly `NoteIn`: every field, required ones required. Reusing it is not a
shortcut, it is what the verb means.

```bash
curl -sS -X POST localhost:18500/api/notes -H 'content-type: application/json' \
  -d '{"title":"before","body":"old"}'
curl -sS -X PUT localhost:18500/api/notes/1 -H 'content-type: application/json' \
  -d '{"title":"after","body":"new"}'
```

```json
{"title":"after","body":"new","id":1}
```

The behaviour worth checking is what happens when a field is **left out**:

```bash
curl -sS -X PUT localhost:18500/api/notes/1 -H 'content-type: application/json' \
  -d '{"title":"after"}'
```

```json
{"title":"after","body":"","id":1}
```

**`body` came back empty, not `"new"`.** `NoteIn.body` defaults to `""`, so an omitted field is sent
to the model as an empty string and the row is overwritten with it. That is correct `PUT` semantics
and it surprises people anyway — the request looks like "just change the title" and it silently
cleared the other column. There is a test pinning it (`test_put_omitting_body_clears_it_because_put_replaces`)
so nobody later "fixes" it into a partial update by accident.

**A partial update is `PATCH`, and that is the verb that needs the extra class** — a `NoteUpdate`
with every field optional, applied with `model_dump(exclude_unset=True)` so "absent" and "explicitly
set to empty" stay distinguishable. Not built here, because nothing needs it yet.

`rowcount` carries the 404: `UPDATE ... WHERE id = ?` against a missing row affects zero rows, so
`update_note` returns `None` and the controller raises. No extra `SELECT` to check existence first.

## PATCH is where the second schema earns its place

The previous section refused to add a class `PUT` did not need. `PATCH` needs it, and the reason is
one distinction a required-fields model physically cannot express: **absent** versus **explicitly set
to empty**.

`NoteUpdate` makes every field optional, and `model_dump(exclude_unset=True)` returns only the keys
the client actually sent — not the ones that merely have defaults. That set becomes the `SET` clause.

Same request body against both verbs, side by side:

```bash
curl -sS -X PATCH localhost:18500/api/notes/1 -H "$J" -d '{"title":"after"}'
curl -sS -X PUT   localhost:18500/api/notes/2 -H "$J" -d '{"title":"after"}'
```

```json
{"title":"after","body":"keep me","id":1}
{"title":"after","body":"","id":2}
```

**Identical input, opposite outcomes for `body`** — and both are correct for their verb. This is the
pair worth keeping in the test suite, because a reader who only ever saw one of them would reasonably
conclude the other is a bug.

The distinction `exclude_unset` buys, shown by actually sending both cases:

| Request | `body` after | Why |
|---|---|---|
| `{"title":"after"}` | `"keep me"` — untouched | `body` never appears in `exclude_unset` output |
| `{"body":""}` | `""` — cleared | explicitly sent, so it is in the `SET` clause |
| `{}` | unchanged | no fields set → no `UPDATE` runs at all |

Without `exclude_unset=True`, the first row would behave like the second: `body` would default to
`None`, land in the `SET` clause, and quietly overwrite the column — a partial update that is not
partial, which is the classic way this endpoint gets written wrong.

**The `SET` clause is built with an f-string, and that is only safe because of where the keys come
from.** They are `NoteUpdate`'s declared field names, not raw request keys — Pydantic discards
anything it does not declare, so a caller cannot inject a column name. Values stay parameterised
either way. Confirmed rather than assumed:

```bash
curl -sS -X PATCH localhost:18500/api/notes/2 -H "$J" -d '{"id":99,"bogus":"x","title":"new"}'
```

```json
{"title":"new","body":"","id":2}
```

`id` and `bogus` were dropped; the row kept `id: 2`. **If that filtering ever moves — a `model_config`
with `extra="allow"`, or someone swapping the Pydantic model for a plain `dict` — the f-string
becomes an injection point.** That is the condition under which this code stops being safe, and it is
the reason `test_patch_ignores_undeclared_fields` exists rather than being left to inspection.

## DELETE — a 204 that says nothing, and the second one that says 404

`DELETE` was in the controller from the first version; it gets a section here because two of its
choices are decisions, not defaults, and both are the kind a later reader might "correct".

```bash
curl -sS -i -X DELETE localhost:18500/api/notes/1
```

```
HTTP/1.1 204 No Content
content-type: application/json
```

The body is **zero bytes** — verified with `-w '%{size_download}'`, not eyeballed. `status_code=204`
in the decorator plus a handler that returns `None` is what produces that; a handler that returned
the deleted row with `204` would be sending a body the status code promises is absent, which is the
usual way this endpoint gets written wrong.

> **Expected output that looks wrong:** the `204` still carries `content-type: application/json`,
> which a `No Content` response has no use for. It is harmless — there is no `content-length` and no
> body — but it will catch the eye of anyone reading headers closely. It comes from the framework
> defaulting the route's media type, not from anything in this handler.

**Deleting the same id twice returns `204` then `404`, and that is deliberate:**

```bash
curl -X DELETE localhost:18500/api/notes/2   # 204
curl -X DELETE localhost:18500/api/notes/2   # 404
```

`DELETE` is required to be *idempotent* — repeating it must not cause further change — and this
satisfies that: the row is gone after the first call and stays gone. **Idempotent constrains the
effect, not the status code.** Returning `204` the second time is also legal, and some APIs choose it
so clients can retry blindly. This one reports `404` because the model already distinguishes the two
cases for free:

```python
return conn.execute("DELETE FROM notes WHERE id = ?", (note_id,)).rowcount > 0
```

`rowcount` is `0` when nothing matched, so the controller gets the answer without an existence
`SELECT` first — the same trick `update_note` uses. Discarding that information to return `204`
regardless would be extra code that tells the client less. `test_deleting_twice_is_404_not_204`
pins the choice so it is a decision on the record rather than an accident.

Deleting the last note is also the only path that reaches the view's `{% else %}` branch:

```bash
curl -sS localhost:18500/notes | grep -E "Notes \(|No notes"
```

```
<h1>Notes (0)</h1>
  <li><i>No notes yet.</i></li>
```

Worth an assertion, because an empty-state branch is exactly the kind of markup that gets broken by
a template edit and never noticed — nothing in normal use renders it.

## A delete button, without a line of JavaScript

The JSON API has `DELETE /api/notes/{id}`. The view cannot use it: **HTML forms send `GET` or `POST`
and nothing else.** There is no `method="delete"`.

Three ways out, and the ladder stops at the first:

| Approach | Cost |
|---|---|
| **A `POST` route the form can reach** | one route, no JavaScript, works with JS disabled |
| `fetch('/api/notes/1', {method:'DELETE'})` | a script block, and a page that silently does nothing when JS fails |
| A `_method=DELETE` hidden field + middleware | middleware to write and maintain, to emulate a verb the server already exposes |

The middle option is what most tutorials reach for. It is more code than the route it avoids.

```python
@router.post("/notes/{note_id}/delete")
def page_delete(note_id: int):
    """Browsers cannot send DELETE from a form, so the view posts here instead."""
    if not models.delete_note(note_id):
        raise HTTPException(status_code=404, detail="note not found")
    return RedirectResponse("/notes", status_code=303)
```

```html
<form method="post" action="/notes/{{ n.id }}/delete" style="display:inline">
  <button>Delete</button>
</form>
```

**The controller grew; the model did not.** `page_delete` and `api_delete` both call the same
`models.delete_note` — two transports, one rule, which is the same reason `Annotated[NoteIn, Form()]`
was worth it earlier. The 404 behaviour matches the API's for free.

`{{ n.id }}` in the `action` is not a string-building risk here — it is an integer from the database,
and the route declares `note_id: int`, so a non-numeric id never reaches the handler:

```bash
curl -X POST localhost:18500/notes/abc/delete    # 422
```

### The check that lied

Following the redirect the way a browser does needs care with `curl`:

```bash
curl -sS -L -X POST localhost:18500/notes/2/delete
```

That returns a `422` from `/notes`, which reads like the delete route is broken. It is not —
**`-X POST` with `-L` forces `POST` onto the redirect target too**, so curl re-posted to `/notes`
instead of fetching it. Traced with `-v`:

```
> POST /notes/2/delete      < 303 See Other
> POST /notes               < 422 Unprocessable Content     ← -X POST forced the method
```

Dropping `-X` and letting `-d` imply the method gives the browser's actual behaviour:

```
> POST /notes/2/delete      < 303 See Other
> GET  /notes               < 200 OK                        ← what a browser really does
```

```bash
curl -sS -L -d '' localhost:18500/notes/2/delete | grep -E "Notes \(|<b>"
```

```
<h1>Notes (1)</h1>
    <b>first</b> — keep
```

The app was correct the whole time; the command checking it was not. Same shape as the piped-exit-code
mistake in [[dbt-duckdb-local]] — **when a check fails, rule out the check before changing the code.**

## What only a browser could confirm

`curl` and `TestClient` cover the wire. Two of this app's guarantees are about what a *browser* does
with the response, and neither is observable from either tool. Both were checked by driving a real
browser against `http://127.0.0.1:18500/notes`.

### What the page actually looks like

Three notes, each row carrying its own prefilled edit form plus **Save** and **Delete** — no CSS,
because none of the claims in this document are about styling.

![The notes list: three rows, each with prefilled title and body inputs, a Save button and a Delete button](/01-install/img/notes-list.png)

Filling the top form and clicking **Add** — four rows, and the top inputs cleared, because the
browser fetched a fresh page rather than redisplaying the submitted one:

![After Add: four rows, the new note at the bottom, the top form empty again](/01-install/img/notes-after-add.png)

Editing the third row's title in place and clicking **Save** — the title changes, the body is
untouched, the count stays at four:

![After Save: the third row now reads "edited via Save" with its body unchanged](/01-install/img/notes-after-edit.png)

Clicking **Delete** on that same row — back to three, with the other rows exactly as they were:

![After Delete: three rows, the edited row gone, the remaining rows unchanged](/01-install/img/notes-after-delete.png)

These four were captured with Playwright driving the same Chrome used for the interactive checks
below, at a 2× device scale factor, clipped to the content height. They are the app as it renders,
not a mockup.

### Post/redirect/get, proven by reloading

The `303` in `page_create` exists so a reload does not re-submit. Testing that means actually
reloading after a form submit:

```js
// after clicking Add, in the browser console
location.reload()
document.querySelector('h1').textContent                              // "Notes (3)"
performance.getEntriesByType('navigation')[0].type                    // "reload"
```

**Still three notes after a reload, not four.** The navigation type confirms it was a genuine reload
rather than a fresh navigation, and no "Confirm Form Resubmission" prompt appeared. With `307` — the
`RedirectResponse` default — the browser would have re-issued the POST and created a duplicate. That
is the failure the status code prevents, and **no `curl` invocation demonstrates it**, because curl
has no back/forward cache and no resubmission behaviour to exercise.

### Escaping, proven by outcome instead of appearance

Earlier, `curl` showed `&lt;script&gt;alert(1)&lt;/script&gt;` in the response bytes. That is the
right *appearance*, but it does not prove the browser built no element. Inserting two payloads —
one needing a script tag, one not:

```bash
curl -sS -d 'title=<script>alert(1)</script>&body=<img src=x onerror=alert(2)>' \
  http://127.0.0.1:18500/notes
```

```js
document.querySelectorAll('li script').length   // 0
document.querySelectorAll('li img').length      // 0
[...document.querySelectorAll('li')].pop().textContent.trim()
// "<script>alert(1)</script> — <img src=x onerror=alert(2)>"
```

**Zero elements constructed, both payloads sitting in the DOM as text**, and the console clean.
`<img src=x onerror=...>` is the more useful half of that test: it fires without a `<script>` tag at
all, so a page that only ever tried `<script>` would look safe while being vulnerable to the
attribute form.

### An edit form — which is a replace, and looks like one

The follow-up asked for an edit UI. It is one route and four lines of template, and it maps to
**`update_note`, not `patch_note`**: a form always submits every field it contains, so what arrives
is a complete representation. That is `PUT` semantics, and reusing the `PUT` model function is both
lazier and more honest than routing a full payload through the partial-update path.

```python
@router.post("/notes/{note_id}/edit")
def page_edit(note_id: int, data: Annotated[models.NoteIn, Form()]):
    """A form always sends every field, so this is a replace — update_note, not patch_note."""
    if models.update_note(note_id, data) is None:
        raise HTTPException(status_code=404, detail="note not found")
    return RedirectResponse("/notes", status_code=303)
```

```html
<form method="post" action="/notes/{{ n.id }}/edit" style="display:inline">
  <input name="title" value="{{ n.title }}" required>
  <input name="body" value="{{ n.body }}">
  <button>Save</button>
</form>
```

Inline on the list rows, so there is no second template and no `GET /notes/{id}/edit` to render one.

Editing a title in the browser and clicking **Save** kept the body — but **not because the endpoint
is partial.** The form resubmitted the body unchanged. Clearing the body field and saving proves
which it is:

```js
f.querySelector('input[name=body]').value = '';   // user clears the field
f.querySelector('button').click();
// after the redirect:
[...document.querySelectorAll('li input')].map(i => i.value)
// ["edited in the browser", "", …]     ← body cleared, as a replace should
```

**What is on screen is what gets stored.** A user who empties a field expects it emptied, which is
exactly what `PUT` semantics deliver and what `PATCH` would not — the field's absence from a partial
update would leave the old value in place, contradicting the form the user just submitted.

`required` on the title input means the browser blocks submission before any request is sent:

```js
f.checkValidity()                              // false
t.validationMessage                            // "Please fill out this field."
```

That is a convenience, not the guard — `min_length=1` on `NoteIn` still returns `422` to anything
that skips the browser, which `test_edit_form_validates_like_the_api` pins.

#### The `value="{{ … }}"` attribute is the new escaping surface

Rendering user text inside an attribute is a different context from rendering it between tags. A
title of `evil" onfocus=alert(1) x="` is a deliberate attempt to close the quote and inject an event
handler. Asked of the browser's own parser:

```js
const ins = [...document.querySelectorAll('li input')];
ins.some(i => i.hasAttribute('onfocus'))                          // false
[...new Set(ins.flatMap(i => [...i.attributes].map(a => a.name)))] // ["name","value","required"]
ins.map(i => i.value)                                             // includes: 'evil" onfocus=alert(1) x="'
```

Jinja escapes `"` to `&#34;`, so the payload stays *inside* the value. **Three attributes exist and
`onfocus` is not among them** — the check is the attribute list, not a substring search, for the
reason in [Where this bit us](#where-this-bit-us).

### PATCH, which no form on the page can reach

`DELETE` got a button because a `POST` route could stand in for it. `PATCH` has no such workaround
at the form layer, and the DOM says so outright:

```js
const f = document.createElement('form'); f.method = 'patch';
f.method                                   // "get"
[...document.forms].map(x => x.method)     // ["post", "post", "post"]
```

**Assigning `method="patch"` silently yields `"get"`** — the browser does not reject it, it coerces
it. That is worth seeing once, because a template with `method="patch"` renders fine, submits as a
`GET`, and looks like a routing bug rather than an HTML constraint.

So a browser reaches `PATCH` only through `fetch`, which is exactly how a real front end would:

```js
const p = (id, body) => fetch(`/api/notes/${id}`, {
  method: 'PATCH',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body),
}).then(async r => ({s: r.status, b: await r.json().catch(() => null)}));
```

The `exclude_unset` distinction, re-confirmed from a browser rather than curl:

| Call | Status | Result |
|---|---|---|
| `p(1, {title: 'patched title only'})` | `200` | `body` still `"keep this body"` — untouched |
| `p(2, {body: ''})` | `200` | `body` now `""` — explicitly cleared |
| `p(1, {})` | `200` | unchanged, no `UPDATE` issued |
| `p(1, {title: ''})` | `422` | `string_too_short` |
| `p(999, {title: 'ghost'})` | `404` | `note not found` |
| `p(2, {id: 99, bogus: 'x', title: 'renamed'})` | `200` | `id` stayed `2`, `bogus` dropped |

> **Expected output that reads wrong.** The `422` and the `404` above each log a red
> `Failed to load resource` line in the browser console. Those are the two deliberate failure cases
> answering correctly — `fetch` does not throw on a 4xx, it resolves, and the console notes the
> status regardless. A clean console here would mean those two calls never ran.

Reloading `/notes` afterwards shows both patches through the **view**, which is the MVC claim worth
closing on: mutations made against the JSON API appear in the HTML page because both go through the
same `models.py`.

```
Notes (2)
  patched title only — keep this body     ← body survived a title-only PATCH
  renamed —                                ← body cleared, id and bogus ignored
```

**There is no edit form in the view**, so nothing a user can click reaches `PATCH` — only script does.
Adding one is in [Follow-ups](#follow-ups); it needs a `POST /notes/{id}/edit` route for the same
reason `DELETE` needed one.

Clicking a **Delete** button took the list from `Notes (3)` to `Notes (2)` with the row gone and the
URL back at `/notes` — the same flow the [check that lied](#the-check-that-lied) made curl fumble,
working exactly as intended once a real browser did the redirecting.

## The checks that can fail

```python title="tests/test_notes.py (excerpt)"
def test_form_validation_is_422_not_500():
    assert client.post("/notes", data={"title": ""}).status_code == 422


def test_view_escapes_html():
    client.post("/api/notes", json={"title": "<script>alert(1)</script>"})
    assert "<script>alert(1)</script>" not in client.get("/notes").text
```

```bash
.venv/bin/pytest -q
```

```
29 passed, 1 warning in 0.49s
```

The escaping test is worth keeping even though Jinja2 autoescapes `.html` by default — **it is a
default, and defaults get changed by someone configuring the environment later.** Confirmed by
sending the payload through the real view:

```
<li><b>&lt;script&gt;alert(1)&lt;/script&gt;</b> — x</li>
```

## Verification checklist

- [x] `POST /api/notes` returns `201` and the assigned `id`
- [x] `GET /notes` renders the same rows as `GET /api/notes`
- [x] `GET /api/notes/999` returns `404`, and so does `DELETE` and `PUT` on a missing id
- [x] `DELETE` returns `204` with a **zero-byte** body, measured rather than assumed
- [x] Deleting the same id twice gives `204` then `404` — the deliberate choice, pinned by a test
- [x] Deleting the last note renders the view's `{% else %}` empty state
- [x] The view renders one delete form per note, each posting to its own `/notes/{id}/delete`
- [x] Submitting that form returns `303` and the row is gone from `GET /api/notes`
- [x] `POST /notes/abc/delete` is `422` — the path param is typed, not a string
- [x] In a real browser, clicking **Delete** removes the row and lands back on `/notes`
- [x] Reloading after a form submit leaves the count unchanged — post/redirect/get, **not** demonstrable with curl
- [x] `<script>` and `<img onerror=…>` payloads construct **zero** elements in the DOM, console clean
- [x] `form.method = 'patch'` coerces to `"get"` in the DOM — the constraint confirmed, not quoted
- [x] `fetch(..., {method:'PATCH'})` reproduces all six curl cases from a browser, including `422` and `404`
- [x] Patches made against the JSON API show up in the HTML view after a reload
- [x] Editing a title in the browser and saving keeps the body — because the form resubmits it
- [x] Clearing the body field and saving **clears** it, confirming replace rather than partial semantics
- [x] A quote in a title creates no `onfocus` attribute — asserted against the parsed attribute list, not a substring
- [x] `PUT` replaces every field — omitting `body` clears it rather than keeping the old value
- [x] `PUT` rejects an empty title `422`, the same rule `POST` enforces, from the same model
- [x] `PATCH` with a field omitted leaves that column alone — the same request `PUT` uses to clear it
- [x] `PATCH {"body": ""}` clears the column, proving absent and explicitly-empty stay distinguishable
- [x] `PATCH {}` runs no `UPDATE` and returns the row unchanged
- [x] `PATCH` drops undeclared keys (`id`, `bogus`) instead of putting them in the `SET` clause — **payload actually sent**
- [x] An empty title is rejected `422` over **both** JSON and form encoding — the second one regressed once, see below
- [x] A browser-style `POST /notes` (url-encoded, no JSON) returns `303` and the row persists
- [x] `<script>` in a title comes back HTML-escaped from the view — **payload actually sent, not assumed**
- [x] `pytest -q` reports `29 passed`

## Rollback

```bash
rm -rf .venv notes.db
```

## Where this bit us

**The HTML form path was broken and every test still passed, because nothing had posted a real
form.** The first controller took the form fields as plain function arguments:

```python
def page_create(title: str = "", body: str = ""):
    models.create_note(models.NoteIn(title=title, body=body))
```

A bare `str = ""` parameter is a **query parameter** to FastAPI, not a form field. A real browser
form sends a url-encoded *body*, which was therefore ignored — both arguments fell back to `""`,
`NoteIn(title="")` raised `ValidationError` inside the controller, and nothing caught it:

```bash
curl -sS -X POST localhost:18500/notes -d 'title=from-a-form&body=posted'
```

```
Internal Server Error   (500)
pydantic_core.ValidationError: 1 validation error for NoteIn
  ... string_too_short
```

Two mistakes stacked, and the second is the instructive one: **validating inside the controller
instead of in the signature converts a 422 into a 500.** When FastAPI does the validating, a bad
request is a client error with a field-level message; when the handler constructs the model itself,
the same bad input is an unhandled exception. `Annotated[models.NoteIn, Form()]` fixes both at once —
the body is parsed as a form, and validation moves back where FastAPI can turn a failure into `422`.

**A JSON-only test suite proves nothing about the HTML half.** All four original tests passed against
a controller whose form endpoint could not accept a form. The `data={...}` tests exist now because of
this, not in anticipation of it.

**A substring search is the wrong way to assert escaping, and it fails the safe case.** The first
attribute-escaping test read:

```python
assert "onfocus=alert(1)" not in body      # wrong
```

It failed against correctly-escaped output. Jinja had turned `"` into `&#34;`, so the payload sat
harmlessly inside `value="evil&#34; onfocus=alert(1) x=&#34;"` — the substring is *present and
inert*. The assertion was checking for the appearance of the payload rather than for the property
that matters, so it would also have passed on a page that escaped nothing but spelled the handler
differently.

The replacement parses the HTML with `html.parser` from the standard library and asserts the real
thing — that no `onfocus` **attribute** exists on any input, while the payload survives intact as a
`value`:

```python
inputs = _parse_inputs(client.get("/notes").text)
assert any(a.get("value") == 'evil" onfocus=alert(1) x="' for a in inputs)
assert not any("onfocus" in a for a in inputs)
```

Same failure shape as the `curl -L -X POST` trap above and the piped exit code in
[[dbt-duckdb-local]]: **the code was right and the check was wrong.** Escaping tests are especially
prone to it, because the correct output contains the attack string by design.

## What was deliberately left out

MVC discussions attract layers. These were skipped on purpose, with the condition that would bring
each one back:

| Skipped | Add it when |
|---|---|
| ORM (SQLAlchemy/SQLModel) | you need migrations, relationship loading, or a second backend |
| Repository / service layer | a second caller needs the same logic, or the model file passes ~200 lines |
| Dependency-injected DB session | requests need a transaction spanning several model calls |
| Separate `schemas.py` | the wire format and the stored shape genuinely diverge |
| Async handlers | a real profile shows the sync-threadpool is the bottleneck — `sqlite3` is blocking either way |

The layer worth having on day one is the one this document measured: **a single validated model
shared by both transports.** The rest of the table is speculative until the condition in the right
column is actually true.

## Follow-ups

- [x] Add an edit form to the view — done as `POST /notes/{id}/edit`, mapping to `update_note` (replace) rather than `patch_note`; see [An edit form — which is a replace, and looks like one](#an-edit-form--which-is-a-replace-and-looks-like-one)
- [x] Add `PUT /api/notes/{id}` — done, and it needed **no** new schema; see [PUT replaces, it does not patch](#put-replaces-it-does-not-patch). A `NoteUpdate` with optional fields is what `PATCH` would need, not `PUT`
- [x] Add `PATCH /api/notes/{id}` — done; `NoteUpdate` and `exclude_unset=True` earned their place exactly as predicted, see [PATCH is where the second schema earns its place](#patch-is-where-the-second-schema-earns-its-place)
- [ ] Swap `sqlite3` for the CloudNativePG instance in [[postgresql-cnpg-onprem]] and confirm only `models.py` changes — the claim this layering makes, currently untested
- [ ] Point [[bruno-api-client]]'s collection at these endpoints so the API contract has a check outside the app's own test suite
- [ ] Containerise and deploy through [[gitlab-ci-argocd-fastapi-procedure]] — that pipeline's `hello-api` is a single file, and this is the version with something to actually deploy

## Related

[[gitlab-ci-argocd-fastapi-onprem]] — the same framework taken the other direction: one file, but a full path to a running pod.
[[gitlab-ci-argocd-fastapi-procedure]] — where `pyproject.toml`'s `pythonpath = ["."]` comes from; the console-script `pytest` used here needs it for the same reason.
[[bruno-api-client]] — checking an HTTP contract from outside the code that implements it.
[[postgresql-cnpg-onprem]] — the database the model layer would point at if this left the laptop.
