---
title: Draining and replacing a production node
date: 2026-08-07
domain: runbook
tags: [maintenance, capacity, kubernetes]
stack: [kubernetes, kubectl, aws-eks, terraform]
summary: Empty a live worker node and swap in a new one without downtime. The PDB pre-check and the abort criteria are half the procedure.
source: handson
env: Kubernetes 1.31 (EKS) · Managed Node Group · kubectl 1.31
verified: 2026-08-07
duration: 20–40 min per node
risk: high
---

The same procedure covers kernel patching, instance type changes, AMI refreshes, and clearing out a zombie node. **One node at a time**, always. Two half-drained nodes stuck behind a PDB is the hardest state to recover from.

> This procedure is reversible up to step 3. After step 4 (node deletion) the only move left is waiting for the replacement.

## Pre-checks (before the maintenance window, not during)

### 1. Spare capacity

Confirm the remaining nodes can absorb this one's load.

```bash
kubectl top nodes
kubectl describe node <NODE> | grep -A5 "Allocated resources"
```

If the CPU/memory requests on the surviving nodes would land above 90%, **add capacity first**. Waiting on a scale-out mid-drain is an incident, not a maintenance step.

### 2. PodDisruptionBudgets — the step that matters most

```bash
kubectl get pdb -A
```

Any PDB showing `ALLOWED DISRUPTIONS` of `0` will stall the drain on that pod indefinitely.

```bash
# which pods on this node are covered by a PDB
kubectl get pods --field-selector spec.nodeName=<NODE> -A \
  -o custom-columns='NS:.metadata.namespace,POD:.metadata.name,OWNER:.metadata.ownerReferences[0].kind'
```

Common causes of `ALLOWED DISRUPTIONS = 0`:

| Cause | Check | Action |
|---|---|---|
| replicas=1 with `minAvailable: 1` | `kubectl get deploy <NAME>` | temporarily scale to 2 for the window |
| one pod already unhealthy | `kubectl get pods -l <SELECTOR>` | fix that pod first |
| single-instance StatefulSet | `kubectl get sts` | agree a downtime window with the owning team |

### 3. What only exists on this node

```bash
# pods using emptyDir or hostPath — draining destroys that data
kubectl get pods --field-selector spec.nodeName=<NODE> -A -o json | \
  jq -r '.items[] | select(.spec.volumes[]?|has("emptyDir") or has("hostPath")) |
         "\(.metadata.namespace)/\(.metadata.name)"'
```

Tell the owning teams about anything listed here. Without `--delete-emptydir-data` the drain refuses; with it the data is gone. Picking one of those quietly is not an option.

### 4. Communication

- Change ticket number in hand
- Start and end announced in the owning channel, with expected duration and rollback conditions
- Silence alerts **for this node only**, always with an expiry

## Execution

### Step 1 — cordon (reversible)

Stops new pods scheduling here. Everything already running keeps running.

```bash
kubectl cordon <NODE>
kubectl get node <NODE>          # STATUS: Ready,SchedulingDisabled
```

Rollback: `kubectl uncordon <NODE>`

### Step 2 — drain (reversible, but reversing causes another reshuffle)

```bash
kubectl drain <NODE> \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120 \
  --timeout=15m \
  --skip-wait-for-delete-timeout=60
```

Why each flag is there:

- `--ignore-daemonsets` — DaemonSet pods cannot move anywhere else. Without this the drain refuses immediately.
- `--delete-emptydir-data` — only after pre-check 3 confirmed and agreed it.
- `--grace-period=120` — larger than your longest `terminationGracePeriodSeconds`. Too short and connections get cut.
- `--timeout=15m` — prevents an unbounded wait. If it trips, a human needs to decide.

**When the drain looks stuck**, watch from another terminal. Do not stare at the log — look at the cause.

```bash
kubectl get pods --field-selector spec.nodeName=<NODE> -A -w
kubectl get events -A --sort-by=.lastTimestamp | grep -i evict | tail
```

`Cannot evict pod as it would violate the pod's disruption budget` sends you back to pre-check 2.

### Step 3 — confirm it is empty (last reversible point)

```bash
kubectl get pods --field-selector spec.nodeName=<NODE> -A \
  --field-selector status.phase!=Succeeded,status.phase!=Failed
```

Only DaemonSet and static pods should remain. If anything else is there, **do not proceed**.

Also check that the evicted pods are actually serving, not merely scheduled.

```bash
kubectl get pods -A -o wide | grep -v Running | grep -v Completed
```

Look at service metrics here (error rate, p99). If they moved against baseline, stop, `uncordon`, and find out why.

### Step 4 — remove the node (not reversible)

On a managed node group, terminate the instance and let the ASG bring up a replacement.

```bash
# EKS managed node group — resolve the instance ID
INSTANCE_ID=$(kubectl get node <NODE> -o jsonpath='{.spec.providerID}' | awk -F/ '{print $NF}')
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
```

If this is managed by IaC, do not delete it from the console or CLI — handle it through Terraform. An instance removed by hand comes back as drift on the next `terraform plan`.

```bash
terraform plan -target=module.eks.module.eks_managed_node_group
```

### Step 5 — verify the replacement

```bash
kubectl get nodes -w        # wait for the new node to reach Ready
kubectl get node <NEW_NODE> -o jsonpath='{.status.nodeInfo.kubeletVersion}{"\n"}'
kubectl get node <NEW_NODE> -o jsonpath='{.metadata.labels}' | jq
```

If the old node object lingers as `NotReady`, clean it up.

```bash
kubectl delete node <NODE>
```

## Abort criteria (any one of these — stop and uncordon)

- Drain past 15 minutes with no identified cause
- An evicted pod sitting `Pending` on another node — that is a capacity signal
- Service error rate visibly above baseline
- `MemoryPressure` on any remaining node
- Replacement node not `Ready` within 10 minutes

After aborting, write down why. Aborting twice for the same reason is a problem with the procedure, not with the day.

## Verification checklist

- [ ] All nodes `Ready`, none `SchedulingDisabled`
- [ ] `kubectl get pods -A | grep -v Running | grep -v Completed` comes back empty
- [ ] New node's kubelet version, labels, and taints match the old one
- [ ] DaemonSets show `DESIRED == READY`
- [ ] Service dashboard error rate and p99 back to pre-maintenance levels
- [ ] Alert silence lifted
- [ ] Change ticket closed with an end record

## Follow-ups

- [ ] Scale back the workloads that were temporarily bumped to 2 replicas 📅 2026-08-08
- [ ] Hand the teams the list of services that showed `ALLOWED DISRUPTIONS = 0`

## Related

[[pod-crashloopbackoff]] — when pods die as soon as they land on the new node.
[[argocd-helm-ha-install]] — the Argo CD controller runs at 1 replica, so syncing pauses briefly during this procedure. Confirm recovery with `argocd app list` right after the drain.
