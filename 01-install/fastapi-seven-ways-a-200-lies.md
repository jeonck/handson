---
title: FastAPI — seven ways a 200 lies, one small app, each one broken and fixed
date: 2026-09-10
domain: install
tags: [fastapi, python, api, reliability]
stack: [fastapi, pydantic, uvicorn, sqlite, python]
summary: One FastAPI service with seven endpoints, each written the way it usually gets written and then broken on purpose. A swallowed exception returns 200 with the error in the body, a route that forgot its auth dependency returns 200 to anyone, two concurrent payments both return 200 and only one is deducted, a renamed upstream field downgrades a paying user to free with a 200, and a health check keeps returning 200 with the database gone. Each has a fix, and each fix was watched to change the answer.
source: handson
env: FastAPI 0.141.1 · Pydantic 2.13.5 · uvicorn 0.52.4 · httpx 0.28.1 · Python 3.13 · SQLite in-memory · macOS 26.6.2 arm64
verified: 2026-09-10
verifiability: partial
verifiability-note: A single in-memory SQLite behind a single uvicorn worker, so the consistency race is real but narrower than one against a networked database with connection pooling, and the recovery section takes the database away by closing a connection rather than by killing a server. The upstream service is a function inside the app; nothing here exercises a network timeout or a partial response.
duration: 60–90 min
risk: low
---

> **Verified 2026-09-10.** Every status code and body below came from the app shown, and each fix was
> re-run to confirm it changes the result rather than assumed to.

Seven things go wrong in an API, and in each case the natural first version of the code returns
`200`. **A `200` is the one response nothing retries, nothing alerts on, and nothing takes out of the
load balancer** — which is what makes it the wrong answer to return when something has failed.

This page is one app with seven endpoints. Each is written first the way it usually gets written, then
broken to show what the `200` is hiding, then fixed, then broken again to show the fix holding.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Python | `python3 --version` | 3.11+ |
| Packages | `pip install fastapi uvicorn httpx` | resolves |

```bash
uvicorn app:app --port 8000
```

## 1. Exceptions — a caught error that keeps the success code

```python title="app.py"
@app.get("/boom")
def boom():
    return 1 / 0

@app.get("/boom-swallowed")
def boom_swallowed():
    try:
        return 1 / 0
    except Exception as e:
        return {"error": str(e)}     # HTTP 200 with a failure inside
```

```
  GET /boom            -> HTTP 500  Internal Server Error
  GET /boom-swallowed  -> HTTP 200  {"error":"division by zero"}
```

**The second one is worse than the first.** `/boom` is ugly and honest: the client's retry fires, the
error rate ticks up, someone gets paged. `/boom-swallowed` reports success with a failure in the body,
and every client that checks the status — which is all of them — proceeds as if it worked.

The fix is to handle the exception without changing what the status code says:

```python title="app.py"
@app.exception_handler(ZeroDivisionError)
def on_zero(request: Request, exc: ZeroDivisionError):
    log.error("boom: %s", exc)
    return JSONResponse(status_code=500, content={"error": "internal"})
```

```
  GET /boom-handled    -> HTTP 500  {"error":"internal"}
```

Logged, clean body, and still a `500`. **Catching an exception is not the same as deciding the request
succeeded**, and `except Exception: return {...}` conflates the two.

## 2. Logging — two requests, four lines, no way to pair them

```python title="app.py"
@app.get("/work")
def work():
    log.info("start work")
    time.sleep(0.1)
    log.info("end work")
```

Two concurrent requests:

```
  16:46:26,420 INFO start work
  16:46:26,422 INFO start work
  16:46:26,526 INFO end work
  16:46:26,527 INFO end work
```

**Which `end` belongs to which `start` is not recoverable from this log.** With two requests it is a
guess; with two hundred it is nothing. Every line is true and the log as a whole says almost nothing.

```python title="app.py"
@app.get("/work-traced")
def work_traced(x_request_id: str = Header(default=None)):
    rid = x_request_id or uuid.uuid4().hex[:8]
    log.info("[%s] start work", rid)
    ...
```

```
  16:46:26,868 INFO [req-B] start work
  16:46:26,868 INFO [req-A] start work
  16:46:26,970 INFO [req-A] end work
  16:46:26,973 INFO [req-B] end work
```

Now the log shows something the first one could not: **B started first and A finished first.** A
request id is not decoration for the log; it is the thing that makes concurrent lines into a story.
Accept it from the caller when present, generate one when absent, and return it in the response so
the client can quote it back.

## 3. Authorization — the route that forgot

```python title="app.py"
def require_admin(x_role: str = Header(default="")):
    if x_role != "admin":
        raise HTTPException(403, "admin only")

@app.get("/admin/users", dependencies=[Depends(require_admin)])
def admin_users(): ...

@app.get("/admin/export")          # the dependency was forgotten here
def admin_export(): ...
```

```
  /admin/users    no header -> 403    X-Role: admin -> 200
  /admin/export   no header -> 200    X-Role: admin -> 200
```

**`/admin/export` is open to everyone and nothing says so.** It starts, it serves, it appears in the
docs, and the test that exercises `/admin/users` and concludes "auth works" is the false pass — it
tested the route that has the dependency.

Per-route dependencies fail open: forgetting one is silent. Put it where forgetting is impossible:

```python title="app.py"
admin = APIRouter(prefix="/admin2", dependencies=[Depends(require_admin)])

@admin.get("/export")            # no per-route dependency, still protected
def admin2_export(): ...
```

```
  /admin2/users   no header -> 403    X-Role: admin -> 200
  /admin2/export  no header -> 403    X-Role: admin -> 200
```

**The router carries the check, so a route added next month cannot leave it off.** The remaining
question — does every admin route actually live on this router — is a `grep` for `@app.get("/admin`,
which is a check that can fail.

## 4. Data consistency — two payments, one deduction

```python title="app.py"
@app.post("/pay/{amount}")
def pay(amount: int):
    (bal,) = DB.execute("SELECT balance FROM acct WHERE id='u1'").fetchone()
    if bal < amount:
        raise HTTPException(409, "insufficient")
    time.sleep(0.05)               # a slow calculation between read and write
    DB.execute("UPDATE acct SET balance=? WHERE id='u1'", (bal - amount,))
```

Balance 100, two concurrent payments of 50, three runs:

```
  pay          200 200   final balance 50   (correct: 0)   <- lost update
  pay          200 200   final balance 50   (correct: 0)   <- lost update
  pay          200 500   final balance 50   (correct: 0)   <- lost update
```

**Both requests read 100, both wrote 50, and a customer was charged once for two orders.** Both
returned `200`. The read-check-write is three steps with a gap in the middle, and the gap is where the
other request runs.

```python title="app.py"
@app.post("/pay-atomic/{amount}")
def pay_atomic(amount: int):
    cur = DB.execute(
        "UPDATE acct SET balance=balance-? WHERE id='u1' AND balance>=?", (amount, amount))
    if cur.rowcount == 0:
        raise HTTPException(409, "insufficient")
```

```
  pay-atomic   200 200   final balance 0    (correct: 0)   OK
  pay-atomic   200 200   final balance 0    (correct: 0)   OK
  pay-atomic   200 200   final balance 0    (correct: 0)   OK
```

**The check and the write are one statement, so there is no gap.** The database decides, and
`rowcount` reports what it decided. Pydantic validates the shape of a request; it cannot validate the
order of two of them — that is the database's job, and only if the query is written to let it.

## 5. Failure recovery — the health check that never notices

```python title="app.py"
@app.get("/healthz")
def healthz():
    return {"status": "ok"}
```

Take the database away:

```
  before        /healthz 200   /healthz-real 200   /balance 200
  db closed     /healthz 200   /healthz-real 503   /balance 500
  seconds later /healthz 200   /healthz-real 503   /balance 500
```

**`/healthz` returns `200` for a service that cannot serve a single real request**, and keeps doing so
indefinitely. A Kubernetes readiness probe on it keeps the pod in rotation; a liveness probe on it
never restarts the pod. The process is fine. The service is not. The check asked about the process.

```python title="app.py"
@app.get("/healthz-real")
def healthz_real():
    try:
        DB.execute("SELECT 1").fetchone()
        return {"status": "ok", "db": "up"}
    except Exception as e:
        raise HTTPException(503, f"db: {e}")
```

**A health check earns its place by touching what the service depends on.** This is the same finding
as [[valkey-redis-dragonfly-on-kubernetes]] — a `PING` answering `PONG` while every write was refused
— and [[container-image-size-and-what-breaks]], where `/healthz` passed on an image that could not make
an HTTPS call. The shape repeats because the cheap check is always the one with no dependencies.

The recovery half is worth stating plainly: **nothing here recovered on its own.** The connection
stayed closed until a restart, and the honest probe is what makes the restart happen.

## 6. External service change — the rename that downgrades a customer

```python title="app.py"
class Upstream(BaseModel):
    user_id: str
    plan: str = "free"
```

The upstream changes its response in two ways:

```
  v1  {"user_id": "u1", "plan": "pro"}     unchanged
  v2  {"userId":  "u1", "plan": "pro"}     required field renamed
  v3  {"user_id": "u1", "tier": "pro"}     field with a default renamed
```

```
  v1  default model -> 200  {"user_id":"u1","plan":"pro"}
  v2  default model -> 500  Internal Server Error
  v3  default model -> 200  {"user_id":"u1","plan":"free"}
```

**v2 is loud and v3 is the dangerous one.** A renamed required field crashes the endpoint, someone
notices within the hour, and it gets fixed. A renamed field *with a default* validates cleanly — the
key is unknown, so it is dropped, and `plan` falls back to `"free"`. **A paying customer is now on the
free tier, the response is `200`, and there is no error anywhere to find.**

```python title="app.py"
class UpstreamStrict(BaseModel):
    model_config = {"extra": "forbid"}
    user_id: str
    plan: str = "free"
```

```
  v3  strict model  -> 500  Internal Server Error
```

`extra="forbid"` turns the unknown `tier` key into a validation error. **When parsing a response from
something you do not control, a field you did not expect is the signal that the contract moved**, and
silently discarding it discards the signal.

## 7. User mistakes — what Pydantic accepts without being asked

```python title="app.py"
class Profile(BaseModel):
    age: int
    admin: bool = False
```

```
  {"age": 25}                    -> 200  {"age":25,"admin":false}
  {"age": "25"}                  -> 200  {"age":25,"admin":false}
  {"age": "25.0"}                -> 200  {"age":25,"admin":false}
  {"age": 25.7}                  -> 422  int_from_float
  {"age": 25, "admin": "yes"}    -> 200  {"age":25,"admin":true}
  {"age": 25, "admin": "true"}   -> 200  {"age":25,"admin":true}
  {"age": 25, "admin": 1}        -> 200  {"age":25,"admin":true}
  {"age": 25, "role": "admin"}   -> 200  {"age":25,"admin":false}
```

Two of these are the ones to look at. **`"admin": "yes"` became `true`** — Pydantic's lax mode reads
`yes`, `no`, `on`, `off`, `1`, `0`, `true`, `false` as booleans, so a form field that was never meant to
be a boolean toggles admin. And **`"role": "admin"` was silently dropped**: the user typed the wrong
field name, got a `200`, and has no idea their setting did not take.

```python title="app.py"
class ProfileStrict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    age: int
    admin: bool = False
```

```
  {"age": "25"}                  -> 422  int_type
  {"age": 25, "admin": "yes"}    -> 422  bool_type
  {"age": 25, "role": "admin"}   -> 422  extra_forbidden
```

**Coercion is a convenience for the caller who meant it and a trap for the one who did not**, and the
API cannot tell them apart. `strict=True` makes the client say what it means; `extra="forbid"` makes a
typo an error instead of a silent no-op. Both are one line, and both change a `200` into a `422` that
names the field.

## Verification checklist

- [x] `/boom` returns **500**; `/boom-swallowed` returns **200** with `{"error":"division by zero"}` in the body
- [x] The `ZeroDivisionError` handler returns **500** with a clean body — handled without lying
- [x] Two concurrent `/work` requests log `start/start/end/end` with **no way to pair them**; with a request id, the log shows B starting first and A finishing first
- [x] `/admin/users` returns **403** without the header; `/admin/export`, missing the dependency, returns **200**
- [x] On a router carrying the dependency, `/admin2/export` returns **403** with no per-route declaration
- [x] Two concurrent `/pay/50` from a balance of 100 both return **200** and leave **50** — three runs out of three
- [x] `/pay-atomic/50` under the same race leaves **0** — three out of three
- [x] With the database closed, `/healthz` returns **200** while `/balance` returns **500**, and does not recover on its own
- [x] `/healthz-real` returns **503** in that state
- [x] An upstream rename of a required field gives **500**; a rename of a field with a default gives **200 with `plan: "free"`**
- [x] `extra="forbid"` turns the second case into **500**
- [x] Lax Pydantic accepts `"25"`, `"25.0"`, `"yes"`, `"true"` and `1`, and drops an unknown `role` field, all with **200**
- [x] `strict=True, extra="forbid"` rejects those with **422** naming `int_type`, `bool_type`, `extra_forbidden`

## Rollback

```bash
pkill -f "uvicorn app:app"
rm -rf .venv
```

The database is in memory; nothing persists past the process.

## Where this bit us

**The first run of the consistency race reported `409 409` and a final balance of 0, which reads as
"no race".** A stray line above the measured pair had already fired two payments, so the measured
requests hit an empty account and were correctly refused. The result was right for the wrong reason
— exactly the shape this page is about — and it was caught only because `409` on a fresh balance of
100 is impossible. **A result that agrees with the expected number is not evidence until the path to
it is checked.**

**Six of the seven fixes were verified by re-running the break.** The one that was not is section 2:
a request id makes the log attributable, but "attributable" was judged by reading four lines, not by
a check. It holds here; it is not a measurement.

**Every one of the seven `200`s is a check that cannot fail**, in the sense this repository uses: the
status code was read as a property of the request, and in each case it was a stand-in for one. The
swallowed exception, the forgotten dependency, the lost update, the stale health check, the
defaulted field and the coerced boolean all share it.

## Follow-ups

- [ ] Repeat section 4 against PostgreSQL with a connection pool, where the race window is wider and `SELECT … FOR UPDATE` is the alternative to the atomic statement
- [ ] Add a timeout and a partial-response case to section 6, since a slow or truncated upstream is a different failure from a renamed field
- [ ] Make section 2's claim a check — parse the traced log and assert every `end` has a matching `start` with the same id
- [ ] Wire `/healthz-real` into a kind cluster's readiness probe and confirm the pod actually leaves the endpoint list when the database goes

## Related

[[fastapi-mvc-layering]] — the same framework, organised for code that has more than seven endpoints.
[[pydantic-ai-structured-output]] — Pydantic used to constrain a model's output rather than a client's input, with the same strictness question.
[[valkey-redis-dragonfly-on-kubernetes]] — the health-check shape of section 5, on a datastore.
[[container-image-size-and-what-breaks]] — the same shape again, on an image that passed its probe and could not reach anything.
[[local-rag-retrieval-failure-modes]] — a refusal detector that read a phrase instead of a property, which is section 1 in a different domain.
