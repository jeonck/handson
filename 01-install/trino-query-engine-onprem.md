---
title: Trino on a 2-node on-prem cluster — SQL over MinIO with Iceberg
date: 2026-08-16
domain: install
tags: [on-prem, analytics, object-storage, lakehouse]
stack: [kubernetes, trino, helm, iceberg, minio, postgresql, ingress-nginx, cert-manager]
summary: A coordinator and exactly one worker on the two schedulable nodes this cluster has, with the Iceberg JDBC catalog so no metastore pod competes for the 4 GB. The trade is a ~300 MB per-node query memory ceiling and no spill — Trino kills the query rather than swapping, and that is the correct behaviour here.
source: handson
env: Kubernetes 1.31.14 (kubeadm) · Calico 3.28.2 · Ubuntu 24.04 · Helm 3.x · Trino Helm chart 1.42.2 (appVersion 480) · MinIO in-cluster · PostgreSQL via CloudNativePG — target nodes 2 vCPU / 4 GB
verified:
duration: 60–90 min
risk: medium
---

> **Not executed. Assembled from official documentation and from the chart and Trino sources, read on
> 2026-08-16.** Nothing below has been run on the cluster it targets, and `verified` is empty because
> of that. What was actually checked, and where:
>
> | Thing | Value found | Source, read 2026-08-16 |
> |---|---|---|
> | Newest `trino` chart | **1.42.2**, `appVersion: "480"`, published `2026-05-01` | [`trinodb.github.io/charts/index.yaml`](https://trinodb.github.io/charts/index.yaml) and [`Chart.yaml` at tag `trino-1.42.2`](https://github.com/trinodb/charts/blob/trino-1.42.2/charts/trino/Chart.yaml) |
> | Newest Trino release | **483**, 17 Jul 2026 (480 was 24 Mar 2026) | [Release notes](https://trino.io/docs/current/release.html) |
> | S3 enable property **for 480** | `fs.native-s3.enabled` | [`object-storage.md` at tag 480](https://github.com/trinodb/trino/blob/480/docs/src/main/sphinx/object-storage.md) |
> | S3 enable property **for 483** | `fs.s3.enabled` | [`object-storage.md` at tag 483](https://github.com/trinodb/trino/blob/483/docs/src/main/sphinx/object-storage.md) |
>
> **The chart trails the release, and the property was renamed in between.** Chart 1.42.2 deploys
> Trino 480, so this document writes `fs.native-s3.enabled`. `trino.io/docs/current` is 483 and says
> `fs.s3.enabled`. No release note for 481, 482 or 483 mentions the rename, so the only reliable check
> is to read the docs *at the tag you are running* — see
> [Failure points documented upstream](#failure-points-documented-upstream). Anything you copy from a
> blog post is a third naming era: `hive.s3.*` was the legacy Hadoop-based support, removed in 481.

Trino is a query engine with no storage of its own. It reads objects out of S3-compatible storage,
gets its table definitions from a catalog, and holds everything else in JVM heap. That last part is
what makes this cluster interesting: Trino's whole performance model assumes heap it can spend, and
[[onprem-3node-kubeadm-ubuntu]] gives it two schedulable nodes of 2 vCPU / 4 GB that already run
other things.

This document stands up Trino against MinIO ([[minio-object-storage-onprem]]) using the Iceberg
connector with a **JDBC catalog** in PostgreSQL ([[postgresql-cnpg-onprem]]), exposes the UI and the
JDBC/HTTP endpoint through the single ingress address, and ends with a query that physically reads
bytes off an object. Out of scope: authentication beyond TLS at the edge, fault-tolerant execution,
Trino Gateway, and any attempt to make this fast.

---

## Capacity — read this before installing

**This is a functional lab, not a capacity target.** The goal is a cluster that plans a query,
distributes splits, reads Parquet from MinIO, and returns correct rows. It is not a cluster that will
run an analytics workload, and no amount of tuning below makes it one.

### Two schedulable nodes, and what fits on them

The control-plane taint is kept by standing decision ([[schedulable-node-budget]]), so:

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

Two untainted nodes. Everything Trino runs must fit in those two, alongside MinIO, PostgreSQL,
ingress-nginx and whatever else already lives there.

| Layout | Pods | Verdict |
|---|---|---|
| Coordinator + 2 workers (chart default `server.workers: 2`) | 3 JVMs on 2 nodes | **No.** Two Trino JVMs land on one 4 GB node and the node runs out of memory. |
| Coordinator + 1 worker, one per node | 2 JVMs on 2 nodes | **This document.** A real coordinator/worker split — the worker joins over the network and is assigned splits, so the distributed path is genuinely exercised. |
| Coordinator only, `node-scheduler.include-coordinator=true` | 1 JVM | The fallback if you drop to one schedulable node. Trino supports it — "a single machine can function as both coordinator and worker" ([node scheduler properties](https://trino.io/docs/480/admin/properties-node-scheduler.html)) — but then nothing proves a worker ever joined, and the verification below loses its sharpest check. |

So: **`server.workers: 1`**, coordinator and worker forced apart by pod anti-affinity. Note the
chart's default is `2`; leaving it alone is the single easiest way to break this install.

### JVM heap, and the arithmetic the chart will not do for you

The chart defaults to an 8 GB heap for both roles. There is no 8 GB here. Dropping the heap is
mandatory — and it is where the chart's other defaults turn into a startup failure, because
`query.maxMemoryPerNode` defaults to a flat `1GB` and does not scale down with the heap.

Trino's documentation states the constraint plainly:

> "The sum of `query.max-memory-per-node` and `memory.heap-headroom-per-node` must be less than the
> maximum heap size in the JVM on the node."
> — [Resource management properties](https://trino.io/docs/480/admin/properties-resource-management.html)

It is enforced at startup, not warned about. `LocalMemoryManager` throws with this message format:

```text
Invalid memory configuration. The sum of max query memory per node (%s) and heap headroom (%s) cannot be larger than the available heap memory (%s)
```

— [`LocalMemoryManager.java` at tag 480](https://github.com/trinodb/trino/blob/480/core/trino-main/src/main/java/io/trino/memory/LocalMemoryManager.java).
That is the format string in the source, not output observed from a run.

Both properties accept a percentage of heap ([`NodeMemoryConfig`](https://github.com/trinodb/trino/blob/480/core/trino-main/src/main/java/io/trino/memory/NodeMemoryConfig.java)
parses `30%`), and both default to 30%. Setting them as percentages instead of the chart's flat `1GB`
makes the arithmetic hold at any heap size, which is why the values file below does that.

| Setting | Value here | Why |
|---|---|---|
| `jvm.maxHeapSize` | `1G` | What is left on a 4 GB node after kubelet, Calico, and MinIO or PostgreSQL |
| `query.max-memory-per-node` | `30%` ≈ 307 MB | Scales with the heap; satisfies the sum rule at 30 + 30 < 100 |
| `memory.heap-headroom-per-node` | `30%` ≈ 307 MB | Explicit, so a chart default change cannot silently break the sum |
| container memory limit | `2Gi` | Heap is not the pod's footprint — see below |

**Do not set the container limit to the heap size.** The chart's `jvm.config` includes
`-XX:ReservedCodeCacheSize=512M`, metaspace and direct buffers are on top of that, and it sets
`-XX:+ExitOnOutOfMemoryError` alongside the `libjvmkill` agent — so a JVM that runs out of memory
exits and the pod restarts, rather than degrading. Reserved address space is not resident memory, but
committed code cache does grow under load. `2Gi` for a `1G` heap is the smallest margin worth trying.

### What will simply fail

With ~307 MB of user memory per node and **spilling off** — `spill-enabled` defaults to `false`
([spilling properties](https://trino.io/docs/480/admin/properties-spilling.html)) — Trino kills a
query rather than swapping. The setting that decides this is **`query.max-memory-per-node`**:
exceeding it fails the query with `EXCEEDED_LOCAL_MEMORY_LIMIT`
([`StandardErrorCode`](https://github.com/trinodb/trino/blob/480/core/trino-spi/src/main/java/io/trino/spi/StandardErrorCode.java)).

That is the right behaviour on this hardware. The alternative — enabling spill — writes to
`spiller-spill-path` on node disks that Longhorn is already using, and upstream warns against
spilling to system drives. Leave it off and accept that:

- Aggregations over a high-cardinality `GROUP BY` fail once the hash table passes ~300 MB on a node.
- Joins fail when the build side does not fit; broadcast joins fail earliest.
- `ORDER BY` over a large result without a `LIMIT` fails.
- Scans, filters, projections, and `LIMIT` queries are fine, because they stream.

TPC-H at `sf1` is a reasonable smoke test. Anything above that is a memory experiment, not a query.

---

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Two schedulable nodes | `kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'` | exactly two rows with no taint |
| Free memory on both | `kubectl top nodes` | ≥ 2 Gi allocatable headroom on each |
| Helm | `helm version --short` | v3.x |
| MinIO reachable in-cluster | `kubectl -n <MINIO_NS> get svc` | a ClusterIP service on port 9000 |
| A bucket for the warehouse | MinIO console or `mc ls` | `<WAREHOUSE_BUCKET>` exists |
| PostgreSQL reachable | `kubectl -n <PG_NS> get cluster` | CNPG cluster healthy, `-rw` service present |
| Ingress controller | `kubectl get ingressclass` | `nginx`, exactly one default — see [[ingress-nginx-onprem]] |
| ClusterIssuer | `kubectl get clusterissuer internal-ca` | `Ready: True` — see [[cert-manager-onprem]] |

---

## 1. Choose the catalog, and understand what you are choosing

Trino needs somewhere to record which tables exist and where their metadata files live. The Iceberg
connector supports `hive_metastore`, `glue`, `rest`, `jdbc`, `nessie`, and `snowflake`
([metastores](https://trino.io/docs/480/object-storage/metastores.html)).

On two 4 GB nodes the decision is made by pod count, not by preference:

- **Hive Metastore (thrift)** — a separate JVM service, no official chart from Trino, and roughly a
  gigabyte of heap this cluster does not have. Rejected on memory.
- **REST catalog** — the option upstream recommends, but it is another deployment plus another
  version to pin, and it needs the same PostgreSQL anyway. Rejected for now; see Follow-ups.
- **JDBC catalog** — Trino talks to PostgreSQL directly. **Zero additional pods.** Chosen.

That choice comes with two warnings from upstream, both worth reading before you commit:

> "The JDBC catalog may have compatibility issues if Iceberg introduces breaking changes in the
> future. Consider the REST catalog as an alternative solution.
>
> The JDBC catalog requires the metadata tables to already exist. Refer to Iceberg repository for
> creating those tables."
> — [metastores.md at tag 480](https://github.com/trinodb/trino/blob/480/docs/src/main/sphinx/object-storage/metastores.md)

The second one is a real, blocking step, and the sources disagree about it — see §3.

Iceberg rather than Hive table format, because Iceberg keeps its own metadata alongside the data in
the bucket and does not need a Hive-shaped directory layout to be maintained by hand.

---

## 2. Namespace, credentials, and the MinIO bucket

Credentials must not go into the catalog file directly. **The chart renders `catalogs:` into a
ConfigMap**, not a Secret — see
[`configmap-catalog.yaml`](https://github.com/trinodb/charts/blob/trino-1.42.2/charts/trino/templates/configmap-catalog.yaml)
— so a secret key written there is readable by anyone with `get configmaps` in the namespace, and it
lands in `helm get values` as well.

Trino substitutes environment variables in properties files with `${ENV:VARIABLE}`
([secrets](https://trino.io/docs/480/security/secrets.html)), and the chart can inject a Secret into
every pod via `envFrom`. Use both.

```bash
kubectl create namespace trino
```

```bash
kubectl -n trino create secret generic trino-catalog-secrets \
  --from-literal=S3_ACCESS_KEY='<REDACTED>' \
  --from-literal=S3_SECRET_KEY='<REDACTED>' \
  --from-literal=PG_PASSWORD='<REDACTED>'
```

The keys become environment variable names verbatim, which is why they are named the way the catalog
file below references them.

Create the warehouse bucket in MinIO if [[minio-object-storage-onprem]] has not already, and use a
MinIO user scoped to that bucket rather than the root credentials — the root key can delete every
bucket on the instance, and Trino only needs one.

---

## 3. Bootstrap the Iceberg catalog tables in PostgreSQL

Create a database and a role for the catalog on the CNPG cluster:

```sql
CREATE DATABASE iceberg_catalog;
CREATE ROLE trino LOGIN PASSWORD '<REDACTED>';
GRANT ALL PRIVILEGES ON DATABASE iceberg_catalog TO trino;
```

> **The sources disagree about whether the metadata tables are created for you. Resolve this before
> you trust the install.**
>
> Trino's documentation says the tables must already exist (quoted in §1). But reading the code,
> [`TrinoJdbcCatalogFactory`](https://github.com/trinodb/trino/blob/480/plugin/trino-iceberg/src/main/java/io/trino/plugin/iceberg/catalog/jdbc/TrinoJdbcCatalogFactory.java)
> calls `jdbcCatalog.initialize(...)` on Iceberg's own `JdbcCatalog`, which has table-initialization
> behaviour of its own. Meanwhile
> [`IcebergJdbcClient`](https://github.com/trinodb/trino/blob/480/plugin/trino-iceberg/src/main/java/io/trino/plugin/iceberg/catalog/jdbc/IcebergJdbcClient.java)
> — the path used for table operations — only ever issues `INSERT INTO iceberg_tables`, `UPDATE
> iceberg_tables`, and `SELECT ... FROM iceberg_tables`. It never creates anything.
>
> **This has not been run, so treat it as a fork in the procedure**, not as settled. Do the `CREATE
> SCHEMA` in §6 first; if it fails with a missing-relation error naming `iceberg_tables`, the
> documentation is right and you must create the tables yourself.

If you do have to create them, the canonical definition lives in Iceberg's `JdbcUtil` in the
[apache/iceberg](https://github.com/apache/iceberg) repository — take it from there rather than from
here, because getting the key constraints wrong produces a catalog that appears to work and then
loses commits under concurrency. For cross-checking, these are the columns Trino's client reads and
writes at `schema-version` `V1`, read from `IcebergJdbcClient.java` above:

- `iceberg_tables`: `catalog_name`, `table_namespace`, `table_name`, `metadata_location`,
  `previous_metadata_location`, `iceberg_type`

`V0` is the same set without `iceberg_type`; `V1` is the default
([`IcebergJdbcCatalogConfig`](https://github.com/trinodb/trino/blob/480/plugin/trino-iceberg/src/main/java/io/trino/plugin/iceberg/catalog/jdbc/IcebergJdbcCatalogConfig.java)).
Namespace state is handled by Iceberg's `JdbcCatalog`, not by Trino's client, so its tables come from
the same upstream definition.

Confirm what actually exists before moving on:

```bash
kubectl -n <PG_NS> exec -it <PG_CLUSTER>-1 -- psql -d iceberg_catalog -c '\dt'
```

---

## 4. Install Trino

```bash
helm repo add trino https://trinodb.github.io/charts
helm repo update trino
helm search repo trino/trino --versions | head -5
```

Confirm the chart version and its `APP VERSION` column before installing — the property names in the
catalog file below are tied to Trino 480, and a newer chart may ship 483, where `fs.native-s3.enabled`
is spelled `fs.s3.enabled`.

```yaml title="values-trino.yaml"
image:
  # Pinned explicitly. Chart 1.42.2 defaults to appVersion 480; leaving tag empty
  # means a chart bump silently changes the Trino version and the S3 property names.
  tag: "480"

server:
  # NOT the chart default of 2. Two workers plus a coordinator do not fit on two
  # 4 GB nodes. See the capacity section.
  workers: 1
  config:
    query:
      maxMemory: "1GB"

# TLS terminates at ingress-nginx, so Trino must trust the forwarded headers or it
# builds self-referential URLs on http:// and the UI breaks after the first redirect.
additionalConfigProperties:
  - http-server.process-forwarded=true

# Credentials come from the Secret created in step 2, never from the catalog
# ConfigMap. Injected into both coordinator and worker pods.
envFrom:
  - secretRef:
      name: trino-catalog-secrets

coordinator:
  jvm:
    maxHeapSize: "1G"
  config:
    # Left false: the worker below is what proves the distributed path works.
    nodeScheduler:
      includeCoordinator: false
    query:
      # Percentages, not the chart's flat 1GB, so the sum rule holds at this heap.
      maxMemoryPerNode: "30%"
    memory:
      heapHeadroomPerNode: "30%"
  resources:
    requests:
      cpu: "500m"
      memory: "1600Mi"
    limits:
      # No CPU limit on purpose — a hard limit throttles the JVM mid-query.
      memory: "2Gi"

worker:
  jvm:
    maxHeapSize: "1G"
  config:
    query:
      maxMemoryPerNode: "30%"
    memory:
      heapHeadroomPerNode: "30%"
  resources:
    requests:
      cpu: "500m"
      memory: "1600Mi"
    limits:
      memory: "2Gi"
  # Keep the worker off the coordinator's node. Both are Deployments, so without
  # this the scheduler is free to stack them and the 4 GB node loses.
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: trino
              app.kubernetes.io/instance: trino

catalogs:
  # tpch/tpcds are the chart defaults and are kept deliberately: they let you prove
  # the coordinator/worker split works before MinIO or PostgreSQL are in the picture.
  tpch: |
    connector.name=tpch
    tpch.splits-per-node=4
  lake: |
    connector.name=iceberg
    iceberg.catalog.type=jdbc
    iceberg.jdbc-catalog.catalog-name=lake
    iceberg.jdbc-catalog.driver-class=org.postgresql.Driver
    iceberg.jdbc-catalog.connection-url=jdbc:postgresql://<PG_RW_SERVICE>.<PG_NS>.svc.cluster.local:5432/iceberg_catalog
    iceberg.jdbc-catalog.connection-user=trino
    iceberg.jdbc-catalog.connection-password=${ENV:PG_PASSWORD}
    iceberg.jdbc-catalog.default-warehouse-dir=s3://<WAREHOUSE_BUCKET>/warehouse
    # Trino 480 spelling. On 483+ this key is fs.s3.enabled.
    fs.native-s3.enabled=true
    s3.endpoint=https://<MINIO_SERVICE>.<MINIO_NS>.svc.cluster.local:9000
    s3.region=us-east-1
    s3.path-style-access=true
    s3.aws-access-key=${ENV:S3_ACCESS_KEY}
    s3.aws-secret-key=${ENV:S3_SECRET_KEY}

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: internal-ca
  hosts:
    - host: trino.apps.<DOMAIN>
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: trino-tls
      hosts:
        - trino.apps.<DOMAIN>
```

Notes on the catalog block, each tied to a source read on 2026-08-16:

- `s3.path-style-access=true` — MinIO is addressed by path, not by virtual host. Upstream states that
  of S3-compatible systems, "only AWS S3 and MinIO are tested for compatibility"
  ([S3 file system support](https://trino.io/docs/480/object-storage/file-system-s3.html)), and lists
  `s3.path-style-access` as the property for this.
- `s3.region` — not marked required in the docs, but the AWS SDK underneath wants one. `us-east-1` is
  the conventional filler for MinIO. If the pod logs complain about a missing region, this is why it
  is here.
- `s3.endpoint` takes a full URL including scheme. The migration table from the legacy properties
  notes explicitly that moving from `hive.s3.endpoint` requires adding the `https://` prefix — the
  same applies to `http://` for an in-cluster MinIO without TLS.
- `${ENV:...}` resolves from the `envFrom` Secret, so what lands in the ConfigMap is the literal
  string `${ENV:PG_PASSWORD}`.

```bash
helm install trino trino/trino \
  --namespace trino \
  --version 1.42.2 \
  -f values-trino.yaml \
  --wait --timeout 10m
```

```bash
kubectl -n trino get pods -o wide
```

Two pods, on two different nodes, `1/1`. A coordinator stuck in `CrashLoopBackOff` on first start is
most likely the memory arithmetic — check for the `Invalid memory configuration` message quoted in
the capacity section:

```bash
kubectl -n trino logs deploy/trino-coordinator | head -50
```

---

## 5. Reach the UI and the JDBC endpoint

They are the same endpoint. Trino's UI, its REST API, and the JDBC driver all speak HTTP on the
coordinator's port 8080, which the chart's Service exposes and the Ingress fronts.

```bash
kubectl -n trino get ingress
kubectl -n trino get certificate
```

The `ADDRESS` column must fill in with `<INGRESS_IP>`; an empty one after a minute is a class
mismatch, not slowness ([[ingress-nginx-onprem]]). The Certificate must reach `Ready: True`
([[cert-manager-onprem]]).

The UI is then at `https://trino.apps.<DOMAIN>/ui/`, and the JDBC URL follows
`jdbc:trino://host:port/catalog/schema` ([JDBC driver](https://trino.io/docs/480/client/jdbc.html)):

```text
jdbc:trino://trino.apps.<DOMAIN>:443/lake/default?SSL=true
```

Two things about that URL. The port is required unless the endpoint is on the default 443 with
`SSL=true`, which it is here — so it may be omitted, and is written above only for clarity. And the
internal CA root from [[cert-manager-onprem]] must be in the client's trust store, or the driver
fails the handshake; a JDBC client is not a browser and will not offer to continue.

> **Anyone who reaches this URL can run any query as any user.** `server.config.authenticationType`
> is unset, which means no authentication at all — Trino accepts whatever username the client sends.
> The ingress makes that reachable from the whole LAN. Do not leave it there; see Follow-ups.

For a look without exposing anything, port-forward instead:

```bash
kubectl -n trino port-forward svc/trino 8080:8080
```

---

## 6. Run a query that reads an object

Use the CLI inside the coordinator pod, which avoids the client-side CA question entirely while you
are still proving the engine works:

```bash
kubectl -n trino exec -it deploy/trino-coordinator -- trino
```

### 6.1 Prove the cluster before touching storage

```sql
SELECT node_id, coordinator, state, node_version FROM system.runtime.nodes;
```

Two rows. One with `coordinator = true`, one with `coordinator = false`, both `state = active`. One
row means the worker never joined — the pod may be `1/1` and still not be in the cluster, because
readiness does not depend on discovery registration.

```sql
SELECT count(*) FROM tpch.sf1.lineitem;
```

This uses the built-in generator, no storage involved. If it fails, the problem is memory or
discovery, not MinIO.

### 6.2 Create a table and write an object

```sql
CREATE SCHEMA lake.demo;
```

**This is the step §3 warned about.** A missing-relation error naming `iceberg_tables` here means the
catalog tables were not auto-created and you must go back and create them.

```sql
CREATE TABLE lake.demo.orders_small AS
SELECT orderkey, custkey, orderstatus, totalprice, orderdate
FROM tpch.sf1.orders
WHERE orderdate < DATE '1992-02-01';
```

A narrow, date-filtered slice on purpose — `sf1.orders` in full is a memory experiment on a 307 MB
per-node budget, not a smoke test.

Confirm objects actually exist in the bucket, from MinIO's side rather than Trino's:

```bash
mc ls --recursive <ALIAS>/<WAREHOUSE_BUCKET>/warehouse/demo/orders_small/
```

Expect both a `data/` prefix with Parquet files and a `metadata/` prefix with Iceberg's JSON and Avro
manifests. Metadata with no data files means the write failed after the commit.

### 6.3 Prove a worker read the bytes

Restart the coordinator first, so nothing is served from a cache warmed by the write:

```bash
kubectl -n trino rollout restart deploy/trino-coordinator
kubectl -n trino rollout status deploy/trino-coordinator --timeout=300s
```

Then, in a fresh CLI session:

```sql
SELECT orderstatus, count(*), sum(totalprice)
FROM lake.demo.orders_small
GROUP BY orderstatus;
```

Rows returned here came out of objects in MinIO. Now show which node did the reading:

```sql
SELECT query_id, query FROM system.runtime.queries ORDER BY created DESC LIMIT 5;
```

```sql
SELECT t.node_id, n.coordinator, t.splits, t.physical_input_bytes
FROM system.runtime.tasks t
JOIN system.runtime.nodes n ON t.node_id = n.node_id
WHERE t.query_id = '<QUERY_ID>';
```

Column names are from
[`TaskSystemTable`](https://github.com/trinodb/trino/blob/480/core/trino-main/src/main/java/io/trino/connector/system/TaskSystemTable.java)
and
[`NodeSystemTable`](https://github.com/trinodb/trino/blob/480/core/trino-main/src/main/java/io/trino/connector/system/NodeSystemTable.java)
at tag 480.

What proves the install: **at least one row with `coordinator = false`, `splits > 0`, and
`physical_input_bytes > 0`.** That is the worker, not the coordinator, having been assigned split
work and having pulled bytes over the network from MinIO. A result set alone proves none of it.

---

## Verification checklist

Each of these fails on a specific, realistic breakage. Where a check has a known false pass, it says
so.

- [ ] `kubectl get nodes` with the taint column shows exactly **two** untainted nodes, and
      `server.workers` in your values is `1`, not the chart's default `2`
- [ ] `kubectl -n trino get pods -o wide` — coordinator and worker both `1/1`, **on different nodes**.
      Same node means the anti-affinity block did not apply and one node is carrying two JVMs
- [ ] `kubectl -n trino logs deploy/trino-coordinator | grep -i "Invalid memory configuration"` returns
      nothing — the heap-headroom sum rule holds at the heap size you set
- [ ] `SELECT node_id, coordinator, state FROM system.runtime.nodes` returns **two** rows, one with
      `coordinator = false`, both `state = active`.
      *Known false pass:* the worker pod reaching `1/1` proves only that its HTTP port answers.
      Readiness does not depend on having registered with discovery, so a worker can be `Running`,
      `Ready`, and absent from this table
- [ ] `SELECT count(*) FROM tpch.sf1.lineitem` returns a count — engine and split distribution work
      independently of storage
- [ ] `CREATE SCHEMA lake.demo` succeeds without a missing-relation error naming `iceberg_tables`
- [ ] `mc ls --recursive <ALIAS>/<WAREHOUSE_BUCKET>/warehouse/demo/orders_small/` lists files under
      **both** `data/` and `metadata/`. Metadata only means the commit landed in PostgreSQL while the
      write to MinIO did not, which leaves a table that exists and cannot be read
- [ ] After `rollout restart` of the coordinator, the `GROUP BY` over `lake.demo.orders_small`
      returns rows, and those rows match the `WHERE orderdate < DATE '1992-02-01'` slice.
      *Known false pass:* `SHOW CATALOGS` and `SHOW SCHEMAS` list a catalog whose credentials or
      endpoint are wrong. Catalog configuration is not validated at startup — the first failure
      appears on the first read, which is why nothing short of returned rows counts here
- [ ] `system.runtime.tasks` joined to `system.runtime.nodes` for that query has at least one row with
      `coordinator = false`, `splits > 0`, and `physical_input_bytes > 0`
- [ ] Deliberately break it and watch the check fail: patch `s3.endpoint` in the catalog ConfigMap to a
      wrong port, restart both pods, and confirm `SHOW SCHEMAS FROM lake` still succeeds while the
      `SELECT` fails. Restore afterwards. This is the false pass above, made visible
- [ ] `kubectl -n trino get configmap trino-catalog -o yaml` contains the literal string
      `${ENV:S3_SECRET_KEY}` and **no** secret value
- [ ] `kubectl -n trino get ingress` shows `<INGRESS_IP>` in `ADDRESS`, and
      `kubectl -n trino get certificate` shows `trino-tls` `Ready: True`
- [ ] `curl -sI https://trino.apps.<DOMAIN>/ui/ --cacert internal-ca.crt` returns a 2xx or 3xx, and the
      same request without `--cacert` fails on certificate verification
- [ ] A query deliberately over the memory ceiling — for example an unbounded `ORDER BY` over
      `tpch.sf1.lineitem` — fails with `EXCEEDED_LOCAL_MEMORY_LIMIT` and **the worker pod does not
      restart**. `kubectl -n trino get pods` restart count unchanged. A restart instead of a clean
      query failure means memory is being used outside what Trino tracks

---

## Rollback

Trino holds no state of its own. The data in MinIO and the catalog rows in PostgreSQL outlive it,
which makes removal safe and re-installation cheap.

```bash
helm uninstall trino -n trino
kubectl delete namespace trino
```

Abort criteria — points at which to stop rather than push on:

- **The coordinator will not start after two heap adjustments.** The node does not have the memory.
  Adding a machine is the fix; further tuning is not.
- **§3 needs manual table creation and you are unsure of the schema.** Stop and switch to a REST
  catalog rather than hand-building tables whose constraints you have not verified. A wrong
  `iceberg_tables` definition corrupts commits under concurrency instead of failing loudly.
- **The worker never appears in `system.runtime.nodes`.** Two nodes with one worker is the smallest
  configuration that proves anything; without it there is nothing to verify.

To drop the lakehouse contents as well — irreversible, and independent of the Helm release:

```sql
DROP TABLE lake.demo.orders_small;
DROP SCHEMA lake.demo;
```

Removing the catalog database on the PostgreSQL side leaves orphaned objects in MinIO with no
pointer to them. Drop the tables through Trino first, or clear the bucket prefix separately.

---

## Where this bit us

Nothing yet — this document has not been run. Every trap below is cited to upstream documentation or
source rather than to experience, and `verified` stays empty until someone follows it end to end and
writes what actually happened here.

## Failure points documented upstream

**The S3 enable property was renamed between the release the chart ships and the release the current
docs describe.** Trino 480 uses `fs.native-s3.enabled`; Trino 483 uses `fs.s3.enabled`. No release
note for 481, 482 or 483 announces it, so `trino.io/docs/current` will disagree with whatever the
chart deployed unless you read the docs at your tag. A wrong key here means native S3 is simply never
activated. ([object-storage.md at 480](https://github.com/trinodb/trino/blob/480/docs/src/main/sphinx/object-storage.md) vs [at 483](https://github.com/trinodb/trino/blob/483/docs/src/main/sphinx/object-storage.md))

**`hive.s3.*` properties from older blog posts do nothing.** That was the legacy Hadoop-based support,
deprecated in 470 and removed in 481. The migration table maps every old name to its native
equivalent and notes that `hive.s3.endpoint` values need a scheme prefix once moved.
([S3 file system support](https://trino.io/docs/480/object-storage/file-system-s3.html), [Release 481](https://trino.io/docs/current/release/release-481.html))

**`query.max-memory-per-node` plus `memory.heap-headroom-per-node` above the heap is a startup
failure, not a warning.** The chart's flat `1GB` default for the first does not scale down when you
lower `maxHeapSize`, so shrinking the heap for a small cluster is exactly the change that triggers it.
([Resource management properties](https://trino.io/docs/480/admin/properties-resource-management.html), [`LocalMemoryManager.java`](https://github.com/trinodb/trino/blob/480/core/trino-main/src/main/java/io/trino/memory/LocalMemoryManager.java))

**Spilling is off by default, so a query over the per-node limit is killed rather than slowed.**
`spill-enabled` defaults to `false`, and the resulting error is `EXCEEDED_LOCAL_MEMORY_LIMIT`.
Enabling spill is not a free fix here — upstream warns against spilling to system drives, and these
nodes have no spare ones. ([Spilling properties](https://trino.io/docs/480/admin/properties-spilling.html))

**Behind a TLS-terminating proxy, Trino needs `http-server.process-forwarded=true`.** Without it Trino
does not process `X-Forwarded-*` headers, and upstream states the config properties file "*must*"
include the property for a load-balanced HTTPS setup. The symptom is a UI that works until the first
redirect. ([TLS and HTTPS](https://trino.io/docs/480/security/tls.html))

**The Iceberg JDBC catalog requires its metadata tables to exist, and upstream recommends REST
instead.** Both warnings are in the same block of the metastores documentation. Trino's own client
only ever inserts into `iceberg_tables`; it never creates it.
([metastores.md at 480](https://github.com/trinodb/trino/blob/480/docs/src/main/sphinx/object-storage/metastores.md), [`IcebergJdbcClient.java`](https://github.com/trinodb/trino/blob/480/plugin/trino-iceberg/src/main/java/io/trino/plugin/iceberg/catalog/jdbc/IcebergJdbcClient.java))

**Catalog properties land in a ConfigMap, not a Secret.** Anything written literally into `catalogs:`
is world-readable within the namespace and shows up in `helm get values`. `${ENV:VARIABLE}` plus
`envFrom` is the documented way out.
([`configmap-catalog.yaml`](https://github.com/trinodb/charts/blob/trino-1.42.2/charts/trino/templates/configmap-catalog.yaml), [Secrets](https://trino.io/docs/480/security/secrets.html))

**`server.workers` defaults to 2.** On two schedulable nodes that is three Trino JVMs for two
machines. ([values.yaml at trino-1.42.2](https://github.com/trinodb/charts/blob/trino-1.42.2/charts/trino/values.yaml))

**A JVM out-of-memory exits the process rather than degrading.** The chart's `jvm.config` sets
`-XX:+ExitOnOutOfMemoryError` and loads the `libjvmkill` agent, so an under-sized container limit
turns into pod restarts mid-query instead of slow queries. ([configmap-coordinator.yaml](https://github.com/trinodb/charts/blob/trino-1.42.2/charts/trino/templates/configmap-coordinator.yaml))

---

## Follow-ups

- [ ] Put authentication in front of the coordinator before anyone else is told the URL — the chart's
      `auth.passwordAuth` with a password file is the smallest option, and `server.config.authenticationType`
      must be set alongside it 📅 2026-08-23
- [ ] Re-check the S3 property spelling when chart 1.42.2 is superseded by one shipping Trino 483 or
      later, and update the `lake` catalog block in the same commit as the chart bump 📅 2026-09-15
- [ ] Replace the JDBC catalog with a REST catalog against the same PostgreSQL once there is memory
      headroom for one more pod — upstream recommends it, and it removes the manual table bootstrap in
      §3 entirely. Decide against [[schedulable-node-budget]] first, since it is another pod on the
      same two nodes 📅 2026-10-01
- [ ] Reconcile §2 and §3 against [[minio-object-storage-onprem]] and [[postgresql-cnpg-onprem]] —
      both were written the same day as this and both are also unrun, so three unverified documents
      currently agree with each other on paper and nowhere else. Run the storage and database ones
      first; this one cannot be followed before they are 📅 2026-08-30

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster underneath. Its node count and its control-plane taint decision are what force the single-worker layout above.
[[schedulable-node-budget]] — Trino wants two nodes' worth of memory on a cluster that has two nodes total. This is where that competition gets settled rather than re-argued per add-on.
[[minio-object-storage-onprem]] — the object storage this reads from. §2 assumes a bucket and a scoped user created there, and its standalone-on-Longhorn layout is what `s3.path-style-access` above is talking to.
[[postgresql-cnpg-onprem]] — holds the Iceberg JDBC catalog. §3 assumes the `-rw` service of a healthy CNPG cluster from it, and its own memory budget is competing with Trino's on the same two nodes.
[[ingress-nginx-onprem]] — the single LAN address the UI and the JDBC endpoint arrive on, and the source of the `nginx` IngressClass used above.
[[cert-manager-onprem]] — issues `trino-tls` from the internal CA. Its root must be in the trust store of any JDBC client, which is a step browsers let you skip and drivers do not.
[[longhorn-storage-onprem]] — why spilling to node disks is not the easy answer to the memory ceiling; those disks are already committed.
