---
title: GitLab CI to Argo CD FastAPI deployment — step-by-step procedure
date: 2026-08-18
domain: runbook
tags: [on-prem, cicd, gitops, python]
stack: [python, fastapi, pytest, ruff]
summary: Ordered procedure for taking the hello-api FastAPI service from source to a running pod through GitLab CI and Argo CD. Step 1 of the procedure — application development and testing — is written up here; later steps are added as separate entries.
source: handson
env: Python 3.13.0, FastAPI 0.141.1, pytest 9.1.1, ruff 0.16.3 on macOS 14.7.5
verified: 2026-08-17
verifiability: lab
duration: 15–20 min for this step
risk: low
---

> **Verified 2026-08-17.** Every command below was run against the exact `app/` and `tests/`
> committed to the application repository, and every output is reproduced as printed.

This is the procedure form of [[gitlab-ci-argocd-fastapi-onprem]] — same work, ordered as discrete
numbered steps rather than narrated. That document carries the design rationale and the traps;
this one is what to actually type, in order, to reproduce it. Steps are added here one at a time as
each is re-verified in procedure form; this entry covers **Step 1 only**.

## Step 1 — Application development and testing

**Goal:** a FastAPI service with `/healthz`, `/readyz`, and `/`, proven clean by `ruff` and green
under `pytest`, before it ever touches CI.

### 1.1 Write the application

```python title="app/main.py"
import os

from fastapi import FastAPI
from pydantic import BaseModel

# Injected by the deployment, not baked into the image: the same image has to be
# promotable between environments without a rebuild.
VERSION = os.getenv("APP_VERSION", "dev")
ENVIRONMENT = os.getenv("APP_ENV", "local")

app = FastAPI(title="hello-api", version=VERSION)


class Health(BaseModel):
    status: str
    version: str
    environment: str


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    """Liveness. Answers from the process alone — no database, no upstream."""
    return Health(status="ok", version=VERSION, environment=ENVIRONMENT)


@app.get("/readyz", response_model=Health)
def readyz() -> Health:
    """Readiness. Where a real dependency check belongs, if there is one."""
    return Health(status="ready", version=VERSION, environment=ENVIRONMENT)


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "hello from hello-api", "version": VERSION}
```

Two endpoints, not one, and the distinction is deliberate: `/healthz` answers from the process
alone; `/readyz` is where a database or upstream check would go. Pointing liveness at a dependency
turns a slow database into a restart loop — [[pod-crashloopbackoff]] section D is that failure.

### 1.2 Write the tests

```python title="tests/test_main.py"
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz_reports_ok():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_root_carries_the_version():
    r = client.get("/")
    assert r.status_code == 200
    assert "version" in r.json()
```

### 1.3 Resolve and pin dependencies

Resolve first, pin what actually resolved — do not write version numbers from memory. See
[Where this bit us](#where-this-bit-us): the first draft of this file invented two version numbers
that do not exist.

```bash
python3 -m venv .venv
.venv/bin/pip install fastapi 'uvicorn[standard]' pydantic pytest httpx ruff
.venv/bin/python -c "import importlib.metadata as m; print(m.version('fastapi'))"
```

```text title="requirements.txt"
fastapi==0.141.1
uvicorn[standard]==0.52.3
pydantic==2.13.4
```

```text title="requirements-dev.txt"
-r requirements.txt
pytest==9.1.1
httpx==0.28.1
ruff==0.16.3
```

### 1.4 Install and run the quality gates

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check app tests
.venv/bin/python -m pytest -q
```

```
All checks passed!
2 passed, 1 warning in 0.45s
```

**Pass condition:** `ruff check` exits `0` with `All checks passed!`, and `pytest` reports `2
passed` with zero failures. Either one failing means the endpoint work in 1.1–1.2 is not done —
nothing later in the overall procedure depends on this step, so nothing else should start until
both pass.

## Verification checklist

- [x] `ruff check app tests` passes clean
- [x] `pytest -q` reports `2 passed`
- [x] Every pin in `requirements.txt` / `requirements-dev.txt` was resolved by `pip`, not written from memory

## Rollback

Nothing outside this directory is touched. Delete the virtualenv and start over:

```bash
rm -rf .venv
```

## Where this bit us

**Pinned versions that do not exist.** The first `requirements.txt` carried plausible-looking pins
written from memory — `fastapi==0.120.4`, `httpx==0.29.0` — and `pip` rejected them with a list of
what actually exists. Resolve first, then pin what was resolved; a pipeline is a bad place to
discover an invented version number for the first time.

**`uvicorn[standard]` needs quoting in zsh.** `pip install uvicorn[standard]` fails with `no matches
found` because zsh treats the brackets as a glob. It works unquoted in a CI job running `sh`, which
is exactly why this only ever wastes time locally — the command in 1.3 above is quoted for this
reason.

## Follow-ups

- [ ] Step 2 — image build (Podman, non-root user, version injected at runtime)
- [ ] Step 3 — GitLab Runner and building images without a Docker daemon
- [ ] Step 4 — the `.gitlab-ci.yml` pipeline (test / build / release)
- [ ] Step 5 — the GitOps repository and the Argo CD `Application`
- [ ] Step 6 — the three-signal deploy verification
- [ ] Fold this procedure's steps back into a single ordered document once all are written, or keep it split by step — decide once there are more than a couple

## Related

[[gitlab-ci-argocd-fastapi-onprem]] — the full narrative document this procedure is extracted from, with the design rationale and every trap hit across the whole pipeline.
[[pod-crashloopbackoff]] — why liveness must not check a database, referenced from the endpoint split in 1.1.
