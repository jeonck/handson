---
title: CKA service, ingress, storage and DNS drills — five faults that every status column calls healthy
date: 2026-09-04
domain: install
tags: [kubernetes, cka, certification, networking, storage]
stack: [kubernetes, kind, ingress-nginx, kubectl, podman]
summary: A Service with a mistyped selector is indistinguishable from a working one in kubectl get svc, a Bound PVC mounts cleanly on a second node with the data missing, an Ingress with a Running controller answered nothing until it was moved to the node holding the port, and a CoreDNS with its kubernetes plugin removed runs 2/2 with populated endpoints, clean logs, and no cluster names.
source: handson
env: kind 0.32.0 on Podman 5.7.1 · Kubernetes 1.36.1 (1 control-plane + 2 workers) · ingress-nginx (kind provider manifest) · kubectl 1.36.4 · arm64 · macOS 14.7.5
verified: 2026-09-04
verifiability: partial
verifiability-note: The storage drill uses a hostPath PersistentVolume, which is where the node-locality finding comes from; a real CSI driver behaves differently and that comparison was not run. The ingress port path is kind-specific — hostPort on a node plus an extraPortMapping — so the routing results are faithful but the plumbing is not what an exam cluster uses. No drill was performed under time pressure.
duration: 60–90 min
risk: low
---

> **Verified 2026-09-04.** Every status line and HTTP code below came off the cluster in `env`.

Five faults that Kubernetes reports as healthy. In the first four **the object was created correctly
and the thing it was supposed to connect to was not checked**; the fifth is the harder case, where the
configuration itself is wrong and every status column still agrees. Setup is in [[cka-exam-first-three-minutes]].

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster | `kubectl get nodes` | three `Ready` nodes |
| Ingress | `kubectl get ingressclass` | `nginx` present |

## 1. A Service whose selector matches nothing

Two Services over the same Deployment. One selector says `app: web`, the other `app: web-typo`:

```bash
kubectl expose deploy web --name=web-ok --port=80 --target-port=80
kubectl apply -f web-broken.yaml     # selector: app=web-typo
```

```
  get svc web-broken   ClusterIP   80/TCP
  get svc web-ok       ClusterIP   80/TCP
```

**Identical.** Type, port, age — `kubectl get svc` cannot tell them apart, and neither object is in an
error state, because a selector matching nothing is legal.

```bash
kubectl get endpoints <svc>
```

```
  endpoints web-broken : (empty)
  endpoints web-ok     : 10.244.1.2 10.244.2.2 10.244.2.3
```

```
  web-broken : FAILS
  web-ok     : REACHES
```

**`get endpoints` is the one-command check**, and it is the first thing to run on any Service task.
An empty endpoint list has exactly three causes worth checking in order: the selector does not match
the pod labels, the pods are not `Ready`, or the port names do not line up.

DNS resolves either way, which is worth knowing before you use it as evidence:

```
  Name:    web-ok.drills.svc.cluster.local
  Address: 10.96.112.74
```

**A name resolving proves the Service object exists.** It says nothing about whether anything is
behind it, so `nslookup` succeeding is not a passing check for a connectivity task.

## 2. An Ingress whose controller is on the wrong node

```bash
kubectl create ingress web --rule="demo.local/*=web-ok:80"
```

```
  NAME   CLASS    HOSTS        ADDRESS     PORTS
  web    <none>   demo.local   localhost   80
```

An `ADDRESS` appeared, the controller pod was `1/1 Running`, and every request returned nothing:

```
  Host: demo.local  -> HTTP 000
  Host: nope.local  -> HTTP 000
  no Host header    -> HTTP 000
```

`000` is curl for "the connection never happened", which is a different problem from a 404 and points
away from the Ingress rule. Working down the path:

```bash
kubectl -n ingress-nginx get pods -o wide          # which node is the controller on?
<on that node> ss -lntp | grep ':80 '              # is anything listening?
```

```
  controller pod : Running on cka2-worker2
  node :80 listen: none on cka2-control-plane
```

**The controller was on a different node than the one whose port 80 is published.** `hostPort` opens
the port on the node running the pod and nowhere else, so a healthy controller and a published port
that never meet produce a Running pod, an Ingress with an address, and silence.

```bash
kubectl -n ingress-nginx patch deploy ingress-nginx-controller -p '{"spec":{"template":{"spec":{
  "nodeSelector":{"ingress-ready":"true"},
  "tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'
```

```
  Host: demo.local  -> HTTP 200   (nginx welcome page)
  Host: nope.local  -> HTTP 404
  no Host header    -> HTTP 404
```

**Test a host that should *not* match.** `200` on the right host proves routing works; `404` on the
wrong one proves the rule is matching on host rather than catching everything — and a rule that
catches everything passes the first test on its own.

Two details worth carrying into an exam:

- **`CLASS` shows `<none>` and it still worked here**, because this controller watches Ingresses
  without a class. On a cluster where it does not, the same object is silently ignored. Set
  `ingressClassName` explicitly and the question never arises.
- The node label the kind recipe uses, `ingress-ready=true`, was present on the control plane the
  whole time — **the shipped manifest's `nodeSelector` was only `kubernetes.io/os: linux`** and never
  looked at it. A label that nothing reads is not a constraint.

## 3. A Bound PVC with no data behind it

```yaml title="pv-drill.yaml"
apiVersion: v1
kind: PersistentVolume
metadata: {name: pv-drill}
spec:
  capacity: {storage: 1Gi}
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath: {path: /tmp/pv-drill}
```

```
  pv  : pv-drill  1Gi  Retain  Bound
  pvc : pvc-drill Bound pv-drill
```

A pod pinned to the first worker writes through the claim:

```
  writer on cka2-worker : echo > /data/marker.txt -> "written-on-worker"
```

Delete it, and run the same claim from a pod on the other worker:

```
  reader on cka2-worker2
  PVC status   : Bound
  /data mounts : /data
  marker.txt   : cat: can't open '/data/marker.txt': No such file or directory
```

**Three checks pass and the data is gone.** The claim is bound, the volume mounts, the directory is
writable — and `hostPath` means a directory on whichever node the pod landed on:

```
  cka2-worker  : marker.txt
  cka2-worker2 : (empty)
```

**`Bound` describes the claim, not the data.** For a task that says "the pod must keep its data", the
check is to write, delete the pod, let it reschedule, and read back — and to force it onto a different
node if the cluster has more than one, because that is the case a single-node test cannot see.

A `hostPath` PV used across nodes should carry `nodeAffinity` so the scheduler refuses instead of
succeeding quietly; without it, the failure surfaces as missing data rather than as a scheduling
error.

## 4. DNS is down and every DNS object looks fine

Break it the way a task's scenario would:

```bash
kubectl -n kube-system scale deploy coredns --replicas=0
```

The symptom, from a pod:

```
  http://web              -> FAIL
  http://10.96.136.176    -> OK
```

**Names fail and the IP works.** That single pair localises the fault before anything is inspected:
the pod's network, the Service's ClusterIP, kube-proxy and the backend are all fine, because traffic
to the address reaches nginx. Only the step that turns a name into that address is broken. Run this
pair first on any "cannot reach the service" task — it splits the problem in half for the cost of one
extra command.

### The checks that look healthy

```
  get svc kube-dns   : kube-dns  ClusterIP  10.96.0.10
  pod's nameserver   : 10.96.0.10
```

**Both are correct and both stay correct with no DNS server running at all.** The Service object owns
a ClusterIP whether or not anything is behind it — the same property as the broken selector in
section 1 — and the pod's `/etc/resolv.conf` is written at pod creation from the kubelet's config,
so it keeps pointing at an address that answers nothing.

### The checks that fail

```
  endpoints kube-dns : (empty)
  deploy coredns     : READY=0/0  AVAILABLE=0
  nslookup web       : ;; connection timed out; no servers could be reached
```

`endpoints` is the same one-command check as section 1, and it works here for the same reason.

**`READY 0/0` deserves a second look.** It is not `0/2`; a deployment scaled to zero reports a ratio
that is internally consistent and reads as fine at a glance. When a control-plane add-on is the
suspect, compare the replica count against what it should be, not the fraction against itself.

```bash
kubectl -n kube-system scale deploy coredns --replicas=2
```

```
  endpoints kube-dns : 10.244.1.5 10.244.2.5
  http://web         : OK
  nslookup web       : Address: 10.96.136.176
```

**Restoring and re-testing is what makes this a diagnosis rather than a guess** — the same name that
failed now resolves to the same ClusterIP the IP test was already using.

## 5. A Corefile that is valid, loaded, and wrong

Section 4 was the easy version. Every check that caught it — endpoints, pod state, the deployment's
replica count — passes here.

Start from what is running rather than from memory:

```bash
kubectl -n kube-system get cm coredns -o jsonpath='{.data.Corefile}'
```

```
  .:53 {
      errors
      health { lameduck 5s }
      ready
      kubernetes cluster.local in-addr.arpa ip6.arpa {
         pods insecure
         fallthrough in-addr.arpa ip6.arpa
         ttl 30
      }
      prometheus :9153
      forward . /etc/resolv.conf { max_concurrent 1000 }
      cache 30 { … }
      loop
      reload
      loadbalance
  }
```

**`kubernetes` is the plugin that answers for `cluster.local`.** Remove that block and the file is
still valid CoreDNS configuration — it just no longer knows anything about the cluster. The `reload`
plugin picks the change up on its own; no restart is needed, which is part of why this is quiet.

### Everything green

```
  coredns pods : 2/2 Running, restarts=0
  endpoints    : 10.244.0.2 10.244.0.4
  logs         : 0 lines matching error|warn|fail
```

The logs are not merely unhelpful, they are clean:

```
  [INFO] plugin/reload: Running configuration SHA512 = 1b226df798…
  CoreDNS-1.14.2
```

**Nothing is wrong from CoreDNS's point of view.** It was asked to serve a configuration and it is
serving it. The only sign is that reload SHA changing — useful if you know the good value, which
nobody does mid-exam.

### The pair that finds it

```
  internal  nslookup web         -> ** server can't find web.dns.podman: NXDOMAIN
  external  nslookup example.com -> Address: 104.20.23.154
```

**Internal fails, external works.** Section 4's pair was *name fails, IP works*, which localised the
fault to DNS. This second pair localises it inside DNS:

| internal | external | where to look |
|---|---|---|
| fails | fails | CoreDNS is not answering at all — pods, endpoints, section 4 |
| fails | works | the `kubernetes` plugin — cluster names are not being served |
| works | fails | the `forward` block — upstream resolution |

The error text carries the same information if you read past `NXDOMAIN`: the query became
`web.dns.podman`, meaning the resolver exhausted the cluster search domains and fell through to the
host's. **A cluster name that reaches an upstream resolver has not been handled by the `kubernetes`
plugin.**

Confirm against what is actually loaded, not against the ConfigMap you just read:

```bash
kubectl -n kube-system exec deploy/coredns -- cat /etc/coredns/Corefile | grep -c kubernetes
```

```
  0
```

### For contrast, a syntax error is loud

```
  coredns-df6c596f8-qbcrr   0/1   CrashLoopBackOff
  coredns-df6c596f8-w97mh   0/1   CrashLoopBackOff
  endpoints: 10.244.0.4                       <- the surviving old pod
  log: plugin/prometheus: this plugin can only be used once per Server Block
```

**A broken Corefile names its own problem and takes the pods down with it.** That failure is easy;
this section exists because the valid-but-wrong one is not, and the two are reached by editing the
same file.

One detail worth carrying: during the rollout the endpoint list was **not empty** — one old pod was
still serving while the new ones crashlooped. **A partially populated endpoint list during a config
change is its own signal**, and a single endpoint where you expect two is worth a second look rather
than a relieved glance.

## Verification checklist

- [x] Two Services, one with a mistyped selector, are **identical in `kubectl get svc`**
- [x] `get endpoints` shows the broken one **empty** and the working one with **three pod IPs**
- [x] Connectivity confirms it: `FAILS` against the broken Service, `REACHES` against the working one
- [x] DNS resolves the Service name to a ClusterIP **regardless** of whether any endpoint exists
- [x] An Ingress with `ADDRESS` set and a `1/1 Running` controller returned **HTTP 000** for every host
- [x] The cause was located by node, not by manifest: controller on `cka2-worker2`, port published on `cka2-control-plane`, **nothing listening on :80** there
- [x] After pinning the controller: **200** for `demo.local`, **404** for a non-matching host and for no host
- [x] `CLASS` reads `<none>` and routing still worked, because this controller watches class-less Ingresses
- [x] The shipped controller `nodeSelector` is `kubernetes.io/os: linux` — the `ingress-ready` label was never read
- [x] A `Bound` PVC mounts on a second node with `/data` present and **`marker.txt` missing**
- [x] The file exists in `/tmp/pv-drill` on the first worker only
- [x] With CoreDNS scaled to zero, a pod reaches the Service **by IP** and fails **by name**
- [x] `kubectl get svc kube-dns` still shows ClusterIP `10.96.0.10`, and the pod's `resolv.conf` still points at it
- [x] `endpoints kube-dns` is **empty** and `deploy coredns` reads **`READY 0/0`** — a self-consistent ratio, not an obvious failure
- [x] `nslookup` returns `connection timed out; no servers could be reached`
- [x] Scaling CoreDNS back restores two endpoints and the name resolves to the ClusterIP the IP test used
- [x] Removing the `kubernetes` block leaves CoreDNS **2/2 Running with 0 restarts and populated endpoints**
- [x] Its logs contain **zero** error/warn/fail lines in that state — only the reload SHA and the version banner
- [x] Internal `web` returns **NXDOMAIN for `web.dns.podman`** while external `example.com` resolves normally
- [x] `exec deploy/coredns -- cat /etc/coredns/Corefile | grep -c kubernetes` returns **0**, confirming what is loaded rather than what was applied
- [x] A genuine syntax error instead gives **CrashLoopBackOff** and a log line naming the plugin
- [x] During that rollout the endpoint list held **one** address, not zero — a partial list is its own signal

## Rollback

```bash
kubectl delete ns drills
kubectl delete pv pv-drill
kubectl -n kube-system scale deploy coredns --replicas=2   # if a drill left it at 0
kubectl delete -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

`Retain` means the PV is not cleaned up for you; the directory on the node outlives everything above.

## Where this bit us

**The first `kubectl create ingress` failed and the output was thrown away.** It ran seconds after
`kubectl apply` of the controller, before the admission webhook was serving, and the error went to
`/dev/null` along with the rest of stderr. The next command reported "No resources found", which sent
the investigation toward the port mapping — the right place eventually, but for the wrong reason.
**Suppressing stderr while a procedure is still being written costs more than the noise it removes.**

**`HTTP 000` was the most useful signal on the page and is easy to skim past.** It is not a
failed request, it is no request — which rules out the Ingress rule, the Service and the backend
before any of them are examined, and points at the port path. A `404` from the same setup would have
meant the opposite: the connection worked and the rule did not match.

**Two of the three drills fail in the same shape.** The Service has no endpoints, the Ingress has no
listener, and the PVC has no data — in each case the Kubernetes object is correct and complete, and
the thing it points at was never checked. **The habit that catches all three is to verify the far end,
not the object you just created.**

## Follow-ups

- [ ] Repeat the storage drill against a real CSI driver, where the same task should keep the data and the node-locality trap disappears
- [ ] Add `nodeAffinity` to the hostPath PV and confirm the scheduler refuses the second pod instead of mounting an empty directory
- [ ] Add a NodePort and a LoadBalancer Service drill, including what `EXTERNAL-IP: <pending>` means on a cluster with no provider
- [ ] Break the `forward` block instead and confirm the third row of the table — external failing while internal works — which is the one combination not yet measured
- [ ] Test an Ingress with `ingressClassName` deliberately wrong, to see the silent-ignore case rather than reasoning about it

## Related

[[cka-exam-first-three-minutes]] — shell setup and generated YAML.
[[cka-workloads-scheduling-drills]] — the workload half, where the same status-column problem appears in Deployments.
[[cka-practice-cluster-and-checks-that-lie]] — etcd, RBAC, NetworkPolicy, a dead node and a kubeadm upgrade.
[[ingress-nginx-onprem]] — the same controller installed for real rather than for a drill.
[[longhorn-storage-onprem]] — storage that does follow the pod, and what it costs to run.
