---
title: Point a workload at the cluster's S3 endpoint — Garage, not MinIO
date: 2026-11-02
domain: runbook
tags: [on-prem, storage, object-storage, s3, data-platform]
stack: [kubernetes, garage, minio, trino, spark, cloudnative-pg, airflow]
summary: Four install documents wire their S3 client against MinIO, written before the cluster's S3 decision changed to Garage on 2026-08-16. This runbook is the one substitution each of them needs — scheme, host:port, and credential source — done the same way everywhere, so it stops being re-derived per consumer and getting three of the four details right.
source: standardize
env:
verified:
duration: 60–90 min total, 15–25 min per consumer
risk: medium
---

> ⚠️ This runbook was synthesized from [[minio-object-storage-onprem]], [[garage-object-storage-onprem]],
> [[trino-query-engine-onprem]], [[spark-on-k8s-onprem]], [[postgresql-cnpg-onprem]] and
> [[airflow-orchestration-onprem]]. **Nobody has executed it in this order yet** — Garage itself is
> only partly verified ([[garage-object-storage-onprem]] ran on kind's local-path provisioner, not
> Longhorn), and none of the four consumers below has been pointed at Garage even once. Fill in
> `verified` after the first real run, against Longhorn, not kind.

Run this once per workload, any time a document still shows a MinIO-shaped S3 client block:
`https://`, a `.minio.` hostname, port `9000`, or a credential created with `mc`. That block was
correct for the MinIO-shaped endpoint design it was written against, and it is now wrong in three
ways at once against the endpoint actually running.

## Why this is its own procedure

[[s3-object-storage-options]] decided the cluster's S3 endpoint is Garage, not MinIO, on
**2026-08-16** — the same day three of the four consumer documents below were written against MinIO.
[[garage-object-storage-onprem]] itself carries the open follow-up: *"Re-point the four consumers at
this endpoint once it exists... currently carry `https://` and a CA-trust requirement written for
MinIO, which Garage does not need in-cluster"*, dated **2026-08-30** and still unchecked as of the
2026-11-01 weekly review — 64 days late and growing, because it is one fact that has to be re-derived
four times rather than looked up once.

The two designs disagree on three things at once, not one, which is why a find-and-replace on the
hostname alone still leaves a broken client:

| Property | MinIO-shaped (written into all four, 2026-08-16) | Garage-shaped (the endpoint actually running) |
|---|---|---|
| Scheme | `https://` — MinIO terminates TLS on 9000 and has **no plaintext port** once the certificate is installed (§5.3 of [[minio-object-storage-onprem]]) | plain `http://` — Garage **terminates no TLS at all** in-cluster; the reverse-proxy cookbook's own words are "the main reason to add a reverse proxy in front of Garage is to provide TLS to your users", and that proxy is the off-cluster ingress path, not this one |
| Host : port | `<service>.<minio-ns>.svc.cluster.local:9000` | `<service>.<garage-ns>.svc.cluster.local:3900` — confirm both the Service name and the port from the live chart, same caveat [[garage-object-storage-onprem]] §6 gives for its own install: the port is "one value here most likely to differ" |
| CA trust | required — the internal CA has to be in the client's truststore/connection extra, or the handshake fails `PKIX path building failed` ([[spark-on-k8s-onprem]] §4.3) or the operator's barman-cloud trust setting has to carry it ([[postgresql-cnpg-onprem]] §3) | **not needed in-cluster.** Dropping it is not a shortcut, it is the endpoint having nothing to trust |
| Credential issuance | `mc admin user add` + `mc admin policy create/attach` against a JSON bucket policy ([[minio-object-storage-onprem]] §6) | `garage key create <KEY_NAME>` + `garage bucket allow --read --write <BUCKET> --key <KEY_NAME>` — **Garage has no bucket-policy endpoints at all**; a procedure written against `PutBucketPolicy` cannot be re-pointed, only rewritten ([[garage-object-storage-onprem]] §7, [[s3-object-storage-options]] §API-coverage) |

Everything else — path-style addressing, the shape of a Kubernetes Secret holding an access key and
secret, the S3A/JDBC/connection-extra property names each runtime uses — carries over unchanged. The
four properties above are the whole substitution.

---

## Pre-checks

### 1. Garage is actually up and has the names you are about to use

```bash
kubectl -n garage get statefulset,pod,svc
```

Confirm the Service name and the port carrying the S3 API (3900 on the 2026-08-17 run, in a release
named `garage` in a namespace named `garage` — do not assume those are this cluster's names):

```bash
kubectl -n garage get svc -o wide
```

### 2. The layout was applied, not merely assigned

```bash
kubectl exec -n garage garage-0 -- ./garage layout show
```

A node with no role assigned stores nothing while answering every other check as healthy — see
[[garage-object-storage-onprem]] §5. Do not proceed past this check with a `NO ROLE ASSIGNED` node.

### 3. A bucket and a key exist for the workload you are re-pointing

```bash
kubectl exec -n garage garage-0 -- ./garage bucket list
kubectl exec -n garage garage-0 -- ./garage key list
```

If not, create them per [[garage-object-storage-onprem]] §7 before touching the consumer — this
runbook rewires a client, it does not provision storage.

---

## Execution

### Step 1 — Trino's Iceberg catalog (reversible)

Current state, [[trino-query-engine-onprem]] catalog block:

```text
s3.endpoint=https://<MINIO_SERVICE>.<MINIO_NS>.svc.cluster.local:9000
```

Replace with:

```text
s3.endpoint=http://<GARAGE_SERVICE>.<GARAGE_NS>.svc.cluster.local:3900
s3.region=us-east-1
s3.path-style-access=true
s3.aws-access-key=${ENV:S3_ACCESS_KEY}
s3.aws-secret-key=${ENV:S3_SECRET_KEY}
```

`s3.path-style-access=true` and the `${ENV:...}` indirection are unchanged — both are properties of
the Trino S3 filesystem client, not of which S3-compatible server is on the other end.
`s3.region=us-east-1` is carried over as the same filler value; **not confirmed that Garage needs
it at all** — see Follow-ups.

```bash
kubectl -n trino rollout restart deployment
kubectl -n trino get pods -o wide
```

Rollback: revert the ConfigMap edit and roll out again. Nothing was destroyed; Trino only lost its
ability to read/write the lake catalog for the duration.

### Step 2 — Spark's S3A settings (reversible)

Current state, [[spark-on-k8s-onprem]] §4.3:

```yaml
sparkConf:
  spark.hadoop.fs.s3a.endpoint: "https://minio.minio.svc.cluster.local:9000"
  spark.hadoop.fs.s3a.path.style.access: "true"
  spark.hadoop.fs.s3a.connection.ssl.enabled: "true"
  spark.hadoop.fs.s3a.aws.credentials.provider: "org.apache.hadoop.fs.s3a.auth.EnvironmentVariableCredentialsProvider"
```

Replace with:

```yaml
sparkConf:
  spark.hadoop.fs.s3a.endpoint: "http://<GARAGE_SERVICE>.<GARAGE_NS>.svc.cluster.local:3900"
  spark.hadoop.fs.s3a.path.style.access: "true"
  spark.hadoop.fs.s3a.connection.ssl.enabled: "false"
  spark.hadoop.fs.s3a.aws.credentials.provider: "org.apache.hadoop.fs.s3a.auth.EnvironmentVariableCredentialsProvider"
  spark.hadoop.fs.s3a.committer.name: "directory"
```

`path.style.access` stays `true` for the same reason it did against MinIO — Garage's S3 API is
path-style too. Dropping `connection.ssl.enabled` to `false` removes the one step
[[spark-on-k8s-onprem]] §4.3 itself called *"the step most likely to be wrong on the first
attempt"* — baking the internal CA into the executor image's Java truststore. That step is no
longer needed for this endpoint; it is **not removed from the custom-image follow-up entirely**,
because `hadoop-aws` and the AWS SDK bundle still have to be baked in for S3A to load at all (see
[[spark-on-k8s-onprem]] §4.1 and its own follow-up, unrelated to TLS).

[[garage-object-storage-onprem]]'s own checklist has an item **confirmed on 2026-08-17** that this
substitution depends on: a 32 MiB multipart upload round-tripped through `create-multipart-upload` /
`upload-part` / `complete-multipart-upload`. The `directory` committer Spark uses for S3A writes
depends on exactly that path, and unlike MinIO it has been watched work against this endpoint —
on kind's local-path provisioner, not yet Longhorn.

```bash
kubectl -n spark-jobs create secret generic garage-credentials \
  --from-literal=AWS_ACCESS_KEY_ID='<REDACTED>' \
  --from-literal=AWS_SECRET_ACCESS_KEY='<REDACTED>'
```

Issue that access key with `garage key create` / `garage bucket allow`, not `mc` — see Pre-check 3.
Rename the `envFrom` reference in the `SparkApplication` CR from `minio-credentials` to
`garage-credentials` at the same time, or the Secret exists and nothing points at it.

Rollback: revert `sparkConf` and the `envFrom` name; resubmit the smoke-test job from
[[spark-on-k8s-onprem]] §5 before trusting a real one.

### Step 3 — PostgreSQL's barman-cloud `ObjectStore` (not reversible mid-backup-window)

Current state, [[postgresql-cnpg-onprem]] §3:

```yaml
spec:
  configuration:
    destinationPath: s3://<BUCKET>/
    endpointURL: https://minio.<MINIO_NS>.svc.cluster.local:9000
```

Replace with:

```yaml
spec:
  configuration:
    destinationPath: s3://<BUCKET>/
    endpointURL: http://<GARAGE_SERVICE>.<GARAGE_NS>.svc.cluster.local:3900
```

[[postgresql-cnpg-onprem]] §3 never named the actual field for the CA trust setting it said the
MinIO endpoint would need — it was left as "the operator needs the internal CA in
`.spec.backup.barmanObjectStore` trust settings" with no field name, because nothing was run. Moving
to plain HTTP removes the need to ever find that field. That is a simplification, not a loss.

```bash
kubectl -n database create secret generic pg-backup-s3-garage \
  --from-literal=ACCESS_KEY_ID='<REDACTED>' \
  --from-literal=ACCESS_SECRET_KEY='<REDACTED>'
kubectl apply -f pg-objectstore.yaml
kubectl -n database get objectstore pg-meta-store
```

**Do this only outside an active backup or WAL-archiving window.** An `ObjectStore` mid-edit is a
database whose WAL archiving target just changed; confirm the previous target's last successful
archive before cutting over, not after.

Rollback: re-apply the previous `pg-objectstore.yaml` with the MinIO endpoint. The barman-cloud
plugin re-reads the `ObjectStore` on each reconcile; nothing is destroyed by reverting the YAML,
but any backup taken against the Garage endpoint in between stays wherever that endpoint put it.

### Step 4 — Airflow's connection (reversible)

Current state, [[airflow-orchestration-onprem]] §5:

```bash
kubectl -n airflow create secret generic airflow-connections \
  --from-literal=AIRFLOW_CONN_MINIO_DEFAULT='aws://<ACCESS_KEY>:<REDACTED>@?endpoint_url=https%3A%2F%2F<MINIO_SVC>.<MINIO_NS>.svc.cluster.local%3A9000&region_name=us-east-1'
```

Replace with:

```bash
kubectl -n airflow create secret generic airflow-connections \
  --from-literal=AIRFLOW_CONN_GARAGE_DEFAULT='aws://<ACCESS_KEY>:<REDACTED>@?endpoint_url=http%3A%2F%2F<GARAGE_SVC>.<GARAGE_NS>.svc.cluster.local%3A3900&region_name=us-east-1'
```

The connection ID changes too (`minio_default` → `garage_default`), which means every reference to
it has to move with it, not just the endpoint: `remote_log_conn_id` in the values file
([[airflow-orchestration-onprem]] §6) and the `ObjectStoragePath("s3://minio_default@<BUCKET>")`
line in the smoke-test DAG ([[airflow-orchestration-onprem]] §8). A rename that only touches the
Secret leaves both of those pointed at a connection ID that no longer exists, which fails at DAG
parse time, not at endpoint-connect time — a different, more confusing error than the one this
runbook is trying to prevent.

Rollback: re-create the Secret under the old key and name and revert the two in-DAG/values
references. Logging already written under the old connection ID is unaffected either way.

---

## Abort criteria (any one of these — stop immediately)

- Pre-check 2 (`garage layout show`) reports no committed layout version. Nothing downstream of this
  runbook can be verified against an endpoint that stores nothing.
- The Service/port confirmed in Pre-check 1 does not match `3900`, and you cannot explain why — the
  2026-08-17 run is one data point, not a guarantee for every install of this chart.
- Step 3 is about to run during an active backup or while a base backup is in flight. Finish or
  cancel it first; see [[postgresql-cnpg-onprem]] for what an interrupted `barman-cloud-backup`
  leaves behind.
- Any step's checksum or denial check (see Verification) comes back wrong. Do not hand the new
  endpoint to the workload's normal traffic until it does.

## Verification checklist

- [ ] Each consumer's pod/deployment restarted after its edit and is `1/1` or `Running` with the new
      image/config — not the previous ReplicaSet still serving
- [ ] Trino: a query against the `lake` catalog succeeds, and `EXPLAIN` or the query log shows
      `s3.endpoint` pointing at the Garage host:port, not MinIO's. **False pass:** `SHOW CATALOGS`
      succeeds without ever touching S3 — run a query that reads or writes the warehouse path
- [ ] Spark: `spark-pi` from [[spark-on-k8s-onprem]] §5 still succeeds (proves nothing about S3A),
      then a job that writes to the warehouse bucket succeeds and the object is listable with
      `garage bucket list` or `aws s3 ls --endpoint-url http://<GARAGE_SERVICE>:3900`
- [ ] PostgreSQL: `kubectl -n database get objectstore pg-meta-store` is accepted, and a manual
      `barman-cloud-backup` (or the next scheduled one) lists under `backup-list` against the new
      target — **not** merely that the `ObjectStore` object was created, which the API accepts
      whether or not the endpoint is reachable
- [ ] Airflow: `airflow dags trigger minio_roundtrip` (renamed per Step 4) reaches `success`, and a
      task log written after the cutover is readable from the Airflow UI, which proves the API
      server's read-back path, not only the worker's write path
- [ ] **The scoped key is denied where it was not granted.** Create a second bucket, do not grant the
      workload's key, and confirm `garage bucket allow` was never run for it — `garage key info`
      lists only the bucket it should
- [ ] Nothing in any of the four consumers' manifests, ConfigMaps or DAG files still contains
      `minio`, `9000`, or `https://` in an S3 context. A leftover is where the previous follow-up
      stalled for 64 days — grep rather than trust memory:
      `grep -rni 'minio\|:9000' <path-to-each-consumer's-manifests>`

## Follow-ups

- [ ] Confirm whether `s3.region` / the AWS SDK region filler is actually required against Garage,
      or whether it is cargo-culted from the MinIO-era config in all four consumers — no source
      states Garage's behavior either way
- [ ] Run Step 3 for real and record which barman-cloud operations were exercised against Garage
      through plain HTTP — [[garage-object-storage-onprem]] proved multipart and barman-cloud
      end to end on kind, but not through the operator's `ObjectStore` CRD specifically
- [ ] Re-run this whole runbook once [[garage-object-storage-onprem]]'s own open follow-up closes —
      Garage re-verified on Longhorn rather than kind's local-path provisioner — since this runbook's
      `verified` cannot be trusted ahead of that one
- [ ] Decide and record a retention rule for the warehouse/log buckets now that Garage's lifecycle
      support is `Expiration`-only ([[garage-object-storage-onprem]] Follow-ups) — unrelated to the
      endpoint cutover itself, but the four consumers are exactly the four things about to start
      writing into those buckets for real

## Related

[[s3-object-storage-options]] — the decision this runbook carries out: Garage over MinIO, 2026-08-16.
[[garage-object-storage-onprem]] — the endpoint this points everything at, its own open follow-up to
re-point these four consumers, and the only one of the four with anything actually verified against
it (barman-cloud, multipart, 2026-08-17, on kind).
[[minio-object-storage-onprem]] — the superseded design every consumer below was still wired to; kept
as the record of what the AIStor path would still look like.
[[trino-query-engine-onprem]], [[spark-on-k8s-onprem]], [[postgresql-cnpg-onprem]],
[[airflow-orchestration-onprem]] — the four consumers, each carrying the pre-cutover MinIO config
this runbook replaces section by section.
[[schedulable-node-budget]] — Garage's own redundancy argument (`replication_factor 1`, Longhorn
underneath) is the same two-node arithmetic this runbook's sources already settled once.
