---
title: Airflow 3 on a two-node on-prem cluster — the orchestrator for a data platform
date: 2026-08-16
domain: install
tags: [on-prem, data-platform, orchestration]
stack: [kubernetes, airflow, helm, postgresql, minio, longhorn, ingress-nginx, cert-manager, git-sync]
summary: With two schedulable nodes and roughly 8 GB between them, CeleryExecutor's one resident worker beats KubernetesExecutor's pod-per-task — and the chart's logs PersistentVolume is hard-coded ReadWriteMany, which on Longhorn buys an NFS share-manager pod that shipping logs to MinIO avoids entirely.
source: handson
env: Targets the 3-machine on-prem cluster (1 control plane + 2 workers, ~2 vCPU / 4 GB each) — Kubernetes 1.31.14 (kubeadm) · Calico 3.28.2 · Longhorn 1.7.2 · Airflow Helm chart 1.22.0 (Airflow 3.2.2) · Helm ≥ 3.19.0. Not executed on that cluster or on any substitute.
verified:
duration: 60–90 min
risk: medium
---

> **Not run. Assembled from official documentation on 2026-08-16.** Every version, parameter name and
> default below was read out of upstream sources on that date and is cited where it is used:
> chart **1.22.0** (released 2026-06-01, default Airflow image **3.2.2**) from the
> [chart release notes](https://airflow.apache.org/docs/helm-chart/stable/release_notes.html) and
> [`chart/Chart.yaml`](https://github.com/apache/airflow/blob/helm-chart/1.22.0/chart/Chart.yaml),
> with defaults read from
> [`chart/values.yaml`](https://github.com/apache/airflow/blob/helm-chart/1.22.0/chart/values.yaml)
> and the templates beside it. No command here has been typed against a cluster, no output below was
> observed, and the sizing numbers are *proposed requests*, not measurements. Treat it as a plan with
> citations, not as a procedure that came back.

Airflow is the piece that decides *when* things run and *in what order*, and on a data platform it
ends up owning the schedule for ingestion, transformation and everything that reads object storage.
This document stands up Airflow 3 on the on-prem cluster from [[onprem-3node-kubeadm-ubuntu]] using
the official Helm chart, with the metadata database outside the release, DAGs arriving over git-sync,
the UI behind the single ingress address, and one DAG that writes and reads back an object in MinIO.

Out of scope: multi-tenant RBAC, Airflow's own high availability (two schedulers on two nodes is not
HA, it is two things to lose at once), KEDA autoscaling, and anything that needs a second cluster.

## Airflow 3 is not Airflow 2, and most guidance you will find is for 2.x

Chart 1.22.0 deploys Airflow 3.2.2 by default (`defaultAirflowTag: "3.2.2"`, `airflowVersion:
"3.2.2"`). Five differences matter before you copy anything from a 2.x tutorial:

| Airflow 2.x | Airflow 3.x, chart 1.22.0 |
|---|---|
| `webserver` component, `ingress.web`, `webserverSecretKey` | `apiServer` component, `ingress.apiServer`, `apiSecretKey` — `webserverSecretKey` is marked *(deprecated, use `apiSecretKey` instead (Airflow 3+))* in `values.yaml` |
| DAG parsing inside the scheduler unless you opted in | Standalone dag-processor. `config.scheduler.standalone_dag_processor` is templated to `True` for `>=3.0.0`, and `dag-processor-deployment.yaml` enables the deployment automatically when `dagProcessor.enabled` is unset and `airflowVersion >= 3.0.0` |
| DAG folder is a folder | DAG **bundles**. `dagProcessor.dagBundleConfigList` defaults to a single `dags-folder` bundle of class `airflow.dag_processing.bundles.local.LocalDagBundle` |
| Tasks talk to the metadata database | Tasks talk to the **Task Execution API** on the API server, using the Task SDK. Nothing about the database is reachable from task code |
| `from airflow import DAG`, `from airflow.decorators import task` | `from airflow.sdk import dag, task, ObjectStoragePath` — the [Task SDK](https://airflow.apache.org/docs/task-sdk/stable/index.html) is the stable authoring interface |

The last one has a consequence that bites at deploy time rather than at authoring time: because
workers reach the API server over HTTP, **`[core] execution_api_server_url` has to be an address the
workers can actually reach.** Its documented default is `{BASE_URL}/execution/`, where `{BASE_URL}`
is `[api] base_url`
([configuration reference, `[core]`](https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html#core)).
Set `base_url` to your public ingress hostname and every task now depends on hairpinning out to the
ingress and trusting a certificate from your internal CA. Section 6 pins it to the in-cluster
Service instead.

---

## The node budget decides the executor

[[schedulable-node-budget]] is where this cluster's arithmetic lives: the control-plane taint is kept
by standing decision, so **two nodes are schedulable**, roughly 2 vCPU and 4 GB each, and Longhorn,
Calico, ingress-nginx, cert-manager and MinIO are already taking a share of that.

Count what each executor asks for. These are pod counts read off the chart, not measurements:

| | CeleryExecutor | KubernetesExecutor |
|---|---|---|
| Long-lived pods | api-server, scheduler, dag-processor, triggerer, **1 worker**, **redis** = 6 | api-server, scheduler, dag-processor, triggerer = 4 |
| Extra PVCs | worker StatefulSet volume + redis volume | none |
| Cost per task | a slot inside a process that is already running | **one pod**, scheduled onto the same two nodes as everything else |
| Task start latency | fork inside the worker | pod admission + image start + Task SDK handshake |
| Blast radius of a heavy task | the worker's other slots | whichever node the Kubernetes scheduler picked |
| `statsd` | enabled by default in both — `statsd.enabled: true` | same |

**Recommendation for this cluster: `CeleryExecutor` with exactly one worker.** Two nodes with ~8 GB
between them cannot absorb an unbounded number of task pods, and KubernetesExecutor's whole value —
per-task isolation, per-task images, workers that exist only while a task runs — is value you buy
with *spare scheduling capacity*, which is precisely what is missing here. With one resident worker
you size the memory ceiling once, at install, and the number of concurrent tasks is a number you
chose rather than a race between Airflow and whatever else wants to schedule.

**What KubernetesExecutor would cost here, concretely.** It removes redis and the worker StatefulSet
(two pods and two volumes), which is real. In exchange, every task becomes a pod competing with
ingress-nginx, Longhorn's instance managers, MinIO and Airflow's own four components for the same two
nodes. When they do not fit, tasks sit `queued` and the UI does not say "the cluster is full" — it
says nothing. And because DAGs arrive over git-sync without a shared volume, the chart runs git-sync
**as an init container on every task pod** (`chart/files/pod-template-file.kubernetes-helm-yaml`
includes `git_sync_container` with `is_init` when `dags.gitSync.enabled` and not
`dags.persistence.enabled`), so each task pays a clone against your git server before it starts.
On a cluster that can autoscale, that trade is fine. This one cannot.

**The third option, honestly.** `LocalExecutor` drops redis *and* the worker, running tasks as
subprocesses of the scheduler — upstream describes it as "very easy to use, fast, very low latency"
but "shares resources with the Airflow scheduler"
([executor overview](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/executor/index.html)).
For a data platform where scheduling must survive a task that allocates too much, one extra pod to
keep the OOM away from the scheduler is worth paying. If this were a personal lab, LocalExecutor
would be the right answer.

> **The chart's `worker_concurrency` default is 16.** `config.celery.worker_concurrency: 16` in
> `values.yaml`. Sixteen concurrent tasks inside one pod on a 4 GB node is not a configuration, it is
> an OOMKill with a schedule. Section 6 sets it to 4.

---

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Two schedulable nodes | `kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'` | exactly two without `node-role.kubernetes.io/control-plane` |
| Helm version | `helm version --short` | **≥ v3.19.0** — chart 1.22.0 raised the minimum ([Chart.yaml notes](https://github.com/apache/airflow/blob/helm-chart/1.22.0/chart/Chart.yaml)) |
| Kubernetes version | `kubectl version -o json \| jq -r .serverVersion.gitVersion` | ≥ v1.30.13, per the [chart index page](https://airflow.apache.org/docs/helm-chart/stable/index.html) |
| Default StorageClass | `kubectl get storageclass` | `longhorn (default)` — [[longhorn-storage-onprem]] |
| Free Longhorn capacity | Longhorn UI, or `kubectl -n longhorn-system get nodes.longhorn.io` | enough for the volumes sized in section 6, **at `defaultReplicaCount=2`** |
| PostgreSQL for metadata | `kubectl -n <CNPG_NS> get cluster` | a database and role exist — [[postgresql-cnpg-onprem]] |
| Object storage | bucket exists, credentials issued | [[minio-object-storage-onprem]] |
| Ingress + issuer | `kubectl get ingressclass`, `kubectl get clusterissuer` | `nginx`, and `internal-ca` from [[cert-manager-onprem]] |
| DNS for the host | `dig +short <AIRFLOW_HOST>` | the ingress LoadBalancer address, per [[ingress-nginx-onprem]] |

---

## 1. The metadata database — use CNPG, not the bundled subchart

The chart ships a PostgreSQL subchart and it is **on by default**: `postgresql.enabled: true`,
pulling `bitnamilegacy/postgresql:16.1.0-debian-11-r15`. Upstream's own production guide is blunt
about it — "Embedded Postgres lacks stability, monitoring and persistence features that you need for
a production database"
([production guide](https://airflow.apache.org/docs/helm-chart/stable/production-guide.html)).

Two more reasons specific to this cluster:

- It is a **single pod with a single Longhorn volume and no backup story of its own**. Airflow's
  metadata database holds every DAG run, every task state, every connection and variable. Losing it
  does not lose your DAGs — those are in git — but it loses everything Airflow knows about what has
  and has not run, which is the part you cannot reconstruct.
- It competes for the same 8 GB. [[postgresql-cnpg-onprem]] already runs an operator that does
  failover, backups and point-in-time recovery on this cluster; running a second, worse PostgreSQL
  beside it is pure cost.

Use the bundled one only for a first look, and only knowing you will throw the release away.

Create the connection secret. The chart expects a key literally named `connection`, holding a
base64-encoded SQLAlchemy URL — the format is spelled out in `values.yaml` above
`data.metadataSecretName`:

```bash
kubectl create namespace airflow
```

```bash
kubectl -n airflow create secret generic airflow-metadata-connection \
  --from-literal=connection='postgresql+psycopg2://<DB_USER>:<REDACTED>@<CNPG_RW_SERVICE>.<CNPG_NS>.svc.cluster.local:5432/<DB_NAME>'
```

Upstream's warning for why this is a Secret and not a value: "Due to security concerns, it is not
advised to store Airflow database user credentials directly in the `values.yaml` file."

```bash
kubectl -n airflow get secret airflow-metadata-connection \
  -o jsonpath='{.data.connection}' | base64 -d | sed 's|//[^@]*@|//<REDACTED>@|'
```

That prints the URL with the password masked, so you can confirm host, port and database name
without putting the password in your shell history.

---

## 2. Generate the three keys, and persist them yourself

Three secrets decide whether an upgrade is a rolling restart or an outage. Read the chart templates
rather than trusting a summary — the difference between them is the whole point:

| Key | Chart template | What happens if you let the chart generate it |
|---|---|---|
| Fernet key | `templates/secrets/fernetkey-secret.yaml` — `randAlphaNum 32 \| b64enc`, rendered as a **`pre-install` hook** with `hook-delete-policy: before-hook-creation` | Survives `helm upgrade`, but a reinstall mints a new one. Every connection password and variable already encrypted in the metadata database becomes undecryptable. `values.yaml` also notes it "can only be set during 'helm install', not 'helm upgrade'" |
| API secret key | `templates/secrets/api-secret-key-secret.yaml` — `randAlphaNum 32`, an **ordinary manifest** | Re-randomised on **every `helm upgrade`**. Sessions break, and the api-server restarts because its secret changed |
| JWT secret | `templates/secrets/jwt-secret.yaml` — `randAlphaNum 128`, an **ordinary manifest** | Re-randomised on every upgrade. `values.yaml` says so itself: *"It is not advised to use in production as during helm upgrade it will be changed which can cause dag failures during component rollouts"* |

So create all three as Secrets you own, and point the chart at them.

```bash
python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
python3 -c 'import secrets; print(secrets.token_hex(16))'
python3 -c 'import secrets; print(secrets.token_hex(64))'
```

The first needs the `cryptography` package. If the machine you are on does not have it, a Fernet key
is 32 random bytes in url-safe base64 and nothing more:

```bash
python3 -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
```

The second command is the one the production guide gives for the API secret key, alongside "You
should use a different secret key for every instance you run."

```bash
kubectl -n airflow create secret generic airflow-fernet-key-ext --from-literal=fernet-key='<REDACTED>'
kubectl -n airflow create secret generic airflow-api-secret-key-ext --from-literal=api-secret-key='<REDACTED>'
kubectl -n airflow create secret generic airflow-jwt-secret-ext --from-literal=jwt-secret='<REDACTED>'
```

The *inner* key names are not free choices — `fernetKeySecretName` wants a `fernet-key` key,
`apiSecretKeySecretName` wants `api-secret-key`, and `jwtSecretName` wants `jwt-secret`. All three
are documented inline in `values.yaml`.

The `-ext` suffix on the Secret names is deliberate. With release name `airflow`, the chart's own
generated names are `airflow-fernet-key`, `airflow-api-secret-key` and `airflow-jwt-secret`
(`printf "%s-jwt-secret" (include "airflow.fullname" .)` and friends in `templates/_helpers.yaml`).
Reusing those names makes "did the chart generate this or did I?" unanswerable from
`kubectl get secret`, and it is exactly the question the upgrade check in the verification list is
asking.

**Back the Fernet key up somewhere that is not this cluster.** It is the only thing standing between
a database restore and a pile of connection passwords you cannot read.

---

## 3. How DAGs get into the dag-processor

In Airflow 3 the scheduler never reads your DAG files; the **dag-processor** parses them and the
scheduler works from the database. So "getting DAGs in" means getting the files onto the
dag-processor pod — and, because the task also imports the module, onto whatever runs the task.
Three ways, from
[Manage Dag files](https://airflow.apache.org/docs/helm-chart/stable/manage-dag-files.html):

**Baked into the image.** `COPY ./dags/ ${AIRFLOW_HOME}/dags/` on top of `apache/airflow`, push, then
`--set images.airflow.repository=... --set images.airflow.tag=...`. Every DAG change is an image
build and a Helm upgrade that restarts every component. Correct and auditable; too slow to be the
only path while a platform is being built, and it needs a registry this cluster can pull from.

**A shared PersistentVolume.** `dags.persistence.enabled=true` with `ReadOnlyMany` or
`ReadWriteMany`, populated by something outside the chart. On Longhorn that means an RWX volume, and
upstream is explicit that this is the combination to avoid: git-sync "is primarily designed to be
used for local, POSIX-compliant volumes", the symlink swap it performs "might have undesirable side
effects when the folder that git-sync works on is not a local volume", and the "general
recommendation is to use git-sync with local volumes only". Read that section before choosing this.

**git-sync without persistence — use this one.** `dags.persistence.enabled=false` plus
`dags.gitSync.enabled=true` puts a git-sync sidecar on the dag-processor, worker and triggerer pods,
each syncing into a pod-local `emptyDir`. No RWX volume, no shared filesystem, no Longhorn in the DAG
path at all. The cost is that each pod syncs independently, so for a few seconds after a push
different components can be on different commits.

Four defaults in `dags.gitSync` will send you to the wrong repository if you skip them:

| Parameter | Chart default | Set it to |
|---|---|---|
| `repo` | `https://github.com/apache/airflow.git` | `<GIT_REPO_URL>` |
| `subPath` | `tests/dags` | your DAG directory, or `""` — `values.yaml`: *"Should be `""` if dags are at repo root"* |
| `branch` / `rev` | `v2-2-stable` / `HEAD` | your branch / `HEAD` — these feed the v3-era `GIT_SYNC_BRANCH` and `GIT_SYNC_REV` variables |
| `ref` | `v2-2-stable` | **the one that matters.** `images.gitSync.tag` is `v4.4.2`, and the `git_sync_container` helper sets `GITSYNC_REF` from `ref` while setting `GIT_SYNC_BRANCH` from `branch` — two separate values, both rendered into the container |

Setting `branch: main` and leaving `ref` alone is the mistake to avoid — set `branch`, `rev` and
`ref` consistently.

The synced path becomes the DAG folder. The `airflow_dags` helper renders
`{{ .Values.airflowHome }}/dags/repo/{{ .Values.dags.gitSync.subPath }}` when git-sync is on, and
that path is what the default `dags-folder` `LocalDagBundle` reads.

Only one repository is possible: "Airflow git-sync integration in the Helm Chart does not allow
synchronization of multiple repositories at the same time. The Dag folder must come from single git
repository." Submodules are the documented workaround.

For a private repository, create the credentials secret git-sync v4 expects and set
`dags.gitSync.credentialsSecret`:

```bash
kubectl -n airflow create secret generic airflow-git-credentials \
  --from-literal=GITSYNC_USERNAME='<GIT_USER>' \
  --from-literal=GITSYNC_PASSWORD='<REDACTED>'
```

For SSH, the secret key is `gitSshKey` and the parameter is `dags.gitSync.sshKeySecret`; both are
documented in `values.yaml` beside `credentialsSecret`.

---

## 4. Logs — the ReadWriteMany question, and why to skip it

`logs.persistence.enabled` is **`false`** by default, and with it off, upstream states the
consequence plainly: "Airflow will log locally to each pod. As such, the logs will only be available
during the lifetime of the pod"
([Manage logs](https://airflow.apache.org/docs/helm-chart/stable/manage-logs.html)). That is not the
whole story for CeleryExecutor: `workers.celery.persistence.enabled` defaults to `true`, so the
worker StatefulSet keeps its logs on a PVC that re-attaches to the replacement pod — upstream notes
"With this option only task logs are persisted, unlike when log persistence is enabled which will
also persist scheduler logs." For KubernetesExecutor there is no such volume and the task pod's logs
go with the pod.

Turning persistence on is where Longhorn enters. The access mode is **not configurable** —
`chart/templates/logs-persistent-volume-claim.yaml` hard-codes it:

```yaml
spec:
  accessModes: ["ReadWriteMany"]
```

and the documentation adds "Not all volume plugins have support for `ReadWriteMany` access mode."

**Is RWX available on this cluster? Yes — and it is not free.** Longhorn serves RWX through an NFS
share-manager pod, which is why [[longhorn-storage-onprem]] step 1.1 installs `nfs-common` on every
node and warns that a missing client gives you an RWX PVC that hangs with no obvious cause. Check
before assuming:

```bash
kubectl -n longhorn-system get pods -l longhorn.io/component=share-manager
dpkg -l nfs-common | tail -1     # on each schedulable node
```

What enabling it actually buys you on two nodes:

- one more pod (the share-manager) whose loss makes every Airflow component's log directory hang, not
  just one component's;
- a `100Gi` default request (`logs.persistence.size`) against Longhorn running
  `storageOverProvisioningPercentage=100` on modest disks — that PVC will not bind, and the symptom
  is components stuck at `ContainerCreating`;
- every log write from every component crossing NFS to land on replicated block storage.

**Ship logs to MinIO instead.** Airflow's remote logging writes finished task logs to object storage
and the API server reads them back from there, so a log survives the pod, the worker and the node.
The keys are `[logging] remote_logging`, `remote_base_log_folder` and `remote_log_conn_id`
([Writing logs to Amazon S3](https://airflow.apache.org/docs/apache-airflow-providers-amazon/stable/logging/s3-task-handler.html)),
and a non-AWS endpoint is configured through the connection's `endpoint_url` extra — the same
mechanism that page documents for LocalStack. `delete_local_logs` sits in the same `[logging]`
section; upstream's example block is `remote_logging`, `remote_base_log_folder` and
`delete_local_logs` together
([Logging for Tasks](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/logging-tasks.html)).
The provider is `apache-airflow-providers-amazon`,
which the official image already carries: `AIRFLOW_EXTRAS` in
[the 3.2.2 Dockerfile](https://github.com/apache/airflow/blob/3.2.2/Dockerfile) includes
`aiobotocore,amazon,common-io`.

The honest caveat: remote logging uploads on task completion. A task that is still running, or one
whose pod was killed, is read live from the pod — and once that pod is gone, a log that never
uploaded is gone with it. Object storage is a better answer than RWX here, not a complete one.

---

## 5. The MinIO connection

One Airflow connection serves both remote logging and the DAG in section 8. Supply it as an
environment variable so it never enters the metadata database in plaintext, using the chart's
`extraEnvFrom` hook (its `values.yaml` example is a `secretRef` to an
`{{ .Release.Name }}-airflow-connections` secret):

```bash
kubectl -n airflow create secret generic airflow-connections \
  --from-literal=AIRFLOW_CONN_MINIO_DEFAULT='aws://<ACCESS_KEY>:<REDACTED>@?endpoint_url=https%3A%2F%2F<MINIO_SVC>.<MINIO_NS>.svc.cluster.local%3A9000&region_name=us-east-1'
```

The `endpoint_url` value is URL-encoded because it sits in a query string. Point it at the in-cluster
Service, not at the ingress host — see [[minio-object-storage-onprem]] for the service name and for
issuing a scoped access key rather than reusing the root credentials.

---

## 6. The values file

```yaml title="values-airflow.yaml"
airflowVersion: "3.2.2"
defaultAirflowTag: "3.2.2"

executor: "CeleryExecutor"

# --- metadata database: CNPG, not the bundled subchart --------------------
postgresql:
  enabled: false
data:
  metadataSecretName: airflow-metadata-connection

# --- keys we own, so an upgrade is not an outage --------------------------
fernetKeySecretName: airflow-fernet-key-ext
apiSecretKeySecretName: airflow-api-secret-key-ext
jwtSecretName: airflow-jwt-secret-ext

# --- connections ----------------------------------------------------------
extraEnvFrom: |
  - secretRef:
      name: airflow-connections

# --- dags: git-sync sidecars, no shared volume ----------------------------
dags:
  persistence:
    enabled: false
  gitSync:
    enabled: true
    repo: <GIT_REPO_URL>
    branch: main
    ref: main
    rev: HEAD
    subPath: "dags"
    depth: 1
    period: 30s
    maxFailures: 3
    credentialsSecret: airflow-git-credentials

# --- logs: object storage, not a ReadWriteMany Longhorn volume ------------
logs:
  persistence:
    enabled: false

config:
  logging:
    remote_logging: "True"
    remote_base_log_folder: "s3://<LOGS_BUCKET>/airflow"
    remote_log_conn_id: "minio_default"
    delete_local_logs: "True"
  celery:
    worker_concurrency: 4
  api:
    base_url: "https://<AIRFLOW_HOST>"
  core:
    # Must NOT inherit from api.base_url: workers would have to hairpin through
    # the ingress and trust the internal CA. Confirm the Service name after install.
    execution_api_server_url: "http://airflow-api-server.airflow.svc.cluster.local:8080/execution/"

# --- one worker, sized on purpose -----------------------------------------
workers:
  celery:
    replicas: 1
    persistence:
      size: 5Gi
    resources:
      requests:
        cpu: 200m
        memory: 768Mi
      limits:
        memory: 1536Mi

scheduler:
  resources:
    requests:
      cpu: 150m
      memory: 512Mi
    limits:
      memory: 1Gi

dagProcessor:
  resources:
    requests:
      cpu: 100m
      memory: 384Mi
    limits:
      memory: 768Mi

apiServer:
  replicas: 1
  # values.yaml documents both of these for running behind a reverse proxy
  args: ["bash", "-c", "exec airflow api-server --proxy-headers"]
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      memory: 1Gi

triggerer:
  persistence:
    size: 2Gi
  resources:
    requests:
      cpu: 100m
      memory: 384Mi
    limits:
      memory: 768Mi

# --- things that are on by default and should not be here -----------------
statsd:
  enabled: false
flower:
  enabled: false
pgbouncer:
  enabled: false

# --- the initial admin user ------------------------------------------------
createUserJob:
  defaultUser:
    role: Admin
    username: <ADMIN_USER>
    email: <ADMIN_EMAIL>
    firstName: <FIRST>
    lastName: <LAST>
    password: <REDACTED>

# --- one address, one certificate -----------------------------------------
ingress:
  apiServer:
    enabled: true
    ingressClassName: nginx
    annotations:
      cert-manager.io/cluster-issuer: internal-ca
    hosts:
      - name: <AIRFLOW_HOST>
        tls:
          enabled: true
          secretName: airflow-tls
```

Notes on the values that are not obvious:

- **The worker and triggerer volumes are `100Gi` each unless you say otherwise.**
  `triggerer.persistence` is `enabled: true, size: 100Gi` outright. The worker is one indirection
  further: `workers.celery.persistence.size` is `~`, and `worker-deployment.yaml` merges
  `workers.celery` over `workers` before reading `.Values.workers.persistence.size` — which is
  `100Gi`. Setting `workers.celery.persistence.size` is what overrides it. Two 100Gi requests on
  Longhorn at `defaultReplicaCount=2` is 400Gi of replica placement against the disks
  [[longhorn-storage-onprem]] describes; they will not bind, and this is the single most likely reason
  a first install on this cluster never reaches `Running`.
- **`statsd.enabled` defaults to `true`** — a metrics relay for a StatsD consumer this cluster does
  not have. One pod back.
- **`ingress.apiServer` is the Airflow 3 path.** `ingress.web` is labelled *"Configs for the Ingress
  of the web Service (Airflow <3.0.0)"* in `values.yaml`; using it on 3.x produces an Ingress
  pointing at a Service that does not exist.
- **`config.api.base_url`** must be set because, in Airflow's own words, "Airflow cannot guess what
  domain or CNAME you are using"
  ([configuration reference, `[api]`](https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html#api)).
- **The admin password is a Helm value.** It lands in the release's stored manifest, readable by
  anyone with `helm get` in that namespace. Change it in the UI immediately after first login and
  treat the value as a bootstrap credential, not a password. The chart's default, if you leave it
  alone, is `createUserJob.defaultUser` = username `admin`, password `admin`, role `Admin` — that is
  the literal default in `values.yaml`.

---

## 7. Install

```bash
helm repo add apache-airflow https://airflow.apache.org
helm repo update apache-airflow
helm search repo apache-airflow/airflow --versions | head -5
```

Confirm 1.22.0 is what you get, and record what you actually installed in this document's `env`.

```bash
helm upgrade --install airflow apache-airflow/airflow \
  --namespace airflow \
  --version 1.22.0 \
  -f values-airflow.yaml \
  --wait --timeout 15m
```

`migrateDatabaseJob` runs first and creates the schema in the CNPG database; `createUserJob` follows
and creates the admin user. Both have `ttlSecondsAfterFinished: 300`, so they disappear about five
minutes later — a missing Job is not evidence of a missing step.

```bash
kubectl -n airflow get pods -o wide
kubectl -n airflow get pvc
kubectl -n airflow get svc
```

Take the api-server Service name from that output and correct `config.core.execution_api_server_url`
in `values-airflow.yaml` if it is not `airflow-api-server`, then re-run the upgrade.

---

## 8. A DAG that touches object storage

Commit this to `<GIT_REPO_URL>` under the `subPath` you configured. It is written against the
Airflow 3 Task SDK and the documented `ObjectStoragePath` API; it has not been executed.

```python title="dags/minio_roundtrip.py"
from __future__ import annotations

import datetime

from airflow.sdk import ObjectStoragePath, dag, task

# The part before "@" is an Airflow connection id, not a username.
BUCKET = ObjectStoragePath("s3://minio_default@<BUCKET>")


@dag(
    dag_id="minio_roundtrip",
    schedule=None,
    start_date=datetime.datetime(2026, 8, 1),
    catchup=False,
    tags=["smoke"],
)
def minio_roundtrip():
    @task
    def write_object() -> str:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        key = f"smoke/{stamp}.txt"
        (BUCKET / key).write_text(f"airflow smoke test {stamp}\n")
        # Return the key, not str(path): rebuilding from BUCKET keeps the
        # connection id attached without depending on how the path stringifies.
        return key

    @task
    def read_object(key: str) -> int:
        body = (BUCKET / key).read_text()
        if "airflow smoke test" not in body:
            raise ValueError(f"{key} did not read back what was written")
        return len(body)

    read_object(write_object())


minio_roundtrip()
```

The connection id sits in the username position of the URI — upstream: "The username part of the URI
represents the Airflow connection id and is optional"
([Object Storage](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/objectstorage.html)).
That page also names the dependency: `apache-airflow-providers-amazon[s3fs]`, which "depends on
aiobotocore, which is not installed by default as it can create dependency challenges with botocore."
The official 3.2.2 image lists `aiobotocore` in `AIRFLOW_EXTRAS`, so it should be present — confirm
rather than assume:

```bash
kubectl -n airflow exec deploy/airflow-dag-processor -- \
  python -c 'import aiobotocore, s3fs; print(aiobotocore.__version__, s3fs.__version__)'
```

If that import fails, build a derived image rather than pip-installing into a running pod.

After pushing, wait out `dags.gitSync.period` and check what the dag-processor made of the file. The
read that matters is the import-error list, not the UI:

```bash
kubectl -n airflow exec deploy/airflow-dag-processor -- airflow dags list-import-errors
kubectl -n airflow exec deploy/airflow-dag-processor -- airflow dags list
```

An empty import-error list plus `minio_roundtrip` in `airflow dags list` is the DAG genuinely
parsed. Then trigger it:

```bash
kubectl -n airflow exec deploy/airflow-scheduler -- airflow dags trigger minio_roundtrip
kubectl -n airflow exec deploy/airflow-scheduler -- airflow dags list-runs minio_roundtrip
```

`dag_id` is a positional argument on both, not a flag — `ARG_DAG_ID = Arg(("dag_id",), ...)` in
[`cli_config.py`](https://github.com/apache/airflow/blob/3.2.2/airflow-core/src/airflow/cli/cli_config.py)
for 3.2.2. Copying a `-d <dag_id>` invocation from elsewhere will fail on argument parsing.

---

## Verification checklist

Each of these fails on a specific, realistic breakage. Where a check has a known false pass, it is
written next to the check. None of them has been watched fail on this cluster — nothing here has been
run, so treat every one as an unproven check.

- [ ] Every Airflow pod is at full readiness — `2/2` where a git-sync sidecar is present, `1/1`
      otherwise: `kubectl -n airflow get pods`. **A worker at `1/2` is a git-sync container that
      cannot reach the repository**, and the Airflow container beside it runs happily on a stale
      checkout. `Running` alone passes in that state.
- [ ] Every PVC is `Bound`: `kubectl -n airflow get pvc`. This is the check that catches leaving
      `triggerer.persistence.size` and `workers.celery.persistence.size` at `100Gi`.
- [ ] The chart deployed **no** PostgreSQL of its own:
      `helm -n airflow get manifest airflow | grep -c bitnamilegacy/postgresql` returns `0`. Forgetting
      `postgresql.enabled: false` gives you a second database eating memory while Airflow uses the
      CNPG one, and nothing about the running system looks wrong.
- [ ] The scheduler is **heartbeating**, not merely up:
      `kubectl -n airflow exec deploy/airflow-scheduler -- airflow jobs check --job-type SchedulerJob --local`
      exits non-zero when no scheduler job is alive. This is the same command the chart uses for
      `scheduler_liveness_check_command` in `templates/_helpers.yaml`.
      **This is the classic false pass**: the api-server can be perfectly healthy, the UI fully
      browsable and every page rendering, while the scheduler has stopped heartbeating — and the only
      visible symptom is that runs never leave `queued`. "The web UI loads" is not a scheduler check.
- [ ] The dag-processor is heartbeating too:
      `airflow jobs check --local --job-type DagProcessorJob`. In Airflow 3 this is a separate
      process from the scheduler, and a dead one means DAG *changes* stop arriving while everything
      already in the database keeps running — the most deceptive failure mode of the three.
- [ ] **A DAG pushed to git reaches the scheduler's list, and runs to success.** Push a trivial
      change, wait `period`, then `airflow dags list-import-errors` (empty) and `airflow dags list`
      (the DAG present) inside the **dag-processor** pod, then trigger it and confirm
      `airflow dags list-runs minio_roundtrip` reaches `success`.
      **Named false pass:** the UI lists a DAG that the dag-processor can no longer parse — the row
      is the last successfully parsed version, still in the database, while the current file raises
      on import. `list-import-errors` is what distinguishes them; the DAG list does not.
- [ ] **A task's logs are retrievable after the pod that produced it is gone.** Let
      `minio_roundtrip` finish, `kubectl -n airflow delete pod airflow-worker-0`, wait for the
      replacement to be `2/2`, then open that task instance's log in the UI. It must render the task
      output, not an error about a missing log file. This is the thing that quietly does not work,
      and it passes for the wrong reason if you check it while the worker is still the same pod that
      ran the task. (There is no `airflow tasks logs` subcommand — `TASKS_COMMANDS` in `cli_config.py`
      has `list`, `clear`, `state`, `failed-deps`, `render`, `test`, `states-for-dag-run` and nothing
      for logs. The UI and the REST API are the ways in.)
      **Named false pass, and it is a bad one:** `workers.celery.persistence.enabled` defaults to
      `true`, so the replacement worker re-attaches the *same* log PVC. The log will read back from
      local disk whether or not remote logging ever worked. The next check is what discriminates.
- [ ] The log actually landed in object storage: list `s3://<LOGS_BUCKET>/airflow/` with `mc` or the
      MinIO console and find a key for that task instance. Reading the log in the Airflow UI does
      **not** prove this — see above. If `delete_local_logs: "True"` is set and this check fails, the
      log has been deleted locally *and* never uploaded, and it is gone.
- [ ] The object the DAG wrote exists in MinIO, confirmed from **outside** Airflow:
      `mc ls <ALIAS>/<BUCKET>/smoke/`. The DAG's own success is not evidence — its read task and its
      write task share the same connection and the same misconfiguration.
- [ ] `https://<AIRFLOW_HOST>/` serves a certificate **issued by the internal CA**, not a self-signed
      or default-backend certificate:
      `echo | openssl s_client -connect <AIRFLOW_HOST>:443 -servername <AIRFLOW_HOST> 2>/dev/null | openssl x509 -noout -issuer -subject`.
      **Named false pass:** a `curl` from a cluster node returns 200 whether or not the ingress
      routing and certificate are right — test from a client that resolves `<AIRFLOW_HOST>` through
      real DNS.
- [ ] Workers reach the Task Execution API **in-cluster**, read from the worker itself rather than
      from your values file:
      `kubectl -n airflow exec statefulset/airflow-worker -- airflow config get-value core execution_api_server_url`.
      It must be the `.svc.cluster.local` URL. If it inherited `api.base_url`, tasks may still
      succeed from a node that happens to resolve and trust the ingress — and fail on the other node,
      which reads as a flaky DAG rather than a configuration error.
- [ ] The chart generated **no** key secrets of its own:
      `kubectl -n airflow get secret airflow-fernet-key airflow-api-secret-key airflow-jwt-secret`
      returns `NotFound` for all three. Any that exist mean a `*SecretName` value did not take.
- [ ] `helm upgrade` with **no changes** leaves the keys byte-identical:
      record `kubectl -n airflow get secret airflow-api-secret-key-ext airflow-jwt-secret-ext -o jsonpath='{.items[*].data}' | sha256sum`
      before and after. If they differ, the chart is generating them and section 2 was skipped —
      and the JWT rotation is the one that breaks DAG runs mid-rollout, per `values.yaml`.
- [ ] The admin password is no longer the one in `values-airflow.yaml` — change it at first login and
      confirm the old one is rejected.
- [ ] Kill one schedulable node and confirm the api-server and scheduler come back on the survivor.
      With one replica each this is downtime, not HA; the check is that they *return*, and that no
      pod is stuck because its Longhorn volume cannot attach on the remaining node.

---

## Rollback

Airflow's DAGs live in git and its state lives in the CNPG database, so uninstalling the release does
not destroy either. What it does destroy is the worker, triggerer and redis volumes.

```bash
helm -n airflow uninstall airflow
```

```bash
kubectl -n airflow get pvc
```

Helm does not remove PVCs created by StatefulSet `volumeClaimTemplates`. Delete them **by name** from
the listing above, not by label — the worker's claim template in
`templates/workers/worker-deployment.yaml` carries only `name: logs` under `metadata`, with no
`release` label, so a label selector silently matches nothing and you are left believing the storage
is gone:

```bash
kubectl -n airflow delete pvc logs-airflow-worker-0 logs-airflow-triggerer-0 redis-db-airflow-redis-0
```

Confirm those names against the `get pvc` output rather than trusting them — they follow from the
release name and the StatefulSet names, both of which change if you install under a different name.

**Reinstalling with a new Fernet key is the unrecoverable step.** If the metadata database survives
and the Fernet key does not, every stored connection and variable becomes undecryptable while the
rows remain — which reads like a permissions problem, not a key problem. Keep the Secrets from
section 2:

```bash
kubectl -n airflow get secret airflow-fernet-key-ext airflow-api-secret-key-ext airflow-jwt-secret-ext
```

To abort mid-install, the criteria are: the `migrateDatabaseJob` failing (the schema is partially
applied — restore the CNPG database from backup before retrying, do not re-run the job), or PVCs
still `Pending` after ten minutes (a sizing problem, section 6, not a timing one).

Full removal, including the schema:

```bash
kubectl delete namespace airflow
```

Then drop the Airflow database and role on the CNPG side, per [[postgresql-cnpg-onprem]].

---

## Where this bit us

**Nothing, because nothing has been run.** No install, no substitute environment, no partial
execution. `verified` is empty for exactly that reason, and this section stays empty on purpose
rather than being filled with plausible-sounding traps. Everything below came out of upstream
documentation and the chart source, and is labelled as such.

## Failure points documented upstream

**The bundled PostgreSQL subchart is on by default.** `postgresql.enabled: true`. Upstream: "Embedded
Postgres lacks stability, monitoring and persistence features that you need for a production
database." Section 1.
([Production guide](https://airflow.apache.org/docs/helm-chart/stable/production-guide.html))

**API secret key and JWT secret are re-randomised on every `helm upgrade`** unless you supply them.
`values.yaml` on `jwtSecret`: "It is not advised to use in production as during helm upgrade it will
be changed which can cause dag failures during component rollouts." Section 2.
([`chart/values.yaml`](https://github.com/apache/airflow/blob/helm-chart/1.22.0/chart/values.yaml))

**The Fernet key cannot be changed after the fact.** `values.yaml`: "Note: `fernetKey` can only be
set during 'helm install', not 'helm upgrade' command." Section 2 and Rollback.

**Task logs vanish with the pod when persistence is off.** "With this option, Airflow will log locally
to each pod. As such, the logs will only be available during the lifetime of the pod." Section 4.
([Manage logs](https://airflow.apache.org/docs/helm-chart/stable/manage-logs.html))

**The logs PVC is hard-coded `ReadWriteMany`** in
`chart/templates/logs-persistent-volume-claim.yaml`, and "Not all volume plugins have support for
`ReadWriteMany` access mode." On Longhorn that means an NFS share-manager pod and `nfs-common` on
every node. Section 4, and [[longhorn-storage-onprem]] step 1.1.

**git-sync onto a networked persistent volume is discouraged.** "General recommendation is to use
git-sync with local volumes only" — the symlink swap it relies on needs POSIX semantics, and upstream
lists networking bursts, temporary inconsistency between files, and performance drops as the DAG
count grows. Section 3.
([Manage Dag files](https://airflow.apache.org/docs/helm-chart/stable/manage-dag-files.html))

**git-sync syncs exactly one repository.** "Airflow git-sync integration in the Helm Chart does not
allow synchronization of multiple repositories at the same time." Submodules are the documented
workaround. Section 3.

**`[core] execution_api_server_url` inherits from `[api] base_url`.** "Default is `{BASE_URL}/execution/`
where `{BASE_URL}` is the base url of the API Server." Set a public ingress hostname as `base_url`
and every worker has to hairpin through the ingress and trust the internal CA. Section 6.
([Configuration reference, `[core]`](https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html#core))

**KubernetesExecutor plus git-sync-without-persistence clones the repository per task.** The chart's
`files/pod-template-file.kubernetes-helm-yaml` adds `git_sync_container` as an init container on
every worker pod, and the docs confirm: "If you are using the `KubernetesExecutor`, Git-Sync will run
as an init container on your worker pods." Executor section.

**`ObjectStoragePath` with `s3://` needs `apache-airflow-providers-amazon[s3fs]`**, which "depends on
aiobotocore, which is not installed by default as it can create dependency challenges with botocore."
Section 8.
([Object Storage](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/objectstorage.html))

**The default admin user is `admin`/`admin` with role `Admin`** if `createUserJob.defaultUser` is left
alone, and whatever you set is stored in the Helm release manifest either way. Section 6.

---

## Follow-ups

- [ ] Reconcile section 1 against [[postgresql-cnpg-onprem]], written the same day — confirm the service name, the `Pooler` question, and that the connection secret this chart wants matches what that document produces. **Not yet cross-read against
      link to yet 📅 2026-08-23
- [ ] Reconcile section 5 against [[minio-object-storage-onprem]], written the same day — it terminates TLS on the S3 port, so the connection is `https` and the worker needs the internal CA. Confirm the scoped access key for Airflow
      rather than handing it the root credentials 📅 2026-08-23
- [ ] Decide in [[schedulable-node-budget]] whether Airflow's six long-lived pods fit alongside Argo
      CD and MinIO on two nodes, or whether this is the add-on that finally buys a third machine
      📅 2026-08-30
- [ ] Settle the log-retention question before the first month of runs: `delete_local_logs: "True"`
      moves logs to MinIO but nothing expires them there, and the chart's `logGroomerSidecar` only
      grooms what is local

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this targets; its control-plane taint decision is what
makes two nodes the number that matters here.
[[schedulable-node-budget]] — the two-schedulable-node arithmetic that selects CeleryExecutor over
KubernetesExecutor in this document.
[[longhorn-storage-onprem]] — supplies the `longhorn` default StorageClass, and is why the
`ReadWriteMany` logs volume costs an NFS share-manager pod. Its `100Gi`-scale capacity warnings apply
directly to the chart's triggerer and worker volume defaults.
[[dagster-local-quickstart]] — the other orchestrator in this repo, software-defined-assets rather
than tasks, verified locally rather than on this cluster.
[[postgresql-cnpg-onprem]] — where the metadata database comes from. Not written yet.
[[minio-object-storage-onprem]] — the object storage the smoke-test DAG and remote logging both use.
Not written yet.
[[ingress-nginx-onprem]] — the single ingress address the api-server is published behind, and the
`nginx` IngressClass referenced in the values file.
[[cert-manager-onprem]] — supplies the `internal-ca` ClusterIssuer named in the ingress annotation.
[[argocd-helm-ha-install]] — competes for the same two nodes; read together with the node budget
before installing both.
