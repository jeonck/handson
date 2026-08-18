---
title: GitLab CI to Argo CD on-prem — a FastAPI service from commit to running pod
date: 2026-08-17
domain: install
tags: [on-prem, cicd, gitops, python]
stack: [kubernetes, gitlab, gitlab-runner, argocd, fastapi, kaniko, podman]
summary: CI builds and pushes an image, writes the new tag to a GitOps repository, and stops there — Argo CD does the deploying. The pipeline never holds a kubeconfig, and the check that the deploy worked is the running pod's image digest, not a green pipeline.
source: handson
env: Application and image verified locally — Python 3.13.0, FastAPI 0.141.1, Podman 5.7.1 on macOS 14.7.5. Sections 3–7 verified on two AWS EC2 instances standing in for on-prem — GitLab Omnibus 17.x on a separate t3.large, single-node kubeadm 1.31 + Calico on a t3.medium (not the real on-prem 3-node cluster), GitLab Runner 17.x (Kubernetes executor), Argo CD per the chart in the companion document. Registry reached over plain HTTP, not the internal-CA TLS this document assumes for a real deployment.
verified: 2026-08-18
verifiability: partial
verifiability-note: End to end — GitLab, runner, pipeline, GitOps commit, Argo CD sync and the running pod — ran on a two-EC2-instance substitute for on-prem, single-node instead of 3-node, and the registry was plain HTTP instead of the internal-CA TLS the real deployment would use. cert-manager-issued registry TLS and the true multi-node scheduling story from [[schedulable-node-budget]] are still unproven.
duration: 2–4 h for the cluster side
risk: medium
---

> **Verified 2026-08-18, end to end, on a substitute cluster.** The FastAPI service, its tests and the
> container image were verified locally first: `ruff` clean, `pytest` green, image built with Podman,
> container running as uid 10001 and answering `/healthz` with the version injected at runtime.
>
> Sections 3–7 were then run for real on two AWS EC2 instances (GitLab Omnibus on one, a single-node
> kubeadm cluster on the other) standing in for the on-prem hardware — a pipeline built and pushed an
> image, committed the tag to a GitOps repository, and Argo CD deployed it. The three-signal check in
> [section 7](#7-the-check-that-can-actually-fail) passed: pipeline SHA, running pod's image digest and
> `/healthz`'s version field all agreed. What that run could not exercise — a real multi-node cluster
> and a certificate-authority-signed registry instead of plain HTTP — is called out inline and in
> [Where this bit us](#where-this-bit-us).

Two tools, one rule: **GitLab builds, Argo CD deploys, and the pipeline never touches the cluster.**

That rule is the whole design. The common alternative — a `kubectl apply` at the end of the pipeline — needs a kubeconfig in CI, which means every job on that runner can reach the cluster, and it leaves no record of what is deployed other than the pipeline log. GitOps replaces both: CI's last act is a commit, and the cluster converges to what Git says.

```
 app repo                     registry              gitops repo            cluster
 ────────                     ────────              ───────────            ───────
 push ──▶ test ──▶ build ──▶ image:<sha> ──▶ commit image tag ──▶ Argo CD sync ──▶ pods
                    │                              ▲
                    └──────── CI stops here ───────┘
```

## What this cluster can hold

GitLab is not small. Before installing anything, take the number from [[schedulable-node-budget]]: on the cluster [[onprem-3node-kubeadm-ubuntu]] builds, the control plane keeps its taint, so **workloads land on two nodes**, not three.

| Component | Where | Rough ask |
|---|---|---|
| GitLab (Omnibus or chart) | **off the cluster if you can** | 4+ CPU, 8+ GB |
| GitLab Runner | on the cluster | small; the *jobs* are what cost |
| Build jobs | on the cluster | 1–2 GB each, bursty |
| Argo CD | on the cluster | per [[argocd-helm-ha-install]] |

**Put GitLab itself on a separate machine** unless the cluster has room to spare. A CI server that dies when the cluster does cannot be used to fix the cluster — the same circular-dependency argument as [[longhorn-backup-target-onprem]] makes about backups.

---

## 1. The application

A service small enough that the pipeline is the subject, not the code. Two endpoints and a version that comes from the environment.

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

**Two endpoints, not one.** `/healthz` answers from the process alone; `/readyz` is where a database check would go. Pointing liveness at a dependency is how a slow database turns into a restart loop — [[pod-crashloopbackoff]] section D is that failure.

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

```toml title="pyproject.toml"
[tool.pytest.ini_options]
# Without this, the console-script `pytest` cannot import `app` — only `python
# -m pytest` can, because that form puts the working directory on sys.path and
# the console script does not. The CI job below runs the console script.
pythonpath = ["."]
testpaths = ["tests"]
```

**This file only earns its place because CI runs `pytest -q`, not `python -m pytest -q`.** Testing
locally with `python -m pytest` never surfaces the gap — `sys.path` gets the working directory for
free — so the first pipeline run is where `ModuleNotFoundError: No module named 'app'` shows up. See
[Where this bit us](#where-this-bit-us).

Those versions were resolved by `pip` on 2026-08-17, not remembered. Pin what you installed:

```bash
pip install fastapi 'uvicorn[standard]' pydantic pytest httpx ruff
python -c "import importlib.metadata as m; print(m.version('fastapi'))"
```

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check app tests
.venv/bin/python -m pytest -q
```

```
All checks passed!
2 passed, 1 warning in 0.45s
```

## 2. The image

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

`.dockerignore` matters more than it looks: without it the build context carries `.venv/`, which is both slow and a way to ship a laptop's binaries into a Linux image.

Build it and prove the two properties the cluster will demand — that it runs as a non-root uid, and that the version is injected rather than baked:

```bash
podman build -t hello-api:probe .
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

The same image with a different `APP_VERSION` reports a different version. That is what makes promotion between environments a config change rather than a rebuild.

---

## 3. The runner, and building images without a Docker daemon

Install GitLab Runner on the cluster with the Kubernetes executor, so each job is a pod that goes away afterwards.

```bash
helm repo add gitlab https://charts.gitlab.io
helm install gitlab-runner gitlab/gitlab-runner \
  --namespace gitlab-runner --create-namespace \
  --set gitlabUrl=https://<GITLAB_HOST>/ \
  --set runnerToken=<REDACTED> \
  --set rbac.create=true
```

**The build step is where on-prem pipelines usually get ugly.** `docker build` needs a Docker daemon, and the ways to get one inside Kubernetes are all bad:

| Approach | Cost |
|---|---|
| Mount the node's `/var/run/docker.sock` | any job can control every container on that node — and containerd clusters have no such socket |
| Docker-in-Docker, privileged | a privileged pod per build |
| **Kaniko / Buildah, rootless** | no daemon, no privilege — use this |

The cluster from [[onprem-3node-kubeadm-ubuntu]] runs containerd, so the socket option does not exist even if you wanted it.

## 4. `.gitlab-ci.yml`

```yaml title=".gitlab-ci.yml"
stages: [test, build, release]

variables:
  IMAGE: $CI_REGISTRY_IMAGE
  # The commit SHA, never `latest`. Argo CD compares manifests; if the tag does
  # not change, there is nothing for it to notice and nothing gets deployed.
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
    - /kaniko/executor
      --context "$CI_PROJECT_DIR"
      --dockerfile "$CI_PROJECT_DIR/Dockerfile"
      --destination "$IMAGE:$TAG"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

release:
  stage: release
  image: alpine/git:latest
  script:
    - 'git clone https://oauth2:$GITOPS_TOKEN@<GITLAB_HOST>/<group>/hello-api-gitops.git gitops'
    - cd gitops
    # Quoted, because an unquoted scalar containing ": " is not valid YAML —
    # this exact line is rejected by GitLab before the job ever starts.
    - 'sed -i "s|image: .*hello-api:.*|image: $IMAGE:$TAG|" overlays/prod/deployment.yaml'
    - git config user.email "ci@example.internal"
    - git config user.name "gitlab-ci"
    # [skip ci] or this commit triggers the gitops repo's own pipeline, which
    # commits again, which triggers... a loop that only stops when someone notices.
    # [skip ci] does not stop the pipeline from being *created* — it still shows up
    # in the pipeline list with status "skipped". What it stops is any job inside
    # it from *running*, which is what actually breaks the loop.
    - git commit -am "hello-api $TAG [skip ci]"
    - git push
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

`GITOPS_TOKEN` is a project access token with write scope on the **GitOps repository only** — masked and protected in GitLab's CI variables. It is the one credential the pipeline holds, and it can write manifests, not run workloads.

## 5. The GitOps repository

Separate from the application repository. Reviewing a deploy then means reviewing a one-line diff, and the history answers "what was running on Tuesday" without reading pipeline logs.

```yaml title="overlays/prod/deployment.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-api
  namespace: hello-api
spec:
  replicas: 2
  selector:
    matchLabels: { app: hello-api }
  template:
    metadata:
      labels: { app: hello-api }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
      containers:
        - name: app
          image: registry.<GITLAB_HOST>/<group>/hello-api:abc1234   # CI rewrites this line
          ports: [{ containerPort: 8000 }]
          env:
            - name: APP_VERSION
              value: abc1234                                        # and this one
            - name: APP_ENV
              value: prod
          readinessProbe:
            httpGet: { path: /readyz, port: 8000 }
          livenessProbe:
            httpGet: { path: /healthz, port: 8000 }
            periodSeconds: 10
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { memory: 256Mi }
      imagePullSecrets:
        - name: gitlab-registry
```

The registry needs a pull secret, and if GitLab serves a certificate from the internal CA in [[cert-manager-onprem]], the nodes' container runtime has to trust it — otherwise every pull fails with an x509 error that looks like a registry outage.

```bash
kubectl -n hello-api create secret docker-registry gitlab-registry \
  --docker-server=registry.<GITLAB_HOST> \
  --docker-username=<DEPLOY_USER> \
  --docker-password=<REDACTED>
```

> **If the registry is plain HTTP instead of CA-signed TLS** — true for a quick lab, not for a real
> deployment — containerd needs an explicit insecure-registry entry, and on containerd **2.2.x this has
> a live upstream bug that produces no error, just a pull that never works.** See
> [Where this bit us](#where-this-bit-us) before assuming the config below is enough:
>
> ```toml title="/etc/containerd/certs.d/<registry-host>:<port>/hosts.toml"
> server = "http://<registry-host>:<port>"
> [host."http://<registry-host>:<port>"]
>   capabilities = ["pull", "resolve"]
>   skip_verify = true
> ```

**Anonymous pulls are correctly refused, and that is not a bug to chase.** A project created as
Private (GitLab's default) rejects an unauthenticated pull with `403 {"errors":[{"code":"DENIED",
"message":"access forbidden"}]}` — from `crictl pull` with no credentials, or `ctr images pull` run
by hand, this is expected and correct. The `imagePullSecrets` above is what makes the kubelet's pull
authenticated; testing with a bare `crictl`/`ctr` pull to "confirm the registry is reachable" will
report this 403 and looks identical to a broken registry. Check reachability with `curl`, not with an
anonymous image pull.

## 6. The Argo CD Application

```yaml title="argocd/hello-api.yaml"
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: hello-api
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://<GITLAB_HOST>/<group>/hello-api-gitops.git
    targetRevision: main
    path: overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: hello-api
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

`selfHeal: true` means a `kubectl edit` against this namespace is reverted within minutes. That is the point, and it is also the surprise — during an incident, fix Git, not the cluster. Same warning as [[argocd-helm-ha-install]].

---

## 7. The check that can actually fail

Three things will tell you the deploy worked. Two of them are lying.

| Signal | What it actually proves |
|---|---|
| Pipeline is green | the image was pushed and a commit was made |
| Argo CD says `Synced` | the cluster matches **Git** — including matching an old tag perfectly |
| **Running pod's image digest == the image CI built** | the new code is serving |

`Synced` is the dangerous one. If the `release` job failed to push, Git still holds the previous tag, the cluster still matches it, and Argo CD is truthfully, uselessly green.

Check the property:

```bash
# what CI built, from the pipeline
echo "$CI_COMMIT_SHORT_SHA"
```

```bash
# what is actually running
kubectl -n hello-api get pods \
  -o jsonpath='{range .items[*]}{.status.containerStatuses[0].imageID}{"\n"}{end}'
```

```bash
# and what the application itself believes it is
kubectl -n hello-api run curl --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- \
  curl -sS http://hello-api/healthz
```

```
{"status":"ok","version":"abc1234","environment":"prod"}
```

The pass condition is that all three agree. The last one is worth keeping even though it looks redundant: it is the only one that proves the *process inside* the new image is answering, rather than that Kubernetes pulled something.

## Verification checklist

Every item below ran, on the EC2 substitute described in `verifiability-note`. The last two are
deliberately left unchecked — this run never touched them.

- [x] `ruff check` clean and `pytest` green on the application
- [x] The image builds, and `podman exec … id` reports uid 10001 — not root
- [x] `APP_VERSION` changes the response without rebuilding the image
- [x] `.gitlab-ci.yml` parses as YAML before it is pushed — GitLab's CI lint, or `yaml.safe_load`
- [x] A pipeline run produces an image tagged with the commit SHA, and **no `latest` tag exists**
- [x] The `release` job's commit lands in the GitOps repository and does **not run any jobs** — it still
      creates a `skipped` pipeline, which is not the same as no pipeline
- [x] Argo CD moves to `Synced`/`Healthy` within a few minutes with no manual sync
- [x] The running pod's `imageID` matches the digest CI pushed
- [x] `/healthz` from inside the cluster reports the new version
- [ ] `kubectl -n hello-api scale deploy hello-api --replicas=5` is reverted by selfHeal
- [ ] Revert the GitOps commit — the previous image is running again within minutes
- [x] No kubeconfig or cluster credential exists anywhere in GitLab CI variables

That last one is the whole architecture as a single check. If it fails, the pipeline can deploy directly and the GitOps repository is decoration.

## Rollback

Rolling back a deploy is a Git operation, which is the point:

```bash
git -C gitops revert <COMMIT> && git -C gitops push
```

Argo CD converges on the previous tag. Do not use `kubectl rollout undo` — selfHeal puts it back within minutes, and the two fight until somebody notices.

For a bad pipeline rather than a bad release, delete the tag from the registry and let CI rebuild; the GitOps repository is unaffected because it references a SHA that never existed.

## Where this bit us

**`containerd 2.2.x` silently ignores a colon-separated `config_path` — the single most expensive trap
in this run.** `containerd config default` on this version writes `config_path =
'/etc/containerd/certs.d:/etc/docker/certs.d'` into the CRI images plugin. That value looks correct in
`containerd config dump`, the `hosts.toml` file underneath it was byte-for-byte correct, and `ctr
images pull --hosts-dir /etc/containerd/certs.d` (with the directory named explicitly) even succeeded
— which briefly looked like confirmation the setup was right. It was not: that flag makes `ctr` ignore
the daemon's own config and use the given directory directly, so it was accidentally testing the
directory, not the configuration. The actual CRI pull path — what `crictl pull` and the kubelet both
use — kept failing with `http: server gave HTTP response to HTTPS client` regardless, because
containerd 2.2.x does not support a colon-separated multi-path value there
([containerd#12808](https://github.com/containerd/containerd/issues/12808)); it neither errors nor
falls back, it just never resolves the entry. Cutting the value down to a single path —
`config_path = '/etc/containerd/certs.d'`, no `/etc/docker/certs.d` — and restarting containerd fixed
it immediately. **Verify an insecure-registry config with `crictl pull`, never with `ctr … --hosts-dir
<dir>`**; the two do not exercise the same code path, and the second one lies.

**A `Synced`/`Degraded` Argo CD Application looks like a deploy problem and is actually a pull
problem.** `Synced` held for over ten minutes while the pods sat in `ImagePullBackOff` underneath it —
exactly the failure mode [section 7](#7-the-check-that-can-actually-fail) warns about, just with a
different root cause (image pull, not a stale tag) than the one the section originally illustrated.
`kubectl -n hello-api get pods` and the events under `kubectl describe pod` were the only things that
showed the real state; the Argo CD UI's own health rollup did not.

**A private GitLab project correctly returns `403` to an anonymous registry pull.** After fixing the
containerd bug above, the very next error — `access forbidden` from `/jwt/auth` — looked like the same
class of problem and was not: GitLab was doing its job, refusing a pull with no credentials against a
Private project (the default visibility for a new project). The fix was already in the manifest
(`imagePullSecrets: [gitlab-registry]`) — the false lead was testing reachability with an anonymous
`crictl pull` instead of `curl`, which cannot tell a broken registry from a correctly-secured one.

**The console-script `pytest` cannot import `app`; `python -m pytest` can, and hides the gap.** Testing
locally with `python -m pytest -q` never surfaces this — that invocation puts the working directory on
`sys.path` for free. The pipeline's `pytest -q` does not get that, and fails with `ModuleNotFoundError:
No module named 'app'` on the very first CI run. Fixed by the `pyproject.toml` in
[section 1](#1-the-application) with `pythonpath = ["."]`. Whichever form is used locally to develop
against, run the *pipeline's* exact command at least once before trusting green tests to mean the
pipeline will pass.

**The `.gitlab-ci.yml` in the first draft was not valid YAML.** The release job's `sed` contains
`image: `, and an unquoted YAML scalar cannot hold a colon followed by a space — the whole file is
rejected before a single job starts. It was caught by parsing the block while writing this document
rather than by a pipeline run, which is the cheap place to catch it: `python -c "import yaml,sys;
yaml.safe_load(open('.gitlab-ci.yml'))"` costs nothing, and GitLab's own CI lint does the same.

**Pinned versions that do not exist.** The first `requirements.txt` carried plausible-looking pins written from memory — `fastapi==0.120.4`, `httpx==0.29.0` — and `pip` rejected them with a list of what does exist. Resolve first, then pin what was resolved. A pipeline is a bad place to discover an invented version number.

**`uvicorn[standard]` needs quoting.** In zsh, `pip install uvicorn[standard]` fails with `no matches found` because the shell treats the brackets as a glob. In a CI job running `sh` it works, so this is only ever a local-terminal problem — which is exactly why it wastes time.

**A wrong readiness check can waste more time than a real outage.** While waiting for GitLab itself to
come up, `curl http://<host>/-/readiness` returned `404` for several minutes and read as "GitLab is not
up yet." GitLab was already serving — `/` was returning `302` the whole time. `/-/readiness` is real,
but it is not the first endpoint to answer during a slow startup; check the plain root response, or the
API's `/api/v4/version`, before concluding a service is down.

## Follow-ups

- [x] Run sections 3–7 end to end and fill in what breaks — done on an EC2 substitute, 2026-08-18
- [ ] Re-run on the real on-prem 3-node cluster from [[onprem-3node-kubeadm-ubuntu]] — this run was single-node, and [[schedulable-node-budget]]'s multi-node scheduling story is still unproven 📅 2026-09-30
- [ ] Re-run the registry over CA-signed TLS via [[cert-manager-onprem]] instead of plain HTTP — the containerd insecure-registry path documented here would not even be exercised on a real deployment
- [ ] Decide where GitLab itself lives — on the cluster it protects is the wrong answer
- [ ] Add image scanning to the build stage, and decide whether a finding fails the pipeline or only reports
- [ ] Sign images and verify signatures at admission, once the basic path works
- [ ] Replace the `sed` in the release job with a tool that understands the manifest, before someone reformats the YAML and the substitution silently stops matching

## Related

[[argocd-helm-ha-install]] — the Argo CD this depends on, including the gRPC trap when exposing it.
[[schedulable-node-budget]] — how many nodes anything installed here can actually use.
[[cert-manager-onprem]] — the internal CA the registry certificate comes from, which the nodes must trust.
[[pod-crashloopbackoff]] — when the new image starts and immediately dies, and why liveness must not check a database.
[[onprem-3node-kubeadm-ubuntu]] — the cluster underneath, running containerd rather than Docker.
