---
title: MetalLB in L2 mode — real LoadBalancer services on an on-prem cluster
date: 2026-08-07
domain: install
tags: [on-prem, bare-metal, networking]
stack: [kubernetes, metallb, kubectl, calico]
summary: Hand out LAN addresses to LoadBalancer services on hardware you own, using MetalLB in L2 mode. Testing it from a cluster node returns 200 whether or not the mechanism works — kube-proxy answers locally, and the ARP table is the only honest check.
source: handson
env: MetalLB 0.14.8 · install path on Kubernetes 1.31.14 (kubeadm/Calico 3.28.2/Ubuntu 24.04.4, AWS EC2) · L2 announcement and failover on Kubernetes 1.32.2 (kind 0.27 on podman, kindnet, one bridge) — not yet on bare metal
verified: 2026-08-08
verifiability: partial
verifiability-note: Install path on EC2, L2 announcement and failover on a kind bridge. Never on bare metal with a real switch — and a cloud VPC cannot host L2 mode at all.
duration: 20–30 min
risk: medium
---

> **Verified 2026-08-08, across two environments, because no single one could do it.** The install
> path ran on a three-node EC2 cluster. The L2 mechanism itself — ARP answered for the assigned
> address, the address moving when a node dies — was verified on a three-node kind cluster sharing
> one bridge, where ARP is real. Both are in [Rehearsing this without hardware](#rehearsing-this-without-hardware).
>
> **Do not rehearse L2 mode on a cloud.** An AWS VPC does not deliver traffic to an address no ENI
> owns, and does not forward ARP for one. From a LAN machine outside the cluster the assigned VIP
> gives `curl` → `000` and `ip neigh` → `FAILED`, while a node address on the same subnet resolves
> and answers normally. Nothing about the configuration can fix that.
>
> Five corrections came out of the two runs, and one of them makes a cluster look healthy when it is
> not. See [Where this bit us](#where-this-bit-us).

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

```yaml title="metallb-pool.yaml"
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

Check the MAC against the node rather than trusting the address, because that is the assertion:

```bash
# on the announcing node named in the nodeAssigned event
cat /sys/class/net/<IFACE>/address
```

On the verification run the client's ARP entry read `d6:8d:1a:ce:8a:06`, the announcing node's
interface read the same, and the `nodeAssigned` event named that node. Three independent sources
agreeing is what "verified" means here.

### Failover test

The reason to run L2 mode at all is that it survives losing a node. Verify it rather than assuming it.

**Two obvious ways to do this both fail to test anything.** Worth knowing before you conclude that
failover works.

*Cordon and drain does not move the address.* The speaker is a DaemonSet, `drain --ignore-daemonsets`
leaves it running, and a cordoned node goes on announcing quite happily. The address stayed put for
as long as it was watched. Drain tests pod eviction; it says nothing about L2.

*Deleting the speaker pod does not test it either.* The DaemonSet recreates the pod on the same node
within a second or two, and the announcement comes back to where it started. A 1-second probe loop
recorded zero failures — which looks like a flawless failover and is actually a failover that never
happened.

**Take the node away.** That is the failure this mechanism exists for, and the only test that
exercises the client's ARP cache:

```bash
# from the NON-cluster machine, in one terminal
while true; do printf '%s %s\n' "$(date +%s)" \
  "$(curl -s -m1 -o /dev/null -w '%{http_code}' http://192.168.1.240)"; sleep 1; done
```

```bash
# then power off, or hard-stop, the node named in the nodeAssigned event
```

```bash
kubectl describe svc lbtest | grep nodeAssigned | tail -1     # names the new node
ip neigh show 192.168.1.240                                   # on the client: a different MAC now
```

Measured on the verification run: probes failed at +1s, +3s and +5s after the node was stopped, and
were back to `200` at +7s — **about a six-second outage**, with the client's ARP entry re-resolving
to the new node's MAC. Budget ten seconds and treat anything much longer as a problem. A gap that
never ends means the remaining speakers are not gossiping — check port 7946 between nodes.

Bring the node back and the address does **not** return to it; MetalLB has no preference for the
original leader. Do not wait for that as a sign of recovery.

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
- [ ] **Powering off** the announcing node moves the address; traffic recovers within ~10s (cordon, drain and pod deletion all fail to test this)
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

## Where this bit us

Two runs on 2026-08-08: the install path on three EC2 instances plus a fourth non-cluster machine on
the same subnet, and the L2 mechanism on a three-node kind cluster on one bridge. Five findings, the
first of which is the one to remember.

**A `200` that proves nothing.** Curling the assigned VIP from a cluster node returned `200` from
every node — on the AWS network, where L2 announcement demonstrably cannot work at all. kube-proxy
programs iptables rules for LoadBalancer addresses on every node, so the node answers itself and no
ARP request is ever sent. The tell is an empty ARP table for an address you just talked to.
Reproduced identically on kind, where the mechanism *does* work: `200` from the node with no ARP
entry, `200` from the non-cluster client with the announcing node's MAC. **This document previously
warned only against testing from a pod**, leaving the far more tempting mistake wide open.

**Neither cordon+drain nor deleting the speaker tests failover.** Drain leaves the DaemonSet running
and the cordoned node keeps announcing. Deleting the speaker pod gets it recreated on the same node
in about a second, and a 1-second probe loop recorded zero failures — a perfect-looking failover that
did not occur. Stopping the node produced the real thing: failures at +1s, +3s, +5s, back to `200` at
+7s, ARP re-resolved to the surviving node's MAC.

**`avoidBuggyIPs` does not do what the comment claimed.** It skips addresses ending in `.0` and
`.255`, not the ends of your range. With `…240-…250` the first service was assigned `…240`, not
`…241` — on both platforms.

**7946 is neither opened nor checkable where the document asked.** No document in this set opened it,
and nothing listens on it until step 2 installs the speaker, so the prerequisite as written fails
whether or not the firewall is correct. The two failure modes at least look different: filtered
hangs, open-with-nothing-behind-it gives `Connection refused` immediately.

**The address does not come back.** When the stopped node returned, the announcement stayed on its
replacement. Fine, but not what "recovery" looks like if you are waiting for the original.

Smaller: `kube-proxy`'s configmap reports `mode: ""` on a kubeadm 1.31 cluster rather than the word
`iptables`.

## Rehearsing this without hardware

L2 mode needs a real broadcast domain, so where you rehearse it decides whether the rehearsal means
anything.

| Environment | Install path | ARP, announcement, failover |
|---|---|---|
| Cloud VM subnet (AWS VPC, and equivalents) | works | **impossible** — the fabric filters on IP and does not forward ARP for an unowned address |
| Containers on one bridge (kind, k3d, plain Docker) | works | works — the bridge is a genuine L2 segment |
| VMs on one bridged network (libvirt, Proxmox, nested) | works | works, and closest to the target |
| The actual LAN | works | works, and is the only place `verified` should eventually come from |

The kind cluster used here, for anyone repeating it:

```yaml title="kind-cluster.yaml"
# same shape as the on-prem cluster: one control plane, two workers
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: metallb-l2
nodes:
  - role: control-plane
  - role: worker
  - role: worker
```

```bash
kind create cluster --config kind-cluster.yaml
docker network inspect kind --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

Take the pool from that subnet, outside the range the container runtime hands out — `…240-…250` of a
`/24` works — and then follow this document from step 1 unchanged.

The non-cluster machine is one more container on the same network:

```bash
docker run -d --name lanclient --network kind nicolaka/netshoot sleep 3600
docker exec lanclient ip neigh show <LB_IP>
```

Two divergences to keep in mind: kind ships kindnet rather than Calico, and its Kubernetes version
tracks the kind release rather than yours. Neither touches the ARP path, which is handled by the
speaker and kube-proxy, but neither is your cluster either.

## Failure points documented upstream

These come from the MetalLB documentation and its issue tracker, and were not hit on either run above.

**Pool overlapping DHCP** — the failure lands on a random laptop, not on the cluster, and nothing in `kubectl` shows it. The prerequisite scan is the only cheap defence. ([MetalLB — L2 mode](https://metallb.universe.tf/concepts/layer2/))

**IPVS without strictARP** — kube-proxy answers ARP for the service address, announcements go to the wrong node, and reachability becomes intermittent depending on which reply the client caches. Step 1. Both verification clusters ran iptables mode, so this stayed untested. ([Installation — preparation](https://metallb.universe.tf/installation/#preparation))

**Applying the pool before the webhook is ready** — `Internal error occurred: failed calling webhook`. Not a configuration error; wait for the controller rollout and re-apply. Step 2.

**Expecting L2 to distribute load** — one node carries all traffic for a given service. Under a real load test the ceiling is one NIC, and adding nodes does not raise it. Use BGP mode, or split across several services and addresses.

**Running MetalLB in BGP mode alongside Calico's BGP** — both want to be the BGP speaker on the node and they conflict. L2 mode has no such interaction, which is part of why this document uses it. If you need BGP, configure it through Calico rather than running both.

**`externalTrafficPolicy: Local` with an uneven pod spread** — works until the address moves to a node without a pod. Section 5.

## Follow-ups

- [ ] Run this on the real LAN. Containers on one bridge proved the mechanism, but not a real switch, a real DHCP server to collide with, or `strictARP` under IPVS 📅 2026-09-30
- [ ] Record the reserved LAN range in the network documentation, not only in the manifest
- [ ] Put an ingress controller on a single LoadBalancer address, with everything else behind it on ClusterIP — cheaper than an address per service. Procedure drafted in [[ingress-nginx-onprem]], still unverified
- [ ] Revisit BGP mode if any single service outgrows one node's bandwidth

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on. This document answers the LoadBalancer follow-up left open there.
[[k8s-node-drain-replace]] — the drain used in the failover test, with the pre-checks that matter on a live cluster.
[[argocd-helm-ha-install]] — its ingress assumes something already answers for an external address. On-prem, that something is this.
[[pod-crashloopbackoff]] — if the speaker or controller pods will not start.
[[metallb-pin-loadbalancer-ip]] — pins a fixed address from the pool set up here onto any `type: LoadBalancer` service, not only the ingress controller. Unverified.
