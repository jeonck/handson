---
title: CKA practice on kind — four exam tasks, and the check that passes on each wrong answer
date: 2026-08-31
domain: install
tags: [kubernetes, cka, certification, troubleshooting]
stack: [kubernetes, kind, etcd, rbac, networkpolicy, podman]
summary: A three-node practice cluster and four graded-shape CKA tasks — etcd restore, RBAC, NetworkPolicy, a dead node. Each one is paired with the check most candidates run, which passes whether the answer is right or wrong, and the check that actually distinguishes them.
source: handson
env: kind 0.32.0 on Podman 5.7.1 · Kubernetes 1.36.1 (1 control-plane + 2 workers) · etcd 3.6.0 · kindnetd v20260528 · arm64 · macOS 14.7.5
verified: 2026-08-31
verifiability: partial
verifiability-note: kind is not the exam environment. etcdctl is absent from the node filesystem and lives only inside a distroless etcd container, the CNI is kindnet rather than the exam's, and there is no kubeadm upgrade path here — so the commands differ in detail from a real kubeadm cluster even though the task shapes and the verification logic do not. Cluster upgrade, multi-master etcd, and storage tasks are not covered.
duration: 90–120 min
risk: low
---

> **Verified 2026-08-31.** Every state transition below was produced on the cluster in `env`, in both
> directions — each check was watched passing on a correct answer and on a wrong one.

The CKA is graded on the end state of a cluster, not on what you typed. **That makes the verification
command the whole game**, and the ones that come to hand first tend to pass no matter what you did.
This page runs four tasks in the exam's shape and pairs each with two checks: the reassuring one and
the one that can fail.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| kind | `kind version` | 0.30+ |
| Provider | `podman machine list` | running, ≥4 GiB |
| Context | `kubectl config current-context` | `kind-cka` |

## 1. The practice cluster

```yaml title="kind.yaml"
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
```

```bash
export KIND_EXPERIMENTAL_PROVIDER=podman
kind create cluster --name cka --config kind.yaml --wait 240s
kubectl get nodes
```

```
  cka-control-plane   Ready   control-plane   v1.36.1
  cka-worker          Ready   <none>          v1.36.1
  cka-worker2         Ready   <none>          v1.36.1
```

**Two workers, not one.** Half the tasks below need somewhere for a pod to be that is not the node you
are about to break.

## 2. etcd snapshot and restore

The highest-value task on the exam and the one where "the cluster came back" is the least informative
sentence available. Read the running configuration rather than trusting a remembered path:

```bash
kubectl -n kube-system get pod etcd-cka-control-plane \
  -o jsonpath='{range .spec.containers[0].command[*]}{@}{"\n"}{end}' | grep -E 'data-dir|cert|key|trusted'
```

```
  --cert-file=/etc/kubernetes/pki/etcd/server.crt
  --data-dir=/var/lib/etcd
  --key-file=/etc/kubernetes/pki/etcd/server.key
  --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
```

**Plant something the restore has to bring back, before taking the snapshot.** Without it there is
nothing to check afterwards:

```bash
kubectl create ns exam
kubectl -n exam create configmap marker --from-literal=state=before-snapshot
```

On kind, `etcdctl` is not on the node — it exists only inside the etcd container, which is distroless
and has no shell, so commands go straight to the binary:

```bash
CP=cka-control-plane
CTR=$(podman exec $CP crictl ps --name etcd -q | head -1)
podman exec $CP crictl exec $CTR etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /var/lib/etcd/snapshot.db
```

```
  Snapshot saved at /var/lib/etcd/snapshot.db
  Server version 3.6.0
  1937440 bytes
```

Now diverge the cluster from the snapshot in **both** directions — delete something that existed, add
something that did not:

```bash
kubectl -n exam delete configmap marker
kubectl -n exam create configmap after --from-literal=state=created-after-snapshot
```

**On etcd 3.6 the restore verb has moved to `etcdutl`.** `etcdctl snapshot restore` is gone, which is
worth knowing before the clock is running:

```bash
podman exec $CP crictl exec $CTR etcdutl snapshot restore \
  /var/lib/etcd/snapshot.db --data-dir /var/lib/etcd/restored
```

Restoring into a subdirectory of the existing data-dir is deliberate: `/var/lib/etcd` is the only path
mounted from the node, so it is the only place the container can write that survives it.

```bash
# Moving the manifests out stops the static pods; the kubelet restarts them when they return.
podman exec $CP mkdir -p /tmp/held
podman exec $CP mv /etc/kubernetes/manifests/etcd.yaml /tmp/held/
podman exec $CP mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/held/
podman exec $CP mv /var/lib/etcd/member /var/lib/etcd/member.old
podman exec $CP mv /var/lib/etcd/restored/member /var/lib/etcd/member
podman exec $CP mv /tmp/held/etcd.yaml /etc/kubernetes/manifests/
podman exec $CP mv /tmp/held/kube-apiserver.yaml /etc/kubernetes/manifests/
```

Swapping `member/` in place keeps `--data-dir` correct, so the manifest needs no edit — one less thing
to get wrong under time pressure.

### The check that passes either way

```
  kubectl get nodes  : Ready
  API /healthz       : ok
  etcd pod           : 1/1 Running
```

**All three are true of a cluster that ignored your snapshot entirely.** They say etcd is serving, not
that it is serving the data you restored.

### The check that can fail

```
  marker (existed before the snapshot, must return) : before-snapshot
  after  (created after it, must be gone)           : Error from server (NotFound)
```

**Both halves are needed.** `marker` alone passes if the restore silently did nothing and you had
mis-remembered deleting it; `after` alone passes if etcd came up empty. Together they pin the database
to one specific point in time.

One more signal that the restore really happened — the cluster identity changes:

```
  before restore   ID bfaeab7dc3bc6a02   (etcdctl member list)
  after restore    ID 8e9e05c52164694d   RAFT TERM 2   RAFT APPLIED INDEX 97
```

A restored member gets etcd's default ID and a raft log that starts over. **A member ID that did not
change means you are still talking to the old data directory.**

## 3. RBAC

```yaml title="rbac.yaml"
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: pod-reader, namespace: dev}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
```

```bash
SA=system:serviceaccount:dev:reader
kubectl auth can-i get pods    -n dev     --as=$SA
kubectl auth can-i delete pods -n dev     --as=$SA
kubectl auth can-i get pods    -n default --as=$SA
```

```
  can-i get pods    -n dev     : yes
  can-i list pods   -n dev     : yes
  can-i delete pods -n dev     : no
  can-i get secrets -n dev     : no
  can-i get pods    -n default : no
```

That is a correct answer, and the trouble is what a *wrong question* looks like:

```
  can-i get pods (no -n)                        : no    <- asked about `default`
  --as=reader (missing the SA prefix)           : no
  --as=system:serviceaccount:dev:raeder (typo)  : no
```

**Every mistake in the question returns `no`, exactly like a missing RoleBinding.** A candidate who
mistypes the subject sees `no`, concludes the RBAC is broken, and starts editing a correct answer.

The check that distinguishes them enumerates instead of asking:

```bash
kubectl auth can-i --list -n dev --as=$SA
```

```
  correct subject : pods  []  []  [get list]
  typo'd subject  : (no pods row at all)
```

**`--list` returns what was actually granted**, so a subject that does not exist shows an empty grant
rather than a `no` that reads like a policy decision.

## 4. NetworkPolicy

```yaml title="netpol-allow.yaml"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: api-allow-client, namespace: dev}
spec:
  podSelector: {matchLabels: {app: api}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {matchLabels: {app: client}}
```

Three pods: `api` is the target, `client` should reach it, `stranger` should not.

```bash
IP=$(kubectl -n dev get pod api -o jsonpath='{.status.podIP}')
kubectl -n dev exec client   -- wget -q -T 3 -O /dev/null http://$IP && echo REACHES || echo BLOCKED
kubectl -n dev exec stranger -- wget -q -T 3 -O /dev/null http://$IP && echo REACHES || echo BLOCKED
```

| state | `client` | `stranger` |
|---|---|---|
| no policy at all | REACHES | REACHES |
| `ingress: []` (deny all) | BLOCKED | BLOCKED |
| allow `app=client` | **REACHES** | BLOCKED |

**Read only the `client` column and the first and third rows are identical.** Testing the pod that is
supposed to get through cannot tell a correct policy from no policy — and "no policy" is what you have
if the YAML never applied, the namespace was wrong, or the `podSelector` matched nothing.

The pod that must be **blocked** is the one carrying the information. Testing both is one extra
command and it is the difference between a verified answer and a hopeful one.

The middle row matters too. **Deleting the policy and watching traffic return** is what proves the
blocking was the policy's doing rather than a broken probe, a wrong IP or a pod that never came up.

> Worth stating because the opposite was assumed here: **kindnet enforces NetworkPolicy** at
> v20260528. A CNI that ignores policy is the classic version of this trap — everything stays
> reachable and the manifest looks applied — and the four-state table above is what detects it.

## 5. A node that stops reporting

```bash
podman exec cka-worker systemctl stop kubelet
```

```
  NotReady after: 51 seconds
```

```
  node : cka-worker  NotReady
  pod  : client      Running        <- on that node
```

**The pod on the dead node still reads `Running`.** Nothing is lying on purpose: the field is stale
because the component that updates it is the one that stopped. `kubectl get pods` is the check that
passes here, and it will keep passing for the whole eviction timeout.

```bash
kubectl -n dev exec client --request-timeout=20s -- echo alive
```

```
  healthy node   : alive
  kubelet stopped: error: unable to upgrade connection: error dialing backend: dial tcp …
  after recovery : alive
```

**Touching the pod is what separates `Running` from running.** The cause is one command away, and it
names itself:

```bash
kubectl describe node cka-worker | grep -A2 'Ready '
podman exec cka-worker systemctl is-active kubelet
```

```
  Ready  Unknown  …  NodeStatusUnknown  Kubelet stopped posting node status.
  inactive
```

```
  systemctl start kubelet  ->  Ready after 3 seconds
```

**51 seconds to notice, 3 seconds to fix.** On a timed exam the asymmetry is the point: nearly all of
the elapsed time is the cluster's detection delay, so a task that looks unfinished may only need
waiting out — and re-running `kubectl get nodes` before the node controller has reacted tells you
nothing.

## Verification checklist

- [x] Three nodes reach `Ready` on Kubernetes 1.36.1
- [x] The etcd data-dir and cert paths are read from the running static pod, not assumed
- [x] `etcdctl snapshot save` produces a **1,937,440-byte** file from etcd **3.6.0**
- [x] On etcd 3.6 the restore is **`etcdutl snapshot restore`**; `etcdctl` no longer has the verb
- [x] After restore, `get nodes` / `/healthz` / `etcd 1/1 Running` **all pass** — the uninformative check
- [x] After restore, `marker` returns as `before-snapshot` **and** `after` is `NotFound` — both halves
- [x] The etcd member ID changes **bfaeab7dc3bc6a02 → 8e9e05c52164694d**, with raft term 2 and applied index 97
- [x] `can-i` returns `yes` for get/list pods in `dev` and `no` for delete, secrets, and other namespaces
- [x] A missing `-n`, a missing `system:serviceaccount:` prefix and a typo'd name **all return `no`**, like a missing binding
- [x] `can-i --list` shows a `pods [get list]` row for the real subject and **no such row** for the typo
- [x] NetworkPolicy states measured in all four cells: no policy REACHES/REACHES, deny-all BLOCKED/BLOCKED, allow-client REACHES/BLOCKED
- [x] Deleting the policy restores traffic — the control proving the block was the policy
- [x] `kindnetd:v20260528` **does** enforce NetworkPolicy, contrary to the assumption this page started with
- [x] Stopping the kubelet turns the node `NotReady` in **51 s** while its pod still reads `Running`
- [x] `kubectl exec` into that pod fails with `unable to upgrade connection`, and succeeds again after recovery
- [x] `describe node` reports `NodeStatusUnknown / Kubelet stopped posting node status`, and recovery takes **3 s**

## Rollback

```bash
kind delete cluster --name cka
```

Everything above lives in that cluster, which is the reason to practise on a throwaway one: the etcd
step deliberately destroys state, and the node step deliberately breaks a kubelet.

## Where this bit us

**A finding was nearly published from a command that does not exist.** The first pass at section 5 ran
`timeout 25 kubectl exec …` and printed `exec failed`, which fitted the hypothesis perfectly. It was
wrong: `timeout` is not on macOS, the shell returned "command not found", and the `&&` simply never
fired. What caught it was running the same check against a **healthy** node, where it also reported
failure. **A check that fails on a known-good input is broken, and that costs one command to find out**
— the same discipline the rest of this page applies to the exam tasks.

**`zsh` does not word-split unquoted expansions, and it bit twice.** A loop over
`"get pods -n dev"` passed the whole string as one argument, and `kubectl auth can-i` answered
`you must specify two arguments` — which was invisible because stderr was redirected away. Building a
command in a variable (`E="podman exec … crictl exec $CTR"`) failed the same way. Shell functions fix
both, and dropping `2>/dev/null` while a script is still being written would have shown the error the
first time.

**The assumption that kindnet ignores NetworkPolicy was wrong and would have inverted the lesson.**
This page was drafted expecting the policy to be inert, which would have made section 4 a story about
CNIs. Applying it and measuring gave the opposite result. The four-state table survived the surprise
because it does not depend on which way the answer comes out — **a test designed to distinguish
outcomes still works when you predicted the wrong one**, and one designed to confirm a belief does not.

## Follow-ups

- [ ] Add a `kubeadm upgrade` drill, the other high-value Cluster Architecture task, which kind cannot host — it needs a real kubeadm cluster
- [ ] Add PV/PVC and StorageClass tasks with a check that distinguishes `Bound` from actually writable
- [ ] Time each task end to end against the exam's roughly six-minutes-per-question budget, since none of the above was performed under time pressure
- [ ] Repeat the etcd restore with the snapshot on a *different* host path than the data-dir, which is the shape a real exam question uses
- [ ] Build the same four checks as a script that grades a cluster, so a practice attempt can be marked without re-reading this page

## Related

[[valkey-redis-dragonfly-on-kubernetes]] — a Ready pod refusing every write: the same stale-signal shape as section 5.
[[pod-crashloopbackoff]] — the other direction of pod troubleshooting, where the status is honest and the cause is not.
[[k8s-node-drain-replace]] — draining a node deliberately, rather than discovering one that stopped reporting.
[[crossplane-cloud-resources-as-crds]] — a status field standing in for the property it claims to verify.
[[chrome-devtools-protocol-testing]] — two more checks that could not fail, and the known-good input that exposed them.
