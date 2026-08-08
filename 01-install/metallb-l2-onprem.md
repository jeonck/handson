---
title: MetalLB in L2 mode — real LoadBalancer services on an on-prem cluster
date: 2026-08-07
domain: install
tags: [on-prem, bare-metal, networking]
stack: [kubernetes, metallb, kubectl, calico]
summary: Hand out LAN addresses to LoadBalancer services on hardware you own, using MetalLB in L2 mode. Testing it from a cluster node returns 200 whether or not the mechanism works — kube-proxy answers locally, and the ARP table is the only honest check.
source: handson
env: Kubernetes 1.31.14 (kubeadm) · MetalLB 0.14.8 · Calico 3.28.2 · Ubuntu 24.04.4 LTS — install path exercised on AWS EC2 2026-08-08; L2 announcement cannot be exercised there
verified:
duration: 20–30 min
risk: medium
---

> ⚠️ **`verified` is deliberately still empty.** On 2026-08-08 this was run end to end on a
> three-node EC2 cluster, and the install path — CRDs, pool, advertisement, address assignment,
> leader election — worked and has been corrected where it was wrong. But **the thing this document
> is actually about, answering ARP on a LAN, cannot be exercised on a cloud VPC at all**, so the
> checks that matter most are still unproven. Marking it verified on the strength of the parts that
> did run would be the more dishonest option.
>
> What was proven not to work there, so nobody repeats the attempt: an AWS VPC does not deliver
> traffic to an address that is not assigned to an ENI, and does not forward ARP for one. From a LAN
> machine outside the cluster, the assigned VIP gives `curl` → `000` and `ip neigh` → `FAILED`, while
> a real node address on the same subnet resolves to a MAC and answers normally. Rehearse this on
> hardware, a home lab, or nested VMs on one bridge — not on a cloud.
>
> Four corrections did come out of the run. See [What the EC2 run found](#what-the-ec2-run-found).

On a cloud provider, `type: LoadBalancer` calls an API and an address appears. On your own hardware nothing answers that call, so the service sits at `<pending>` forever. MetalLB is the thing that answers it.

This document covers **L2 mode**, which needs nothing from your network team — the speaker pod answers ARP for the assigned address, and the switch sends the traffic to that node. BGP mode is stronger and is a different document; the last section says when to reach for it.

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]] — three nodes on one flat LAN, Calico as the CNI.

## What L2 mode actually does

Worth being precise, because the name misleads people into expecting load balancing.

1. A service asks for `type: LoadBalancer`. The MetalLB controller picks a free address from your pool and writes it into the service status.
2. **One** node is elected leader for that address. Its speaker pod answers ARP requests for it.
3. Every packet for that service arrives at that one node, and kube-proxy spreads it across pods from there.

So it is **failover, not load balancing.** A single service's inbound traffic is capped by one node's bandwidth. If the leader node dies, another takes over in roughly ten seconds. For internal services on a three-node cluster this is fine; for something needing genuine multi-gigabit ingress it is not.

- Source: [MetalLB — L2 mode concepts](https://metallb.universe.tf/concepts/layer2/)

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Working cluster | `kubectl get nodes` | all nodes `Ready` |
| CNI running | `kubectl -n calico-system get pods` | all `Running` |
| Free addresses on the node LAN | see below | a contiguous range nobody else owns |
| Firewall permits 7946/tcp **and** 7946/udp between nodes | firewall config, not a port check | allowed |

**7946 cannot be checked before installing.** Nothing listens on it until the speaker DaemonSet is
running, so `nc -zv <W1_IP> 7946` fails at this point no matter how the firewall is set — and the two
failures look different in a way worth knowing: a filtered port hangs until timeout, an open port
with nothing behind it returns `Connection refused` immediately. Confirm the *rule* here, and check
the *port* after step 2. Neither this document nor [[onprem-3node-kubeadm-ubuntu]] previously said to
open it, and memberlist needs both protocols:

```bash
# on every node, if ufw is active
sudo ufw allow 7946/tcp
sudo ufw allow 7946/udp
```

### Reserve the address range first — before touching the cluster

This is the step that can break things outside Kubernetes. MetalLB will answer ARP for whatever you give it, including an address your DHCP server hands to a laptop tomorrow. Two hosts claiming one address is an outage for both, and it is confusing to debug from the Kubernetes side because the cluster looks healthy.

Get the range from whoever runs the network, or carve it out of the router's DHCP configuration yourself. Then confirm it is genuinely idle:

```bash
# from any machine on the same LAN — every address in the range must be silent
for i in $(seq 240 250); do
  ping -c1 -W1 192.168.1.$i >/dev/null 2>&1 && echo "IN USE: 192.168.1.$i"
done
echo "scan done"
```

```bash
# ARP table view of who is actually on the segment
ip neigh show | sort -t. -k4 -n
```

Requirements for the range:

- **Same subnet as the nodes.** L2 mode announces on the node's own segment; an address from a different subnet is never reachable.
- **Outside the DHCP pool.** Not merely unused today.
- Sized for the services you expect, plus room. Resizing later is one edit, but renumbering live services is not free.

This document uses `192.168.1.240-192.168.1.250` as `<LB_RANGE>`. Substitute your own everywhere.

## 1. kube-proxy mode and strict ARP

If kube-proxy runs in IPVS mode, MetalLB L2 requires `strictARP: true`. Without it kube-proxy answers ARP for addresses it should not, and announcements land on the wrong node.

Check which mode you are in:

```bash
kubectl -n kube-system get configmap kube-proxy -o yaml | grep -E '^\s+mode:'
```

On a kubeadm 1.31 cluster this prints `mode: ""` — an empty string, not the word `iptables`. Empty
means "the default", which is iptables, and this setting is not required. Only a literal `ipvs` calls
for the change below; do not read the blank as a missing value and go looking for it.

```bash
kubectl -n kube-system get configmap kube-proxy -o yaml | \
  sed -e 's/strictARP: false/strictARP: true/' | \
  kubectl apply -f - -n kube-system
```

```bash
kubectl -n kube-system rollout restart daemonset kube-proxy
kubectl -n kube-system rollout status daemonset kube-proxy
```

Restarting kube-proxy briefly disturbs service routing on every node. Do it before there is traffic on the cluster, not after.

- Source: [MetalLB — installation, preparation](https://metallb.universe.tf/installation/#preparation)

## 2. Install MetalLB

Pin the version. The CRD API group has changed across releases, and an unpinned manifest applied months later can arrive with resources your `IPAddressPool` no longer matches.

```bash
export METALLB_VERSION=v0.14.8
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/${METALLB_VERSION}/config/manifests/metallb-native.yaml
```

Current releases are on the [releases page](https://github.com/metallb/metallb/releases). Record whichever you used in this document's `env`.

That manifest creates the `metallb-system` namespace, the `controller` Deployment (assigns addresses), the `speaker` DaemonSet (announces them), and the CRDs.

```bash
kubectl -n metallb-system get pods -o wide
```

Wait for `controller` to be `Running` and for one `speaker` per node. **The webhook must be up before the next step** — applying an `IPAddressPool` too early fails with a webhook connection error, which reads like a config problem but is only impatience.

```bash
kubectl -n metallb-system rollout status deployment controller --timeout=120s
kubectl -n metallb-system get daemonset speaker
```

## 3. Give it the address pool

Two objects: the pool of addresses, and the instruction to announce them over L2. Both are needed — a pool with no advertisement assigns addresses that nobody answers for, which looks exactly like a broken network.

```yaml
# metallb-pool.yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: lan-pool
  namespace: metallb-system
spec:
  addresses:
    - 192.168.1.240-192.168.1.250     # <LB_RANGE> — must be free and outside DHCP
  autoAssign: true
  # Skips addresses ending in .0 and .255 only. It does NOT reserve the ends of
  # your range — with the range above, the first service gets .240. Harmless to
  # leave on; just do not count on it holding anything back.
  avoidBuggyIPs: true
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: lan-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - lan-pool
```

```bash
kubectl apply -f metallb-pool.yaml
```

```bash
kubectl -n metallb-system get ipaddresspool,l2advertisement
```

To keep a pool for explicit requests only — useful when you want most services on ClusterIP and only a chosen few exposed — set `autoAssign: false` and have services ask for the pool by annotation:

```yaml
metadata:
  annotations:
    metallb.io/address-pool: lan-pool
```

## 4. Verify with a real service

```bash
kubectl create deployment lbtest --image=nginx:1.27 --replicas=3
kubectl expose deployment lbtest --port=80 --type=LoadBalancer
```

```bash
kubectl get svc lbtest -w
```

`EXTERNAL-IP` should move from `<pending>` to an address in your range within a few seconds. Still `<pending>` after a minute means the controller could not assign — the reason is in its events, not its logs:

```bash
kubectl describe svc lbtest | tail -20
kubectl -n metallb-system logs deployment/controller --tail=50
```

Find which node took the announcement. The service's own events say it in one line, and unlike a log
grep they do not change shape between releases:

```bash
kubectl describe svc lbtest | grep -E 'IPAllocated|nodeAssigned'
```

```
Normal  IPAllocated   metallb-controller  Assigned IP ["192.168.1.240"]
Normal  nodeAssigned  metallb-speaker     announcing from node "k8s-w2" with protocol "layer2"
```

The speaker logs carry the same information in JSON, if you want the timestamps:

```bash
kubectl -n metallb-system logs -l component=speaker --tail=200 | grep -i 'assigned\|announcing'
```

### The test has to come from a machine that is not a cluster node

**Not from a pod, and not from a node either.** The pod case is obvious — it never touches ARP. The
node case is the trap: kube-proxy programs iptables rules for the LoadBalancer address on *every*
node, so a node curling the VIP is answered by its own local DNAT. You get a clean `200` with no ARP
request ever leaving the machine, and it tells you nothing about whether L2 works.

That is a genuinely misleading pass — on the EC2 run it returned `200` from all three nodes on a
network where the mechanism is fundamentally incapable of working. The tell is that `ip neigh`
holds no entry for an address you supposedly just talked to:

```bash
# on a cluster node — 200, and no ARP entry. This is the false positive.
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.240
ip neigh show 192.168.1.240
```

Use a workstation, a laptop, or any other host on the same segment that is not part of the cluster:

```bash
# from a NON-cluster machine on the LAN
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.240
```

```bash
ip neigh show 192.168.1.240      # or: arp -n | grep 192.168.1.240
```

`REACHABLE` with a MAC address that belongs to the announcing node is the whole mechanism, visible in
one line. `FAILED`, or no entry, means nothing answered the ARP request — the announcement is not
reaching the segment.

### Failover test

The reason to run L2 mode at all is that it survives losing a node. Verify it rather than assuming it.

**Cordon and drain do not move the announcement.** This was the plan here and it does not work: the
speaker is a DaemonSet, `drain --ignore-daemonsets` leaves it running, and a cordoned node keeps
announcing. Verified on 2026-08-08 — the address stayed on the drained node for as long as it was
watched, and moved within about 25 seconds of the speaker actually going away.

So drain tests pod eviction, not L2 failover. To test failover, take the speaker off the node:

```bash
# from the events above
NODE=k8s-w2
kubectl -n metallb-system delete pod \
  "$(kubectl -n metallb-system get pods -o wide --no-headers \
     | awk -v n="$NODE" '$1 ~ /^speaker/ && $7 == n {print $1}')"
```

```bash
# from the NON-cluster machine, in another terminal — expect a short gap, then 200s again
while true; do curl -s -o /dev/null -w '%{http_code} ' http://192.168.1.240; sleep 1; done
```

```bash
kubectl describe svc lbtest | grep nodeAssigned | tail -1     # names the new node
```

Recovery normally takes about ten seconds while the new leader gratuitously ARPs. A gap that never ends means the remaining speakers are not gossiping — check port 7946 between nodes.

Powering the node off, or stopping kubelet on it, is the more faithful test still — it is the failure
the mechanism exists for, and it also exercises the ARP cache on the client, which a pod deletion
does not.

Full drain semantics, including the PDB checks worth doing first, are in [[k8s-node-drain-replace]].

### Clean up the test

```bash
kubectl delete service lbtest
kubectl delete deployment lbtest
```

## 5. Decide externalTrafficPolicy before real services land

The default (`Cluster`) spreads traffic to pods on every node but rewrites the source IP, so applications log the node address instead of the client. `Local` preserves the client IP but only sends traffic to pods on the announcing node — and if that node has no pod, the service blackholes.

```yaml
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local     # keeps the client IP; needs a pod on the announcing node
```

Pick per service, and if you choose `Local`, make sure the workload runs on every node (a DaemonSet, or an anti-affinity spread) — otherwise you have built an intermittent outage that depends on which node holds the address.

## Verification checklist

- [ ] `kubectl -n metallb-system get pods` — controller `Running`, one speaker per node, no restarts
- [ ] `kubectl -n metallb-system get ipaddresspool` — the pool exists with the intended range
- [ ] `kubectl -n metallb-system get l2advertisement` — an advertisement references the pool
- [ ] A `type: LoadBalancer` service gets an `EXTERNAL-IP` within seconds
- [ ] `kubectl describe svc` shows a `nodeAssigned` event naming the announcing node
- [ ] `curl` to that IP **from a machine that is not a cluster node** returns the application
- [ ] `ip neigh` on that machine shows the address `REACHABLE` at the announcing node's MAC
- [ ] Removing the speaker from the announcing node moves the address; traffic recovers within ~15s
- [ ] Every address in the pool is outside the DHCP range (re-check the router config, not memory)
- [ ] The MetalLB version is recorded in this document's `env`

The two ARP lines are the ones that decide whether L2 mode works. Everything above them passes on a
network where it cannot possibly function — that is not hypothetical, it is what happened on EC2.

## Rollback

Remove configuration first, then the installation. Deleting the manifest while pools still exist leaves services holding addresses nothing announces — they look assigned and are unreachable.

```bash
kubectl delete -f metallb-pool.yaml
```

```bash
# services that had an address go back to <pending>; nothing else changes for them
kubectl get svc -A --field-selector spec.type=LoadBalancer
```

```bash
kubectl delete -f https://raw.githubusercontent.com/metallb/metallb/${METALLB_VERSION}/config/manifests/metallb-native.yaml
```

If kube-proxy was switched to `strictARP: true` in step 1 and you are removing MetalLB entirely, set it back the same way and restart the DaemonSet.

Stale ARP entries on client machines can outlive the removal — the address will appear reachable from a laptop that cached it. `ip neigh flush all` on the client, or wait out the cache.

## What the EC2 run found

2026-08-08, on a three-node kubeadm cluster in one AWS subnet plus a fourth non-cluster machine on
the same subnet. Everything up to the ARP boundary ran; these are the four things that were wrong.

**A `200` that proved nothing.** Curling the assigned VIP from a cluster node returned `200` from all
three nodes — on a network where L2 announcement demonstrably does not work. kube-proxy answers for
LoadBalancer addresses locally on every node. From the non-cluster machine the same request gave
`curl` → `000` and `ip neigh` → `FAILED`, while a real node address on that subnet resolved to a MAC
and answered normally, so the harness was fine and the mechanism was not. **The document previously
warned only against testing from a pod**, which leaves the far more tempting mistake wide open.
Section 4 now says which machine to use and shows the false positive.

**Cordon and drain do not move the announcement.** The failover test as written cannot work: the
speaker is a DaemonSet, `--ignore-daemonsets` keeps it alive, and a cordoned node goes on announcing.
The address moved about 25 seconds after the speaker pod itself was deleted. Failover section
rewritten.

**`avoidBuggyIPs` does not do what the comment said.** It skips addresses ending in `.0` and `.255`,
not the ends of your range. With `…240-…250` the first service was assigned `…240`, not `…241`.

**7946 is unopenable and uncheckable at the point the document asks for it.** No rule in any document
here opened it, and nothing listens on it until step 2 installs the speaker, so the prerequisite as
written fails whether or not the firewall is right. Prerequisites section now distinguishes the rule
from the check.

Smaller: `kube-proxy`'s configmap reports `mode: ""` rather than `iptables` on 1.31.

## Failure points documented upstream

These come from the MetalLB documentation and its issue tracker, and were not reached on the run above.

**Pool overlapping DHCP** — the failure lands on a random laptop, not on the cluster, and nothing in `kubectl` shows it. The prerequisite scan is the only cheap defence. ([MetalLB — L2 mode](https://metallb.universe.tf/concepts/layer2/))

**IPVS without strictARP** — kube-proxy answers ARP for the service address, announcements go to the wrong node, and reachability becomes intermittent depending on which reply the client caches. Step 1. ([Installation — preparation](https://metallb.universe.tf/installation/#preparation))

**Applying the pool before the webhook is ready** — `Internal error occurred: failed calling webhook`. Not a configuration error; wait for the controller rollout and re-apply. Step 2.

**Expecting L2 to distribute load** — one node carries all traffic for a given service. Under a real load test the ceiling is one NIC, and adding nodes does not raise it. Use BGP mode, or split across several services and addresses.

**Running MetalLB in BGP mode alongside Calico's BGP** — both want to be the BGP speaker on the node and they conflict. L2 mode has no such interaction, which is part of why this document uses it. If you need BGP, configure it through Calico rather than running both.

**`externalTrafficPolicy: Local` with an uneven pod spread** — works until the address moves to a node without a pod. Section 5.

## Follow-ups

- [ ] Run this where L2 can actually work — hardware, a home lab, or VMs on one bridge — and only then set `verified`. A cloud VPC cannot verify it; the install path is already done 📅 2026-09-30
- [ ] Record the reserved LAN range in the network documentation, not only in the manifest
- [ ] Put an ingress controller on a single LoadBalancer address, with everything else behind it on ClusterIP — cheaper than an address per service. Procedure drafted in [[ingress-nginx-onprem]], still unverified
- [ ] Revisit BGP mode if any single service outgrows one node's bandwidth

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on. This document answers the LoadBalancer follow-up left open there.
[[k8s-node-drain-replace]] — the drain used in the failover test, with the pre-checks that matter on a live cluster.
[[argocd-helm-ha-install]] — its ingress assumes something already answers for an external address. On-prem, that something is this.
[[pod-crashloopbackoff]] — if the speaker or controller pods will not start.
