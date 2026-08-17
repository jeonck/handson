---
title: Garage on the on-prem cluster — an S3 endpoint that fits two nodes
date: 2026-08-16
domain: install
tags: [on-prem, storage, object-storage, s3, data-platform]
stack: [kubernetes, garage, helm, longhorn, ingress-nginx, cert-manager, kubectl]
summary: Stand up an S3-compatible endpoint for Trino, Spark, Airflow, barman-cloud and Longhorn's backup target. One Garage instance at replication factor 1 with Longhorn owning redundancy — and Garage terminates no TLS at all, which is what makes the in-cluster side simpler than MinIO's.
source: handson
env: Garage 2.3.0 (AGPLv3) · Kubernetes 1.31.14 (kubeadm) · Longhorn 1.7.2 · Helm 3 · in-tree chart at script/helm
verified: 2026-08-17
verifiability: partial
verifiability-note: Chart install, the layout trap, bucket/key/permissions, the full multipart API and barman-cloud end to end were run on kind. The storage layer underneath was kind's local-path, not Longhorn; the ingress/TLS path and Longhorn's backupstore were not exercised.
duration: 45–75 min
risk: medium
---

> **Partly verified on 2026-08-17, on a two-node kind cluster.** Sections 1–7 were executed and the
> chart values corrected from what the chart actually ships. barman-cloud was driven against the
> resulting endpoint end to end — WAL archived and restored byte-identical, a base backup taken, and
> a restored cluster returning exactly the rows that existed at backup time and none of the ones
> added after it.
>
> **What was not exercised, and is therefore still documentation rather than observation:** the
> storage layer was kind's local-path provisioner, **not Longhorn**, so the "Longhorn owns
> redundancy" premise this document rests on is untested; the ingress and TLS path in section 6; and
> Longhorn's own backupstore against this endpoint. See the Follow-ups.

An S3 endpoint for the data platform: [[trino-query-engine-onprem]], [[spark-on-k8s-onprem]],
[[airflow-orchestration-onprem]] remote logging, [[postgresql-cnpg-onprem]]'s barman-cloud backups,
and eventually [[longhorn-backup-target-onprem]].

**Read [[s3-object-storage-options]] first** — it is why this is Garage rather than MinIO or Ceph,
and it records what this choice gives up. The short version: MinIO's open-source line is archived
with an unpatched CVSS 8.8, Ceph does not fit in 4 GB per node, and Garage is built for deployments
this size.

> **The decision is recorded: Garage, 2026-08-16**, in that page's Decision section, with what it
> accepts and what would reverse it. AIStor was rejected on cost rather than capability — if Garage
> disappoints, that is the option to revisit first, and the evaluation behind it does not need
> redoing.

## The two decisions this document makes for you

**One instance, `replication_factor 1`, redundancy owned by Longhorn.** Upstream is explicit that
this factor is not for production — *"There is no redundancy, and data will be unavailable as soon as
one node fails or its network is disconnected. Do not use this for anything else than test
deployments"*
([configuration reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/)).
That warning is written for Garage on bare disks. Here the disk underneath is a Longhorn volume
already replicated across both workers, so a node loss means Longhorn reattaches the volume and the
pod restarts on the survivor — an outage, then full read *and write* service.

The alternative, factor 2 across two nodes, is worse for this workload rather than better: upstream
says data then *"remains available in read-only mode when one node is down, but write operations will
fail"* — and it doubles storage on top of Longhorn's own two copies. **Neither option survives a node
loss without interruption.** That is the two-node arithmetic in [[schedulable-node-budget]], not
something Garage does badly.

**No TLS inside Garage.** Garage does not terminate TLS at all — *"The main reason to add a reverse
proxy in front of Garage is to provide TLS to your users"*
([reverse proxy cookbook](https://garagehq.deuxfleurs.fr/documentation/cookbook/reverse-proxy/)).
So the split is clean, and simpler than the MinIO arrangement:

| Client | Route | Scheme |
|---|---|---|
| In-cluster (Trino, Spark, Airflow, CNPG) | Service, directly | **plain HTTP** — no certificate, no CA to trust |
| Workstations, anything off-cluster | ingress-nginx with a cert from the internal CA | HTTPS |

That removes the whole per-runtime CA-truststore problem the MinIO route creates. It also means the
S3 API is unauthenticated-in-transit inside the cluster — acceptable only because that traffic stays
on the Calico overlay; say so out loud rather than discovering it in an audit.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster healthy | `kubectl get nodes` | all `Ready` |
| Default StorageClass | `kubectl get storageclass` | `longhorn (default)` — see [[longhorn-storage-onprem]] |
| Helm | `helm version --short` | v3 |
| Ingress controller | `kubectl get ingressclass` | the annotation check in [[ingress-nginx-onprem]] returns one `true` |
| Internal CA issuer | `kubectl get clusterissuer` | `Ready: True` — see [[cert-manager-onprem]] |
| Schedulable node count | `kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'` | `2`, matching [[schedulable-node-budget]] |
| `git` on the workstation | `git --version` | any — the chart is not on a Helm repo |

---

## 1. Get the chart

There is no hosted Helm repository. The chart lives in the Garage source tree
([Deploying on Kubernetes](https://garagehq.deuxfleurs.fr/documentation/cookbook/kubernetes/)), so
pin it by checking out a tag rather than tracking a branch:

```bash
git clone https://git.deuxfleurs.fr/Deuxfleurs/garage
cd garage
git checkout v2.3.0
cd script/helm
```

```bash
git describe --tags
```

Record the tag in this document's `env`. A chart consumed from `main` is an unpinned dependency that
changes under you between installs — the same trap as every other chart in this repository.

## 2. Generate the secrets before installing

Two values must exist and must survive reinstalls. Generate them once and keep them where secrets
belong, not in the values file:

```bash
openssl rand -hex 32       # rpc_secret — 32-byte hex, per the configuration reference
openssl rand -base64 32    # admin_token
```

`rpc_secret` identifies the cluster to itself and is mandatory. `admin_token` guards the admin API;
the configuration reference notes that before v2.0 an unset token disabled those endpoints entirely,
while 2.x supports dynamically defined tokens with scopes and expiry — this document uses the simple
static token.

**Corrected 2026-08-17 against the chart.** Two things the first draft got wrong:

- **If `garage.rpcSecret` is empty the chart generates one and stores it in a Secret itself** — its
  own comment says so. Doing nothing is a valid choice; the risk is that a `helm upgrade` which
  regenerates it would split the cluster, so supply your own for anything you intend to keep.
- To supply it, the value is **`garage.existingRpcSecret`** — a Secret name, with the value under the
  key `rpcSecret`. There is **no `adminToken` value in this chart**; the admin token is configured
  through the garage.toml `[admin]` section, via `garage.additionalTopLevelConfig` or an
  `existingConfigMap`.

```bash
kubectl create namespace garage
kubectl -n garage create secret generic garage-rpc \
  --from-literal=rpcSecret='<REDACTED>'
```

```yaml
# then, in the values file
garage:
  existingRpcSecret: garage-rpc
```

Always read the chart's own value names rather than a document's — a Secret nothing reads is a
silent failure, and that is exactly what the first draft of this section produced:

```bash
grep -n -i -A3 'rpcSecret\|existingRpcSecret\|admin' ./garage/values.yaml
```

## 3. Values

Three of these were wrong in the first draft and were corrected against the chart on 2026-08-17.
Read `values.yaml` at your tag rather than trusting any of it:

```yaml title="values-garage.yaml"
garage:
  # A STRING, not a number. The chart ships `replicationFactor: "3"` quoted, and
  # the value is templated straight into garage.toml.
  replicationFactor: "1"

  # LMDB is the default since 0.9.0. See the trap about unclean shutdowns below.
  dbEngine: "lmdb"

deployment:
  # Under `deployment:`, NOT at the top level, and the chart's default is 3.
  # Leave it alone and you get a three-node StatefulSet with two pods Pending.
  replicaCount: 1

image:
  # The chart's own comment reads "default to amd64 docker image". On arm64 the
  # pod never starts; `dxflrs/arm64_garage` is what the 2026-08-17 run used.
  repository: dxflrs/amd64_garage

persistence:
  meta:
    storageClass: longhorn
    size: 5Gi          # chart default is 100Mi
  data:
    storageClass: longhorn
    size: <DATA_SIZE>  # chart default is 100Mi
```

Two things to size deliberately rather than accept:

- **Separate meta and data volumes.** Upstream recommends metadata on the faster device and data on
  the larger one ([real-world cookbook](https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/)).
  Both are Longhorn here, so the speed argument does not apply — but keeping them apart still means a
  data volume filling up does not take the metadata store down with it.
- **`<DATA_SIZE>` against Longhorn's real capacity.** Longhorn stores two replicas of whatever you
  ask for, so a 40 Gi data volume consumes 80 Gi across the two workers' disks.
  `storageMinimalAvailablePercentage=25` from [[longhorn-storage-onprem]] will refuse to schedule a
  replica onto a nearly full disk, and the failure surfaces as a `Pending` PVC.

Upstream publishes **no RAM or CPU minimum** for a Garage node. That is not the same as "it is
light" — nothing here has been measured. Leave requests unset for the first run and set them from
`kubectl top pod` afterwards, which is also the second follow-up.

## 4. Install

```bash
helm install --create-namespace --namespace garage garage ./garage -f values-garage.yaml
```

```bash
kubectl -n garage get statefulset,pod,pvc
```

The chart deploys a StatefulSet with the meta and data PVCs from its volume-claim templates. Wait
for `1/1`, not merely `Running`.

## 5. Bootstrap the layout — the step that is easy to skip

**A running Garage pod stores nothing until a layout is applied.** This is the trap of the whole
procedure: everything looks healthy, the S3 endpoint answers, and writes fail or vanish because no
node has been assigned a role.

```bash
kubectl exec --stdin --tty -n garage garage-0 -- ./garage status
```

Take the node ID from that output, then assign it a zone and a capacity
([quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/)):

```bash
kubectl exec -n garage garage-0 -- ./garage layout assign -z <ZONE> -c <CAPACITY> <NODE_ID_PREFIX>
```

```bash
kubectl exec -n garage garage-0 -- ./garage layout apply --version 1
```

`assign` stages a change; **`apply` is what commits it**, and the version number is not optional.
`-c` is the capacity this node contributes — omit it and the node holds no data.

```bash
kubectl exec -n garage garage-0 -- ./garage status
```

The node should now show its role, zone and capacity rather than only being connected.

**Observed 2026-08-17.** Before `assign`, `garage status` listed the node under a heading that reads
**`==== HEALTHY NODES ====`** with `NO ROLE ASSIGNED` in the Capacity column — the pod was `1/1` and
upstream's own output called it healthy while it stored nothing. `assign` replied *"Role changes are
staged but not yet committed"*, and only after `apply` did the row carry `dc1` and a capacity.

## 6. Expose it

**In-cluster** consumers use the Service directly, over plain HTTP:

```text
http://garage.garage.svc.cluster.local:3900
```

Confirm the actual Service name and port from the chart rather than trusting that line — it is the
one value here most likely to differ:

```bash
kubectl -n garage get svc
```

On the 2026-08-17 run the chart created **`garage`** and **`garage-headless`**, both exposing
**3900** (S3 API) and **3902**, which makes the in-cluster URL above correct as written for a release
named `garage` in a namespace named `garage`.

**Off-cluster** access goes through ingress-nginx with a certificate from the internal CA:

```yaml title="garage-ingress.yaml"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: garage-s3
  namespace: garage
  annotations:
    cert-manager.io/cluster-issuer: <INTERNAL_CA_ISSUER>
    # S3 clients upload objects far larger than the 1 MiB default. Without this,
    # uploads fail at 413 — the same trap recorded in [[ingress-nginx-onprem]].
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [<S3_HOST>]
      secretName: garage-s3-tls
  rules:
    - host: <S3_HOST>
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: <GARAGE_SVC>
                port:
                  number: 3900
```

Path-style addressing keeps this to one hostname. Virtual-host style (`<BUCKET>.<S3_HOST>`) needs a
wildcard DNS record and a wildcard certificate; newer AWS SDKs default to virtual-host style, so
every client will need path-style set explicitly — decide which, and write it down.

## 7. A bucket and a scoped key

```bash
kubectl exec -n garage garage-0 -- ./garage bucket create <BUCKET>
kubectl exec -n garage garage-0 -- ./garage key create <KEY_NAME>
```

`key create` prints the access key and secret. **They are shown once** — capture them into the
consumer's Secret, not into a terminal you will close.

```bash
kubectl exec -n garage garage-0 -- ./garage bucket allow --read --write <BUCKET> --key <KEY_NAME>
```

Grant `--owner` only where the key genuinely needs to manage the bucket itself.

> **Garage has no bucket policies.** It implements none of the S3 policy endpoints and uses
> *"its own system instead, built around a per-access-key-per-bucket logic"*
> ([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)).
> Access scoping is real, but any procedure written against `PutBucketPolicy` — including the scoped-key
> checks in [[minio-object-storage-onprem]] — has to be rewritten against `bucket allow`, not
> re-pointed at a new endpoint.

---

## Verification checklist

Every item states a pass condition precisely enough to be wrong, and several name the false pass
sitting next to them.

- [ ] `kubectl -n garage get pod` — `1/1`, not merely `Running`
- [ ] `garage status` shows the node **with a role, zone and capacity**. **False pass:** a node
  appears in `status` as soon as it is connected, before any layout exists — and stores nothing
- [ ] `garage layout show` reports the applied version, and it is the version you applied
- [ ] `kubectl -n longhorn-system get volumes.longhorn.io` — both Garage volumes `attached` / **`healthy`**, not merely `attached`
- [ ] Put an object with the scoped key, record its checksum, get it back, **checksums match**
- [ ] **The object survives the pod being destroyed.** `kubectl -n garage delete pod garage-0`, wait for the StatefulSet to bring it back, then get the object again and compare checksums. This is the check that tests the storage layer rather than the API
- [x] **A multipart upload completes.** Verified 2026-08-17: a 32 MiB `aws s3 cp` round-tripped with matching md5, and the explicit API path — `create-multipart-upload`, two `upload-part`, `list-parts`, `complete-multipart-upload`, plus `abort-multipart-upload` — all succeeded. S3A and barman-cloud both depend on this, and a single small `PutObject` exercises none of it
- [ ] **The scoped key is denied on a bucket it was not granted.** Create a second bucket, do not grant the key, and confirm the write is refused. **Run the denial** — a key that works where it should proves nothing about where it should not
- [ ] An unimplemented endpoint returns **501 Not Implemented** (try `GetBucketPolicy`). This confirms both that you are talking to Garage and that the client tolerates the boundary
- [ ] From a workstation with the internal CA trusted and **no `-k`**: `https://<S3_HOST>/` completes the TLS handshake. **False pass:** a `curl` from inside the cluster to the Service proves nothing about the ingress path — it never touches ingress-nginx or the certificate
- [ ] An upload larger than 1 MiB succeeds **through the ingress route**, not only through the Service — this is what `proxy-body-size` is for
- [ ] Deleting a test bucket frees space: Longhorn's used capacity for the data volume drops

## Rollback

```bash
kubectl -n garage delete ingress garage-s3
helm uninstall garage -n garage
```

**`helm uninstall` leaves the `garagenodes.deuxfleurs.fr` CRD behind** — the Kubernetes cookbook says
so explicitly. Remove it only if nothing else expects it:

```bash
kubectl get crd garagenodes.deuxfleurs.fr
kubectl delete crd garagenodes.deuxfleurs.fr
```

**The PVCs outlive the release.** A StatefulSet's volume-claim templates are not deleted by
`helm uninstall`, which is the behaviour you want on an accident and the one that silently keeps data
after a deliberate removal:

```bash
kubectl -n garage get pvc            # still there
kubectl -n garage delete pvc --all   # destroys every object stored — no undo
kubectl delete namespace garage
```

Anything holding data in this bucket — CNPG backups, Airflow logs, Iceberg tables — loses it here.
Check what points at this endpoint before running that line.

## Failure points documented upstream

Nothing bit us; nothing has been run. These come from Garage's own documentation.

**LMDB and unclean shutdowns** — LMDB is the default engine since 0.9.0 and the configuration
reference notes limitations "regarding unclean shutdowns and architecture portability". On
Kubernetes, an unclean shutdown is a routine event: an OOMKill, a node loss, an eviction. Worth
knowing before it happens rather than after. ([configuration reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/))

**A layout that was assigned but never applied** — `assign` alone changes nothing. Section 5.

**Replication factor 1 is documented as test-only** — *"Do not use this for anything else than test
deployments."* This document takes that route deliberately, with Longhorn underneath, and says so;
it is a decision to re-make if the storage layer ever changes. ([configuration reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/))

**No object versioning** — *"Garage does not (yet) support object versioning"*, and
`GetBucketVersioning` is a stub returning "not enabled". There is no S3-level recovery from an
overwrite or a mistaken delete; whatever protects this data has to sit elsewhere.
([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/))

**No object lock, no server-side-encryption endpoints, partial lifecycle** — lifecycle supports only
`AbortIncompleteMultipartUpload` and `Expiration`. A retention policy expressed any other way will
not be enforced. (same page)

**Missing endpoints return 501** — clients that treat 501 as a transport error rather than a
capability answer will retry it. (same page)

## Follow-ups

- [ ] Re-point the four consumers at this endpoint once it exists — [[trino-query-engine-onprem]], [[spark-on-k8s-onprem]], [[postgresql-cnpg-onprem]] and [[airflow-orchestration-onprem]] currently carry `https://` and a CA-trust requirement written for MinIO, which Garage does not need in-cluster 📅 2026-08-30
- [ ] Set resource requests from `kubectl top pod` under a real load — upstream publishes no minimum, so the first numbers have to be measured rather than copied
- [x] Prove barman-cloud against Garage — done 2026-08-17: `check-wal-archive`, WAL archive and restore byte-identical, `barman-cloud-backup`, `backup-list`, and a `barman-cloud-restore` into a separate cluster that came up with exactly the rows present at backup time and none added after it, with WAL fetched back from Garage during recovery
- [ ] Prove **Longhorn's backupstore** against Garage. **Could not be done on kind:** `iscsid` refuses to start inside a rootless-podman node — the unit is skipped by `ConditionVirtualization=!private-users`, and run by hand it exits with `failed to mlockall`. Needs a rootful container runtime, a Linux host, or real VMs 📅 2026-09-15
- [ ] Re-run sections 3–5 with **Longhorn** as the StorageClass. The 2026-08-17 run used kind's local-path, so the premise this whole document rests on — that Longhorn owns redundancy underneath a factor-1 Garage — is still unobserved 📅 2026-09-15
- [ ] Decide the retention story now that lifecycle is `Expiration`-only, before Airflow logs and WAL archives accumulate

## Related

[[s3-object-storage-options]] — why Garage, what it gives up, and what would reverse the decision.
[[minio-object-storage-onprem]] — the incumbent this replaces. Kept as the record; its scoped-key checks do not port directly, because Garage has no bucket policies.
[[longhorn-storage-onprem]] — owns redundancy under this deployment, which is the whole reason factor 1 is defensible.
[[schedulable-node-budget]] — where the two-node write-availability limit comes from.
[[ingress-nginx-onprem]] — terminates the TLS Garage does not, and the source of the `proxy-body-size` trap.
[[cert-manager-onprem]] — issues the certificate the ingress presents.
[[longhorn-backup-target-onprem]] — a consumer, and the one with a circularity problem: a cluster's backups living inside that cluster.
