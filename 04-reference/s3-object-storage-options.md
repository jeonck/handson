---
title: S3-compatible object storage for this cluster — MinIO, Ceph and Garage
date: 2026-08-16
domain: reference
tags: [storage, object-storage, s3, decision]
stack: [kubernetes, minio, ceph, rook, garage, longhorn]
summary: MinIO's open-source line was archived in April 2026, so the S3 endpoint under Trino, Spark, Airflow and the database backups had to be decided again. Ceph does not fit in 4 GB per node; Garage does, and gives the same write-availability on two nodes that MinIO does, because the binding constraint is the node count rather than the product. Decided 2026-08-16: Garage.
source: handson
verified:
---

> **Nothing here has been run.** This is a documentation review carried out on 2026-08-16 against
> upstream sources, each quoted and linked below with the date it was read. It exists to make a
> decision, not to describe a working system. Every performance or capacity claim is either quoted
> from a vendor or labelled as arithmetic — none of it is measured.

[[minio-object-storage-onprem]] was written against MinIO and stays as the record of that
investigation. This document is the step before it: **whether MinIO should still be the answer**, and
what the alternatives actually cost on the hardware this cluster has.

## Why this is being asked again

The MinIO document's own section 0 found that the open-source line is finished:

- `minio/minio` was **archived on 2026-04-25**, with "THIS REPOSITORY IS NO LONGER MAINTAINED" on the
  repository front page ([github.com/minio/minio](https://github.com/minio/minio), read 2026-08-16).
- [GHSA-hv4r-mvr4-25vw](https://github.com/minio/minio/security/advisories/GHSA-hv4r-mvr4-25vw) —
  **CVSS 8.8**, an attacker holding a valid access key can write objects without a valid signature —
  affects "all MinIO releases through the final release of the minio/minio open-source project" and
  is patched only in **AIStor** `RELEASE.2026-04-11T03-20-12Z`. The advisory's own remediation is to
  move to AIStor.
- AIStor Free is licensed "solely in standalone mode (single-node deployments without distributed
  clustering or high availability)"
  ([AIStor Free Tier License Agreement](https://www.min.io/legal/aistor-free-agreement), read
  2026-08-16).

**There is no patched, distributed, free MinIO.** That is the whole reason for this page.

## The constraint that decides it, before any product does

Two schedulable nodes ([[schedulable-node-budget]]) and roughly 2 vCPU / 4 GB each, with Longhorn,
Calico and ingress-nginx already resident. The disks are already owned by Longhorn — there is no
spare raw block device.

The finding worth internalising is that **on two nodes, MinIO and Garage arrive at the same place by
different routes**:

| | Behaviour when one of two nodes is lost |
|---|---|
| MinIO, distributed | reads continue, writes fail — two nodes meet erasure-coding read quorum exactly and miss write quorum always (per [[minio-object-storage-onprem]] §2) |
| Garage, `replication_factor 2` | "Data remains available in read-only mode when one node is down, but **write operations will fail**" ([configuration reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/), read 2026-08-16) |

Neither is a deficiency of the product. A replicated store on two nodes cannot keep a write quorum
when half of it disappears — that is arithmetic, and swapping the product does not change it. **The
choice on this hardware is not "which object store"; it is whether to accept losing writes on a node
failure, or to add a third machine.**

---

## Candidate 1 — MinIO

| | |
|---|---|
| Status | archived 2026-04-25; free tier relicensed to standalone-only |
| Fits 2 nodes? | yes, as a single instance |
| Blocking issue | an unpatched CVSS 8.8 with no free fix |

Documented end to end in [[minio-object-storage-onprem]], including the interim mitigations for the
advisory and the reasoning behind running it standalone on one Longhorn PVC. Keeping it means
accepting a known-vulnerable build, or buying AIStor.

## Candidate 2 — Rook / Ceph with RGW

| | |
|---|---|
| Status | healthy — Rook v1.20.4 (2026-08-13), Apache 2.0, CNCF Graduated |
| Kubernetes 1.31 | **supported** — Rook 1.20 covers v1.31–v1.36 |
| Fits 2 nodes? | **no** |
| Blocking issue | RAM, and it is not close |

Rook is in better shape than MinIO on every axis except the one that matters here. Its Kubernetes
support window includes this cluster — unlike CloudNativePG, which does not — and its licence and
governance carry none of MinIO's risk.

It does not fit, and the numbers are upstream's own
([Ceph hardware recommendations](https://docs.ceph.com/en/latest/start/hardware-recommendations/),
read 2026-08-16):

- `ceph-mon`: **">= 5 GB per daemon"** — one monitor is larger than an entire worker
- `ceph-osd`: **">= 4 GB per daemon (more is better) 2-4 GB may function but will be slow. Less than
  2 GB is not recommended"**, and `osd_memory_target` defaults to 4 GB

Node count is independently disqualifying. Rook states: **"Clusters with valuable production data
should comprise at least three nodes when using replicated pools and at least four when using
erasure coding"**
([CephBlockPool CRD](https://rook.io/docs/rook/v1.20/CRDs/Block-Storage/ceph-block-pool-crd/), read
2026-08-16). Ceph's monitors need a super-majority for quorum, so a two-monitor cluster requires
*both* to be up — a routine reboot then stops all I/O, which is worse availability than a single
monitor.

And there is no raw device. Rook can consume PVCs, so Ceph OSDs on Longhorn volumes is technically
permitted — but that stacks a replicated store on a replicated store, and Ceph's CRUSH map would
believe it is placing copies on distinct hosts while Longhorn independently decides where the bytes
actually land. *That last point is inference from the two systems' documented behaviour, not a
statement either project makes; no upstream guidance was found recommending or forbidding the
combination.*

**Verdict: not viable, and a fourth machine of the same size does not rescue it.** Ceph here means
different hardware — three or more nodes with dedicated raw devices and materially more RAM.

## Candidate 3 — Garage

| | |
|---|---|
| Status | active — v2.3.0 released 2026-04-16, **AGPLv3** |
| Fits 2 nodes? | yes |
| Blocking issue | none for this stack — but read the API gaps below |

Garage is built for exactly this shape of deployment: small, self-hosted, few nodes. Releases are
recent and regular ([releases](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases), read
2026-08-16), the repository is active, and the licence is AGPLv3 with no free/paid split of the kind
that ended MinIO's open-source line ([repository](https://github.com/deuxfleurs-org/garage), read
2026-08-16). There is an official Helm chart, carried in-tree under `script/helm`
([Deploying on Kubernetes](https://garagehq.deuxfleurs.fr/documentation/cookbook/kubernetes/)).

Replication, quoted from the [configuration reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/):

| Factor | What upstream says |
|---|---|
| 1 | "There is no redundancy… **Do not use this for anything else than test deployments.**" |
| 2 | tolerates one node failure; "Data remains available in read-only mode when one node is down, but write operations will fail" |
| 3 | tolerates two node failures; needs three nodes |

Upstream's [real-world cookbook](https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/)
states **no RAM or CPU minimum** — it only recommends separating a small fast metadata directory from
a larger data directory. That absence is worth naming rather than reading as "it is light": nothing
was measured here.

### S3 API coverage — the part that decides whether it can be adopted

From Garage's [S3 compatibility page](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
(read 2026-08-16). Endpoints Garage does not implement return **501 Not Implemented**.

| Feature | Garage |
|---|---|
| Multipart upload (all endpoints) | supported |
| `ListObjectsV2` | supported |
| `CopyObject`, `UploadPartCopy` | supported |
| Range reads | supported |
| Presigned URLs | supported |
| **Object versioning** | **not supported** — "Garage does not (yet) support object versioning"; `GetBucketVersioning` is a stub returning "not enabled" |
| **Bucket policies** | **not supported** — "Garage implements none of them, and has its own system instead, built around a per-access-key-per-bucket logic" |
| Object lock, server-side-encryption endpoints | not supported |
| Lifecycle | partial — `AbortIncompleteMultipartUpload` and `Expiration` only |

What that means for the five things that would use this endpoint. **This section is reasoning from
the table above against each consumer's documented requirements — it is not a compatibility claim
from either side, and none of it has been tested:**

- **Trino + Iceberg** — the gap that would normally worry you is atomic commit. It does not apply
  here, because [[trino-query-engine-onprem]] chose the **JDBC catalog** backed by PostgreSQL:
  commit atomicity lives in the database, not in S3. An Iceberg deployment relying on S3 conditional
  writes would need re-checking; this one does not.
- **Spark via S3A** — needs multipart, `ListObjectsV2` and range reads. All present.
- **CloudNativePG / barman-cloud** — WAL archiving is many small sequential objects plus multipart
  base backups. Nothing in the unsupported column is implicated.
- **Longhorn backup target** — put/get/list against a bucket. Nothing implicated.
- **Airflow remote logging** — small objects written on task completion. Nothing implicated.

The two real losses are **versioning** (no per-object recovery from an overwrite, and no S3-level
protection against a mistaken delete) and **bucket policies** (access scoping exists, but through
Garage's own per-key model — so [[minio-object-storage-onprem]]'s "the scoped key is denied
elsewhere" check has to be rewritten against a different mechanism, not merely re-pointed).

---

## Decision — 2026-08-16

> **Garage. Not MinIO, not AIStor, not Ceph.**
>
> One instance at `replication_factor 1` on a Longhorn volume, with Longhorn owning redundancy.
> Procedure in [[garage-object-storage-onprem]].
>
> **Why, in one line each:** MinIO's free line is archived with an unpatched CVSS 8.8 and its
> successor tier cannot legally run distributed; Ceph does not fit in 4 GB per node and would not
> fit with a fourth identical machine either; Garage is actively released, AGPLv3, and its S3 gaps
> miss every consumer in this stack.
>
> **AIStor was considered and rejected on cost, not capability.** Buying it would make MinIO a
> supported, patched product again and [[minio-object-storage-onprem]] would mostly still apply.
> That is the option to revisit first if Garage disappoints — the evaluation does not need redoing.
>
> **What this accepts, knowingly:**
>
> - No object versioning, so nothing at the S3 layer recovers an overwrite or a mistaken delete
> - No bucket policies — access scoping goes through Garage's per-key model, so the scoped-key
>   procedure from the MinIO document has to be rewritten rather than re-pointed
> - Lifecycle limited to `Expiration`, so any other retention rule is unenforced
> - Replication factor 1 is labelled test-only by upstream. Taken deliberately because Longhorn is
>   already replicating underneath — a decision to re-make if the storage layer ever changes
> - A node loss is an outage, then full service. It is not a seamless failover, and no product
>   choice available on two nodes would have made it one
>
> **What reverses this:** a third schedulable node — which fixes the underlying write-availability
> problem rather than working around it — or a Garage failure serious enough to be worth paying for
> AIStor. Not a new release, and not a benchmark.
>
> Nothing has been installed. This records which way to go, not that anyone went.

## Recommendation

**Garage, at `replication_factor 1`, on a Longhorn volume — with the redundancy left to Longhorn.**

That is the same shape [[minio-object-storage-onprem]] reached for MinIO, and for the same reason:
stacking an object store's own replication on top of Longhorn's stores every byte two to four times
over two disks, and leaves two layers each reporting a different story about the same failure. One
layer should own redundancy. On this hardware that layer is Longhorn, because it is already there and
already replicating.

Note what this trades, plainly: at factor 1 Garage has no redundancy of its own, so a node loss is
handled by Longhorn reattaching the volume and the pod restarting on the survivor — an outage of
seconds to minutes, then full read *and write* service. Garage at factor 2 would instead stay up
read-only and refuse writes until the node came back. **A short outage that then works is usually
worth more than a long period of half-working**, but that is a judgement about this workload, not a
fact — and upstream explicitly labels factor 1 as test-only, so the choice is being made against
their advice and should be recorded as such.

What would change the recommendation:

- **A third schedulable node** — Garage at factor 3, or MinIO/AIStor distributed, become real, and
  the write-availability problem disappears. This is the only change that fixes the actual constraint.
- **Buying AIStor** — makes MinIO a supported, patched product again, and the existing document
  mostly still applies.
- **Materially more RAM and dedicated disks** — puts Ceph back on the table, but that is a different
  cluster.

## Follow-ups

- [x] Decide between Garage and paid AIStor and record the decision with its date — done 2026-08-16, see the Decision section above
- [x] If Garage: write the install guide — done 2026-08-16, [[garage-object-storage-onprem]]. It rewrites the scoped-access-key check against `bucket allow` rather than bucket policies, since Garage implements none of the policy endpoints
- [x] Confirm barman-cloud against Garage by testing — done 2026-08-17, end to end including a restore that returned the rows as of the backup point. See [[garage-object-storage-onprem]]
- [ ] Confirm Longhorn's backupstore against Garage. Blocked on kind: `iscsid` cannot start under rootless podman, so Longhorn will not install there. Needs a rootful runtime or real VMs 📅 2026-09-15
- [ ] Re-check whether Rook still supports Kubernetes 1.31 before any future reconsideration — 1.31 is at the bottom of its stated window

## Related

[[minio-object-storage-onprem]] — the incumbent, and the investigation that produced the archived-and-unpatched finding. Left in place as the record.
[[schedulable-node-budget]] — where the two-node constraint comes from, and where the decision this page asks for should be recorded.
[[longhorn-storage-onprem]] — the layer this recommendation hands redundancy to.
[[longhorn-backup-target-onprem]] — one of the five consumers, and the one with a circularity problem whichever product wins.
[[trino-query-engine-onprem]] — its JDBC catalog choice is what makes Garage's missing conditional writes a non-issue.
[[postgresql-cnpg-onprem]] — barman-cloud is the consumer with the least margin for an S3 surprise.
