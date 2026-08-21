---
title: FastAPI in MVC layers — one model serving both a JSON API and an HTML view
date: 2026-08-21
domain: install
tags: [python, web, api, architecture]
stack: [fastapi, python, jinja2, sqlite, pytest]
summary: A notes CRUD split into model / view / controller in 175 lines, with sqlite3 from the standard library instead of an ORM. The layering earns its keep exactly once — the same Pydantic model validates a JSON body and an HTML form — and the browser form path was broken until a real form POST was tried, returning 500 where it owed a 422.
source: handson
env: FastAPI 0.141.1 · Jinja2 3.1.6 · python-multipart · pytest · sqlite3 (stdlib) · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-21
verifiability: lab
duration: 30–45 min
risk: low
---

> **Verified 2026-08-21.** Every response body below came from `curl` against a running uvicorn, and
> the 17-test suite passes. The 500 in [Where this bit us](#where-this-bit-us) is what the app
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
  <li><b>{{ n.title }}</b> — {{ n.body }}</li>
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
17 passed, 1 warning in 0.33s
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
- [x] `PUT` replaces every field — omitting `body` clears it rather than keeping the old value
- [x] `PUT` rejects an empty title `422`, the same rule `POST` enforces, from the same model
- [x] `PATCH` with a field omitted leaves that column alone — the same request `PUT` uses to clear it
- [x] `PATCH {"body": ""}` clears the column, proving absent and explicitly-empty stay distinguishable
- [x] `PATCH {}` runs no `UPDATE` and returns the row unchanged
- [x] `PATCH` drops undeclared keys (`id`, `bogus`) instead of putting them in the `SET` clause — **payload actually sent**
- [x] An empty title is rejected `422` over **both** JSON and form encoding — the second one regressed once, see below
- [x] A browser-style `POST /notes` (url-encoded, no JSON) returns `303` and the row persists
- [x] `<script>` in a title comes back HTML-escaped from the view — **payload actually sent, not assumed**
- [x] `pytest -q` reports `17 passed`

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
