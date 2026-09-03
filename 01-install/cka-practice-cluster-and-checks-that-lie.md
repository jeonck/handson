---
title: CKA practice drills — five exam tasks, and the check that passes on each wrong answer
date: 2026-08-31
domain: install
tags: [kubernetes, cka, certification, troubleshooting]
stack: [kubernetes, kind, etcd, rbac, networkpolicy, podman]
summary: Five graded-shape CKA tasks — etcd restore, RBAC, NetworkPolicy, a dead node, and a kubeadm 1.34 to 1.35 upgrade on real EC2 hosts. Each is paired with the check most candidates run, which passes whether the answer is right or wrong, and the check that actually distinguishes them.
source: handson
env: Sections 1–5 on kind 0.32.0 / Podman 5.7.1 · Kubernetes 1.36.1 (1 control-plane + 2 workers) · etcd 3.6.0 · kindnetd v20260528 · arm64 · macOS 14.7.5 — Section 6 on AWS EC2, 2 × t3.medium, Ubuntu 24.04.4, containerd 2.2.1, flannel, kubeadm 1.34.11 upgraded to 1.35.8, x86_64
verified: 2026-08-31
verifiability: partial
verifiability-note: Sections 1–5 run on kind, which is not the exam environment — etcdctl lives only inside a distroless etcd container and the CNI is kindnet, so those commands differ in detail from a real kubeadm cluster even though the task shapes and verification logic do not. Section 6 ran on real EC2 hosts and is faithful, but it upgrades a single-control-plane cluster; a stacked-etcd HA control plane needs the extra nodes and was not exercised. Storage tasks are not covered, and nothing here was performed under exam time pressure.
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

**Skip the restore completely and these three lines look exactly the same.** They prove etcd is
running. They do not tell you which data it loaded.

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

## 6. kubeadm upgrade, 1.34 to 1.35

kind cannot host this one — its node images carry fixed binaries and there is no apt repository to
move. This section ran on two EC2 instances instead, `t3.medium` running Ubuntu 24.04, built with
`kubeadm init` and joined normally:

```
  ip-172-31-27-27   Ready   <none>          v1.34.11   containerd://2.2.1
  ip-172-31-27-53   Ready   control-plane   v1.34.11   containerd://2.2.1
```

The order is graded, and it is: **control plane first, and on it the kubeadm package before anything
else.**

```bash
sudo sed -i 's|/v1.34/|/v1.35/|' /etc/apt/sources.list.d/kubernetes.list
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
  | sudo gpg --yes --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
sudo apt-get update && apt-cache madison kubeadm | head -2
```

**The repository URL carries the minor version.** Leaving it at `v1.34` makes `apt-cache madison`
show only 1.34 packages, and the upgrade fails at the first step with nothing to install — which
reads like a broken mirror rather than a one-character mistake.

```bash
sudo apt-mark unhold kubeadm
sudo apt-get install -y kubeadm=1.35.8-1.1
sudo apt-mark hold kubeadm
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.8 -y
```

```
  [upgrade] SUCCESS! A control plane node of your cluster was upgraded to "v1.35.8".
```

### The check that passes on a wrong answer, and here also fails on a right one

Stop at that point and run the obvious command:

```
  kubectl get nodes
    ip-172-31-27-27    Ready    v1.34.11
    ip-172-31-27-53    Ready    v1.34.11
```

**Both nodes still say v1.34.11, and the upgrade succeeded.** What actually changed:

```
  kubectl version server   : v1.35.8
  kube-apiserver           : v1.35.8
  kube-controller-manager  : v1.35.8
  kube-scheduler           : v1.35.8
  kube-proxy               : v1.35.8
  kubelet (this node)      : v1.34.11
```

**The `VERSION` column of `kubectl get nodes` is the kubelet's version**, not the cluster's. It is the
last thing to move in this procedure and the first thing everyone checks, so it reports failure on a
correct answer — and, in the other direction, upgrading only the kubelet packages while skipping
`kubeadm upgrade apply` makes that same column read `v1.35.8` over a control plane still running
1.34. **One column, two opposite wrong conclusions.**

The pair that settles it is `kubectl version` for the API server and the container image tags for the
control-plane pods:

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o jsonpath='{.items[0].spec.containers[0].image}'
```

### Finishing each node

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.35.8-1.1 kubectl=1.35.8-1.1
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <node>
```

```
  Warning: ignoring DaemonSet-managed Pods: kube-flannel/kube-flannel-ds-…, kube-system/kube-proxy-…
  node/ip-172-31-27-53 drained
  after drain: Ready,SchedulingDisabled
```

**`Ready,SchedulingDisabled` is the state to look for after a drain** — `Ready` alone means the drain
did not take, and the exam's wording usually requires the node to come back schedulable, which is the
`uncordon` people forget.

### The worker takes a different verb

```bash
sudo kubeadm upgrade apply v1.35.8 -y      # on a worker
```

```
  error: couldn't create a Kubernetes client from file "/etc/kubernetes/admin.conf":
  failed to load admin kubeconfig: open /etc/kubernetes/admin.conf: no such file or directory
```

**The error names a missing file, not a wrong command.** `admin.conf` only exists on control-plane
nodes, so the message sends you looking for a broken install on a machine that is fine. The verb for
every node that is not the first control plane is:

```bash
sudo kubeadm upgrade node
```

```
  [upgrade] Backing up kubelet env file to /etc/kubernetes/tmp/…/kubeadm-flags.env
  [kubelet-start] Writing kubelet environment file with flags to file "/var/lib/kubelet/kubeadm-flags.env"
```

Then the same drain / package / restart / uncordon cycle. Final state, with both signals agreeing:

```
  node ip-172-31-27-27    Ready   v1.35.8
  node ip-172-31-27-53    Ready   v1.35.8
  kubectl version server  : v1.35.8
  kube-apiserver          : v1.35.8
  kube-system pods        : 8 Running
  /healthz                : ok
```

**Agreement between the two signals is the finish line, not either one alone.**

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
- [x] A real kubeadm cluster comes up on EC2 at **v1.34.11** with containerd 2.2.1 and both nodes `Ready`
- [x] After `kubeadm upgrade apply v1.35.8`, `kubectl get nodes` still shows **v1.34.11 on both nodes**
- [x] At that same moment `kubectl version` reports server **v1.35.8** and every control-plane image is **v1.35.8**
- [x] The `VERSION` column tracks the **kubelet**, so it reads stale after a correct control-plane upgrade and fresh after a kubelet-only one
- [x] Draining leaves the node `Ready,SchedulingDisabled`, and `--ignore-daemonsets` is required for flannel and kube-proxy
- [x] `kubeadm upgrade apply` on a worker fails with **`open /etc/kubernetes/admin.conf: no such file`** — an error about a file, not about the command
- [x] `kubeadm upgrade node` is the worker verb and rewrites `/var/lib/kubelet/kubeadm-flags.env`
- [x] Final state has both nodes, the API server and every control-plane image at **v1.35.8**, 8 pods Running, `/healthz` ok

## Rollback

```bash
kind delete cluster --name cka                                    # sections 1–5

# section 6, and none of it is optional — these bill by the hour
aws ec2 terminate-instances --region us-east-1 --instance-ids <ids>
aws ec2 wait instance-terminated --region us-east-1 --instance-ids <ids>
aws ec2 delete-security-group --region us-east-1 --group-id <sg>
aws ec2 delete-key-pair --region us-east-1 --key-name cka-upgrade
```

Everything above lives in throwaway infrastructure, which is the point: the etcd step deliberately
destroys state and the node step deliberately breaks a kubelet. After the EC2 half, confirm rather
than assume — instances, security groups, key pairs and **unattached EBS volumes**, which outlive
their instances and keep billing:

```bash
aws ec2 describe-volumes --region us-east-1 --filters Name=status,Values=available \
  --query 'length(Volumes)' --output text
```

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

- [ ] Repeat the upgrade on a three-node stacked-etcd control plane, where the second and third masters take `kubeadm upgrade node` and the order between them is itself graded
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
