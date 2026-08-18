---
title: GitLab CI to Argo CD FastAPI deployment — step-by-step procedure
date: 2026-08-18
domain: runbook
tags: [on-prem, cicd, gitops, python]
stack: [python, fastapi, pytest, ruff]
summary: Ordered procedure for taking the hello-api FastAPI service from source to a running pod through GitLab CI and Argo CD. Steps 1–2 — application development/testing and the container image — are written up here; later steps are added as separate entries.
source: handson
env: Python 3.13.0, FastAPI 0.141.1, pytest 9.1.1, ruff 0.16.3, Podman 5.7.1 on macOS 14.7.5
verified: 2026-08-17
verifiability: lab
duration: 30–40 min for steps 1–2
risk: low
---

> **Verified 2026-08-17.** Every command below was run against the exact `app/`, `tests/` and
> `Dockerfile` committed to the application repository, and every output is reproduced as printed.

This is the procedure form of [[gitlab-ci-argocd-fastapi-onprem]] — same work, ordered as discrete
numbered steps rather than narrated. That document carries the design rationale and the traps;
this one is what to actually type, in order, to reproduce it. Steps are added here one at a time as
each is re-verified in procedure form; this entry covers **Steps 1–2**.

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

## Step 2 — The container image

**Goal:** an image that runs as a non-root user and takes its version from the environment rather
than from a rebuild — both are things the cluster will demand later, so proving them here is cheap
compared to discovering a violation from a pod's `CrashLoopBackOff`.

### 2.1 Write the Dockerfile

```dockerfile title="Dockerfile"
FROM python:3.13-slim AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.13-slim
# A non-root user, because the deployment sets runAsNonRoot and the kubelet
# refuses to start the container if the image only has root.
RUN useradd --uid 10001 --create-home appuser
COPY --from=build /install /usr/local
WORKDIR /app
COPY app ./app
USER 10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```text title=".dockerignore"
.venv/
.git/
tests/
__pycache__/
*.pyc
```

**`.dockerignore` matters more than it looks.** Without it the build context carries `.venv/`,
which is both slow to send to the daemon and a way to ship a laptop's compiled binaries into a
Linux image.

### 2.2 Build the image

```bash
podman build -t hello-api:probe .
```

### 2.3 Prove the two properties the cluster will demand

Run it, inject a version, and check both the response and the user it runs as:

```bash
podman run -d --name hello-probe -p 8000:8000 \
  -e APP_VERSION=abc1234 -e APP_ENV=lab hello-api:probe
curl -sS http://127.0.0.1:8000/healthz
```

```
{"status":"ok","version":"abc1234","environment":"lab"}
```

```bash
podman exec hello-probe id
```

```
uid=10001(appuser) gid=10001(appuser) groups=10001(appuser)
```

```bash
podman rm -f hello-probe
```

**Pass condition:** the `id` output names uid `10001`, not `root` — a container that starts fine
here but only has a root user will be refused by the kubelet once `runAsNonRoot: true` is set on
the Deployment, which is a worse place to find this out. And the `/healthz` response must change
its `version` field when `APP_VERSION` changes without rebuilding the image — that is what makes
promoting the same image between environments a config change instead of a new build.

## Verification checklist

- [x] `ruff check app tests` passes clean
- [x] `pytest -q` reports `2 passed`
- [x] Every pin in `requirements.txt` / `requirements-dev.txt` was resolved by `pip`, not written from memory
- [x] `podman build` succeeds and the image runs
- [x] `podman exec … id` reports uid `10001`, not `root`
- [x] Changing `APP_VERSION` changes the `/healthz` response without rebuilding the image

## Rollback

Nothing outside this directory or the local image store is touched.

```bash
rm -rf .venv
podman rmi hello-api:probe
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

- [ ] Step 3 — GitLab Runner and building images without a Docker daemon
- [ ] Step 4 — the `.gitlab-ci.yml` pipeline (test / build / release)
- [ ] Step 5 — the GitOps repository and the Argo CD `Application`
- [ ] Step 6 — the three-signal deploy verification
- [ ] Fold this procedure's steps back into a single ordered document once all are written, or keep it split by step — decide once there are more than a couple

## Related

[[gitlab-ci-argocd-fastapi-onprem]] — the full narrative document this procedure is extracted from, with the design rationale and every trap hit across the whole pipeline.
[[pod-crashloopbackoff]] — why liveness must not check a database, referenced from the endpoint split in 1.1.
[[onprem-3node-kubeadm-ubuntu]] — the cluster the image built in step 2 eventually runs on, using containerd rather than Docker.
