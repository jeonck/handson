---
title: Longhorn on an on-prem cluster — replicated block storage from node disks
date: 2026-08-07
domain: install
tags: [on-prem, storage, bare-metal]
stack: [kubernetes, longhorn, helm, kubectl, open-iscsi]
summary: Turn the disks already in your three nodes into replicated PersistentVolumes, so a PVC stops sitting at Pending. The iSCSI prerequisite and the replica count against node count decide whether volumes attach at all.
source: handson
env: Target — Kubernetes 1.31 (kubeadm, on-prem) · Longhorn 1.7 · Ubuntu 24.04 LTS · containerd 1.7
verified:
duration: 30–45 min
risk: medium
---

> ⚠️ **This procedure has not been executed in this environment yet.** It is assembled from upstream
> Longhorn documentation, so `verified` is empty and the site lists it as needing verification. Run it
> once on the real cluster, then fill in `verified` and correct whatever was wrong.

A cluster with no StorageClass answers every PVC with `Pending`. On a cloud provider a CSI driver comes with the platform; on your own hardware the disks are already in the machines and nothing is presenting them to Kubernetes. Longhorn does that — it takes local disk space on each node, replicates a volume across nodes, and exposes it over iSCSI to whichever node the pod lands on.

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]] — three nodes, Calico, one flat LAN.

**Understand the trade before installing.** Longhorn is replicated, not shared: each volume is copied to N nodes, so usable capacity is roughly raw capacity divided by the replica count. Three replicas across three nodes means you keep a third of your disks. That is the price of surviving a node loss without a SAN.

## Capacity planning — do this before installing

| Input | Value | Notes |
|---|---|---|
| Nodes contributing disk | 3 | one replica per node at replica count 3 |
| Raw space per node | `<GB>` | reserve 25% headroom; Longhorn refuses to schedule onto a nearly full disk |
| Default replica count | 3 | one per node — a node loss keeps two |
| **Usable** | ≈ raw ÷ 3 | before the headroom reservation |

Two replicas keeps more space and still survives one node failure, but a second failure during a rebuild loses the volume. On three nodes, keep three replicas and size the disks accordingly.

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

If nothing else on the node uses multipath, turning it off is simpler and has fewer moving parts:

```bash
sudo systemctl disable --now multipathd
```

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
  --set defaultSettings.defaultReplicaCount=3 \
  --set defaultSettings.storageOverProvisioningPercentage=100 \
  --set defaultSettings.storageMinimalAvailablePercentage=25 \
  --wait --timeout 10m
```

Why these settings rather than the defaults:

- `storageOverProvisioningPercentage=100` — the chart default allows provisioning beyond physical capacity, which is fine until every volume fills at once and every node runs out of disk together. On three nodes, do not oversubscribe.
- `storageMinimalAvailablePercentage=25` — stops Longhorn scheduling replicas onto a nearly full disk. The default is lower; a full `/var/lib/longhorn` takes kubelet with it.
- `defaultReplicaCount=3` — explicit, so it does not silently change when the chart default does.

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

## 3. Make it the default StorageClass

Until a default exists, every PVC without an explicit `storageClassName` stays `Pending` — which is the exact symptom this document is meant to remove.

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

Three entries, three distinct `NODE` values, all `running`.

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

- [ ] `systemctl is-active iscsid` returns `active` on all three nodes
- [ ] `environment_check.sh` passes on every node
- [ ] `kubectl -n longhorn-system get pods` — all `Running`, one `longhorn-manager` per node
- [ ] `kubectl -n longhorn-system get nodes.longhorn.io` — every node `Ready` and schedulable
- [ ] `kubectl get storageclass` shows `longhorn (default)`, and only one default
- [ ] `findmnt /var/lib/longhorn` shows the dedicated disk, not the root filesystem
- [ ] A PVC reaches `Bound` without an explicit `storageClassName`
- [ ] Replicas for a test volume sit on three distinct nodes
- [ ] Data survives the pod moving to another node
- [ ] Deleting the PVC removes the Longhorn volume
- [ ] Reboot one node — it rejoins, replicas rebuild, volumes return to `Healthy`
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

## Failure points documented upstream

**This is not "where this bit us" — nobody has run this here yet.** These come from Longhorn's documentation and knowledge base. Replace them with what actually happened on your first run.

**`open-iscsi` missing** — volumes are created and never attach; the pod stays `ContainerCreating` and the event says `iscsiadm: not found`. The single most common install failure. Step 1.1. ([Installation requirements](https://longhorn.io/docs/1.7.2/deploy/install/#installation-requirements))

**multipathd claiming the device** — the mount fails with a device-busy error that names a `/dev/sd*` path rather than anything Longhorn-shaped. Step 1.2. ([Troubleshooting: volume with multipath](https://longhorn.io/kb/troubleshooting-volume-with-multipath/))

**Replica count above the number of schedulable nodes** — volumes come up `Degraded` and stay there, because a replica cannot be placed. On three nodes, draining one for maintenance has the same effect until it returns. See [[k8s-node-drain-replace]] before draining a node that holds replicas.

**`/var/lib/longhorn` on the root filesystem** — a volume that fills the disk takes kubelet and containerd down with it, so the failure looks like a node problem rather than a storage one. Step 1.3.

**Over-provisioning** — the chart default permits allocating more than the disks hold. It works until several volumes grow at once. Step 2.

**Uninstall hanging** — `deleting-confirmation-flag` not set. Rollback section.

**RWX volume hanging** — `nfs-common` missing, so the share-manager pod cannot serve the volume. Step 1.1.

---

## Follow-ups

- [ ] Run this on the real cluster, correct it, and set `verified`
- [ ] Configure a backup target — Longhorn snapshots live on the same disks as the data, so they are not a backup. S3 or an NFS share off the cluster
- [ ] Put basic auth or an ingress with real authentication in front of the UI before anyone else needs it
- [ ] Decide the replica count per workload rather than globally — a rebuildable cache does not need three copies
- [ ] Write a runbook for planned node maintenance with replicas in play, since draining is no longer a pure Kubernetes operation

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on. This document answers the storage follow-up left open there.
[[metallb-l2-onprem]] — needed if the UI or any storage-backed service should hold a LAN address.
[[k8s-node-drain-replace]] — draining a node now moves storage replicas, not just pods. Read this first.
[[pod-crashloopbackoff]] — a PVC stuck at `Pending` shows up there as a pod that never leaves `ContainerCreating`.
