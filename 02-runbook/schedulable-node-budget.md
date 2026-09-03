---
title: Schedulable-node budget — sizing add-ons before you install them
date: 2026-08-08
domain: runbook
tags: [on-prem, capacity, scheduling]
stack: [kubernetes, kubectl, longhorn, argocd, ingress-nginx]
summary: Three machines is not three nodes. Establish how many nodes an add-on can actually place workloads on, and size the add-on to that number before installing — the same miscount produces a silent permanent degradation in one component and a permanent Pending in another. This cluster's standing answer is recorded in step 2: taint kept, budget 2.
source: standardize
env:
verified:
duration: 10–15 min
risk: low
---

> ⚠️ This runbook was synthesized from [[onprem-3node-kubeadm-ubuntu]], [[longhorn-storage-onprem]],
> [[argocd-helm-ha-install]] and [[ingress-nginx-onprem]]. **Nobody has executed it in this order
> yet** — each source was verified separately, and the sequence below is assembled from them. Fill in
> `verified` after the first real run.

Run this **before installing any add-on that places one workload per node, replicates across nodes,
or uses anti-affinity** — storage, ingress controllers, HA control planes for other software. Also
after adding or removing a node, and after any change to node taints.

It takes ten minutes and it is entirely reversible: nothing here changes the cluster except the
optional taint decision in step 2, which is called out where it stops being reversible.

## Why this is its own procedure

The control plane carries a `NoSchedule` taint by default, so on three machines most add-ons see
**two** places to put things. Three separate documents in this repository each hit that, and the
symptoms have nothing in common:

| Component | What it does with too few schedulable nodes | How it looks |
|---|---|---|
| Longhorn | places fewer replicas than asked, forever | **Silent.** Volume attaches, mounts, serves data, and reports `degraded` with `ReplicaSchedulingFailure`. Nothing alerts. Nothing repairs it |
| Argo CD `redis-ha` | anti-affinity cannot be satisfied | **Loud.** Pods sit `Pending`, `helm --wait` blows past its timeout |
| ingress-nginx with `externalTrafficPolicy: Local` | no controller pod on the node holding the address | **Intermittent.** Depends which node MetalLB elected |

One cause, three failure shapes, and only one of them announces itself. That is why the count comes
first rather than after the install fails.

Not every component is affected — the ones that carry a control-plane toleration place on all nodes
regardless. [[onprem-3node-kubeadm-ubuntu]] expects one `calico-node` per node and
[[metallb-l2-onprem]] expects one `speaker` per node, on three machines, including the tainted one.
[[longhorn-storage-onprem]] expects one `longhorn-manager` per *schedulable* node. The difference is
per-component and is not visible from `kubectl get nodes`.

---

## Pre-checks

### 1. The budget itself

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

Count the rows with an empty `TAINTS` column. **That number, not the number of machines, is what
every sizing decision below uses.**

```bash
# the same number, without counting by eye
kubectl get nodes -o json | jq '[.items[] | select(.spec.taints == null)] | length'
```

A cluster built by [[onprem-3node-kubeadm-ubuntu]] returns `2` here on three machines. If it returns
`3`, someone has already removed the taint — find out who and why before relying on it, because step
2 is a decision that should only be made once.

### 2. Communication

Only needed if you take the taint decision in step 2 on a live cluster.

- Change ticket number
- Who is told, and when
- Alert silence scope and expiry

---

## Execution

### Step 1 — Write the budget down (reversible; changes nothing)

Record the number from the pre-check next to the cluster's name, wherever cluster facts live. Every
add-on install from here refers to it. If it only exists in the terminal you ran it in, the next
person re-derives it or guesses.

Rollback: n/a.

### Step 2 — Decide the taint, once (**not reversible in the way it looks**)

> ## Standing decision for this cluster — 2026-08-09
>
> **Keep the control-plane taint. Longhorn runs at two replicas.**
>
> Budget: **2 schedulable nodes** on three machines. Reason: the control plane is the 4 GB node
> [[onprem-3node-kubeadm-ubuntu]] warns about, and a workload evicting etcd takes the cluster down
> rather than one application. Storage redundancy is worth less than the API server staying up.
>
> **This is the answer for new add-ons too.** Do not re-open it per component; size the component to
> 2 and, if it cannot work at 2, that is a hardware conversation rather than a taint conversation.
>
> The cost of this choice, accepted knowingly:
>
> - Longhorn survives one node loss and not a second failure during the rebuild
> - **Argo CD cannot run `redis-ha` here** — it needs three schedulable nodes. Set
>   `redis-ha.enabled: false`, or add a machine. [[argocd-helm-ha-install]] still ships HA values
>   that assume three; they do not apply to this cluster as decided
> - ingress-nginx has exactly two nodes to spread across, so draining one leaves no margin. See the
>   abort criteria below before draining during a maintenance window
>
> Revisit only when a fourth machine exists, or when the control plane is replaced with hardware that
> has room. Revisiting means re-reading this whole section, not just running the untaint command.

The rest of this step is the reasoning behind that decision, kept because the decision has to be
re-made if the hardware changes.

You can raise the budget by removing the control-plane taint:

```bash
# only if you accept that a workload can now compete with etcd and the API server
kubectl taint nodes <CP_NODE> node-role.kubernetes.io/control-plane:NoSchedule-
```

The command reverses cleanly. **The pods scheduled while it was off do not.** Put the taint back
and every pod that landed on the control plane is evicted at once, which on a
three-machine cluster means the remaining two absorb all of it.

The sources do not agree on what to do here, and this is the decision to make deliberately:

- [[onprem-3node-kubeadm-ubuntu]] — "Leave the taint unless the hardware has room." On a 4 GB
  control plane a memory-hungry pod evicting etcd takes the cluster down, not just the app.
- [[longhorn-storage-onprem]] — either size the replica count to the untainted nodes, or remove the
  taint and accept storage replication competing with etcd.
- [[argocd-helm-ha-install]] — "In production, add nodes instead."

They do not contradict each other, but **on three machines you cannot have all three of: the taint
kept, Longhorn at three replicas, and Argo CD's `redis-ha`.** Pick two, or add a fourth machine.

This cluster picked the first two — see the standing decision above. The one given up is Argo CD's
`redis-ha`, which is the choice to remember, because nothing in the Argo CD install will stop you
from trying it and the failure takes ten minutes of `helm --wait` to arrive.

Rollback: re-apply the taint with the same command minus the trailing `-`. See the caveat above.

### Step 3 — Size each add-on against the number

Before running any install command, find its node-count assumption and set it explicitly rather than
taking the chart default:

| Add-on | Setting | Rule | This cluster |
|---|---|---|---|
| Longhorn | `defaultSettings.defaultReplicaCount` | ≤ schedulable nodes. See [[longhorn-storage-onprem]] | `2` |
| Argo CD | `redis-ha.enabled` | needs ≥ 3 schedulable nodes; set `false` below that. See [[argocd-helm-ha-install]] | `false` |
| ingress-nginx | `controller.replicaCount` + spread constraint | ≥ 2, spread across nodes, when using `externalTrafficPolicy: Local`. See [[ingress-nginx-onprem]] | `2`, no margin to drain |

The right-hand column follows from the standing decision, not from the chart defaults. A chart that
defaults to something larger will install happily and fail in whichever way that component fails.

Rollback: these are pre-install values; nothing to roll back if you have not installed yet.

### Step 4 — Verify placement after each install

Do this per add-on, immediately after it comes up, while you still remember what you set.

```bash
# every pod of the add-on, and which node took it
kubectl -n <NAMESPACE> get pods -o wide
```

Count distinct nodes in the `NODE` column and compare to what you asked for. A count lower than the
setting is the failure this runbook exists to prevent, and for Longhorn it is the only sign you get:

```bash
# Longhorn: the property, not the proxy — a volume can serve data and still be degraded
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

`attached` / `healthy` is a pass. `attached` / `degraded` is the failure — and note that a pod using
that volume runs perfectly, so no workload-level check will catch it.

---

## Abort criteria (any one of these — stop immediately)

- The pre-check returns anything other than **2**. Either a machine is gone or the taint has been
  removed against the standing decision. Find out which before installing anything.
- The schedulable-node count disagrees with what the last install was sized for. Stop and reconcile
  before installing anything else; a second add-on sized against a stale number compounds it.
- A drain is planned while the budget is 2. Draining takes it to 1: Longhorn cannot place its second
  replica and ingress-nginx loses its spread. That is survivable and it is not a normal state — read
  [[k8s-node-drain-replace]] first and keep the window short.
- Removing the taint is being considered mid-incident. It is a capacity decision, not a remedy, and
  it puts workloads next to etcd at the moment the cluster is least able to absorb that.
- An add-on's own preflight reports a different node count from the pre-check above. One of the two
  is wrong about tolerations — find out which before proceeding. Longhorn's `environment_check.sh`
  reports on schedulable nodes only, which is correct for Longhorn and misleading if read as "every
  node passed".

## Verification checklist

- [ ] The pre-check returns `2`, matching the standing decision in step 2
- [ ] Every add-on installed since the last count has an explicit node-count setting, not a default
- [ ] No add-on is running with a chart default where the table in step 3 gives a value
- [ ] `kubectl -n <NS> get pods -o wide` shows the intended number of **distinct** nodes per add-on
- [ ] Longhorn volumes report `healthy`, not merely `attached`
- [ ] Argo CD `redis-ha` pods are `Running`, not `Pending`
- [ ] ingress-nginx controller replicas are on different nodes
- [ ] The standing decision in step 2 still matches the hardware — re-read it, do not assume it
- [ ] Re-running the pre-check after all installs returns the same number it did before

## Follow-ups

- [x] Decide the standing answer to step 2 for this cluster and record it once — done 2026-08-09: taint kept, budget 2
- [x] Reconcile [[argocd-helm-ha-install]] with that decision — done 2026-08-09: its section 2.1 now carries the reduced values for a two-node budget, marked unverified until someone runs it
- [ ] Run this before the next add-on install and set `verified` 📅 2026-09-30
- [ ] Add the schedulable-node count to whatever inventory holds cluster facts, so it is not re-derived
- [ ] Work out whether any add-on here can be given a control-plane toleration deliberately, rather than treating the budget as fixed

## Related

[[onprem-3node-kubeadm-ubuntu]] — creates the condition, in section 6.1. The taint decision belongs there and the consequences belong here.
[[longhorn-storage-onprem]] — the silent failure mode, and the one that motivated this runbook.
[[argocd-helm-ha-install]] — the loud failure mode. Same cause, `redis-ha` anti-affinity instead of replica placement.
[[ingress-nginx-onprem]] — the intermittent failure mode, via `externalTrafficPolicy: Local`.
[[metallb-l2-onprem]] — a counter-example worth knowing: its `speaker` runs on every node including the tainted one.
[[pod-crashloopbackoff]] — where this surfaces if you skip it: `node(s) had untolerated taint` in the scheduling branch.
[[k8s-node-drain-replace]] — draining reduces the budget by one for the duration, which is the same problem with a timer on it.
