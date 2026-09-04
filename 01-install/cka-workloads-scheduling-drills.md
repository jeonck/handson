---
title: CKA workload and scheduling drills — six tasks where the status column agrees with a wrong answer
date: 2026-08-31
domain: install
tags: [kubernetes, cka, certification, scheduling]
stack: [kubernetes, kind, kubectl, podman]
summary: Rolling updates, resource pressure, Secrets, nodeSelector, taints and static pods, each run on a three-node cluster. A Deployment whose new image cannot be pulled reports READY 3/3 and AVAILABLE 3, a Deployment with an unschedulable pod reports Available=True, and a static pod in a mistyped directory produces no pod and no log line at all.
source: handson
env: kind 0.32.0 on Podman 5.7.1 · Kubernetes 1.36.1 (1 control-plane + 2 workers) · kubectl 1.36.4 · arm64 · macOS 14.7.5
verified: 2026-08-31
verifiability: partial
verifiability-note: kind rather than the exam's kubeadm cluster, so node names, the control-plane taint and the CNI differ, and none of these drills was performed under time pressure. The static-pod drill edits a node's filesystem through the container runtime, which is a kind-specific path; on a real node it is an ordinary file copy.
duration: 60–90 min
risk: low
---

> **Verified 2026-08-31.** Every column, event and message below came off the cluster in `env`. Each
> drill was run in both directions — the failing state and the fixed one.

Six tasks in the shape the exam uses, each with the command that solves it and the reason the obvious
check does not prove it. Setup for these is in [[cka-exam-first-three-minutes]]; the harder
Cluster Architecture tasks are in [[cka-practice-cluster-and-checks-that-lie]].

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster | `kubectl get nodes` | three `Ready` nodes |
| Namespace | `kubectl create ns drills` | created, then pin it |

## 1. Rolling update, and the two columns that disagree

```bash
kubectl create deployment web --image=nginx:alpine --replicas=3 $do | kubectl apply -f -
kubectl set image deploy/web nginx=nginx:doesnotexist-9.9
```

The obvious check, twenty-five seconds later:

```
  get deploy : READY=3/3  UP-TO-DATE=1  AVAILABLE=3
```

**`READY 3/3` and `AVAILABLE 3` are both true and both irrelevant.** The old ReplicaSet is still
serving all three pods, which is exactly what a rolling update is supposed to do while the new one
comes up. The new one is not coming up:

```
  pod web-5d6b5c7df9-4nqxm   1/1   Running
  pod web-5d6b5c7df9-km8ct   1/1   Running
  pod web-5d6b5c7df9-lk9rf   1/1   Running
  pod web-85f568c6d4-vmks6   0/1   ImagePullBackOff
```

Two things tell you, and only two:

```
  UP-TO-DATE = 1        <- the column that counts new-template pods
  kubectl rollout status deploy/web --timeout=15s
    error: timed out waiting for the condition
```

**`rollout status` is the check that can fail**, and it is one command. Rolling back:

```bash
kubectl rollout undo deploy/web
kubectl rollout history deploy/web
```

```
  deployment "web" successfully rolled out
  get deploy : READY=3/3  UP-TO-DATE=3  AVAILABLE=3
```

The three columns agreeing is the finish line. One warning is worth expecting rather than debugging:
after `kubectl apply`, `rollout undo` prints a note that it will not update the
`last-applied-configuration` annotation. **That is informational and the rollback still happens.**

## 2. Resource requests that cannot be met

```bash
kubectl create deployment big --image=nginx:alpine
kubectl set resources deploy/big --requests=cpu=8,memory=16Gi
```

```
  get deploy : READY=1/1  AVAILABLE=1
  pod big-6d56d65947-9mhlj   Running     <- old template
  pod big-799c45558b-gsb2b   Pending     <- new template, nowhere to go
```

Same shape as drill 1, and the deployment's own conditions do not help either:

```
  Available=True    MinimumReplicasAvailable
  Progressing=True  ReplicaSetUpdated
```

**Both conditions are positive while a pod cannot be scheduled.** The truth lives in one place:

```bash
kubectl describe pod <pending-pod>
kubectl get events --field-selector reason=FailedScheduling
```

```
  Warning  FailedScheduling  default-scheduler
  0/3 nodes are available: 1 node(s) had untolerated taint(s),
  2 Insufficient cpu, 2 Insufficient memory.
```

**That message is a per-node tally and it names every reason at once** — one control-plane taint plus
two workers short on both cpu and memory. Read the counts, not just the first clause: `0/3` with three
different causes is a different problem from `0/3` with one.

## 3. ConfigMaps and Secrets

```bash
kubectl create configmap app-cfg --from-literal=MODE=prod --from-literal=TZ=UTC
kubectl create secret generic app-sec --from-literal=PASSWORD=s3cret
```

```
  stored value : czNjcmV0
  base64 -d    : s3cret
```

**A Secret is encoded, not encrypted.** Anyone who can read the object, or read etcd, reads the
password — the protection is RBAC and etcd encryption-at-rest, neither of which is on by default. If a
task asks you to create one, this changes nothing about the answer; it changes what you should say if
asked whether the value is safe.

## 4. Pinning a pod to a node

```bash
kubectl label node <node> disktype=ssd
kubectl patch deploy pinned -p '{"spec":{"template":{"spec":{"nodeSelector":{"disktype":"ssd"}}}}}'
```

```
  pinned-d8d56d885-6dsbs   Running   on cka2-worker
```

**Verify with `-o wide`, not with `get pods`.** The pod being `Running` says nothing about *where*, and
where is the entire task. The same applies to every affinity and topology question.

## 5. Taints and tolerations

```bash
kubectl taint node <node> tier=db:NoSchedule
```

With the pod pinned to that node and no toleration:

```
  untolerant-5649494b58-x77bj   Pending
```

Adding the matching toleration:

```bash
kubectl patch deploy untolerant -p \
  '{"spec":{"template":{"spec":{"tolerations":[{"key":"tier","value":"db","effect":"NoSchedule"}]}}}}'
```

```
  untolerant-7958cf44df-wsvds   Running   on cka2-worker2
```

**Both directions were watched.** A toleration drill that only shows the working case cannot tell a
correct toleration from a taint that never applied — the same structure as the NetworkPolicy table in
[[cka-practice-cluster-and-checks-that-lie]].

Remove it with the trailing dash, which is the syntax people forget under pressure:

```bash
kubectl taint node <node> tier-
```

## 6. Static pods, and the failure with no error

First read where the kubelet actually looks. Do not assume the path:

```bash
grep -i staticPodPath /var/lib/kubelet/config.yaml
```

```
  staticPodPath: /etc/kubernetes/manifests
```

Now put a manifest one character wrong — `/etc/kubernetes/manifest`, singular:

```
  pod created?  : Error from server (NotFound): pods "wrong-cka2-worker" not found
  kubelet errors: 0 lines mentioning the file
```

**No pod, no event, no log line.** The kubelet is not watching that directory, so there is nothing for
it to complain about. This is the quietest failure in the exam: the file is written, the task feels
done, and nothing anywhere disagrees.

In the right directory:

```
  right-cka2-worker   Running   on cka2-worker
```

**The node name is appended to the pod name** — that suffix is how you confirm a pod is static rather
than scheduled. And the last trap:

```bash
kubectl delete pod right-<node>
```

```
  after delete: right-cka2-worker   Running
```

**It comes back.** The API server deletes the mirror pod; the kubelet recreates it from the file that
is still on disk. To remove a static pod you remove the manifest from the node.

## Verification checklist

- [x] A broken image rollout leaves `READY 3/3` and `AVAILABLE 3` while `UP-TO-DATE` is **1**
- [x] `kubectl rollout status` **times out** in that state, and the new pod is `ImagePullBackOff`
- [x] `rollout undo` restores all three columns to 3 and prints a `last-applied-configuration` warning that is informational
- [x] A pod requesting 8 cpu / 16 Gi stays `Pending` while `get deploy` shows `READY 1/1`
- [x] The deployment reports **`Available=True` and `Progressing=True`** in that same state
- [x] `FailedScheduling` names all causes at once: `0/3 nodes … 1 untolerated taint, 2 Insufficient cpu, 2 Insufficient memory`
- [x] A Secret value round-trips through `base64 -d` to plaintext — encoding, not encryption
- [x] `nodeSelector` places the pod on the labelled node, confirmed with `-o wide`
- [x] Without a toleration the pod is `Pending`; with the matching toleration it runs on the tainted node
- [x] `staticPodPath` is read from `/var/lib/kubelet/config.yaml` rather than assumed
- [x] A manifest in `/etc/kubernetes/manifest` (singular) produces **no pod and zero kubelet log lines**
- [x] A manifest in the correct directory produces a pod named `<name>-<node>`
- [x] `kubectl delete pod` on a static pod is undone by the kubelet within seconds

## Rollback

```bash
kubectl delete ns drills
kubectl taint node <node> tier-
kubectl label node <node> disktype-
# static pods live on the node, not in the API
rm /etc/kubernetes/manifests/<file>.yaml
```

## Where this bit us

**A leftover taint from drill 5 broke drill 6 of the next page and looked like a storage bug.** The
`tier=db:NoSchedule` applied here was never removed, so a pod pinned to that node in a later drill sat
`Pending` and the first reading was that the volume had failed. **Drills leave state behind, and the
cheapest habit is to undo each one at the end of its own section** rather than at the end of the
session — the exam has the same property, where a task that changes a node affects every later task
that uses it.

**Two drills produced the same misleading output for different reasons.** The broken image and the
oversized resource request both show a healthy `READY` count over a stuck new ReplicaSet, because both
are template changes and a rolling update always keeps the old pods until the new ones are ready.
**Once you recognise that shape, `UP-TO-DATE` and `rollout status` answer both** — which is worth more
than memorising two separate diagnoses.

## Follow-ups

- [ ] Add a DaemonSet drill, including what happens to it during a node drain, which is the one workload type not covered here
- [ ] Add multi-container and init-container drills, where the failing check is `kubectl logs` needing `-c` and silently picking the wrong container
- [ ] Repeat drill 2 with a `LimitRange` in the namespace, which changes the failure from `Pending` to a rejected create
- [ ] Time each drill against a six-minute budget, since none of these was done against a clock
- [ ] Confirm the static-pod behaviour on a real kubeadm node rather than through `podman exec`, where the file copy is ordinary

## Related

[[cka-exam-first-three-minutes]] — the shell setup and generated YAML these drills assume.
[[cka-practice-cluster-and-checks-that-lie]] — etcd, RBAC, NetworkPolicy, a dead node and a kubeadm upgrade.
[[cka-services-ingress-storage-drills]] — the networking and volume half.
[[pod-crashloopbackoff]] — the troubleshooting path when a pod fails for a reason the columns do show.
