---
title: What a hypervisor under the lab would settle — and the four things it would not
date: 2026-10-17
domain: reference
tags: [proxmox, virtualization, homelab, evidence]
summary: Fifteen documents here start from "assume three nodes" and the layer below them is empty, so every on-prem page was proved on EC2 and says so. Each of those pages already names what its substitute could not exercise; this sorts that list into what a Proxmox host would settle, what it would only move, and what still needs a second machine and a switch. Proxmox VE 9.2 does ship arm64, and this laptop still cannot run it.
source: handson
env: Verified from this repository's own frontmatter, the Proxmox public repositories, the Terraform Registry and GitHub, on macOS 26.6.2 / Apple M1 Pro
verified: 2026-10-17
verifiability: field
verifiability-note: Nothing on this page was run on Proxmox. This machine is an M1 Pro with no FEAT_NV, so a Proxmox guest could not run guests of its own, and there is no spare bare-metal host here — the facts below are repository measurements and public-repository lookups, and every claim about what Proxmox would settle is reasoning from them, marked as such. Settling it needs one spare machine, and the switch-dependent half needs two plus a managed switch.
duration: 30–45 min to read and decide
risk: low
---

> **Verified 2026-10-17** for the measurements and lookups below. **Nothing here was run on
> Proxmox**, and the section that says so is the most important one on the page.

## The gap, measured

Fifteen documents in this repository begin after the nodes exist:

```
  01-install/onprem-3node-kubeadm-ubuntu.md       01-install/longhorn-storage-onprem.md
  01-install/metallb-l2-onprem.md                 01-install/longhorn-backup-target-onprem.md
  01-install/ingress-nginx-onprem.md              01-install/cert-manager-onprem.md
  01-install/garage-object-storage-onprem.md      01-install/gitlab-ci-argocd-fastapi-onprem.md
  01-install/argocd-helm-ha-install.md            02-runbook/schedulable-node-budget.md
  …and five more
```

Searching every document for the layer underneath returns one incidental mention and one `qemu` in a
`stack` line. **The lab has no documented floor.**

## What the substitute could not exercise — in the pages' own words

This is the part that makes the case specific rather than general. Every "on-prem" page here was
proved on EC2 and says so in its `verifiability-note`:

```
  onprem-3node-kubeadm-ubuntu
    "run on 3× AWS EC2 t3.medium, not on bare metal"
    unproven: real NIC and driver behaviour · disabling swap · cloned product_uuid
              collisions · ufw rules

  longhorn-storage-onprem
    "Ran on EC2 with EBS data disks"
    unproven: real disk controllers · a multipathd that is genuinely in use

  metallb-l2-onprem
    "Install path on EC2, L2 announcement and failover on a kind bridge.
     Never on bare metal with a real switch"
```

**That list is the requirement.** Any argument for a hypervisor has to be checked against it line by
line, which is what the rest of this page does.

## Sorting the list

### Would be settled

- **Snapshot-and-rollback loops.** The repository's method is to break things on purpose and record
  both outputs. On EC2 that costs an instance rebuild; the pages that do it — the Crossplane drift
  test, the Flink TaskManager kill — stayed cheap only because their state was disposable. A
  node-level snapshot makes `kubeadm upgrade` and etcd restore repeatable instead of one-shot.
- **Deliberate disk loss.** `longhorn-storage-onprem` tests replication by trusting it. Detaching a
  virtual disk from a running node is a real failure injection and the recovery drill that follows it
  is real work.
- **Node lifecycle under power loss.** Cutting power to a node mid-drain is a different event from
  `kubectl delete node`, and it is the one `schedulable-node-budget` reasons about without producing.
- **Recreating the lab from code.** `packer-plugin-proxmox` and a Terraform provider make the three
  nodes an artifact rather than a memory, which is the same evidence standard the Terraform and
  Pulumi pages already hold themselves to.

### Would only be moved, not settled

**A VM on Proxmox is still a VM.** Three of the four unproven items above survive the move:

- **Real NIC and driver behaviour** — a Proxmox guest sees `virtio-net`, not the host's card. Closer
  to bare metal than EC2's ENA, and still not a driver.
- **Real disk controllers** — `virtio-scsi` instead of EBS. Same change of costume.
- **`multipathd` genuinely in use** — needs more than one path to the same LUN, which needs storage
  that offers one.

Two of these can be settled on Proxmox specifically, and only by giving the guest the hardware:
PCI passthrough for the NIC, disk passthrough for the controller. **That is a different exercise from
installing a hypervisor**, and it is where the honest version of this page would stop promising.

### Would not be settled at all

`metallb-l2-onprem` says "never on bare metal with a real switch". **A single Proxmox host does not
provide a switch.** A VLAN-aware Linux bridge gives the guests tagged interfaces and the ARP traffic
still never leaves the box. L2 announcement failing over across a real switch's MAC table needs two
machines and the switch between them.

**Of the four named gaps, one is settled, two are moved, and one is untouched.** That is the whole
argument, and it is less than the usual pitch for a home hypervisor.

## What is verified about Proxmox itself

These are lookups, not experience:

```
  proxmox-ve_9.2-1-arm64.iso            exists
  pve-no-subscription  binary-arm64     591 packages, including ceph-base
  pve-no-subscription  binary-amd64     HTTP 200   (open, no credentials)
  pve-enterprise       binary-amd64     HTTP 401   (subscription required)

  Terraform  bpg/proxmox        0.116.1        2026-10-15   16,165,540 downloads
  Terraform  Telmate/proxmox    3.0.2-rc10     2026-08-30   19,902,066 downloads
  Packer     packer-plugin-proxmox  v1.2.4     2026-07-21
```

Three of those are worth a sentence each.

**Proxmox VE ships arm64.** The common assumption that it is x86-only is out of date — 9.2 has an
arm64 ISO and a 591-package arm64 repository with Ceph in it. That changes which spare machines are
candidates.

**The free repository is genuinely open and the enterprise one genuinely is not** — 200 against 401,
which is the cleanest possible statement of what "no subscription required" means here. The
difference is update channel and support, not capability.

**The more-downloaded Terraform provider is still a release candidate.** `Telmate/proxmox` has more
historical downloads and `3.0.2-rc10` as its newest version; `bpg/proxmox` is on a stable `0.116.1`
published two days before this page. Download count is a measure of the past, and picking by it here
picks the RC.

## Why this page is `field` and not a procedure

```
  host arch             arm64 (Apple M1 Pro)
  kern.hv_support       1
  hw.optional.arm.FEAT_NV  not reported
```

`hv_support` means this Mac can run virtual machines. **`FEAT_NV` absent means those machines cannot
run virtual machines of their own.** Proxmox installed in a VM here would boot, serve its web UI, and
fail to start a single guest with KVM — which would produce a page about a hypervisor that never
hypervised.

The alternative — nesting under an x86 emulator — replaces hardware virtualization with instruction
translation, and any timing or driver behaviour measured that way is fiction. The Harbor page in this
repository already recorded where that road ends.

**So this page stops at the decision and does not pretend to be an install.** The install is one
spare machine away, and the switch-dependent half is two machines and a managed switch away.

## Verification checklist

- [x] **15** documents here assume three nodes already exist
- [x] A search for the virtualization layer across all documents returns **one incidental mention** and a single `qemu` in a `stack` line
- [x] `onprem-3node-kubeadm-ubuntu` states it ran on **EC2, not bare metal**, and names NIC behaviour, swap, `product_uuid` and `ufw` as unproven
- [x] `longhorn-storage-onprem` names **real disk controllers** and **multipathd in use** as unproven
- [x] `metallb-l2-onprem` states L2 failover was tested on a **kind bridge**, never on a real switch
- [x] `proxmox-ve_9.2-1-arm64.iso` exists and the arm64 repository carries **591 packages**
- [x] `pve-no-subscription` returns **200** without credentials; `pve-enterprise` returns **401**
- [x] `bpg/proxmox` is **0.116.1** stable; `Telmate/proxmox` is **3.0.2-rc10** despite more downloads
- [x] This host reports `kern.hv_support: 1` and **no `FEAT_NV`**, so nested virtualization is unavailable

## Where this bit us

**The page was commissioned as an install guide and could not be one.** The material it came from
described a working Proxmox lab; this repository forbids presenting a command that was never run as
verified, and the machine available cannot run the thing. Writing the install anyway would have
produced a page that looks like every other page here and is not — which is a worse outcome than a
short honest one, because the rest of this site is trusted on the assumption that it ran.

**The checking turned up a fact that contradicted the premise.** "Proxmox is x86-only" was about to go
into the limitations section from memory. The repository listing says otherwise, and the arm64 port has
Ceph in it. **A limitation quoted from memory is the same risk as a command quoted from memory**, and it
cost one `curl` to find out.

**The strongest argument for the hypervisor turned out to be weaker than the usual one.** Sorting the
pitch against this repository's own `verifiability-note` lines — rather than against a general case
for homelabs — settles one gap, moves two, and leaves one untouched. That is still worth doing, and it
is not what the pitch said.

## Follow-ups

- [ ] Install Proxmox VE 9.2 on a spare machine and redo `onprem-3node-kubeadm-ubuntu` on it, recording which of that page's four unproven items actually change state
- [ ] Measure a snapshot-and-rollback cycle around `kubeadm upgrade` and compare the wall-clock cost against the EC2 rebuild the current page implies
- [ ] Detach a virtual disk from a running Longhorn node and record the replica rebuild, which is the test `longhorn-storage-onprem` currently trusts
- [ ] Settle whether a VLAN-aware bridge changes anything for MetalLB L2, or whether the answer is simply "two machines and a switch" — the page above reasons it is the latter and has not shown it

## Related

[[onprem-3node-kubeadm-ubuntu]] — the page whose four unproven items are the requirement this one sorts.
[[longhorn-storage-onprem]] — replication trusted rather than tested, and the disk-detach drill that would test it.
[[metallb-l2-onprem]] — the gap a single hypervisor host does not close.
[[harbor-installer-on-podman-arm64]] — where the emulation road ends, and why it is not the alternative here.
[[pulumi-kubernetes-outputs-and-drift]] — the IaC evidence standard this lab would be rebuilt to meet.
