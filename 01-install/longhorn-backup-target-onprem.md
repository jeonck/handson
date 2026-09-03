---
title: Longhorn backup target — making snapshots into something that survives the cluster
date: 2026-08-08
domain: install
tags: [on-prem, storage, backup]
stack: [kubernetes, longhorn, minio, s3, kubectl]
summary: Point Longhorn at S3 or NFS storage that lives outside the cluster, schedule recurring backups, and prove the result by destroying a volume and restoring it. A backup that has never been restored is an untested assumption.
source: handson
env: Target — Kubernetes 1.31 (kubeadm, on-prem) · Longhorn 1.7 · MinIO or NFSv4 off-cluster · Ubuntu 24.04 LTS
verified:
verifiability: field
verifiability-note: The property is surviving the loss of the cluster — it needs a second cluster to restore into, and retention only proves itself after retain+1 scheduled runs.
duration: 30–45 min
risk: medium
---

> ⚠️ **This procedure has not been run.** It is drafted from Longhorn's documentation, so `verified`
> is empty and the site lists it as needing verification. Unlike the rest of the on-prem chain, this
> one cannot be rehearsed usefully on a throwaway cluster: the property under test is *survives the
> cluster being gone*, and a lab that is created and destroyed in one sitting cannot demonstrate it.
> Treat every command below as unproven, and see [Which checks can actually fail](#which-checks-can-actually-fail)
> before trusting the checklist.

[[longhorn-storage-onprem]] left this open, and the reason it matters is in the sentence that closed it: **Longhorn snapshots live on the same disks as the data.** A snapshot rolls back a bad deploy. It does nothing about a failed disk, a deleted namespace, a `kubectl delete pvc` typed in the wrong context, or the cluster itself going away. Those need a copy somewhere else.

## Where the backups live decides everything

Before any configuration, one architectural decision, and it is easy to get quietly wrong.

**A backup target running inside the cluster it protects is not a backup target.** MinIO deployed on this cluster, backed by Longhorn PVCs, on these three nodes, is a circular dependency: the disaster that takes the cluster takes the backups with it. It will pass every check in this document. It will fail the only test that counts.

| Option | Survives cluster loss | Notes |
|---|---|---|
| NAS or file server on the LAN (NFSv4) | yes | simplest if one already exists |
| MinIO on a machine outside the cluster | yes | S3 API, one more host to run |
| Cloud object storage (S3, GCS, …) | yes, and survives the building | needs egress and costs money |
| MinIO on this cluster, on Longhorn volumes | **no** | the trap above |
| A node's local disk via `hostPath` | no | dies with the node |

The rest of this document assumes one of the first three, referred to as `<BACKUP_HOST>`.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Longhorn healthy | `kubectl -n longhorn-system get nodes.longhorn.io` | every node `Ready`, per [[longhorn-storage-onprem]] |
| A volume with real data | `kubectl get pvc -A` | at least one `Bound` PVC worth restoring |
| Target reachable from every node | see below | not just from your workstation |
| Target is not hosted on this cluster | `getent hosts <BACKUP_HOST>` | an address outside the MetalLB pool |
| NFS only: `nfs-common` on every node | `dpkg -l nfs-common \| tail -1` | installed — already done in [[longhorn-storage-onprem]] step 1.1 |

Reachability has to be tested from inside the cluster, because that is where the traffic originates. A `curl` from your laptop proves your laptop's routing and nothing else:

```bash
kubectl run nettest --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- \
  curl -sS -o /dev/null -w '%{http_code}\n' http://<BACKUP_HOST>:9000/minio/health/live
```

That check runs on one node. If the nodes sit on different segments or have different firewall rules, run it pinned to each node in turn — `--overrides` with a `nodeName`, or simply repeat it until it has landed everywhere.

---

## 1A. S3-compatible target (MinIO or cloud)

Create the bucket first, on `<BACKUP_HOST>`. Longhorn will not create it.

The credentials go in a secret **in `longhorn-system`**. A secret elsewhere is invisible to Longhorn and the error surfaces later as a backup that never starts.

```bash
kubectl -n longhorn-system create secret generic longhorn-backup-secret \
  --from-literal=AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY" \
  --from-literal=AWS_ENDPOINTS="https://<BACKUP_HOST>:9000"
```

Pass the values through environment variables rather than typing them inline, so they do not land in shell history. For a self-signed MinIO certificate, add the CA so Longhorn does not reject the TLS handshake:

```bash
kubectl -n longhorn-system create secret generic longhorn-backup-secret \
  --from-literal=AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY" \
  --from-literal=AWS_ENDPOINTS="https://<BACKUP_HOST>:9000" \
  --from-file=AWS_CERT=minio-ca.crt
```

`AWS_ENDPOINTS` needs the scheme and the port. Without the scheme Longhorn builds a URL that never resolves, and the failure appears as an unavailable target rather than as a malformed setting.

Now the target itself. The `region` segment is required even for MinIO, which ignores it — `us-east-1` is the conventional filler:

```bash
kubectl -n longhorn-system patch settings.longhorn.io backup-target \
  --type=merge -p '{"value":"s3://longhorn-backups@us-east-1/"}'

kubectl -n longhorn-system patch settings.longhorn.io backup-target-credential-secret \
  --type=merge -p '{"value":"longhorn-backup-secret"}'
```

## 1B. NFS target

The export must be NFSv4 and writable by the nodes. Longhorn mounts it from inside its own pods, so squashing rules that work for an interactive user may still block it.

```bash
kubectl -n longhorn-system patch settings.longhorn.io backup-target \
  --type=merge -p '{"value":"nfs://<BACKUP_HOST>:/exports/longhorn-backups"}'
```

No credential secret is involved, which also means no authentication — anyone who can reach the export can read every backup. If that is not acceptable, use S3 with credentials.

---

## 2. Confirm the target is actually usable

This is the first place a proxy check would slip in. The settings above accept any string; **saving them successfully proves nothing.** Longhorn publishes the result of contacting the target as a separate object:

```bash
kubectl -n longhorn-system get backuptargets.longhorn.io
```

```bash
kubectl -n longhorn-system get backuptargets.longhorn.io default \
  -o jsonpath='{.status.available}{"\t"}{.status.conditions[*].message}{"\n"}'
```

The pass condition is `.status.available` equal to `true`. Anything else means the credentials, the endpoint, or the bucket is wrong, and the message says which. An unreachable endpoint usually leaves the field empty rather than `false`.

> **Expected output that looks wrong:** immediately after configuring the target, `kubectl -n longhorn-system get backups` prints nothing. That is correct — there are no backups yet, and Longhorn only lists what it finds in the target. An empty list is also what an unreachable target produces, which is exactly why `.status.available` above is the check and this is not.

---

## 3. Take one backup by hand before automating anything

A recurring job that has never produced a working backup is a scheduled disappointment. Do one manually and restore it (section 5) before adding a schedule.

```bash
kubectl get pvc <PVC_NAME> -o jsonpath='{.spec.volumeName}{"\n"}'
```

```bash
VOL=$(kubectl get pvc <PVC_NAME> -o jsonpath='{.spec.volumeName}')
kubectl -n longhorn-system get volumes.longhorn.io "$VOL"
```

Trigger the backup from the UI (Volume → Create Backup), or declaratively with a `Snapshot`/`Backup` pair. The UI path is the one Longhorn documents; the CRD path is scriptable but its field names have moved between releases, so check them against the version you installed.

```bash
kubectl -n longhorn-system get backups
```

```bash
kubectl -n longhorn-system get backups -o custom-columns=\
'NAME:.metadata.name,VOLUME:.status.volumeName,STATE:.status.state,SIZE:.status.size,CREATED:.status.backupCreatedAt'
```

`STATE: Completed` means the upload finished. **It does not mean the backup can be restored** — that is section 5, and skipping it is how organisations discover their backup format was wrong two years later.

---

## 4. Recurring jobs

```yaml title="recurring-backup.yaml"
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 2 * * *"          # 02:00 in the cluster's timezone — check what that is
  task: backup
  groups:
    - default
  retain: 7                  # keep 7 backups; older ones are deleted after a successful run
  concurrency: 2             # how many volumes at once — raise carefully, it competes with workloads
```

```bash
kubectl apply -f recurring-backup.yaml
kubectl -n longhorn-system get recurringjobs
```

**`groups: [default]` does not mean "every volume".** It means volumes that carry the default group label, and Longhorn places volumes there when they have no other recurring job. Confirm which volumes it actually covers rather than assuming — this is the check that catches a volume created later with an explicit group and silently excluded:

```bash
kubectl -n longhorn-system get volumes.longhorn.io -o custom-columns=\
'VOLUME:.metadata.name,GROUPS:.metadata.labels' | sed 's/recurring-job-group.longhorn.io\///g'
```

Every volume you expect to be backed up must appear with the `default` group.

Snapshots are cheap and backups are not; a common pairing is frequent snapshots for quick rollback plus a daily backup off-cluster:

```yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot
  namespace: longhorn-system
spec:
  cron: "0 * * * *"
  task: snapshot
  groups: [default]
  retain: 12
```

### Confirm the schedule fires

A created RecurringJob is not a running one. The property is *a new backup appeared after the cron time*, and the only way to check it is to wait for one firing:

```bash
kubectl -n longhorn-system get backups --sort-by=.status.backupCreatedAt | tail -5
```

```bash
kubectl -n longhorn-system get volumes.longhorn.io "$VOL" \
  -o jsonpath='{.status.lastBackupAt}{"\n"}'
```

`lastBackupAt` moving past the scheduled time is the pass condition. To avoid waiting overnight the first time, set the cron a few minutes ahead, watch it fire, then set the real schedule.

Retention is a separate property again, and it only demonstrates itself after `retain + 1` runs. Until you have watched the oldest backup disappear, retention is configured but unproven — do not assume it works, and do not assume it does not.

---

## 5. The only check that matters — destroy and restore

Everything above verifies that data left the cluster. This verifies that it can come back. **If you do one thing from this document, do this one**, and do it before you need it.

Restore into a **new** PVC with a different name. Restoring over the original both destroys your evidence and lets a restore that silently did nothing look like a success, because the original data was there all along.

```bash
# note what you are proving you can recover
kubectl exec <POD> -- sh -c 'md5sum /data/* | sort'
```

Keep that output. It is the comparison at the end, and "the file exists" is not the same claim as "the file is the file".

Longhorn exposes restores through the CSI snapshot interface. A `VolumeSnapshotClass` of type `bak` maps a Longhorn backup to a `VolumeSnapshot`, which a new PVC can use as its data source:

```yaml title="restore.yaml"
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-backup
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: bak
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: restore-src
spec:
  volumeSnapshotClassName: longhorn-backup
  driver: driver.longhorn.io
  deletionPolicy: Delete
  source:
    # from `kubectl -n longhorn-system get backups`
    snapshotHandle: bs://<VOLUME_NAME>/<BACKUP_NAME>
  volumeSnapshotRef:
    name: restore-snap
    namespace: default
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: restore-snap
  namespace: default
spec:
  volumeSnapshotClassName: longhorn-backup
  source:
    volumeSnapshotContentName: restore-src
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: restored-data          # deliberately not the original name
  namespace: default
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: longhorn
  resources:
    requests:
      storage: 2Gi             # at least the size of the original volume
  dataSource:
    name: restore-snap
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

This needs the CSI snapshot CRDs and controller, which kubeadm does not install and Longhorn does not bundle. If `kubectl get volumesnapshotclass` returns `no matches for kind`, install the external-snapshotter CRDs and controller first — and add that to this document once you know which version you used.

```bash
kubectl apply -f restore.yaml
kubectl get pvc restored-data -w
```

Mount it and compare:

```bash
kubectl run restore-check --rm -it --restart=Never --image=busybox:1.36 \
  --overrides='{"spec":{"containers":[{"name":"restore-check","image":"busybox:1.36","command":["sh"],"stdin":true,"tty":true,"volumeMounts":[{"name":"d","mountPath":"/data"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"restored-data"}}]}}' \
  -- sh -c 'md5sum /data/* | sort'
```

The pass condition is **byte-identical checksums to the ones you kept**, not "the pod started" and not "there are files in /data".

```bash
kubectl delete pvc restored-data
kubectl delete volumesnapshot restore-snap
```

---

## Which checks can actually fail

Following the repository's rule that a verification step earns its place only if a realistic failure would catch it — and the finding in [[2026-08-08-weekly]] that four of six procedures shipped a check that could not — here is the honest accounting for this document.

| Check | Catches | Status |
|---|---|---|
| `.status.available == true` on the BackupTarget | wrong endpoint, wrong credentials, unreachable host | reads the property; **never watched fail** |
| `STATE: Completed` on a Backup | an upload that errored | reads a proxy: proves transfer, not restorability |
| Restore to a new PVC + checksum match | corrupt, empty, or unrestorable backups | reads the property; the check this document exists for |
| `lastBackupAt` past the scheduled time | a schedule that never fires | reads the property; needs one real firing |
| Retention: oldest backup disappears | a retention setting that does nothing | **unproven** — needs `retain + 1` runs |
| Target host is outside the cluster | the circular-dependency trap | reads the property, but only at configuration time |
| Reachability from a pod | node-level firewall or routing gaps | reads a proxy: covers one node, not all of them |

Nothing in this table has been observed failing, because the document has not been run. Every "reads the property" claim is reasoning, not evidence, until someone breaks the thing on purpose — point the target at a bucket that does not exist, corrupt a backup, stop the NFS export mid-restore — and records what each check said.

## Verification checklist

- [ ] The backup target host is **not** served by this cluster (`getent hosts <BACKUP_HOST>` returns an address outside the MetalLB pool)
- [ ] `kubectl -n longhorn-system get backuptargets.longhorn.io default -o jsonpath='{.status.available}'` prints `true`
- [ ] A manual backup reaches `STATE: Completed` — noting this proves upload only
- [ ] **A restore into a differently-named PVC produces byte-identical checksums to the original**
- [ ] `kubectl -n longhorn-system get recurringjobs` lists the job, and every volume you expect appears in the `default` group
- [ ] `lastBackupAt` on a volume moves past a scheduled cron time you waited through
- [ ] Credentials live in a secret in `longhorn-system`, and the plaintext is not in anyone's shell history
- [ ] The restore procedure is written down somewhere reachable **when the cluster is down** — a runbook stored only on this cluster is not available during the outage it is for
- [ ] Retention marked as configured-but-unproven until `retain + 1` runs have passed

## Rollback

Removing the target stops backups; it does not delete what is already stored.

```bash
kubectl -n longhorn-system delete recurringjob daily-backup hourly-snapshot
```

```bash
kubectl -n longhorn-system patch settings.longhorn.io backup-target --type=merge -p '{"value":""}'
kubectl -n longhorn-system delete secret longhorn-backup-secret
```

```bash
kubectl -n longhorn-system get backups     # empty now — Longhorn lists from the target
```

The backups still exist in the bucket or the export. Clearing the setting only disconnects Longhorn from them, and re-pointing at the same target brings the list back. Deleting the data is a separate, deliberate act on `<BACKUP_HOST>` — which is the correct shape for a rollback of a backup system.

## Failure points documented upstream

Drafted from Longhorn's documentation. **None of these have been hit here**, because this document has not been run.

**Credential secret outside `longhorn-system`** — invisible to Longhorn; the target reports unavailable while the secret plainly exists. Section 1A. ([Longhorn — set up a backup target](https://longhorn.io/docs/1.7.2/snapshots-and-backups/backup-and-restore/set-backup-target/))

**`AWS_ENDPOINTS` without a scheme or port** — the endpoint never resolves and the failure reads as a connectivity problem rather than a malformed value. Section 1A.

**Missing `AWS_CERT` for self-signed MinIO** — TLS handshake failures inside longhorn-manager, not visible from a workstation that already trusts the CA. Section 1A.

**NFS export not v4, or squashing the pod's identity** — mounts that work interactively fail from Longhorn's pods. Section 1B.

**Assuming `groups: [default]` covers every volume** — a volume with an explicit group is excluded, quietly, forever. Section 4.

**Restoring over the original PVC** — destroys the evidence and turns a no-op restore into an apparent success. Section 5.

**CSI snapshot CRDs absent** — `no matches for kind "VolumeSnapshotClass"`. kubeadm does not install them and Longhorn does not bundle them. Section 5.

## Follow-ups

- [ ] Break it deliberately: point at a non-existent bucket, stop the NFS export mid-restore, corrupt a backup — and record what each check said 📅 2026-09-30
- [ ] Restore into a **different cluster**, which is the only test of the property this document actually claims
- [ ] Install the CSI external-snapshotter and pin its version here, or document the UI restore path instead
- [ ] Alert on `lastBackupAt` falling behind — a schedule that stops firing is silent otherwise
- [ ] Store the restore procedure somewhere that does not depend on this cluster being up

## Related

[[longhorn-storage-onprem]] — the storage this backs up. Answers the backup-target follow-up left open there.
[[k8s-node-drain-replace]] — replica movement during maintenance is a different problem from backups, and is not a substitute for them.
[[onprem-3node-kubeadm-ubuntu]] — the cluster underneath, and the source of the CSI-CRD gap in section 5.
[[2026-08-08-weekly]] — the review that named the defect this document's check table is written against.
