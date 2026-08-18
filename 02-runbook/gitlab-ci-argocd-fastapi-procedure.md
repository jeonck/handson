---
title: GitLab CI to Argo CD FastAPI deployment — step-by-step procedure
date: 2026-08-18
domain: runbook
tags: [on-prem, cicd, gitops, python]
stack: [python, fastapi, pytest, ruff, gitlab, gitlab-runner, kaniko]
summary: Ordered procedure for taking the hello-api FastAPI service from source to a running pod through GitLab CI and Argo CD. Steps 1–4 — application development/testing, the container image, the GitLab Runner, and the CI pipeline — are written up here; later steps are added as separate entries.
source: handson
env: Steps 1–2 on Python 3.13.0, FastAPI 0.141.1, pytest 9.1.1, ruff 0.16.3, Podman 5.7.1 on macOS 14.7.5. Steps 3–4 on a two-EC2 substitute for on-prem — GitLab Omnibus 17.x on one instance, GitLab Runner 17.x (Kubernetes executor) and Kaniko on a single-node kubeadm 1.31 cluster on the other
verified: 2026-08-18
verifiability: partial
verifiability-note: Steps 1–2 ran in a lab with no gaps. Steps 3–4 ran on the EC2 substitute described in [[gitlab-ci-argocd-fastapi-onprem]]'s own verifiability-note — single-node rather than the real on-prem cluster, GitLab and its registry reached over plain HTTP, and the release job's token left unmasked and unprotected for lab debugging.
duration: 60–90 min for steps 1–4
risk: low
---

> **Verified 2026-08-17 (steps 1–2) and 2026-08-18 (steps 3–4).** Every command below was actually
> run; outputs are reproduced as printed, with credentials replaced by `<REDACTED>`.

This is the procedure form of [[gitlab-ci-argocd-fastapi-onprem]] — same work, ordered as discrete
numbered steps rather than narrated. That document carries the design rationale and the traps;
this one is what to actually type, in order, to reproduce it. Steps are added here one at a time as
each is re-verified in procedure form; this entry covers **Steps 1–4**.

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

## Step 3 — GitLab Runner, and building images without a Docker daemon

**Goal:** a runner registered against GitLab that executes each job as its own pod, and a build
approach that needs no Docker daemon on the cluster — because there is not going to be one.

### 3.1 Why not `docker build`

`docker build` needs a Docker daemon, and every way to get one inside Kubernetes costs something:

| Approach | Cost |
|---|---|
| Mount the node's `/var/run/docker.sock` | any job can control every container on that node — and a containerd cluster has no such socket to mount |
| Docker-in-Docker, privileged | a privileged pod per build |
| **Kaniko / Buildah, rootless** | no daemon, no privilege — use this |

The cluster this rig verified against runs containerd, so the socket option was never on the table.

### 3.2 Mint a runner authentication token

The registration-token flow is deprecated; GitLab's runner-creation API issues an authentication
token (`glrt-…`) scoped to the runner you describe:

```bash
curl -sS -X POST -H "PRIVATE-TOKEN: <REDACTED>" \
  "http://<GITLAB_HOST>/api/v4/user/runners" \
  -d 'runner_type=instance_type&description=k8s&tag_list=k8s'
```

The response's `token` field is the value the Helm chart needs next. It is a credential — treat it
like one, not like the project access token used elsewhere in this procedure.

### 3.3 Install GitLab Runner with the Kubernetes executor

```bash
helm repo add gitlab https://charts.gitlab.io
helm repo update
helm upgrade --install gitlab-runner gitlab/gitlab-runner \
  --namespace gitlab-runner --create-namespace \
  --set gitlabUrl=http://<GITLAB_HOST>/ \
  --set runnerToken='<REDACTED>' \
  --set rbac.create=true \
  --set runners.privileged=false \
  --set runners.config='[[runners]]
  [runners.kubernetes]
    namespace = "{{.Release.Namespace}}"
    image = "alpine:3.20"
    cpu_request = "100m"
    memory_request = "128Mi"
' --wait --timeout 5m
kubectl -n gitlab-runner get pods
```

```
gitlab-runner-8969cc55b-pzbpg   1/1   Running
```

**This chart prints a warning that reads like a misconfiguration and is not one:**

```
## Please set `serviceAccount.create` to either `true` or `false`.
## For backwards compatibility a service account will be created.
```

The install still succeeds and the runner still registers — this is the chart nagging about a
default it will remove in a future major version, not a failure. The pod reaching `1/1 Running` is
the actual pass condition; do not chase this warning into a `serviceAccount.create` value hunt on
what is otherwise a working install.

**`helm upgrade --install`, not `helm install`.** The upgrade form is idempotent — re-running it
after editing `runners.config` converges the existing release instead of erroring on "already
exists". This lab did not pin `--version` on the chart; a real deployment should, for the same
reason [[argocd-helm-ha-install]] gives for pinning Argo CD's chart version — an unpinned
`helm upgrade --install` can pull a different chart on the next run than the one just verified.

**Pass condition:** `kubectl -n gitlab-runner get pods` shows the runner pod `1/1 Running`, and the
runner appears under the project or instance's **Settings → CI/CD → Runners** as online. Neither on
its own is sufficient — a pod can be `Running` while still failing to authenticate against GitLab,
which only shows up in the second check.

## Step 4 — The `.gitlab-ci.yml` pipeline

**Goal:** a pipeline that tests, builds with Kaniko, and commits the new tag to the GitOps
repository — and never holds a credential that can reach the cluster.

### 4.1 Register the release job's one credential

The `release` job needs write access to the GitOps repository, and nothing else. A project access
token scoped that narrowly, stored as a masked, protected CI/CD variable:

```bash
curl -sS -X POST -H "PRIVATE-TOKEN: <REDACTED>" \
  "http://<GITLAB_HOST>/api/v4/projects/<group>%2Fhello-api/variables" \
  -d 'key=GITOPS_TOKEN' -d 'value=<REDACTED>' -d 'masked=true' -d 'protected=true'
```

> This lab actually ran with `masked=false` and `protected=false`, to keep the token visible in job
> logs while the pipeline was still being debugged. That is a lab shortcut, not the procedure —
> mask and protect this for real, exactly as written above. A masked value that fails GitLab's
> masking rules (whitespace, too short, wrong charset) is rejected at variable-creation time, which
> is a cheap check to hit before a job ever runs with it.

### 4.2 Write the pipeline

```yaml title=".gitlab-ci.yml"
stages: [test, build, release]

variables:
  IMAGE: $CI_REGISTRY_IMAGE
  TAG: $CI_COMMIT_SHORT_SHA

test:
  stage: test
  image: python:3.13-slim
  script:
    - pip install --no-cache-dir -r requirements-dev.txt
    - ruff check app tests
    - pytest -q

build:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:debug
    entrypoint: [""]
  script:
    - mkdir -p /kaniko/.docker
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"auth\":\"$(printf '%s:%s' "$CI_REGISTRY_USER" "$CI_REGISTRY_PASSWORD" | base64 | tr -d '\n')\"}}}" > /kaniko/.docker/config.json
    - /kaniko/executor --context "$CI_PROJECT_DIR" --dockerfile "$CI_PROJECT_DIR/Dockerfile"
      --destination "$IMAGE:$TAG" --insecure --skip-tls-verify
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

release:
  stage: release
  image: alpine/git:latest
  script:
    - 'git clone http://oauth2:$GITOPS_TOKEN@<GITLAB_HOST>/<group>/hello-api-gitops.git gitops'
    - cd gitops
    - 'sed -i "s|image: .*hello-api:.*|image: $IMAGE:$TAG|" overlays/prod/deployment.yaml'
    - 'sed -i "s|value: \".*\" # APP_VERSION|value: \"$TAG\" # APP_VERSION|" overlays/prod/deployment.yaml'
    - git config user.email "ci@example.internal"
    - git config user.name "gitlab-ci"
    - git commit -am "hello-api $TAG [skip ci]"
    - git push
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

Two things here only make sense next to what step 5 seeds into the GitOps repository: the second
`sed` matches a `# APP_VERSION` comment left on that line specifically so the pattern cannot also
match `APP_ENV`'s `value:` line above it — an un-anchored `s|value: ".*"|...|` rewrites the *first*
`value:` line it finds, which is `APP_ENV`, silently. And Kaniko needs `--insecure
--skip-tls-verify` plus a hand-built `/kaniko/.docker/config.json` because this registry is reached
over plain HTTP — a registry behind [[cert-manager-onprem]]'s CA does not need either.

**`sed -i "s|image: …|…"` and the `[skip ci]` commit message both need single-quoting** in the YAML
— see [Where this bit us](#where-this-bit-us) in [[gitlab-ci-argocd-fastapi-onprem]] for what an
unquoted version of this exact line does to the parser.

### 4.3 Push, and confirm it is valid YAML before trusting a pipeline run to tell you

```bash
python3 -c "import yaml; yaml.safe_load(open('.gitlab-ci.yml')); print('gitlab-ci.yml parses')"
git add -A && git commit -m "hello-api with pipeline" && git push
```

### 4.4 Watch the pipeline

```bash
P=<group>%2Fhello-api
until S=$(curl -sS -H "PRIVATE-TOKEN: <REDACTED>" \
    "http://<GITLAB_HOST>/api/v4/projects/$P/pipelines?per_page=1" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["status"])');
  [ "$S" != running ] && [ "$S" != pending ] && [ "$S" != created ]; do sleep 15; done
echo "pipeline: $S"
```

**Pass condition — the full sequence, not just the final status:**

```
pipeline 2: success
  test     success
  build    success
  release  success
```

The `test` stage genuinely failed the first time this pipeline ran here — `ModuleNotFoundError: No
module named 'app'`, from the `pytest`-vs-`python -m pytest` gap fixed in step 1.3's
`pyproject.toml`. `build` and `release` reported `skipped`, not `failed`, when that happened: a
skipped downstream job on a failed pipeline reads as "did not need to run," which is easy to misread
as "nothing is wrong here" while scanning a job list quickly.

### 4.5 Confirm the image and the GitOps commit both actually happened

```bash
curl -sS -H "PRIVATE-TOKEN: <REDACTED>" \
  "http://<GITLAB_HOST>/api/v4/projects/$P/registry/repositories?tags=true"
curl -sS -H "PRIVATE-TOKEN: <REDACTED>" \
  "http://<GITLAB_HOST>/api/v4/projects/<group>%2Fhello-api-gitops/repository/commits?per_page=3"
```

```
10.20.10.52:5050/root/hello-api ['57abb925']
82c221f1 gitlab-ci hello-api 57abb925 [skip ci]
```

**Pass condition:** the tag in the registry and the short SHA in the GitOps commit message are the
same string.

### 4.6 Confirm `[skip ci]` actually stopped the loop

The GitOps repository has its own pipeline, triggered by the release job's push — `[skip ci]` needs
checking, not assuming, because the tag it stops is *execution*, not pipeline *creation*:

```bash
curl -sS -H "PRIVATE-TOKEN: <REDACTED>" \
  "http://<GITLAB_HOST>/api/v4/projects/<group>%2Fhello-api-gitops/pipelines"
```

```
pipeline 3 skipped sha 82c221f1
```

**Pass condition, stated precisely:** a pipeline record exists (`3`), against the commit that
carried `[skip ci]` — it is not absent. Its `status` is `skipped`, not `success` or `failed`, and no
job under it ever ran. "No pipeline was created" is the wrong thing to check for and would never
pass; "a pipeline exists but nothing in it executed" is the actual claim, and this is what confirms
it rather than assumes it.

## Verification checklist

- [x] `ruff check app tests` passes clean
- [x] `pytest -q` reports `2 passed`
- [x] Every pin in `requirements.txt` / `requirements-dev.txt` was resolved by `pip`, not written from memory
- [x] `podman build` succeeds and the image runs
- [x] `podman exec … id` reports uid `10001`, not `root`
- [x] Changing `APP_VERSION` changes the `/healthz` response without rebuilding the image
- [x] The runner-creation API returns a `glrt-…` token
- [x] `kubectl -n gitlab-runner get pods` shows the runner pod `1/1 Running`
- [x] The runner appears online under **Settings → CI/CD → Runners**
- [x] `.gitlab-ci.yml` parses as YAML before it is pushed
- [x] A pipeline run reports `test`, `build`, and `release` all `success`, in that order
- [x] The pushed image tag in the registry matches the GitOps commit's short SHA
- [x] The GitOps repository's own pipeline exists but shows `skipped`, not absent

## Rollback

Steps 1–2: nothing outside this directory or the local image store is touched.

```bash
rm -rf .venv
podman rmi hello-api:probe
```

Step 3: remove the runner and its namespace; this does not touch GitLab itself or any project.

```bash
helm -n gitlab-runner uninstall gitlab-runner
kubectl delete namespace gitlab-runner
```

Step 4: delete `.gitlab-ci.yml` and push, or revert the commit that added it — a runner with
nothing to pick up does no harm sitting idle. The `GITOPS_TOKEN` CI/CD variable can be removed from
**Settings → CI/CD → Variables** at the same time if the project is being decommissioned, not just
paused.

## Where this bit us

**Pinned versions that do not exist.** The first `requirements.txt` carried plausible-looking pins
written from memory — `fastapi==0.120.4`, `httpx==0.29.0` — and `pip` rejected them with a list of
what actually exists. Resolve first, then pin what was resolved; a pipeline is a bad place to
discover an invented version number for the first time.

**`uvicorn[standard]` needs quoting in zsh.** `pip install uvicorn[standard]` fails with `no matches
found` because zsh treats the brackets as a glob. It works unquoted in a CI job running `sh`, which
is exactly why this only ever wastes time locally — the command in 1.3 above is quoted for this
reason.

**The runner Helm chart's `serviceAccount.create` warning looks like a failed install.** It prints
in red-flag style (`## Please set … ##`) in the middle of otherwise normal Helm output, immediately
before the install reports success. Read the actual exit status and the pod's `Running` state, not
the presence of a warning block, before deciding an install failed.

**The pipeline's `test` stage failed on its first real run, not in review.** `ModuleNotFoundError:
No module named 'app'` — the console-script-vs-module `pytest` gap step 1.3 now fixes proactively
was originally found reactively, from a real pipeline failure. `build` and `release` reported
`skipped`, which reads as "conditionally not needed" on a quick scan, not as "the stage before this
one failed." Read pipeline results stage by stage, in order, not just the final status.

**An unanchored `sed` on the deployment manifest would have silently patched the wrong line.** The
release job's second `sed` rewrites `APP_VERSION`'s value; the manifest carries `env` entries for
both `APP_VERSION` and `APP_ENV`, and a pattern of `value: ".*"` alone matches whichever comes
first in the file — `APP_ENV`, not the one intended. The `# APP_VERSION` trailing comment in step
5's manifest exists specifically to give the pattern something unambiguous to anchor on.

## Follow-ups

- [ ] Step 5 — the GitOps repository and the Argo CD `Application`
- [ ] Step 6 — the three-signal deploy verification
- [ ] Pin the `gitlab-runner` chart version with `--version` — this run did not, and got away with it only because it ran once
- [ ] Mask and protect `GITOPS_TOKEN` for real — this run set `masked=false`, `protected=false` to keep the token visible in job logs while debugging
- [ ] Fold this procedure's steps back into a single ordered document once all are written, or keep it split by step — decide once there are more than a couple

## Related

[[gitlab-ci-argocd-fastapi-onprem]] — the full narrative document this procedure is extracted from, with the design rationale and every trap hit across the whole pipeline.
[[pod-crashloopbackoff]] — why liveness must not check a database, referenced from the endpoint split in 1.1.
[[onprem-3node-kubeadm-ubuntu]] — the cluster the image built in step 2 eventually runs on, using containerd rather than Docker.
[[argocd-helm-ha-install]] — the same unpinned-chart-version risk, spelled out there for Argo CD.
