---
title: Longhorn on an on-prem cluster — replicated block storage from node disks
date: 2026-08-07
domain: install
tags: [on-prem, storage, bare-metal]
stack: [kubernetes, longhorn, helm, kubectl, open-iscsi]
summary: Turn the disks already in your nodes into replicated PersistentVolumes, so a PVC stops sitting at Pending. Count schedulable nodes rather than machines — a replica count above that gives you volumes that mount, serve data, and stay degraded forever.
source: handson
env: Kubernetes 1.31.14 (kubeadm) · Longhorn 1.7.2 · Helm 3.21 · Ubuntu 24.04.4 LTS · containerd 2.2.1 — run on 3× AWS EC2 t3.medium with a 20 GB EBS data disk each, not on bare metal
verified: 2026-08-08
verifiability: partial
verifiability-note: Ran on EC2 with EBS data disks. Real disk controllers, and a multipathd that is genuinely in use, stay unproven.
duration: 30–45 min
risk: medium
---

> **Verified 2026-08-08 on three EC2 instances, each with a dedicated 20 GB disk.** Storage is the one
> thing EC2 rehearses honestly — real block devices, real iSCSI, real replication across machines.
> Three things in the original draft were wrong: the replica count cannot be met on the cluster the
> companion runbook builds, `multipathd` does not stay stopped, and §3 is a no-op. See
> [Where this bit us](#where-this-bit-us). The harness is at
> `terraform-aws-lab/lab20-onprem-k8s-verify` with `attach_data_volumes = true`.

A cluster with no StorageClass answers every PVC with `Pending`. On a cloud provider a CSI driver comes with the platform; on your own hardware the disks are already in the machines and nothing is presenting them to Kubernetes. Longhorn does that — it takes local disk space on each node, replicates a volume across nodes, and exposes it over iSCSI to whichever node the pod lands on.

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]] — three nodes, Calico, one flat LAN.

**Understand the trade before installing.** Longhorn is replicated, not shared: each volume is copied to N nodes, so usable capacity is roughly raw capacity divided by the replica count. Three replicas across three nodes means you keep a third of your disks. That is the price of surviving a node loss without a SAN.

## Capacity planning — do this before installing

| Input | Value | Notes |
|---|---|---|
| Nodes contributing disk | **2**, not 3 | see below — the control plane keeps its taint |
| Raw space per node | `<GB>` | reserve 25% headroom; Longhorn refuses to schedule onto a nearly full disk |
| Default replica count | 2 | must not exceed the number of *schedulable* nodes |
| **Usable** | ≈ raw ÷ replica count | before the headroom reservation |

> **Count schedulable nodes, not nodes.** `longhorn-manager` is a DaemonSet with no control-plane
> toleration, so on the cluster [[onprem-3node-kubeadm-ubuntu]] builds it runs on the two workers
> only — the control plane keeps its `NoSchedule` taint, and that document recommends leaving it
> there. Three machines therefore give Longhorn **two** disks. Asking for three replicas on that
> cluster produces a volume that attaches, mounts, serves data, and is permanently `degraded`:
>
> ```
> ROBUSTNESS: degraded     reason: ReplicaSchedulingFailure
> ```
>
> Nothing ever repairs it, because the third replica has nowhere to go. Check before installing:
>
> ```bash
> kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
> ```
>
> Either set `defaultReplicaCount` to the number of untainted nodes (2 here, and the commands below
> do), or remove the control-plane taint and accept storage replication competing with etcd. Two
> replicas still survives one node failure; it is a second failure *during a rebuild* that loses the
> volume.
>
> **That second option is not free elsewhere.** The taint is decided in
> [[onprem-3node-kubeadm-ubuntu]] section 6.1, which recommends keeping it on a 4 GB control plane,
> and [[argocd-helm-ha-install]] wants three schedulable nodes for `redis-ha`. On three machines you
> cannot keep the taint, run Longhorn at three replicas, and run Argo CD HA — pick two, or add a
> machine. [[schedulable-node-budget]] is where that decision gets made once instead of per add-on.

`environment_check.sh` in step 1.4 has the same blind spot — its pods do not tolerate the taint
either, so it reports on two nodes and says nothing about the third. That is consistent with where
Longhorn will actually run, but it is not the "every node" the script's output implies.

Longhorn stores everything under `/var/lib/longhorn` by default, which is on the **root filesystem** on a stock Ubuntu install. A volume that fills up then takes down kubelet and containerd along with it. Mount a dedicated disk or partition there before installing — see step 2.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster healthy | `kubectl get nodes` | all `Ready` |
| Helm | `helm version --short` | v3.x |
| iSCSI daemon on every node | `systemctl is-active iscsid` | `active` |
| NFSv4 client on every node | `dpkg -l nfs-common \| tail -1` | installed (needed for RWX volumes) |
| Free disk space per node | `df -h /var/lib/longhorn` | the capacity you planned |
| No multipathd claiming devices | `systemctl is-active multipathd` | `inactive`, or blacklisted (see step 1.2) |

---

## 1. Node preparation — run on all three nodes

### 1.1 iSCSI and NFS clients

Longhorn attaches volumes over iSCSI from inside the node. Without `open-iscsi`, volumes are created and then fail to attach with `iscsiadm: not found` — the most common Longhorn install failure by a wide margin.

```bash
sudo apt-get update
sudo apt-get install -y open-iscsi nfs-common util-linux
sudo systemctl enable --now iscsid
```

```bash
sudo modprobe iscsi_tcp
echo iscsi_tcp | sudo tee /etc/modules-load.d/iscsi_tcp.conf
```

```bash
systemctl is-active iscsid
lsmod | grep iscsi_tcp
```

`nfs-common` is only needed for `ReadWriteMany` volumes, which Longhorn serves through an NFS share-manager pod. Install it now anyway — discovering it is missing later means an RWX PVC that hangs with no obvious cause.

- Source: [Longhorn — installation requirements](https://longhorn.io/docs/1.7.2/deploy/install/#installation-requirements)

### 1.2 Keep multipathd off Longhorn devices

If `multipathd` is running, it can claim the block devices Longhorn creates, and volume mounts then fail with a device-busy error that points nowhere useful.

```bash
systemctl is-active multipathd
```

If it is active and you need it for other storage, blacklist Longhorn's devices rather than disabling the service:

```bash
cat <<'EOF' | sudo tee -a /etc/multipath.conf
blacklist {
    devnode "^sd[a-z0-9]+"
}
EOF
sudo systemctl restart multipathd
```

If nothing else on the node uses multipath, turning it off is simpler and has fewer moving parts —
but **the service alone is not enough.** `multipathd` is socket-activated, so stopping the service
lets `multipathd.socket` start it straight back up. Ubuntu 24.04 ships it running:

```bash
sudo systemctl disable --now multipathd.socket
sudo systemctl disable --now multipathd
```

```bash
systemctl is-active multipathd multipathd.socket    # both must say inactive
```

Doing only the second line leaves `is-active` reporting `active` seconds later, with
`systemctl status` explaining why in a line that is easy to read past:

```
Loaded: loaded (/usr/lib/systemd/system/multipathd.service; disabled; preset: enabled)
Active: active (running)
TriggeredBy: ● multipathd.socket
```

Note also that the blacklist above matches `^sd[a-z0-9]+` and therefore covers nothing on a machine
whose disks are NVMe. Check `lsblk` and widen it to `^(sd[a-z0-9]+|nvme[0-9]+n[0-9]+)` if that is
what you have.

- Source: [Longhorn troubleshooting — volume with multipath](https://longhorn.io/kb/troubleshooting-volume-with-multipath/)

### 1.3 Optional but recommended — a dedicated disk

Skip this only if the root filesystem genuinely has room to spare. Assuming a second disk at `<DISK_DEV>` (check with `lsblk`):

```bash
lsblk
```

```bash
sudo mkfs.ext4 /dev/<DISK_DEV>
sudo mkdir -p /var/lib/longhorn
echo "/dev/<DISK_DEV>  /var/lib/longhorn  ext4  defaults  0 2" | sudo tee -a /etc/fstab
sudo mount -a
```

```bash
df -h /var/lib/longhorn
findmnt /var/lib/longhorn
```

Use the disk UUID rather than `/dev/sdX` in `/etc/fstab` if the machine has several disks — device names are not stable across reboots, and a wrong mount here silently puts Longhorn data back on the root disk.

```bash
sudo blkid /dev/<DISK_DEV>      # take UUID= and use that in fstab instead
```

### 1.4 Environment check

Longhorn ships a script that verifies every prerequisite across all nodes at once. Run it before installing — it is far cheaper than reading pod logs afterwards.

```bash
export LONGHORN_VERSION=v1.7.2
curl -sSfL https://raw.githubusercontent.com/longhorn/longhorn/${LONGHORN_VERSION}/scripts/environment_check.sh | bash
```

Check the [releases page](https://github.com/longhorn/longhorn/releases) for the current version; this document was drafted against the 1.7 line. Record what you actually installed in this document's `env`.

Every node must pass. A warning about `nfs` only matters if you intend to use RWX volumes; anything about iSCSI is a hard stop — go back to step 1.1.

---

## 2. Install Longhorn

The prerequisite table asks for Helm 3 and nothing above installs it — a kubeadm node has no Helm.
On the control plane:

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash
helm version --short
```

```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update longhorn
```

```bash
helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --version 1.7.2 \
  --set defaultSettings.defaultDataPath=/var/lib/longhorn \
  --set defaultSettings.defaultReplicaCount=2 \
  --set defaultSettings.storageOverProvisioningPercentage=100 \
  --set defaultSettings.storageMinimalAvailablePercentage=25 \
  --wait --timeout 10m
```

Why these settings rather than the defaults:

- `storageOverProvisioningPercentage=100` — the chart default allows provisioning beyond physical capacity, which is fine until every volume fills at once and every node runs out of disk together. On three nodes, do not oversubscribe.
- `storageMinimalAvailablePercentage=25` — stops Longhorn scheduling replicas onto a nearly full disk. The default is lower; a full `/var/lib/longhorn` takes kubelet with it.
- `defaultReplicaCount=2` — explicit, so it does not silently change when the chart default does, and
  set to the number of *schedulable* nodes rather than the number of machines. See the capacity
  section; asking for 3 here on a cluster with a tainted control plane gives you volumes that are
  `degraded` from birth and never recover.

```bash
kubectl -n longhorn-system get pods -o wide
```

Expect `longhorn-manager` as a DaemonSet (one per node), plus `longhorn-driver-deployer`, `csi-attacher`, `csi-provisioner`, `csi-resizer`, `csi-snapshotter`, and `instance-manager` pods. First start pulls several images and takes a few minutes.

```bash
kubectl -n longhorn-system rollout status daemonset longhorn-manager --timeout=300s
```

```bash
kubectl get storageclass
```

The chart creates a `longhorn` StorageClass. Confirm each node registered its disk:

```bash
kubectl -n longhorn-system get nodes.longhorn.io
kubectl -n longhorn-system get nodes.longhorn.io -o custom-columns=\
'NODE:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,SCHEDULABLE:.spec.allowScheduling'
```

A node showing `Ready: False` here has a disk problem — wrong path, no space, or `/var/lib/longhorn` not mounted where you think it is.

---

## 3. Confirm the default StorageClass

Until a default exists, every PVC without an explicit `storageClassName` stays `Pending` — which is the exact symptom this document is meant to remove.

**Chart 1.7.2 already marks `longhorn` as the default**, so this is a check, not a step. It also
creates a second class, `longhorn-static`, which is not the default and is not used here.

```bash
kubectl get storageclass
```

Patch it only if the annotation is missing — on 1.7.2 the command returns `patched (no change)`:

```bash
kubectl patch storageclass longhorn \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

```bash
kubectl get storageclass
```

`longhorn (default)` should appear. If another StorageClass is already marked default, unset it first — two defaults make PVC binding non-deterministic:

```bash
kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}{end}'
```

---

## 4. Reach the UI — and lock it down first

The Longhorn UI shows volume health, replica placement, and rebuild progress. It is the fastest way to understand what the cluster is doing with your disks.

> **The UI ships with no authentication.** Anyone who can reach it can delete every volume in the cluster. Do not put it on a LoadBalancer address without putting auth in front of it.

For a quick look, port-forward — nothing is exposed and it dies with the terminal:

```bash
kubectl -n longhorn-system port-forward svc/longhorn-frontend 8080:80
```

Then open `http://localhost:8080`.

For permanent access, front it with an ingress carrying basic auth. With [[metallb-l2-onprem]] in place an ingress controller can hold a LAN address, and Longhorn's own documentation covers the basic-auth secret:

```bash
# htpasswd -c auth <USER>   — then create the secret from that file
kubectl -n longhorn-system create secret generic basic-auth --from-file=auth
```

- Source: [Longhorn — create an ingress with basic authentication](https://longhorn.io/docs/1.7.2/deploy/accessing-the-ui/longhorn-ingress/)

---

## 5. Verify with a real volume

A running pod list proves nothing about storage. The test that matters is: write data, kill the pod, have it land on a different node, and still read the data back.

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lh-test
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: longhorn
  resources:
    requests:
      storage: 2Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: lh-writer
spec:
  containers:
    - name: shell
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: lh-test
EOF
```

```bash
kubectl get pvc lh-test
kubectl get pod lh-writer -o wide
```

The PVC must reach `Bound` and the pod `Running`. A PVC stuck at `Pending` — check the reason before anything else:

```bash
kubectl describe pvc lh-test | tail -20
```

Write something identifiable:

```bash
kubectl exec lh-writer -- sh -c 'echo "written at $(date -u +%FT%TZ) on $(hostname)" > /data/proof.txt; cat /data/proof.txt'
```

Confirm the replicas actually landed on three different nodes — this is the whole point of Longhorn, and it is the thing that quietly fails when a node is unschedulable:

```bash
kubectl -n longhorn-system get replicas.longhorn.io \
  -o custom-columns='REPLICA:.metadata.name,NODE:.spec.nodeID,STATE:.status.currentState'
```

One entry per replica, each on a distinct node, all `running`. With `defaultReplicaCount=2` on this
cluster that is two entries — and a replica row with an **empty `NODE` and `stopped` state is the
scheduling failure described in the capacity section**, not a transient:

```bash
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

`attached` / `healthy` is the goal. `attached` / `degraded` means a replica could not be placed —
the volume works and has less redundancy than you asked for, quietly, forever.

### The test that counts — move the pod to another node

```bash
NODE=$(kubectl get pod lh-writer -o jsonpath='{.spec.nodeName}')
echo "currently on $NODE"
kubectl cordon "$NODE"
kubectl delete pod lh-writer
```

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: lh-writer
spec:
  containers:
    - name: shell
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: lh-test
EOF
```

```bash
kubectl get pod lh-writer -o wide          # must be on a different node now
kubectl exec lh-writer -- cat /data/proof.txt
```

The same line, on a different node. That is replicated storage doing its job.

```bash
kubectl uncordon "$NODE"
```

### Clean up

```bash
kubectl delete pod lh-writer
kubectl delete pvc lh-test
```

```bash
kubectl -n longhorn-system get volumes.longhorn.io
```

The volume should disappear — the default reclaim policy is `Delete`. If it lingers, that is a `Retain` StorageClass or a stuck finalizer, and it will quietly consume disk forever.

---

## Verification checklist

- [ ] `systemctl is-active iscsid` returns `active` on every node that will hold replicas
- [ ] `systemctl is-active multipathd multipathd.socket` — **both** `inactive`
- [ ] `environment_check.sh` passes — and the node count it reports matches your schedulable nodes
- [ ] `kubectl -n longhorn-system get pods` — all `Running`, one `longhorn-manager` per schedulable node
- [ ] `kubectl -n longhorn-system get nodes.longhorn.io` — every node listed is `Ready` and schedulable
- [ ] `defaultReplicaCount` ≤ the number of untainted nodes
- [ ] `kubectl get storageclass` shows `longhorn (default)`, and only one default
- [ ] `findmnt /var/lib/longhorn` shows the dedicated disk, not the root filesystem
- [ ] A PVC reaches `Bound` without an explicit `storageClassName`
- [ ] Replicas for a test volume sit on distinct nodes, and the volume is `healthy` — not `degraded`
- [ ] Data survives the pod moving to another node
- [ ] Deleting the PVC removes the Longhorn volume (allow ~10s; it is not instant)
- [ ] Reboot one node — it rejoins, `/var/lib/longhorn` remounts from `/etc/fstab`, replicas rebuild
- [ ] The UI is not reachable from the LAN without authentication

---

## Rollback

**Uninstalling deletes every Longhorn volume and the data on it.** There is no undo. Take backups off the cluster first if any of it matters.

Longhorn deliberately blocks deletion until you confirm:

```bash
kubectl -n longhorn-system patch settings.longhorn.io deleting-confirmation-flag \
  --type=merge -p '{"value":"true"}'
```

```bash
helm uninstall longhorn -n longhorn-system
kubectl delete namespace longhorn-system
```

Without that flag the uninstall hangs with the namespace in `Terminating` and the CRDs still present — which reads like a stuck finalizer but is the guard working as designed.

```bash
kubectl get crd | grep longhorn      # should be empty when the removal completed
```

Node cleanup, if you are removing it permanently:

```bash
sudo rm -rf /var/lib/longhorn/*
sudo systemctl disable --now iscsid   # only if nothing else on the node uses iSCSI
```

- Source: [Longhorn — uninstall](https://longhorn.io/docs/1.7.2/deploy/uninstall/)

---

## Where this bit us

Three failures on the 2026-08-08 run.

**A volume that worked perfectly and was `degraded` the whole time.** The PVC bound, the pod ran, the
data was written and read back — and `robustness: degraded`, `ReplicaSchedulingFailure`, because this
document asked for three replicas on a cluster with two schedulable nodes. Nothing alerts on it and
nothing repairs it; you find out when a node dies and the redundancy you were paying for is not
there. The irony is that this document's own upstream-failures list names *"replica count above the
number of schedulable nodes"* while the install command underneath it did exactly that. Fixed in the
capacity section and in step 2.

**`multipathd` came straight back after being disabled.** `systemctl disable --now multipathd`
returns cleanly and `is-active` says `active` a moment later — it is socket-activated, and
`multipathd.socket` was still there. Ubuntu 24.04 ships it enabled, so this branch of step 1.2 is
not the rare case the wording implies. Step 1.2 now stops the socket first.

**Step 3 was a no-op.** Chart 1.7.2 already annotates `longhorn` as the default StorageClass, so the
patch returns `patched (no change)`. Harmless, but the section was written as though PVCs would stay
`Pending` without it, which sends anyone debugging a genuinely `Pending` PVC down the wrong path.

Two smaller things: Helm is a prerequisite that nothing installed, and `environment_check.sh` quietly
reports on schedulable nodes only.

What went right, for the record: `open-iscsi` and `iscsi_tcp` behaved exactly as described; the
dedicated disk mounted from `/etc/fstab` and survived a reboot; a pod moved to another node read back
the same file; and deleting the PVC removed the Longhorn volume, about ten seconds later rather than
immediately.

## Failure points documented upstream

These come from Longhorn's documentation and knowledge base, and were not hit on the run above.

**`open-iscsi` missing** — volumes are created and never attach; the pod stays `ContainerCreating` and the event says `iscsiadm: not found`. The single most common install failure. Step 1.1. ([Installation requirements](https://longhorn.io/docs/1.7.2/deploy/install/#installation-requirements))

**multipathd claiming the device** — the mount fails with a device-busy error that names a `/dev/sd*` path rather than anything Longhorn-shaped. Step 1.2. ([Troubleshooting: volume with multipath](https://longhorn.io/kb/troubleshooting-volume-with-multipath/))

**Replica count above the number of schedulable nodes** — hit on the first run; moved up to
[Where this bit us](#where-this-bit-us). Draining a node for maintenance reproduces it temporarily.
See [[k8s-node-drain-replace]] before draining a node that holds replicas.

**`/var/lib/longhorn` on the root filesystem** — a volume that fills the disk takes kubelet and containerd down with it, so the failure looks like a node problem rather than a storage one. Step 1.3.

**Over-provisioning** — the chart default permits allocating more than the disks hold. It works until several volumes grow at once. Step 2.

**Uninstall hanging** — `deleting-confirmation-flag` not set. Rollback section.

**RWX volume hanging** — `nfs-common` missing, so the share-manager pod cannot serve the volume. Step 1.1.

---

## Follow-ups

- [ ] Re-run on real hardware — EC2 gave real block devices and real iSCSI, but not real disk controllers, and `multipathd` matters more where multipath is genuinely in use 📅 2026-09-30
- [ ] Configure a backup target — Longhorn snapshots live on the same disks as the data, so they are not a backup. S3 or an NFS share off the cluster. Procedure drafted in [[longhorn-backup-target-onprem]], not yet run
- [ ] Put basic auth or an ingress with real authentication in front of the UI before anyone else needs it
- [ ] Decide the replica count per workload rather than globally — a rebuildable cache does not need three copies
- [ ] Write a runbook for planned node maintenance with replicas in play, since draining is no longer a pure Kubernetes operation

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on. This document answers the storage follow-up left open there.
[[metallb-l2-onprem]] — needed if the UI or any storage-backed service should hold a LAN address.
[[k8s-node-drain-replace]] — draining a node now moves storage replicas, not just pods. Read this first.
[[pod-crashloopbackoff]] — a PVC stuck at `Pending` shows up there as a pod that never leaves `ContainerCreating`.
