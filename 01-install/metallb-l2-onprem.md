---
title: MetalLB in L2 mode — real LoadBalancer services on an on-prem cluster
date: 2026-08-07
domain: install
tags: [on-prem, bare-metal, networking]
stack: [kubernetes, metallb, kubectl, calico]
summary: Hand out LAN addresses to LoadBalancer services on hardware you own, using MetalLB in L2 mode. The address pool and kube-proxy's ARP setting decide whether this works or takes down a neighbouring host.
source: handson
env: Target — Kubernetes 1.31 (kubeadm, on-prem) · MetalLB 0.14 · Calico 3.28 · Ubuntu 24.04 LTS
verified:
duration: 20–30 min
risk: medium
---

> ⚠️ **This procedure has not been executed in this environment yet.** It is assembled from upstream
> MetalLB documentation, so `verified` is empty and the site lists it as needing verification. Run it
> once on the real cluster, then fill in `verified` and correct whatever was wrong.

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
| Node-to-node traffic on 7946 | `nc -zv <W1_IP> 7946` | open (speakers gossip over memberlist) |

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

A kubeadm cluster defaults to iptables mode, where this setting is not required. If the value is `ipvs`, set it:

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
  # Skips .240 and .250 (network/broadcast-style addresses in some setups).
  # Leave false unless you know your gear is fine with them.
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

Find which node took the announcement:

```bash
kubectl -n metallb-system logs -l component=speaker --tail=200 | grep -i 'assigned\|announcing'
```

Now the actual test — **from a machine on the LAN, not from inside the cluster.** Curling from a pod proves nothing here; it never touches ARP.

```bash
# from your workstation
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.241
```

```bash
arp -n | grep 192.168.1.241
```

The MAC address in that ARP entry belongs to the announcing node. That is the whole mechanism, visible in one line.

### Failover test

The reason to run L2 mode at all is that it survives losing a node. Verify it rather than assuming it.

```bash
# note the announcing node from the speaker logs above, then cordon and drain it
kubectl cordon <ANNOUNCING_NODE>
kubectl drain <ANNOUNCING_NODE> --ignore-daemonsets --delete-emptydir-data
```

```bash
# from the workstation, in another terminal — expect a short gap, then 200s again
while true; do curl -s -o /dev/null -w '%{http_code} ' http://192.168.1.241; sleep 1; done
```

Recovery normally takes about ten seconds while the new leader gratuitously ARPs. A gap that never ends means the remaining speakers are not gossiping — check port 7946 between nodes.

```bash
kubectl uncordon <ANNOUNCING_NODE>
```

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
- [ ] `curl` to that IP **from outside the cluster** returns the application
- [ ] `arp -n` shows the address resolving to the announcing node's MAC
- [ ] Draining the announcing node moves the address; traffic recovers within ~15s
- [ ] Every address in the pool is outside the DHCP range (re-check the router config, not memory)
- [ ] The MetalLB version is recorded in this document's `env`

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

## Failure points documented upstream

**This is not "where this bit us" — nobody has run this here yet.** These come from the MetalLB documentation and its issue tracker. Replace them with what actually happened on your first run.

**Pool overlapping DHCP** — the failure lands on a random laptop, not on the cluster, and nothing in `kubectl` shows it. The prerequisite scan is the only cheap defence. ([MetalLB — L2 mode](https://metallb.universe.tf/concepts/layer2/))

**IPVS without strictARP** — kube-proxy answers ARP for the service address, announcements go to the wrong node, and reachability becomes intermittent depending on which reply the client caches. Step 1. ([Installation — preparation](https://metallb.universe.tf/installation/#preparation))

**Applying the pool before the webhook is ready** — `Internal error occurred: failed calling webhook`. Not a configuration error; wait for the controller rollout and re-apply. Step 2.

**Expecting L2 to distribute load** — one node carries all traffic for a given service. Under a real load test the ceiling is one NIC, and adding nodes does not raise it. Use BGP mode, or split across several services and addresses.

**Running MetalLB in BGP mode alongside Calico's BGP** — both want to be the BGP speaker on the node and they conflict. L2 mode has no such interaction, which is part of why this document uses it. If you need BGP, configure it through Calico rather than running both.

**`externalTrafficPolicy: Local` with an uneven pod spread** — works until the address moves to a node without a pod. Section 5.

## Follow-ups

- [ ] Run this on the real cluster, correct it, and set `verified`
- [ ] Record the reserved LAN range in the network documentation, not only in the manifest
- [ ] Decide whether an ingress controller should take a single LoadBalancer address, with everything else behind it on ClusterIP — cheaper than an address per service
- [ ] Revisit BGP mode if any single service outgrows one node's bandwidth

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on. This document answers the LoadBalancer follow-up left open there.
[[k8s-node-drain-replace]] — the drain used in the failover test, with the pre-checks that matter on a live cluster.
[[argocd-helm-ha-install]] — its ingress assumes something already answers for an external address. On-prem, that something is this.
[[pod-crashloopbackoff]] — if the speaker or controller pods will not start.
