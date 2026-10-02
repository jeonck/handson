---
title: Draining a worker on the onprem two-node budget without losing Longhorn or Kafka redundancy
date: 2026-10-02
domain: runbook
tags: [maintenance, capacity, kubernetes, on-prem]
stack: [kubernetes, kubectl, longhorn, strimzi, kafka]
summary: The EKS drain runbook assumes an autoscaler replaces the node within minutes; this cluster's schedulable budget is 2 and nothing replaces it. What's safe to drain outright, and what the Kafka case still cannot answer.
source: standardize
env:
verified:
verifiability: field
verifiability-note: Needs the live onprem cluster with Longhorn and Kafka both installed and a real node taken down for maintenance. The Kafka branch additionally needs two real brokers under load to tell whether forcing a rebalance afterward actually redistributes them — no lab substitute proves that quickly.
duration: 20–40 min for a Longhorn-only node; open-ended for a node holding a Kafka pod, see the branch below
risk: high
---

> ⚠️ This runbook was synthesized from [[minio-object-storage-onprem]], [[kafka-strimzi-onprem]],
> [[longhorn-storage-onprem]] and [[schedulable-node-budget]]. Nobody has executed it in this order
> yet. Fill in `verified` after the first real run. The Kafka branch in particular rests on reasoning
> from those documents, not on anything observed — see the warning at that section.

[[k8s-node-drain-replace]] assumes a managed node group: drain, terminate, and an autoscaler hands
back the lost capacity in minutes. On the cluster [[onprem-3node-kubeadm-ubuntu]] builds there is no
autoscaler and no spare node — the schedulable budget is a standing **2**
([[schedulable-node-budget]]), and draining one of those two nodes takes it to **1** for however long
the node is gone. Three install guides independently hit this and pointed at
[[k8s-node-drain-replace]] without it actually answering their case:

- [[minio-object-storage-onprem]] — treats draining the node holding its one Longhorn replica as an
  outage, not a routine step, and defers planning it to [[k8s-node-drain-replace]].
- [[longhorn-storage-onprem]] — reproduces its own "replica count above schedulable nodes" failure
  every time a node carrying a replica is drained, and asks outright for "a runbook for planned node
  maintenance with replicas in play, since draining is no longer a pure Kubernetes operation."
- [[kafka-strimzi-onprem]] — states plainly that `kubectl drain` against a Kafka node is unsafe
  without the Strimzi Drain Cleaner (not installed here), because the generated PodDisruptionBudget
  does not move broker and controller pods in a quorum-safe order by itself. Its follow-up asks to
  "install the Strimzi Drain Cleaner, or write the manual pre-drain procedure into
  [[k8s-node-drain-replace]]" — overdue since 2026-09-30.

This document is that procedure, written as its own runbook rather than as an addition to
[[k8s-node-drain-replace]]: the two environments share no execution mechanics (no ASG, no Terraform,
no third node to absorb load), and bolting an onprem-stateful branch onto an EKS-managed-node-group
procedure would make both harder to follow.

**Use [[k8s-node-drain-replace]] for the generic cordon/drain/verify mechanics** — PDB checks,
watching a stuck drain, the abort signals. This document replaces that runbook's pre-check 1 (spare
capacity — there is none at budget 2) and step 4 (remove and replace the node — there is nothing to
replace it with), and inserts the branch below in its place.

## Pre-checks (before the maintenance window, not during)

### 1. Confirm the budget and what the target node carries

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

Must show exactly 2 untainted nodes, matching the standing decision in
[[schedulable-node-budget]]. If it does not, stop — every replica and replication-factor count this
procedure relies on assumes 2.

```bash
# Longhorn: which replicas live on the node you are about to drain
kubectl -n longhorn-system get replicas.longhorn.io \
  -o custom-columns='REPLICA:.metadata.name,NODE:.spec.nodeID,STATE:.status.currentState'
```

```bash
# Kafka: which broker/controller pods live on it, if Strimzi is installed on this cluster
kubectl -n kafka get pods -l strimzi.io/pool-name=broker -o wide
kubectl -n kafka get pods -l strimzi.io/pool-name=controller -o wide
```

The result of the second command decides which branch below applies. A node can carry both a
Longhorn replica and a Kafka pod at once — on a 2-node budget this is the common case, not the
exception.

### 2. Communication

Same as [[k8s-node-drain-replace]]: change ticket, who is told, alert silence scoped to this node
with an expiry. On this cluster also say **how long redundancy will be at zero** for whichever of
Longhorn or Kafka is affected — that number is real here, not a worst case, because there is no third
node to shorten it.

## Branch A — the node carries a Longhorn replica, no Kafka pod

This is the better-supported case: [[longhorn-storage-onprem]] and [[minio-object-storage-onprem]]
both describe what happens, even though neither ran it as a full `kubectl drain`.

### Step 1 — cordon and record the before state (reversible)

```bash
kubectl cordon <NODE>
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

Every volume should still read `attached` / `healthy` — cordoning alone does not move anything.

### Step 2 — drain

```bash
kubectl drain <NODE> \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120 \
  --timeout=15m
```

Pods that mounted a volume with its other replica on the surviving node reschedule there and keep
working. Watch the volumes, not just the pods:

```bash
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

**`degraded` here is the expected, correct state for the duration of the maintenance** — at budget 1
there is nowhere left for the missing replica to rebuild to. This is the same alarming-looking-but-
correct output [[longhorn-storage-onprem]] warns about elsewhere; do not treat it as a new failure.
It stops being correct only if it is still `degraded` after the node comes back (see verification).

### Step 3 — do the maintenance, then bring the node back

```bash
kubectl uncordon <NODE>
```

### Step 4 — confirm the replica rebuilt

```bash
kubectl -n longhorn-system get replicas.longhorn.io \
  -o custom-columns='REPLICA:.metadata.name,NODE:.spec.nodeID,STATE:.status.currentState'
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

Back to `healthy`, with a replica on the returned node. Rebuilding a volume that grew while the node
was away takes time proportional to its size — this is a real wait, not a stuck check; compare
against `kubectl -n longhorn-system get volumes.longhorn.io <VOL> -o yaml` for rebuild progress if it
runs long.

## Branch B — the node carries a Kafka broker or controller pod

> **Nothing in the sources confirms a safe procedure here.** [[kafka-strimzi-onprem]] states the
> problem (no Drain Cleaner, no quorum-safe eviction order, no anti-affinity stopping two brokers from
> landing on one machine) but was never run against a real drain — its own "Where this bit us" section
> says the document has not been run at all. What follows is reasoned from what the three source
> documents document about Strimzi's and the scheduler's behavior, not something watched succeed. Confirm
> it on the first real run, and do not treat it as equivalent in confidence to Branch A.

**Default: do not drain this node.** At budget 2 there is exactly one other node, and
[[kafka-strimzi-onprem]]'s own abort criteria call landing both brokers on one machine worse than
running at replication factor 1 — it costs the same and protects nothing. Without the Drain Cleaner,
a plain `kubectl drain` has no mechanism to prevent exactly that. Treat an unplanned need to drain a
Kafka-holding node as a reason to install the Strimzi Drain Cleaner first, not a reason to proceed
without it.

If the maintenance cannot wait:

### Step 1 — decide, explicitly, to accept zero Kafka redundancy for the window

This is the same shape as Longhorn's temporary `degraded` state, but Kafka has no automatic rebuild
once both copies are on one node — someone has to force the redistribution back afterward (step 4).
Record the decision in the change ticket, not just in this terminal.

### Step 2 — cordon and drain

```bash
kubectl cordon <NODE>
kubectl drain <NODE> \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120 \
  --timeout=15m
```

Immediately check where the evicted pods landed:

```bash
kubectl -n kafka get pods -l strimzi.io/pool-name=broker -o wide
kubectl -n kafka get pods -l strimzi.io/pool-name=controller -o wide
```

If both brokers now show the same `NODE`, that is the accepted-for-this-window state from step 1, not
a surprise.

### Step 3 — confirm the cluster is still serving, degraded

```bash
kubectl -n kafka run kafka-admin --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-topics.sh --bootstrap-server onprem-kafka-bootstrap:9092 \
    --describe --under-replicated-partitions
```

Non-empty output here is expected and correct while a broker is down — it is the same check
[[kafka-strimzi-onprem]] uses to prove replication is real, read in reverse. `Ready=True` on the
`Kafka` resource despite this is also expected; readiness and full replication are different
properties.

### Step 4 — bring the node back and force the rebalance

```bash
kubectl uncordon <NODE>
```

Uncordoning does not move anything that is already running. With no anti-affinity configured, the
only way to make the scheduler reconsider is to make the current placement unavailable:

```bash
# delete the stacked broker pod so it is rescheduled; it may land back on the same node,
# since nothing prevents that either — this is the open part of the procedure
kubectl -n kafka delete pod <STACKED_BROKER_POD>
kubectl -n kafka get pods -l strimzi.io/pool-name=broker -o wide
```

If it lands on the returned node, re-run the under-replicated check from step 3 until it reads empty.
If it lands back on the same node, repeat, or cordon the overloaded node briefly to force the
scheduler's hand — then uncordon it immediately after, since that node is also carrying the other
broker. **This loop, and whether it terminates in a reasonable number of tries, is exactly what the
first real run needs to record.**

### Step 5 — confirm full replication restored

```bash
kubectl -n kafka run kafka-admin --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-topics.sh --bootstrap-server onprem-kafka-bootstrap:9092 \
    --describe --under-replicated-partitions
```

Empty, with the two broker pods confirmed on distinct nodes by the `NODE` column — not by pod count.

## Abort criteria (any one of these — stop and uncordon)

- The pre-check does not show exactly 2 schedulable nodes.
- Branch A: a volume is still `degraded` more than a few minutes after the node returns and rebuild
  progress is not visible in `.status`.
- Branch B: you were not prepared to accept zero Kafka redundancy for the duration — abort before
  step 2, not after.
- Branch B: step 4's rebalance loop has not converged after a small, pre-agreed number of attempts.
  Flailing at it live is how a one-node outage becomes a two-node one.
- Either branch: the drain stalls past 15 minutes — see [[k8s-node-drain-replace]]'s PDB pre-check for
  the general cause.

## Verification checklist

- [ ] Pre-check showed exactly 2 schedulable nodes before starting
- [ ] Branch A: Longhorn volume(s) on the drained node's replica are `healthy`, not `degraded`, after
      the node returns and rebuild completes
- [ ] Branch B: `--under-replicated-partitions` is empty after step 5, with the two brokers confirmed
      on distinct nodes
- [ ] Branch B: the three controller pods are split 2+1 across the two nodes again, not 3+0
- [ ] The node is `Ready`, not `SchedulingDisabled`, at the end
- [ ] Alert silence lifted, change ticket closed

## Follow-ups

- [ ] Run this procedure for real against Branch A first — it is the one the sources support — and set
      `verified` for this document from that run
- [ ] Run Branch B for real and record whether the step 4 rebalance loop converges, and in how many
      tries; this is the actual answer to [[kafka-strimzi-onprem]]'s overdue follow-up (📅 2026-09-30)
      to either install the Strimzi Drain Cleaner or write the manual procedure — this document is the
      manual-procedure half of that choice, unverified
- [ ] Revisit entirely once a fourth machine raises the schedulable budget past 2 — both branches exist
      only because there is no spare node; see [[schedulable-node-budget]]

## Related

[[k8s-node-drain-replace]] — the generic drain mechanics this document assumes and does not repeat.
[[schedulable-node-budget]] — the standing budget of 2 that makes draining a capacity event here, not
a routine one.
[[longhorn-storage-onprem]] — the replica-placement failure Branch A exists to walk through on
purpose instead of by accident.
[[kafka-strimzi-onprem]] — the broker/controller placement rules, the missing Drain Cleaner, and the
abort criterion (two brokers on one node) Branch B is built around.
[[minio-object-storage-onprem]] — the first document to treat draining a Longhorn-backed node as an
outage rather than routine maintenance, which is what prompted this runbook.
[[onprem-3node-kubeadm-ubuntu]] — the cluster topology (`k8s-cp1` tainted, `k8s-w1` and `k8s-w2`
schedulable) this entire procedure assumes.
