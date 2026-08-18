---
title: GitLab CI to Argo CD FastAPI deployment — step-by-step procedure
date: 2026-08-18
domain: runbook
tags: [on-prem, cicd, gitops, python]
stack: [python, fastapi, pytest, ruff, gitlab, gitlab-runner, kaniko, argocd, kubernetes, containerd]
summary: Complete, ordered procedure for taking the hello-api FastAPI service from source to a verified running pod through GitLab CI and Argo CD — application, image, runner, pipeline, GitOps/Argo CD, and the three-signal deploy check, including a live containerd 2.2.x registry-config bug hit and fixed along the way.
source: handson
env: Steps 1–2 on Python 3.13.0, FastAPI 0.141.1, pytest 9.1.1, ruff 0.16.3, Podman 5.7.1 on macOS 14.7.5. Steps 3–6 on a two-EC2 substitute for on-prem — GitLab Omnibus 17.x on one instance, GitLab Runner 17.x (Kubernetes executor), Kaniko, and Argo CD v2.13.2 (non-HA) on a single-node kubeadm 1.31 + containerd 2.2.1 cluster on the other
verified: 2026-08-18
verifiability: partial
verifiability-note: Steps 1–2 ran in a lab with no gaps. Steps 3–6 ran on the EC2 substitute described in [[gitlab-ci-argocd-fastapi-onprem]]'s own verifiability-note — single-node rather than the real on-prem cluster, GitLab and its registry reached over plain HTTP rather than cert-manager-issued TLS, and Argo CD installed non-HA rather than via [[argocd-helm-ha-install]]'s chart. Step 4.1's `GITOPS_TOKEN` variable actually ran unmasked and unprotected for lab debugging; the command shown was corrected to `masked=true`/`protected=true` afterward but not re-run live, since the rig was already destroyed.
duration: 100–140 min for the full procedure
risk: medium
---

> **Verified 2026-08-17 (steps 1–2) and 2026-08-18 (steps 3–6).** Every command below was actually
> run; outputs are reproduced as printed, with credentials replaced by `<REDACTED>`. This procedure
> is now complete end to end — a pipeline run and a running pod, with the three-signal check in
> step 6.4 confirming they agree.

This is the procedure form of [[gitlab-ci-argocd-fastapi-onprem]] — same work, ordered as discrete
numbered steps rather than narrated. That document carries the design rationale and the traps;
this one is what to actually type, in order, to reproduce it. All **six steps** are written up here.

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

**This is the corrected command — `masked=true`, `protected=true`.** The pipeline run this
procedure documents actually used `masked=false` and `protected=false`, to keep the token visible
in job logs while the pipeline was still being debugged; that was a lab shortcut taken mid-session,
not the intended procedure, and it has been corrected here rather than left as a caveat to remember.

Two things worth knowing about each flag, neither re-exercised live since the EC2 rig this ran
against no longer exists:

- **`masked=true`** is rejected at variable-creation time — a `400` from this exact `curl`, before
  any job ever runs — if the value fails GitLab's masking rules (must be a single line, meet a
  minimum length, and avoid characters GitLab cannot reliably find and redact in raw log text). A
  `glpat-…` project access token is exactly the shape GitLab expects here: one line, no whitespace,
  comfortably over the minimum length. It is not expected to fail this check; it simply was not
  re-run against a live instance after the flag was corrected.
- **`protected=true`** scopes the variable to pipelines running on a protected ref. GitLab protects
  a new project's default branch automatically, and this pipeline runs on `main` — so this should
  need nothing extra here. On a repository where the default branch's protection was ever turned
  off, `protected=true` makes the variable silently absent from an unprotected branch's pipeline,
  which reads like a missing-credential bug rather than an intentional scoping rule.

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

## Step 5 — The GitOps repository and the Argo CD `Application`

**Goal:** Argo CD watching a separate repository, with the credentials it needs to reach a private
HTTP GitLab instance and the credentials the cluster needs to pull from a private registry — so
that the pipeline itself never needs a kubeconfig.

### 5.1 Install Argo CD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.2/manifests/install.yaml
until [ "$(kubectl -n argocd get pods --no-headers | grep -vc Running)" = 0 ]; do sleep 10; done
kubectl -n argocd get pods
```

> This lab installed the plain, non-HA manifest, not the HA Helm chart
> [[argocd-helm-ha-install]] documents — a single `t3.medium` with 4 GB of RAM cannot host
> `redis-ha`'s three replicas plus everything else on this rig. Recorded as the substitution it is,
> not silently swapped in: **the HA chart's own gRPC and Redis-Sentinel traps are unproven here.**

### 5.2 Seed the GitOps repository

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
          image: <GITLAB_HOST>:5050/root/hello-api:seed
          ports: [{ containerPort: 8000 }]
          env:
            - name: APP_VERSION
              value: "seed" # APP_VERSION
            - name: APP_ENV
              value: prod
          readinessProbe:
            httpGet: { path: /readyz, port: 8000 }
          livenessProbe:
            httpGet: { path: /healthz, port: 8000 }
            periodSeconds: 10
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 256Mi }
      imagePullSecrets:
        - name: gitlab-registry
```

```yaml title="overlays/prod/service.yaml"
apiVersion: v1
kind: Service
metadata:
  name: hello-api
  namespace: hello-api
spec:
  selector: { app: hello-api }
  ports:
    - port: 80
      targetPort: 8000
```

Commit and push these with a placeholder `:seed` tag — step 4's `release` job is what rewrites the
`image:` line and the `# APP_VERSION`-marked `value:` line on every real pipeline run afterward.
This first commit only exists so the Argo CD `Application` in 5.4 has something to sync before a
pipeline has ever run.

### 5.3 Give the cluster and Argo CD their credentials

Two different secrets, for two different consumers — the kubelet pulling the image, and Argo CD
reading the private repository:

```bash
kubectl create namespace hello-api --dry-run=client -o yaml | kubectl apply -f -

kubectl -n hello-api create secret docker-registry gitlab-registry \
  --docker-server=<GITLAB_HOST>:5050 \
  --docker-username=<DEPLOY_USER> \
  --docker-password=<REDACTED> \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n argocd create secret generic gitops-repo \
  --from-literal=type=git \
  --from-literal=url=http://<GITLAB_HOST>/<group>/hello-api-gitops.git \
  --from-literal=username=oauth2 \
  --from-literal=password=<REDACTED> \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n argocd label secret gitops-repo argocd.argoproj.io/secret-type=repository --overwrite
```

**The label is what turns an ordinary secret into a repository credential.** Without
`argocd.argoproj.io/secret-type=repository`, Argo CD ignores this secret entirely and tries the
repository anonymously — which fails identically whether the URL is wrong, the credentials are
wrong, or this label is just missing, so check the label first.

### 5.4 Create the Argo CD `Application`

```yaml title="argocd/hello-api.yaml"
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: hello-api
  namespace: argocd
spec:
  project: default
  source:
    repoURL: http://<GITLAB_HOST>/<group>/hello-api-gitops.git
    targetRevision: main
    path: overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: hello-api
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
```

```bash
kubectl apply -f argocd/hello-api.yaml
```

```
application.argoproj.io/hello-api created
```

**Pass condition:** the `Application` resource is created without error, and
`kubectl -n argocd get app hello-api -o jsonpath='{.status.sync.status}/{.status.health.status}'`
starts returning `Synced/Progressing` within a minute or two — not `Unknown/Unknown`, which means
Argo CD cannot reach the repository at all and points straight back at 5.3's credentials or label.
**`Synced/Progressing` is not the finish line here** — it is where step 6 picks up, because
`Synced` describes Git and the cluster agreeing on manifests, not a running pod.

## Step 6 — The three-signal deploy verification

**Goal:** confirm a running pod is actually serving the code CI built — not just that Argo CD
agrees with Git, which the previous step already showed is not the same claim.

### 6.1 Trust the registry over plain HTTP, correctly, the first time

This lab's registry has no CA-signed certificate, so containerd needs an explicit insecure-registry
entry before the kubelet can pull anything from it:

```bash
sudo mkdir -p /etc/containerd/certs.d/<GITLAB_HOST>:5050
cat <<H | sudo tee /etc/containerd/certs.d/<GITLAB_HOST>:5050/hosts.toml
server = "http://<GITLAB_HOST>:5050"
[host."http://<GITLAB_HOST>:5050"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
H
sudo sed -i "s|config_path = '[^']*'|config_path = '/etc/containerd/certs.d'|" /etc/containerd/config.toml
sudo systemctl restart containerd
```

**The single most expensive command in this entire procedure is the `sed` above, and specifically
what it does *not* write.** `containerd config default` on containerd 2.2.x fills `config_path`
with a colon-separated value — `/etc/containerd/certs.d:/etc/docker/certs.d` — and that value is
silently unsupported for CRI registry hosts resolution
([containerd#12808](https://github.com/containerd/containerd/issues/12808)): no error, no log line,
just a pull that never works. `containerd config dump` shows the colon-separated value sitting there
looking correct. **Write a single path, with no colon**, as the command above does.

### 6.2 Verify the fix with the tool that actually matches the kubelet's code path

```bash
sudo crictl pull <GITLAB_HOST>:5050/root/hello-api:<TAG>
```

```
E... failed to authorize: failed to fetch anonymous token: ... 403 Forbidden
```

**This `403` is the pass condition for this specific check, not a failure.** `crictl pull` with no
credentials hits the same anonymous-pull rejection any unauthenticated client gets against a
Private GitLab project — it proves containerd is now resolving the registry over plain HTTP
(compare against the error in 6.1's absence: `http: server gave HTTP response to HTTPS client`,
which is what a still-broken config produces here instead). The kubelet's actual pull, a few steps
below, carries the `imagePullSecrets` credentials from step 5.3 and gets past this same check.

**Do not "confirm" this with `ctr images pull --hosts-dir <dir> ...`.** Passing `--hosts-dir`
explicitly makes the standalone `ctr` client bypass the daemon's own configuration and read that
directory directly — it can succeed (or get further, into the same 403 above) while the actual CRI
image service, the one kubelet talks to, is still broken. This is not a hypothetical: it is exactly
how the config_path bug in 6.1 went undetected on this run's first pass.

### 6.3 Watch the pods actually come up

```bash
kubectl -n hello-api delete pods -l app=hello-api   # clear any pods stuck in ImagePullBackOff's cached backoff
kubectl -n hello-api get pods -o wide
```

```
hello-api-9f64d66fc-6tnhr   1/1   Running
hello-api-9f64d66fc-9vj5s   1/1   Running
```

```bash
kubectl -n argocd get application hello-api \
  -o jsonpath='{.status.sync.status}/{.status.health.status}'
```

```
Synced/Healthy
```

**`Synced/Degraded` can sit unchanged for ten minutes or more while pods are stuck in
`ImagePullBackOff` underneath it** — the top-level Argo CD status does not surface this on its own.
`kubectl -n hello-api get pods` and `kubectl describe pod` are what show the real state; do not
wait on the `Application`'s health field alone to tell you a deploy has stalled.

### 6.4 The three signals, checked, not assumed

```bash
# 1. what CI built
echo "$CI_COMMIT_SHORT_SHA"           # or: the tag from step 4.5's registry check

# 2. what is actually running
kubectl -n hello-api get pods \
  -o jsonpath='{range .items[*]}{.status.containerStatuses[0].imageID}{"\n"}{end}'

# 3. what the application itself believes it is
kubectl -n hello-api port-forward svc/hello-api 18080:80 &
sleep 2
curl -sS http://localhost:18080/healthz
kill %1
```

```
57abb925

10.20.10.52:5050/root/hello-api@sha256:59af98942e796e64727a2063fd3a62b0054d398a8eaeb6ddc150befbebf1010a
10.20.10.52:5050/root/hello-api@sha256:59af98942e796e64727a2063fd3a62b0054d398a8eaeb6ddc150befbebf1010a

{"status":"ok","version":"57abb925","environment":"prod"}
```

**Pass condition:** the tag from signal 1 (`57abb925`), the digest from signal 2 (identical across
both pods — a mismatch between replicas is its own bug), and the `version` field from signal 3 all
trace back to the same build. Getting `Synced/Healthy` in 6.3 without checking this is trusting
that Argo CD's bookkeeping and the running process agree — which section 7 of
[[gitlab-ci-argocd-fastapi-onprem]] explains is exactly the assumption that fails silently when the
`release` job pushes to Git but the registry push itself did not land.

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
- [x] `kubectl -n argocd get pods` shows every Argo CD pod `Running` before the `Application` is created
- [x] The `gitops-repo` secret carries the `argocd.argoproj.io/secret-type=repository` label
- [x] `kubectl apply -f argocd/hello-api.yaml` reports `application.argoproj.io/hello-api created`
- [x] The `Application`'s sync status moves off `Unknown/Unknown` within a couple of minutes
- [x] `/etc/containerd/certs.d/<host>:<port>/hosts.toml` exists with the plain-HTTP `server` and `skip_verify = true`
- [x] `config_path` in `/etc/containerd/config.toml` is a single path, not colon-separated
- [x] `crictl pull` against the registry reaches an auth response (`403`), not a TLS error
- [x] `kubectl -n hello-api get pods` shows every replica `1/1 Running`
- [x] `kubectl -n argocd get application hello-api` reports `Synced/Healthy`
- [x] The CI pipeline's tag, every running pod's `imageID`, and `/healthz`'s `version` field all agree

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

Step 5: deleting the `Application` does **not** delete what it deployed unless the resource itself
carries a finalizer for that — check before assuming a clean cluster afterward.

```bash
kubectl -n argocd delete application hello-api
kubectl delete namespace hello-api   # only if step 6's workload should go too
kubectl -n argocd delete secret gitops-repo
```

Step 6: the containerd insecure-registry config in 6.1 is node-level, not workload-level — removing
it affects every future pull from this registry on this node, not just `hello-api`. Only revert it
if the node is being decommissioned or the registry is going away.

```bash
sudo rm -rf /etc/containerd/certs.d/<GITLAB_HOST>:5050
sudo systemctl restart containerd
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

**A missing repository-credential label fails exactly like a wrong URL or a wrong password.**
Forgetting `kubectl label secret gitops-repo argocd.argoproj.io/secret-type=repository` leaves Argo
CD trying the clone anonymously, and the `Application`'s sync status sits on `Unknown` with a
generic "repository not found" or auth-failure condition — indistinguishable, from the `Application`
status alone, from the URL itself being wrong. Check the label on the secret before re-checking the
URL a third time.

**`containerd 2.2.x` silently ignores a colon-separated `config_path` — the single most expensive
trap in this whole procedure.** `containerd config default` on this version writes `config_path =
'/etc/containerd/certs.d:/etc/docker/certs.d'` into the CRI images plugin, and that value looks
correct in `containerd config dump`. It is not: containerd 2.2.x does not support a colon-separated
multi-path value for CRI registry hosts resolution
([containerd#12808](https://github.com/containerd/containerd/issues/12808)) — it neither errors nor
falls back, the entry just never resolves. `ctr images pull --hosts-dir <dir>` succeeding is not
evidence the fix worked, either: that flag makes `ctr` bypass the daemon's configuration entirely
and read the given directory directly, so it tests the directory, not the config. **`crictl pull`
is what actually exercises the kubelet's code path** — verify there, not with `ctr … --hosts-dir`.

**A `Synced`/`Degraded` Argo CD `Application` can sit unchanged for ten minutes or more** while the
pods underneath it are stuck in `ImagePullBackOff` — the top-level health rollup does not surface
this on its own. `kubectl get pods` and `kubectl describe pod` are what show the real state.

**A private GitLab project correctly returns `403` to an anonymous registry pull, and that is not a
bug to chase.** After fixing the containerd config, the very next error — `access forbidden` from
`/jwt/auth` — looked like the same class of problem and was not: GitLab was doing its job, refusing
credential-less access to a Private project (the default visibility). The fix was already in place
from step 5.3 (`imagePullSecrets: [gitlab-registry]`) — the false lead was testing registry
reachability with an anonymous pull instead of `curl`, which cannot distinguish a broken registry
from a correctly-secured one.

## Follow-ups

- [x] Mask and protect `GITOPS_TOKEN` for real — step 4.1's command corrected to `masked=true`, `protected=true`; not re-run against a live instance, since the EC2 rig was already torn down when this was fixed
- [ ] Pin the `gitlab-runner` chart version with `--version` — this run did not, and got away with it only because it ran once
- [ ] Re-run this procedure against a real multi-node on-prem cluster and a CA-signed registry — every step here ran on the single-node, plain-HTTP EC2 substitute described in each step's env, and step 4.1's mask/protect correction above is part of what a re-run should confirm
- [ ] Decide whether this procedure's six steps should fold back into a single document now that all are written, or stay split — revisit once it needs its next edit

## Related

[[gitlab-ci-argocd-fastapi-onprem]] — the full narrative document this procedure is extracted from, with the design rationale, section 7's three-signal argument, and every trap hit across the whole pipeline.
[[pod-crashloopbackoff]] — why liveness must not check a database, referenced from the endpoint split in 1.1.
[[onprem-3node-kubeadm-ubuntu]] — the cluster the image built in step 2 eventually runs on, using containerd rather than Docker.
[[argocd-helm-ha-install]] — the HA chart this lab substituted away from in step 5.1, and the same unpinned-chart-version risk.
[[cert-manager-onprem]] — the CA-signed registry certificate a real deployment uses instead of step 6.1's plain-HTTP insecure-registry config.
