---
title: Proxmox on rented bare metal — 42 minutes, $0.29, and the snapshot that silently was not one
date: 2026-10-17
domain: install
tags: [proxmox, virtualization, terraform, aws]
stack: [proxmox, terraform, aws, kvm, cloud-init]
summary: Terraform brings up an a1.metal instance, Proxmox VE 9.2 arm64 installs on Debian, a cloud-init template clones three nodes and they run with real KVM acceleration — all for 29 cents. The snapshot loop that is the whole reason for a hypervisor reports plausible millisecond timings while doing nothing, because disks imported onto directory storage are raw, and a rollback that works still loses the file written seconds before it.
source: handson
env: AWS a1.metal (16 vCPU, 31 GiB, Graviton, us-east-1) · Debian 13 arm64 ami-06dd9b472e689626b · Proxmox VE 9.2.20, kernel 7.0.14-24-pve · Terraform 1.15.7 with aws provider 6.69.1 · driven from macOS 26.6.2
verified: 2026-10-17
verifiability: partial
verifiability-note: One rented bare-metal host for 42 minutes, so nothing here covers clustering, HA fencing, live migration, ZFS or Ceph — all of which need a second and third node. The network is a NAT bridge with no physical port, which is what a cloud host allows and is not what an on-prem box would use, so VLAN and L2 behaviour remains untested. Guest-level verification of the rollback was read from the disk with qemu-nbd rather than from inside the guest, whose SSH did not come back in the window allowed.
duration: 60–90 min
risk: medium
---

> **Verified 2026-10-17.** Every number below came off the host described. Total spend for the
> session was **$0.29**, and the instance was destroyed at the end — the teardown output is in the
> rollback section.

A hypervisor under the lab is hard to justify when it means buying a machine. **It does not: renting
bare metal by the hour makes it a line item you can read.** This page builds the whole thing with
Terraform, installs Proxmox, clones three nodes, and destroys it — and spends most of its length on
the two places where it looked like it worked and had not.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Terraform | `terraform version` | 1.x |
| AWS credentials | `aws sts get-caller-identity` | an account you may spend in |
| vCPU quota | `aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A` | ≥ 16 |

## 1. Why it has to be `.metal`

A normal EC2 instance is already a guest, and AWS does not expose nested virtualisation on one.
Proxmox would install, serve its web interface, and fail to start a single VM — the same wall an
Apple Silicon laptop hits, where `hw.optional.arm.FEAT_NV` is simply absent.

The cheapest bare-metal instance is the one to look for, and it is far cheaper than the rest:

```
  a1.metal     $0.4080 /hr      16 vCPU   32 GiB   arm64
  c6g.metal    $2.1760 /hr
  m6g.metal    $2.4640 /hr
  m5zn.metal   $3.9641 /hr
  c5.metal     $4.0800 /hr
```

**Avoid the `mac*.metal` types entirely** — they carry a 24-hour minimum allocation, so a ten-minute
experiment bills a full day.

`a1.metal` is first-generation Graviton and arm64, which only works because **Proxmox VE 9.2 ships
arm64**: an `-arm64.iso` and a 591-package repository with Ceph in it. The assumption that Proxmox is
x86-only is out of date.

## 2. Terraform

```hcl title="main.tf"
resource "aws_instance" "pmx" {
  ami           = data.aws_ami.debian.id      # debian-13-arm64-*
  instance_type = "a1.metal"
  key_name      = aws_key_pair.k.key_name
  vpc_security_group_ids = [aws_security_group.sg.id]

  root_block_device {
    volume_size           = 50
    volume_type           = "gp3"
    delete_on_termination = true
  }
}
```

```
  aws_instance.pmx: Creation complete after 13s
  ami  = "debian-13-arm64-20261017-2634"
  ip   = "98.93.244.139"
  cost = "a1.metal = $0.408/hr"
```

**`delete_on_termination = true` is the line that keeps the bill at $0.29.** A detached 50 GiB gp3
volume left behind costs more per month than the whole experiment did.

The instance creates in 13 seconds and is reachable minutes later — **bare metal boots slowly**, and
the gap between "Terraform is done" and "SSH answers" is the part to wait out rather than debug.

## 3. Confirming it really is bare metal

Before installing anything, check the thing the whole exercise depends on:

```bash
systemd-detect-virt; ls -l /dev/kvm; nproc
```

```
  systemd-detect-virt   none
  /dev/kvm              present
  16 vCPU   31 GiB   CPU part 0xd08
```

**`none` is the answer that makes the rest possible.** On any non-metal instance this reads `kvm` or
`amazon`, and `/dev/kvm` is absent.

## 4. Installing Proxmox on Debian

Following the Proxmox documentation's "Install Proxmox VE on Debian" path, with the arm64 repository:

```bash
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/proxmox-archive-keyring.gpg] \
  http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
  | sudo tee /etc/apt/sources.list.d/pve.list
sudo apt-get update && sudo apt-get install -y proxmox-default-kernel
sudo reboot
sudo apt-get install -y proxmox-ve postfix open-iscsi chrony
```

```
  pve-manager/9.2.20/49318c671b82f31e (running kernel: 7.0.14-24-pve)
  pve-cluster  active      pvedaemon  active
  pveproxy     active      pvestatd   active

  pvesh get /nodes  ->  node=pmx status=online maxcpu=16 maxmem=31GiB
```

**The hostname has to resolve to a real address before `pve-cluster` will start.** On EC2 that means
writing the private IPv4 into `/etc/hosts` — and `hostname -I` is the wrong way to find it, because it
can return an IPv6 link-local first. `ip -4 -o addr show scope global` is the one that answers.

One output that looks broken and is not:

```
  getent hosts pmx        fe80::8ff:c9ff:feee:70c1 pmx
  getent ahostsv4 pmx     172.31.22.254
```

The `myhostname` NSS module supplies the link-local and `getent hosts` prints whichever family it finds
first. **The IPv4 resolution is correct; the alarming line is `getent` choosing, not a misconfiguration.**

## 5. A cloud-init template and three clones

```bash
qm create 9000 --name tpl-debian13 --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 --machine virt --bios ovmf \
  --serial0 socket --vga serial0 --scsihw virtio-scsi-single --ostype l26
qm set 9000 --efidisk0 local:1,efitype=4m
qm set 9000 --scsi0 local:0,import-from=/tmp/debian-13-arm64.qcow2
```

**`--machine virt --bios ovmf` is mandatory on arm64** — there is no SeaBIOS path, and the firmware
comes from `pve-edk2-firmware-aarch64`.

Then the step every tutorial gets wrong for this architecture:

```bash
qm set 9000 --ide2 local:cloudinit      # the advice everywhere
```

```
  kvm: -device ide-cd,bus=ide.1,unit=0,drive=drive-ide2: Bus 'ide.1' not found
  start failed: QEMU exited with code 1
```

**The arm64 `virt` machine type has no IDE bus.** The cloud-init drive has to go somewhere else:

```bash
qm set 9000 --scsi1 local:cloudinit
```

The failure arrives at `qm start`, not at `qm set`, so the template builds cleanly and the first clone
is where you find out.

### The bridge a cloud host cannot have

```
  bridge 'vmbr0' does not exist
```

Installing Proxmox over Debian does not convert the network configuration, and on EC2 you must not
convert it: **attaching `vmbr0` to the instance's NIC cuts the SSH session that is doing the
attaching.** A bridge with no physical port, plus NAT, is the shape that works:

```bash
ip link add name vmbr0 type bridge
ip addr add 10.10.10.1/24 dev vmbr0 && ip link set vmbr0 up
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 10.10.10.0/24 -o <nic> -j MASQUERADE
```

```
  vmbr0: 10.10.10.1/24
  nat: -A POSTROUTING -s 10.10.10.0/24 -o enP2p4s0 -j MASQUERADE
```

Guests then take static addresses from cloud-init rather than DHCP. **This is the one part of the lab
that is a cloud-host workaround rather than a model of an on-prem box**, where `vmbr0` would own the
physical NIC.

### Three nodes

```bash
qm template 9000
for i in 1 2 3; do qm clone 9000 10$i --name node$i --full; done
```

```
  clone 101: transferred 3.0 GiB of 3.0 GiB (100.00%)
  clone 102: transferred 3.0 GiB of 3.0 GiB (100.00%)
  clone 103: transferred 3.0 GiB of 3.0 GiB (100.00%)

  101 node1 running   102 node2 running   103 node3 running
  ping 10.10.10.101 OK   .102 OK   .103 OK
```

## 6. Proving the guests are accelerated, not emulated

A guest that boots proves nothing — QEMU will emulate arm64 on arm64 quite happily and slowly. The
evidence is in the process:

```bash
ls -l /proc/<qemu-pid>/fd | grep kvm
```

```
  fd 21 -> /dev/kvm
  fd 22 -> anon_inode:kvm-vm
  fd 29 -> anon_inode:kvm-vcpu:0
  fd 31 -> anon_inode:kvm-vcpu:1
  fd 33 -> anon_inode:kvm-arm-vgic-v2
```

**One `kvm-vcpu` per configured core and an ARM interrupt controller.** That is hardware
virtualisation, and it is the thing a laptop and a non-metal instance cannot produce.

Checking it the usual way gives the wrong impression:

```
  lsmod | grep kvm        (nothing)
  CONFIG_KVM=y
```

**On arm64 KVM is built into the kernel, not a module**, so the familiar `lsmod` check reports absence
on a working host.

## 7. The snapshot loop, which is the entire point

Snapshot, break the guest, roll back:

```
  qm snapshot 101 clean      2006 ms
  qm rollback 101 clean      1998 ms
```

Those timings are fiction. The commands failed, the output was redirected away, and the elapsed time
of a failing command looks exactly like the elapsed time of a working one:

```bash
qm snapshot 101 test1        # with output visible this time
```

```
  snapshot feature is not available
```

```
  scsi0: local:101/vm-101-disk-1.raw,size=3G
```

**Disks imported with `import-from` onto directory storage land as `raw`, and raw on a directory does
not support snapshots.** The Proxmox installer normally creates LVM-thin or ZFS; installing on top of
Debian — which is the only path on a cloud host — leaves a plain directory, so this bites exactly
where this page is.

Converting the data disk is not enough:

```bash
qm disk move 102 scsi0 local --format qcow2
qm snapshot 102 clean
```

```
  snapshot feature is not available
```

**Every attached disk has to be snapshot-capable, including the EFI disk**, and the message names
none of them. With both converted:

```
  snapshotting 'drive-scsi0' (local:102/vm-102-disk-2.qcow2)
  snapshotting 'drive-efidisk0' (local:102/vm-102-disk-1.qcow2)
  `-> clean    2026-10-17 17:24:20
   `-> current  You are here!
```

```
  qm snapshot (running VM)   2148 ms
  qm rollback                2782 ms
```

### The rollback worked and lost the file anyway

The break deleted `/etc/ssh/ssh_host_*` and overwrote a marker file. After rollback, read from the
disk directly with `qemu-nbd` rather than from inside the guest:

```
  /etc/marker        (does not exist)
  ssh_host_* files   6
```

**Six host keys restored, and the marker written seconds before the snapshot is simply gone.** The
snapshot was taken on a running VM without `--vmstate`, which makes it crash-consistent: it captures
what is on disk, and a file written moments earlier was still in the guest's page cache.

This is not a malfunction and it is the opposite of reassuring. **A snapshot taken before a risky
step will not contain the change you made to set up the test**, unless the guest flushed it or the
snapshot included RAM. For a lab whose method is "write a marker, break it, roll back", that is the
difference between a working loop and one that silently tests nothing.

## Verification checklist

- [x] `a1.metal` is **$0.408/hr**, five times cheaper than the next bare-metal type; `mac*.metal` carry a 24-hour minimum
- [x] The host reports `systemd-detect-virt: none` with `/dev/kvm` present — genuinely bare metal
- [x] Proxmox VE **9.2.20** installs on Debian 13 arm64 with kernel **7.0.14-24-pve**, and all four services reach `active`
- [x] `pvesh get /nodes` returns `node=pmx status=online maxcpu=16`
- [x] `getent hosts` returns an IPv6 link-local while `getent ahostsv4` returns the correct IPv4 — alarming and correct
- [x] `--ide2 local:cloudinit` fails at `qm start` with **`Bus 'ide.1' not found`**; `--scsi1` works
- [x] A Debian-based install has **no `vmbr0`**, and a NAT bridge with no physical port is what a cloud host allows
- [x] A template clones to three full copies of 3.0 GiB each and all three ping
- [x] The qemu process holds `/dev/kvm`, `kvm-vm`, **one `kvm-vcpu` per core** and `kvm-arm-vgic-v2` — accelerated, not emulated
- [x] `lsmod | grep kvm` returns **nothing** on that working host, because `CONFIG_KVM=y`
- [x] `qm snapshot` on a raw disk reports **`snapshot feature is not available`**, and reports it only when output is not redirected
- [x] Converting `scsi0` alone is insufficient — **`efidisk0` must be converted too**
- [x] With both as qcow2, snapshot takes **2148 ms** and rollback **2782 ms**
- [x] After rollback the six deleted host keys are back and **the marker file written just before the snapshot is absent**
- [x] Total: **0.71 hours × $0.408 = $0.29**, with 0 instances, 0 security groups and 0 unattached volumes remaining

## Rollback

```bash
terraform destroy -auto-approve -var "my_ip=$(curl -s https://checkip.amazonaws.com)"
```

```
  Destroy complete! Resources: 5 destroyed.

  running instances : 0
  lab-tagged        : 0
  security groups   : 0
  unattached EBS    : 0
  key pair          : InvalidKeyPair.NotFound
  snapshots         : 0
```

**Bare-metal termination is slow** — the instance sits in `shutting-down` for minutes while AWS
scrubs the host, and `terraform destroy` waits for it. That is not a hang.

## Where this bit us

**Output was redirected away four times, and once it mattered.** `qm snapshot … >/dev/null 2>&1`
hid `snapshot feature is not available`, and the surrounding script dutifully reported `2006 ms` — a
number that reads as success. The rollback then "took" 1998 ms and the guest came back broken,
because nothing had been snapshotted and nothing was restored. **A timing is not a result**, and a
command whose output you discarded has not told you anything.

**Three checks were wrong in ways that looked like findings.** Grepping `dpkg -l` for
`proxmox-kernel-6` reported no kernel, because the arm64 kernel is 7.0. `pgrep -f "id=101"` matched
the SSH command carrying that string rather than the QEMU process. A loop looking for `/etc/marker`
across `nbd0p1`, `p2` and `p3` unmounted the only partition that existed before reading it. **Each
produced a plausible empty answer**, and each took a second look to distinguish from the thing being
measured.

**The security group locked to one IP broke mid-session when that IP rotated.** `104.202.151.108`
became `104.202.151.156`, SSH timed out, and the instance was healthy the whole time — a metal
instance you cannot reach is still billing. `terraform apply` with the new address fixed it in two
seconds, which is an argument for keeping the lab in Terraform rather than in the console.

## Follow-ups

- [ ] Redo `onprem-3node-kubeadm-ubuntu` on these three guests and record which of its four unproven items — NIC behaviour, swap, cloned `product_uuid`, `ufw` — actually change state on a hypervisor
- [ ] Take a snapshot with `--vmstate` and repeat section 7's marker test, which is the configuration that would have caught the file
- [ ] Attach a second disk as ZFS or LVM-thin and compare snapshot behaviour against the directory-storage case, since the installer's default is not what a Debian-based install gives you
- [ ] Detach a virtual disk from a running Longhorn node on these guests, which is the replication test `longhorn-storage-onprem` currently trusts

## Related

[[the-layer-under-the-three-node-lab]] — the decision this page acts on, and the gaps it sorted.
[[onprem-3node-kubeadm-ubuntu]] — the page whose EC2 substitute this lab exists to replace.
[[longhorn-storage-onprem]] — replication trusted rather than tested, and the disk-detach drill that would test it.
[[harbor-installer-on-podman-arm64]] — the other arm64 page, where the answer was that no image existed.
