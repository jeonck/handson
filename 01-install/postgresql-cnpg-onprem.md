---
title: PostgreSQL with CloudNativePG on the on-prem cluster — a metadata store on two schedulable nodes
date: 2026-08-16
domain: install
tags: [on-prem, database, data-platform, backup]
stack: [kubernetes, postgresql, cloudnative-pg, barman-cloud, longhorn, minio, cert-manager, helm, kubectl]
summary: Two schedulable nodes cap this at one primary and one replica — enough to survive losing a worker, and nothing left over during a drain. The sharper trade is underneath it: Longhorn already replicates every block, so running its default two replicas under PostgreSQL's own replication buys a fourth copy of the data and a second network round trip in every commit.
source: handson
env: Kubernetes 1.31.14 (kubeadm, 1 control plane + 2 workers) · CloudNativePG 1.30.0 (chart 0.29.0) · Barman Cloud Plugin 0.14.0 · PostgreSQL 17 · Longhorn 1.7.2 · cert-manager 1.16.2 · Calico 3.28.2 · Ubuntu 24.04 — target environment, not a run environment
verified:
duration: 60–90 min
risk: medium
---

> **Not executed. Assembled from official documentation on 2026-08-16.** Every version, field name and
> command below was read off a documentation page or a release listing on that date — CloudNativePG
> **1.30.0** (released 2026-06-29), operator chart **0.29.0**, Barman Cloud Plugin **0.14.0**. Sources
> are cited inline. Nothing here has been run against the cluster in the `env` line, or against any
> cluster. Treat the YAML as a starting point that has not been through an `apply`, and treat the
> failover and restore sections as designs for tests rather than as tests that passed.
>
> One finding is worth reading before anything else: **CloudNativePG 1.30 does not list Kubernetes
> 1.31 as a supported version.** See [section 0.1](#01-the-kubernetes-version-problem-read-this-first).

You are standing up PostgreSQL as the metadata store for a data platform — the database Airflow keeps
its DAG runs in, the one a Hive or Iceberg catalog points at, the one that everything else quietly
depends on. Small data, high consequence: nobody notices it until it is gone, and then nothing works.

CloudNativePG is an operator, not a Helm chart that runs a StatefulSet. It manages the primary,
streams WAL to replicas, promotes on failure, and archives to object storage. What it cannot do is
create nodes. This cluster has three machines and **two** places to put a database instance, and that
number decides most of the document.

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]], Longhorn from [[longhorn-storage-onprem]],
and cert-manager from [[cert-manager-onprem]]. Out of scope: PgBouncer connection pooling (see
Follow-ups), monitoring and alerting, major-version upgrades, and tuning beyond a starting point.

---

## 0. Decide these four things before you install

Every one of them is cheaper to decide now than to change later.

### 0.1 The Kubernetes version problem — read this first

CloudNativePG publishes an explicit support matrix, and this cluster is not in it.

| CNPG | Supported Kubernetes | Tested, but not supported | PostgreSQL |
|---|---|---|---|
| 1.30.x (2026-06-29, EOL ~Dec 2026) | 1.34, 1.35, 1.36 | 1.33, 1.32, **1.31**, 1.30 | 14 – 18 |
| 1.29.x (2026-03-31, EOL 2026-09-29) | 1.33, 1.34, 1.35 | 1.36, 1.32, **1.31** | 14 – 18 |

This cluster runs **Kubernetes 1.31.14**. It falls in the "tested, but not supported" column for
*both* currently maintained CNPG minors — there is no CloudNativePG release you can install here that
treats 1.31 as supported. Downgrading the operator does not help; 1.28.x is already end of life.

- Source: [CloudNativePG — supported releases](https://cloudnative-pg.io/docs/1.30/supported_releases/), read 2026-08-16

Three honest options:

1. **Upgrade the cluster** to a Kubernetes version in the supported column before putting a database
   on it. Correct, and the largest piece of work.
2. **Install anyway on 1.31** and accept running a combination upstream tests but will not support.
   Bugs found here are yours to work around.
3. **Do not run the metadata store on this cluster.**

This document takes option 2 so that the rest of it is usable, and says so rather than omitting the
matrix. If a support relationship with the project matters — or if this database is going to matter —
option 1 is the honest answer and it belongs in the plan before the operator is installed.

### 0.2 Instance count: two schedulable nodes

The control-plane taint is kept by standing decision ([[schedulable-node-budget]]), so instances can
land on **two workers only**.

CloudNativePG spreads instances by default, but softly. The documented defaults are
`enablePodAntiAffinity: true` and `podAntiAffinityType: preferred`, which becomes
`preferredDuringSchedulingIgnoredDuringExecution` in the pod spec — a preference the scheduler drops
when it cannot satisfy it.

- Source: [CloudNativePG — scheduling](https://cloudnative-pg.io/docs/1.30/scheduling/), read 2026-08-16

That default produces a third failure shape, different from the two [[schedulable-node-budget]]
already catalogues:

| `instances` | On two schedulable nodes | How it looks |
|---|---|---|
| 3, `preferred` (default) | **Schedules.** Two of the three pods share a node | Healthy. `kubectl cnpg status` is green, and two thirds of your database is one kernel panic away |
| 3, `required` | One pod cannot be placed | `Pending`, loud, obvious |
| **2, `required`** | Exactly one pod per node | What this document uses |
| 1 | One pod, one node | No replica to promote; a node loss is an outage until the pod reschedules |

The dangerous row is the first, because it is the default and it looks fine. Argo CD's `redis-ha`
announced the same miscount with `Pending` pods; Longhorn announced it with a permanent `degraded`;
CloudNativePG does not announce it at all. Worse, it interacts with quorum failover: the docs' worked
example is a three-instance cluster where losing the primary **and** one replica leaves too few
promotable instances, and "*failover is not allowed to prevent possible data loss*" — which is exactly
the state a single node loss puts you in when two of three instances shared that node.

So: **`instances: 2`**, and set the anti-affinity to `required` rather than leaving the default, so
the scheduler enforces the topology this document assumes instead of preferring it.

**What `instances: 2` actually gives you.**

- **One worker dies.** The operator promotes the standby. The `-rw` service follows. Service is
  restored without a human, and the cluster is now a single instance with no redundancy until the
  node returns.
- **A node is drained for maintenance.** With `required` anti-affinity the evicted instance has
  nowhere to go and sits `Pending` until the node comes back. The database keeps serving on one
  instance. **There is no margin: a failure of the surviving node during that window is an outage
  with no replica to promote.** Read [[k8s-node-drain-replace]] before draining anything — on this
  cluster a drain is no longer a pure Kubernetes operation, it moves a database primary.
- **With `preferred` instead**, the evicted instance reschedules onto the node already running the
  primary. You keep two instances and lose the property they were there for, silently.

**There is no Postgres-level quorum to satisfy, and that is the part people get wrong.**
CloudNativePG does not run a consensus protocol between database instances the way a Patroni-plus-etcd
deployment does. Failure is detected through the readiness probe, and promotion is arbitrated with a
Kubernetes `Lease` — "*an instance must acquire and hold this lease before it promotes to primary*".
So two instances is not "below quorum"; there is nothing among the Postgres pods that needs an odd
number.

The quorum that matters is **etcd's, on the single control-plane node.** If that machine is down,
the API server is gone, the operator cannot act, and no promotion happens — while both Postgres pods
keep running, because kubelet keeps existing pods alive. Losing the control plane and then a worker
is an outage that will not self-heal. On a three-machine cluster that is the real availability
ceiling, and no CloudNativePG setting raises it.

The docs also flag the converse case: the lease "*does not fence a primary that has lost connectivity
to the Kubernetes API server but is still running; that is the job of the primary isolation check*".

- Source: [CloudNativePG — failover](https://cloudnative-pg.io/docs/1.30/failover/), read 2026-08-16

### 0.3 Two replication layers over the same two disks

This is the trade that costs the most and is the least visible.

Longhorn is installed with `defaultReplicaCount=2`, so every block written to a `longhorn` PVC is
copied synchronously to both nodes' disks. PostgreSQL then streams WAL to its own replica, which has
its own PVC, which Longhorn also replicates to both nodes.

Run the defaults on both layers and a two-instance cluster holds **four physical copies of the same
data on two disks**, and every commit crosses the network twice for different reasons — once inside
Longhorn to acknowledge the block write, once in WAL streaming to reach the standby.

Upstream is direct about this: "*defining additional replicas at the storage level can lead to write
amplification*", and the storage page favours PostgreSQL's own replication.

- Source: [CloudNativePG — storage](https://cloudnative-pg.io/docs/1.30/storage/), read 2026-08-16

| Combination | Copies on disk | What it survives | What it costs / how it fails |
|---|---|---|---|
| Longhorn 2 + `instances: 2` | 4 | Node loss twice over | Doubled write path. After a node returns, a Longhorn rebuild and a WAL catch-up compete for the same disks and the same NIC, at the worst moment |
| **Longhorn 1 + `instances: 2`** (recommended) | 2, one per node | Node loss once, with a running server ready to take over | A lost disk means the instance is re-cloned from the primary by `pg_basebackup`, not rebuilt block by block. On a metadata store that is minutes, not hours |
| Longhorn 2 + `instances: 1` | 2 | Node loss, but only by restarting the pod elsewhere | No server to promote — you pay PostgreSQL crash recovery on every failover, and there is no protection against a corrupt page, because Longhorn replicates corruption faithfully |

**Recommendation: a dedicated single-replica StorageClass for the database, and let PostgreSQL do the
replication.** The reasoning is not only write amplification. Longhorn protects against a disk or a
node disappearing. It does not protect against a page that is wrong, because it copies the wrong page
to both replicas without comment. PostgreSQL's standby replays WAL on an independent server with its
own buffers and its own checksums, and it is *already running* when you need it — which is the thing
that shortens an outage.

The cost is real and worth stating: with one Longhorn replica, a volume's data lives on exactly one
node. If that node's disk fails, the volume is gone, and CloudNativePG has to build a fresh instance
from the primary. That is a full re-clone of the database over the network. For a metadata store of a
few GB it is acceptable; for a multi-terabyte volume it would not be.

Also give WAL its own volume (`walStorage`), so a stalled archive that fills `pg_wal` does not also
fill PGDATA. Note before you do: "*Removing `walStorage` isn't supported. Once added, a separate
volume for WALs can't be removed*."

### 0.4 Backups in the cluster you are backing up

If the S3-compatible target is MinIO running on these same two workers, on these same Longhorn disks,
then the database and its backups share a failure domain. The event you bought backups for — a worker
burning out, a bad Longhorn upgrade, a full disk, a fat-fingered `kubectl delete ns` — takes the
backups with it. A backup that only exists inside the thing it is backing up is a snapshot, not a
backup, exactly as [[longhorn-backup-target-onprem]] argues one layer down.

There is a second, sharper edge. Continuous backup requires WAL archiving; WAL archives are
"*essential for enabling Point-In-Time Recovery (PITR) and are a foundational component for both
object store and volume snapshot-based backup strategies*". If the archive target is unreachable,
PostgreSQL retries and keeps the un-archived segments — so a MinIO outage stops being a backup problem
and starts being a disk-space problem on the primary. In-cluster MinIO makes a *backup-target* outage
capable of causing a *database* outage.

- Source: [CloudNativePG — WAL archiving](https://cloudnative-pg.io/docs/1.30/wal_archiving/), read 2026-08-16

Least-bad ordering for this cluster:

1. An S3 endpoint **off** the cluster — another machine, a NAS with a MinIO gateway, a rented bucket.
2. In-cluster MinIO **plus** a scheduled copy of the bucket to somewhere else, and alerting on
   `pg_stat_archiver` failures and on `pg_wal` free space.
3. In-cluster MinIO alone, written down as a known gap rather than assumed to be a backup.

This document configures the target as `<S3_ENDPOINT>` and does not care where it lives — but if that
resolves to a Service in this cluster, option 3 is what you have.

---

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster healthy | `kubectl get nodes` | all `Ready` |
| Schedulable node count | `kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'` | 2 untainted — the number `instances` must match |
| Kubernetes version | `kubectl version -o json \| grep gitVersion` | 1.31.14 — see [0.1](#01-the-kubernetes-version-problem-read-this-first) |
| Default StorageClass | `kubectl get storageclass` | `longhorn (default)` |
| Longhorn healthy | `kubectl -n longhorn-system get nodes.longhorn.io` | every node `Ready`, disks schedulable |
| cert-manager running | `kubectl -n cert-manager get pods` | all `Running` — required by the backup plugin |
| Helm | `helm version --short` | v3.x |
| S3 endpoint reachable | `curl -sI <S3_ENDPOINT>` | a response — from inside the cluster, not from your laptop |
| Free capacity | `kubectl describe node <WORKER> \| grep -A5 "Allocated resources"` | room for the requests set in step 4 |

---

## 1. Install the operator

Two documented paths. The manifest is what the installation page shows verbatim; Helm is available
here and makes the version explicit in a values file, so use whichever your cluster is managed with.

Manifest:

```bash
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.0.yaml
```

Helm — chart `0.29.0` carries appVersion `1.30.0`:

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update cnpg
```

```bash
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version 0.29.0 \
  --wait --timeout 5m
```

```bash
kubectl rollout status deployment -n cnpg-system cnpg-controller-manager
kubectl get deployment -n cnpg-system cnpg-controller-manager \
  -o jsonpath="{.spec.template.spec.containers[*].image}"
```

Pin the version rather than tracking latest. The operator watches CRs that outlive it, and a minor
that changes defaults underneath a running database is not a surprise you want on a Tuesday.

- Source: [CloudNativePG — installation and upgrades](https://cloudnative-pg.io/docs/1.30/installation_upgrade/) and the [operator chart README](https://raw.githubusercontent.com/cloudnative-pg/charts/main/charts/cloudnative-pg/README.md), read 2026-08-16

### 1.1 The kubectl plugin

Not optional in practice — `kubectl cnpg status` is the only compact view of replication state,
archiving state and instance roles, and the failover test in section 8 uses it.

```bash
curl -sSfL \
  https://github.com/cloudnative-pg/cloudnative-pg/raw/main/hack/install-cnpg-plugin.sh | \
  sudo sh -s -- -b /usr/local/bin
```

```bash
kubectl cnpg version
```

- Source: [CloudNativePG — kubectl plugin](https://cloudnative-pg.io/docs/1.30/kubectl-plugin/), read 2026-08-16

---

## 2. A single-replica StorageClass for the database

Per [0.3](#03-two-replication-layers-over-the-same-two-disks). This adds a class; it does not touch
the `longhorn` default, so nothing else on the cluster changes.

```yaml title="sc-longhorn-db.yaml"
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-db
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "1"
  staleReplicaTimeout: "30"
  fsType: "ext4"
```

```bash
kubectl apply -f sc-longhorn-db.yaml
kubectl get storageclass
```

`reclaimPolicy: Retain` is deliberate and differs from the `longhorn` default. On a database volume,
"the PVC went away so the data went away" is not a behaviour you want available. The cost is that
deleted volumes leave `Released` PVs behind that someone has to clean up — see Rollback.

Confirm the class produces what you asked for before a database depends on it. A Longhorn volume from
this class must report **one** replica, not two:

```bash
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,REPLICAS:.spec.numberOfReplicas,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

Note that a single-replica volume reports `healthy`, not `degraded` — one replica is what it was asked
for. If you are used to reading that column after [[longhorn-storage-onprem]], `healthy` here means
something weaker than it did there, and that is the trade being made on purpose.

---

## 3. The backup plugin

CloudNativePG's backup story changed, and the change is not cosmetic. Backup and recovery are
"*progressively phased out of the core operator and moved to official CNPG-I plugins*". The in-tree
`barmanObjectStore` stanza is "*deprecated starting with v1.26 in favor of the Barman Cloud Plugin,
but still the default for backward compatibility*".

So on 1.30 both work, and the one to build on is the plugin. This document uses the plugin.

- Source: [CloudNativePG — backup](https://cloudnative-pg.io/docs/1.30/backup/), read 2026-08-16

The plugin requires CloudNativePG 1.26+ and **cert-manager**, which it uses for TLS between the plugin
and the operator, and it must be installed **in the operator's namespace**.

```bash
kubectl apply -f \
  https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.14.0/manifest.yaml
```

```bash
kubectl rollout status deployment -n cnpg-system barman-cloud
```

- Source: [Barman Cloud Plugin — installation](https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/), read 2026-08-16 (version 0.14.0)

### 3.1 Credentials and the ObjectStore

Create the namespace and the S3 credential. The values are secrets — they do not belong in a file
that gets committed.

```bash
kubectl create namespace database
```

```bash
kubectl -n database create secret generic pg-backup-s3 \
  --from-literal=ACCESS_KEY_ID='<REDACTED>' \
  --from-literal=ACCESS_SECRET_KEY='<REDACTED>'
```

```yaml title="pg-objectstore.yaml"
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: pg-meta-store
  namespace: database
spec:
  configuration:
    destinationPath: s3://<BUCKET>/
    endpointURL: <S3_ENDPOINT>
    s3Credentials:
      accessKeyId:
        name: pg-backup-s3
        key: ACCESS_KEY_ID
      secretAccessKey:
        name: pg-backup-s3
        key: ACCESS_SECRET_KEY
    wal:
      compression: gzip
    data:
      compression: gzip
```

```bash
kubectl apply -f pg-objectstore.yaml
kubectl -n database get objectstore pg-meta-store
```

The `ObjectStore` lives in the same namespace as the `Cluster` that references it. If MinIO is in this
cluster, `<S3_ENDPOINT>` is `https://minio.<MINIO_NS>.svc.cluster.local:9000` — `https`, because [[minio-object-storage-onprem]] terminates TLS on that port and has no plaintext one, which also means the operator needs the internal CA in `.spec.backup.barmanObjectStore` trust settings — and
[0.4](#04-backups-in-the-cluster-you-are-backing-up) applies.

- Source: [Barman Cloud Plugin — usage](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/), read 2026-08-16

---

## 4. The Cluster

```yaml title="pg-cluster.yaml"
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-meta
  namespace: database
spec:
  instances: 2
  imageName: ghcr.io/cloudnative-pg/postgresql:17-minimal-trixie

  # One instance per schedulable node, enforced rather than preferred.
  affinity:
    enablePodAntiAffinity: true
    topologyKey: kubernetes.io/hostname
    podAntiAffinityType: required

  storage:
    storageClass: longhorn-db
    size: 20Gi
  walStorage:
    storageClass: longhorn-db
    size: 10Gi

  resources:
    requests:
      cpu: "1"
      memory: 4Gi
    limits:
      cpu: "1"
      memory: 4Gi

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: 1GB
      effective_cache_size: 3GB
      work_mem: 8MB
      maintenance_work_mem: 256MB
      wal_compression: "on"
    synchronous:
      method: any
      number: 1
      dataDurability: preferred

  bootstrap:
    initdb:
      database: metastore
      owner: metastore
      secret:
        name: pg-meta-app

  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: pg-meta-store
```

Create the application credential before applying, so the password has one authority instead of being
generated inside the database namespace and then copied to wherever it is needed (section 6):

```bash
kubectl -n database create secret generic pg-meta-app \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=metastore \
  --from-literal=password='<REDACTED>'
```

```bash
kubectl apply -f pg-cluster.yaml
kubectl -n database get cluster pg-meta -w
kubectl cnpg status pg-meta -n database
```

Why each of the non-obvious choices:

- **`imageName` pinned.** Left unset, "*the operator will install the latest available minor version
  of the latest major version of PostgreSQL when the operator was released*" — meaning the major
  version of your metadata store is a side effect of when you happened to install the operator. CNPG
  1.30 supports PostgreSQL 14–18; pick one on purpose. Tag format is `MM[.mm]-TYPE-OS`. Prefer
  `minimal` or `standard`; the `system` variant that bundled the `barman-cloud` binaries is
  **deprecated**, and with the plugin architecture the operand image no longer needs them.
  ([postgres-containers](https://github.com/cloudnative-pg/postgres-containers), read 2026-08-16)
- **`requests` equal to `limits`.** That is what puts the pod in the Guaranteed QoS class, which makes
  it the last thing the kubelet evicts when a node runs short of memory. On a two-worker cluster where
  the database shares nodes with everything else, this is the difference between "a batch job got
  greedy" and "the primary was evicted".
- **`shared_buffers` at roughly 25% of the memory limit**, the conventional starting point.
  `effective_cache_size` is a hint to the planner, not an allocation. Both need revisiting after real
  traffic; neither should be left at PostgreSQL's stock values for a shared metadata store.
- **`max_connections: 200`** is a stopgap. Airflow's scheduler, webserver, triggerer and every worker
  hold connections, and a Hive metastore adds its own pool. This is what the `Pooler` follow-up is
  for.
- **`walStorage` separate.** A stalled archive fills a volume; make it a volume that is not PGDATA.
  It cannot be removed later.

### 4.1 Synchronous replication — pick the failure you prefer

With exactly one standby there is no comfortable answer, only a choice of which failure you would
rather have. The documented behaviour:

| `dataDurability` | Standby healthy | Standby down |
|---|---|---|
| `required` (default) | Commit acknowledged only after WAL reaches the standby | "*no write operations will be allowed until at least one of the standbys is available again*" — the database stops accepting writes |
| `preferred` | Same acknowledgement | "*Write operations will continue, but with the risk of potential data loss in case of a primary failure*" |
| stanza omitted (async) | Commit acknowledged locally; standby lags | Nothing changes |

- Source: [CloudNativePG — replication](https://cloudnative-pg.io/docs/1.30/replication/), read 2026-08-16

The manifest above uses `preferred`, on the argument that for a metadata store an Airflow scheduler
that cannot write is an outage of the whole platform, while a few seconds of lost WAL after a
simultaneous double failure is survivable. **Be clear about what that means:** under `preferred`, the
moment the standby goes away your durability guarantee silently drops to that of asynchronous
replication, and nothing in the application notices. If losing committed transactions is worse than
being down — a billing ledger rather than a DAG-run table — use `required` and accept that a standby
restart blocks writes.

`.spec.postgresql.synchronous.failoverQuorum: true` exists and requires synchronous replication; its
rule is `R + W > N`. The worked example in the docs is a three-instance cluster, and what it adds on
two instances — where there is exactly one promotable replica — is not something this document has
tested. Left off here rather than enabled on an untested reading.

---

## 5. Confirm the topology before trusting it

```bash
kubectl -n database get pods -l cnpg.io/cluster=pg-meta -o wide
```

Two pods, two **distinct** node names. If both show the same node, the anti-affinity is not doing what
section 4 assumes — check that `podAntiAffinityType: required` survived into the spec:

```bash
kubectl -n database get cluster pg-meta -o jsonpath='{.spec.affinity}' ; echo
```

Confirm WAL really landed on its own volume, without assuming a mount path:

```bash
kubectl -n database get pod pg-meta-1 \
  -o jsonpath='{range .spec.containers[0].volumeMounts[*]}{.name}{"\t"}{.mountPath}{"\n"}{end}'
```

There should be two distinct data mounts, not one. Then confirm Longhorn made one replica per volume,
not two:

```bash
kubectl -n longhorn-system get replicas.longhorn.io \
  -o custom-columns='REPLICA:.metadata.name,VOLUME:.spec.volumeName,NODE:.spec.nodeID,STATE:.status.currentState'
```

---

## 6. Connect from another namespace

CloudNativePG creates three ClusterIP services per cluster:

| Service | Points at |
|---|---|
| `pg-meta-rw` | the primary — read/write. Mandatory, cannot be disabled |
| `pg-meta-ro` | the replicas, where available — read-only |
| `pg-meta-r` | any instance |

- Source: [CloudNativePG — service management](https://cloudnative-pg.io/docs/1.30/service_management/), read 2026-08-16

From another namespace, use the FQDN. **Applications connect to `-rw` and nothing else** — `-ro` on a
two-instance cluster points at a single standby that disappears during every drain and every failover.

```text
host: pg-meta-rw.database.svc.cluster.local
port: 5432
dbname: metastore
```

### 6.1 The credential does not cross the namespace by itself

Secrets are namespaced and the operator does not copy them. Since section 4 created `pg-meta-app`
explicitly rather than letting the operator generate one, apply the same secret in the consuming
namespace from the same source of truth:

```bash
kubectl -n airflow create secret generic pg-meta-app \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=metastore \
  --from-literal=password='<REDACTED>'
```

Do not produce the second copy with `kubectl get secret -o yaml | kubectl apply -f -`. That carries
`namespace`, `uid`, `resourceVersion` and any `ownerReferences` with it — at best the apply is
rejected, at worst you create a secret owned by an object in another namespace and watch it vanish
when that owner is garbage collected. If you must copy, copy the values, not the object.

A copy is also a snapshot. If the password is ever changed on one side, the other side keeps
presenting the old one and the application fails to authenticate at its next reconnect — not at the
moment of the change, which makes it a genuinely confusing outage. One authority, applied twice.

### 6.2 NetworkPolicy

This cluster runs Calico 3.28.2, so NetworkPolicy is enforced. If either namespace has a default-deny
policy, cross-namespace traffic to 5432 needs to be allowed explicitly:

```yaml title="netpol-allow-airflow-to-pg.yaml"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-airflow-to-pg
  namespace: database
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: pg-meta
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: airflow
      ports:
        - protocol: TCP
          port: 5432
```

```bash
kubectl apply -f netpol-allow-airflow-to-pg.yaml
```

### 6.3 Prove the path

```bash
kubectl -n airflow run pg-client --rm -it --restart=Never \
  --image=postgres:17-alpine \
  --env=PGPASSWORD='<REDACTED>' -- \
  psql -h pg-meta-rw.database.svc.cluster.local -U metastore -d metastore -c '\conninfo'
```

> **Known false pass.** On a cluster with no NetworkPolicies at all, this succeeds whether or not the
> policy in 6.2 is correct — everything is allowed by default. It proves the connection works today,
> not that it is authorised. The check that can actually fail is running it again *after* a
> default-deny policy exists in either namespace.

---

## 7. Backups

### 7.1 Scheduled

```yaml title="pg-scheduledbackup.yaml"
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: pg-meta-daily
  namespace: database
spec:
  schedule: "0 30 2 * * *"
  backupOwnerReference: self
  cluster:
    name: pg-meta
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

The schedule field takes six fields, seconds first — `0 30 2 * * *` is 02:30 daily, not 30 seconds
past every second hour. Getting this wrong is silent.

```bash
kubectl apply -f pg-scheduledbackup.yaml
kubectl -n database get scheduledbackup pg-meta-daily
```

### 7.2 On demand

```bash
kubectl cnpg backup pg-meta -n database \
  --method=plugin \
  --plugin-name=barman-cloud.cloudnative-pg.io
```

```bash
kubectl -n database get backups.postgresql.cnpg.io
kubectl cnpg status pg-meta -n database --verbose
```

`kubectl cnpg status` reports continuous archiving state and the last archived WAL. Watch the
archiver counters too — a first backup that succeeds and an archiver that has been failing since are
easy to hold at the same time:

```bash
kubectl cnpg psql pg-meta -n database -- -c \
  "SELECT archived_count, last_archived_wal, failed_count, last_failed_wal, last_failed_time FROM pg_stat_archiver;"
```

`failed_count` above zero with a recent `last_failed_time` means WAL is piling up on the primary's
volume right now. That is the failure mode from
[0.4](#04-backups-in-the-cluster-you-are-backing-up), and it ends in a full disk.

### 7.3 Restore — the only test that means anything

**A backup that has never been restored is an untested assumption.** An object in the bucket proves
`barman-cloud` wrote bytes somewhere. It does not prove the bytes are a database, that the WAL needed
to make them consistent is also there, or that the credentials in the ObjectStore are enough to read
them back. Every one of those has to be demonstrated, and the only demonstration is a restore that
produces the rows.

Write a sentinel first, so there is something specific to look for:

```bash
kubectl cnpg psql pg-meta -n database -- -c \
  "CREATE TABLE IF NOT EXISTS restore_sentinel (id serial primary key, note text, at timestamptz default now());"
kubectl cnpg psql pg-meta -n database -- -c \
  "INSERT INTO restore_sentinel (note) VALUES ('before backup');"
```

Take a backup (7.2), then restore into a **separate** cluster — never over the live one:

```yaml title="pg-restore-test.yaml"
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-meta-restore
  namespace: database
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:17-minimal-trixie
  storage:
    storageClass: longhorn-db
    size: 20Gi
  bootstrap:
    recovery:
      source: origin
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: pg-meta-store
          serverName: pg-meta
```

```bash
kubectl apply -f pg-restore-test.yaml
kubectl cnpg status pg-meta-restore -n database
```

```bash
kubectl cnpg psql pg-meta-restore -n database -- -d metastore -c \
  "SELECT count(*), max(at) FROM restore_sentinel;"
```

The count must match what the source held when the backup was taken. `instances: 1` is deliberate —
the restore test does not need HA, and on two schedulable nodes a second restore instance would
compete with the live database for the one free slot.

Delete the restore cluster when done, and note that `reclaimPolicy: Retain` leaves its PVs behind
(see Rollback).

- Source: [CloudNativePG — recovery](https://cloudnative-pg.io/docs/1.30/recovery/), read 2026-08-16

---

## 8. Prove a failover actually promotes a replica

Three tests, in ascending order of what they prove. Doing only the first is the usual mistake.

**Set up a sentinel that can distinguish "the database survived" from "the connection survived".**

```bash
kubectl cnpg psql pg-meta -n database -- -c \
  "CREATE TABLE IF NOT EXISTS failover_sentinel (id serial primary key, note text, at timestamptz default now());"
kubectl cnpg psql pg-meta -n database -- -c \
  "INSERT INTO failover_sentinel (note) VALUES ('written before failover');"
```

Record the current primary — the pod name, and the node it is on:

```bash
kubectl cnpg status pg-meta -n database
kubectl -n database get pods -l cnpg.io/cluster=pg-meta -o wide
```

### 8.1 Switchover — proves promotion, not detection

```bash
kubectl cnpg promote pg-meta pg-meta-2 -n database
```

Graceful and controlled. It shows that the standby can become a primary and that the `-rw` service
follows. It says nothing about whether the operator *notices* a failure, because you told it.

### 8.2 Kill the primary pod — proves detection

```bash
kubectl -n database delete pod <CURRENT_PRIMARY_POD>
```

The operator should promote the standby. This exercises the readiness probe and the lease. It still
does not exercise a node loss, because the API server, the operator, and the node's kubelet are all
fine.

### 8.3 Lose the node — the one that counts

Power off, or stop kubelet on, the worker holding the primary:

```bash
# on the worker holding the primary
sudo systemctl stop kubelet
```

This is the shape of the failure you actually installed a replica for. It is also the test that will
expose the ceiling in [0.2](#02-instance-count-two-schedulable-nodes): with the anti-affinity set to
`required`, no replacement instance can be scheduled while that node is down, so the cluster runs as
a single instance until it returns.

### 8.4 What to check after any of the three

```bash
kubectl -n database get pods -l cnpg.io/cluster=pg-meta -o wide
kubectl cnpg status pg-meta -n database
```

The pod backing `-rw` must be a **different pod name** than the one recorded before. Then read the
sentinel back through the service, **from the application namespace, with a new connection**:

```bash
kubectl -n airflow run pg-client --rm -it --restart=Never \
  --image=postgres:17-alpine \
  --env=PGPASSWORD='<REDACTED>' -- \
  psql -h pg-meta-rw.database.svc.cluster.local -U metastore -d metastore \
  -c "SELECT * FROM failover_sentinel ORDER BY id;"
```

The row written before the failure must be there, and it must be readable *and writable* — insert a
second row to confirm the new primary is genuinely read/write and not a standby the service is
pointing at by mistake:

```bash
kubectl cnpg psql pg-meta -n database -- -c \
  "INSERT INTO failover_sentinel (note) VALUES ('written after failover');"
```

> **Known false pass, and it is the one that catches people.** A client that already holds an open
> connection can keep querying a demoted instance, or fail in ways that look like a network blip.
> `kubectl cnpg status` reporting `Healthy` is a report about the operator's view, not proof that a
> row survived. Only a *new* connection through `-rw`, returning the row written before the failure
> and accepting a write after it, tests the property.

Finally, confirm the former primary comes back as a standby rather than sitting broken:

```bash
kubectl cnpg psql pg-meta -n database -- -c \
  "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication;"
```

One row, `state = streaming`. This is the step most likely to need intervention — a demoted primary
that diverged has to be rewound or re-cloned, and on a two-instance cluster you are running without
redundancy until it finishes.

---

## Verification checklist

Storage and topology:

- [ ] `kubectl -n database get pods -l cnpg.io/cluster=pg-meta -o wide` shows **two distinct node
      names**. *(False pass with the default `podAntiAffinityType: preferred`: both instances can
      share a node and every status view still reads healthy.)*
- [ ] `kubectl -n longhorn-system get replicas.longhorn.io` shows **one** replica per database volume,
      not two — otherwise the write amplification in [0.3](#03-two-replication-layers-over-the-same-two-disks) is still in the commit path
- [ ] The pod has **two** distinct data volume mounts (PGDATA and WAL), read from
      `.spec.containers[0].volumeMounts`
- [ ] `kubectl get storageclass` still shows `longhorn` as the only default — adding `longhorn-db`
      must not have created a second default

Connectivity:

- [ ] `psql -h pg-meta-rw.database.svc.cluster.local` from a pod in the `airflow` namespace returns
      `\conninfo`. *(False pass: succeeds regardless of NetworkPolicy on a cluster that has none —
      re-run it after a default-deny policy exists.)*
- [ ] Deleting the copied secret in `airflow` makes a **new** connection fail to authenticate — proves
      the application is using that secret and not a cached connection or a hard-coded password

Replication and failover:

- [ ] `pg_stat_replication` on the primary has exactly one row with `state = streaming`
- [ ] A row inserted through `-rw` **before** a node loss is returned by a **new** connection through
      `-rw` **after** it, from the application namespace
- [ ] The pod backing `-rw` after the failover has a different name than the one recorded before
- [ ] A write succeeds against the new primary after failover
- [ ] The former primary rejoins and reaches `streaming` — not `Pending`, not stuck at catch-up
- [ ] Stop the standby deliberately and observe which durability mode you actually configured: with
      `preferred` writes continue, with `required` they block. Confirm by watching it, not by reading
      the YAML — the field only means something once you have seen the behaviour

Backup:

- [ ] `pg_stat_archiver` shows a recent `last_archived_wal`, `failed_count = 0` and an empty
      `last_failed_wal`. *(False pass: a `Backup` object in `Completed` state and a file in the bucket
      say nothing about whether WAL archiving has been failing since.)*
- [ ] **A restored cluster returns the sentinel rows**, and `count(*)` matches the source at backup
      time. Until this has been done once, the backup is an untested assumption and should be
      described that way to whoever is depending on it
- [ ] The restore was performed into a separate `Cluster`, not over the live one
- [ ] The S3 endpoint resolves to something **outside** this cluster — or the gap is recorded
      somewhere a human will read it

---

## Rollback

Nothing here modifies existing cluster components: the operator lives in its own namespace, the
database in `database`, and the new StorageClass does not displace the default.

Remove the database, most destructive step first:

```bash
kubectl -n database delete cluster pg-meta pg-meta-restore
```

```bash
kubectl -n database get pvc
kubectl get pv | grep database
```

**Establish what deleting a `Cluster` does to its PVCs in a throwaway namespace before you need to
know.** This document does not assert an answer, because it has not been run. What it does do is set
`reclaimPolicy: Retain` on `longhorn-db` in step 2, so that even if the PVCs go, the underlying PVs
stay `Released` and the data is recoverable rather than reclaimed. That protection has a cost: those
PVs and their Longhorn volumes persist and consume disk until someone deletes them.

```bash
kubectl delete pv <PV_NAME>                      # only after confirming the data is not wanted
kubectl -n longhorn-system get volumes.longhorn.io
```

The rest:

```bash
kubectl delete -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.14.0/manifest.yaml
helm uninstall cnpg -n cnpg-system
kubectl delete namespace database cnpg-system
kubectl delete storageclass longhorn-db
```

```bash
kubectl get crd | grep -E 'cnpg.io|barmancloud'
```

Removing the operator does **not** remove backups from the object store. That is the correct
behaviour and the reason a restore into a fresh cluster is possible at all.

---

## Failure points documented upstream

Nothing in this list was hit — nothing here has been run. These are the traps the upstream
documentation names, each with the page it came from, all read on 2026-08-16.

**Kubernetes 1.31 is outside the support matrix.** CNPG 1.30 supports 1.34–1.36 and lists 1.31 as
"tested, but not supported"; 1.29 does not cover it either. There is no currently maintained CNPG
release that supports this cluster's Kubernetes version. ([Supported releases](https://cloudnative-pg.io/docs/1.30/supported_releases/))

**Anti-affinity defaults to `preferred`.** Instances co-locate silently when nodes are scarce, and
nothing reports it. ([Scheduling](https://cloudnative-pg.io/docs/1.30/scheduling/))

**Quorum failover can refuse to promote.** With `failoverQuorum` enabled and too few promotable
replicas, the operator declines to fail over rather than risk data loss — the docs' three-instance
example ends with "*failover is not allowed to prevent possible data loss*". ([Failover](https://cloudnative-pg.io/docs/1.30/failover/))

**The primary lease does not fence an isolated primary.** It "*does not fence a primary that has lost
connectivity to the Kubernetes API server but is still running; that is the job of the primary
isolation check*". Relevant on a single-control-plane cluster. ([Failover](https://cloudnative-pg.io/docs/1.30/failover/))

**`dataDurability: required` blocks writes when the only standby is down** — "*no write operations
will be allowed until at least one of the standbys is available again*". On a two-instance cluster
that is one pod restart away. ([Replication](https://cloudnative-pg.io/docs/1.30/replication/))

**Storage-level replicas amplify writes.** "*defining additional replicas at the storage level can
lead to write amplification*" — the default `longhorn` class does exactly that under PostgreSQL's own
replication. ([Storage](https://cloudnative-pg.io/docs/1.30/storage/))

**`walStorage` cannot be removed.** "*Removing `walStorage` isn't supported. Once added, a separate
volume for WALs can't be removed.*" Decide at creation time. ([Storage](https://cloudnative-pg.io/docs/1.30/storage/))

**The in-tree `barmanObjectStore` is deprecated.** Deprecated since 1.26 in favour of the Barman Cloud
Plugin, "*but still the default for backward compatibility*" — so copying an older tutorial gets you a
deprecated path that works. ([Backup](https://cloudnative-pg.io/docs/1.30/backup/))

**The backup plugin needs cert-manager and the operator's namespace.** It requires CNPG 1.26+ and
cert-manager for TLS to the operator, and must be installed in `cnpg-system`. Installing it into the
database namespace produces a plugin that never connects. ([Plugin installation](https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/))

**An unpinned `imageName` picks the major version for you** — "*the latest available minor version of
the latest major version of PostgreSQL when the operator was released*". ([Quickstart](https://cloudnative-pg.io/docs/1.30/quickstart/))

**The `system` operand image variant is deprecated.** It was the one bundling the `barman-cloud`
binaries; with the plugin those live in a sidecar. ([postgres-containers](https://github.com/cloudnative-pg/postgres-containers))

---

## Follow-ups

- [ ] Decide where the S3 target lives. In-cluster MinIO means the database and its backups die
      together, and a MinIO outage becomes a disk-space incident on the primary. Off-cluster endpoint,
      or write the gap down as accepted 📅 2026-08-31
- [ ] Add a `Pooler` (PgBouncer) in front of `pg-meta-rw` before Airflow points at it. Scheduler,
      triggerer, webserver and every worker hold connections; `max_connections: 200` on a 4 GB
      instance is a stopgap, not a plan 📅 2026-09-15
- [ ] Extend [[k8s-node-drain-replace]] with a "this node holds a PostgreSQL primary" branch —
      switchover first, confirm the new primary, then drain. Right now that runbook treats every pod
      as reschedulable, and with `required` anti-affinity on two nodes the evicted instance is not 📅 2026-08-31
- [ ] Benchmark `longhorn-db` (one replica) against `longhorn` (two) with `pgbench` before the
      metadata store is load-bearing. The storage page asks for exactly this and section 0.3 picks a
      side on reasoning alone 📅 2026-09-30

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this targets, and the source of the Kubernetes 1.31.14 that section 0.1 finds outside CloudNativePG's support matrix.
[[schedulable-node-budget]] — the standing decision to keep the control-plane taint, which is what caps this at `instances: 2`. CloudNativePG adds a third failure shape to the table there: silent co-location rather than `Pending` or `degraded`.
[[longhorn-storage-onprem]] — supplies the default StorageClass. Section 2 adds a single-replica class beside it rather than changing it, for the write-amplification reason in 0.3.
[[k8s-node-drain-replace]] — draining a worker now moves a database primary and leaves the cluster with no standby. Read before any maintenance window.
[[cert-manager-onprem]] — a hard prerequisite for the Barman Cloud Plugin, which uses it for TLS to the operator.
[[longhorn-backup-target-onprem]] — the same circularity argument one layer down: a backup target inside the cluster it protects.
[[metallb-l2-onprem]] — only relevant if something outside the cluster must reach this database. Prefer not to; `-rw` is a ClusterIP for good reasons.
