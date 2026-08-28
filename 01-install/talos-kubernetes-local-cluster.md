---
title: Talos Linux — a Kubernetes node with no shell, and four things that stop it locally
date: 2026-08-28
domain: install
tags: [kubernetes, talos, immutable-infrastructure, containers, podman]
stack: [talos, talosctl, kubernetes, podman, kubectl]
summary: A two-node Talos 1.13 cluster on a laptop, and the demonstration that matters — podman exec into a node answers "executable file sh not found in $PATH", because there is no shell to exec. Rootless podman cannot run it at all, the kubeconfig points somewhere unreachable, and flannel crash-loops until a kernel module is loaded in the VM.
source: handson
env: Talos v1.13.7 · talosctl v1.13.7 · Kubernetes v1.36.2 · Podman 5.7.1 (machine switched to rootful) · kubectl v1.36.4 · macOS 14.7.5 on Apple Silicon
verified: 2026-08-28
verifiability: partial
verifiability-note: The docker provisioner, which runs Talos as containers rather than as VMs — so the kernel is the podman machine's, not Talos's own, and everything about disk layout, secure boot, the installer and upgrades is out of scope by construction. What it does exercise honestly is the API surface, the absence of a shell, the machine-config model and a working two-node control plane. `talosctl upgrade`, `apply-config` against a running node, and multi-controlplane etcd behaviour are unexercised.
duration: 60–90 min
risk: low
---

> **Verified 2026-08-28.** Both nodes reached `Ready` and every pod in `kube-system` reached
> `Running`. All four failures below happened on the way there, and each is diagnosed to a specific
> cause rather than worked around blindly.

Every other node in this repo — [[onprem-3node-kubeadm-ubuntu]] included — is a Linux box you can
SSH into and fix by hand. **Talos removes that on purpose**: no SSH, no shell, no package manager. The
node is configured by applying a YAML document over a gRPC API and is otherwise not yours to touch.

Whether that is an improvement is a real argument. What it is not is vague, and the fastest way to
understand it is to try to get a shell.

## Creating it

```bash
brew install siderolabs/tap/talosctl

export DOCKER_HOST="unix://$(podman machine inspect \
  --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
export TALOSCONFIG="$PWD/talosconfig"

talosctl cluster create docker \
  --name talos-lab --workers 1 \
  --memory-controlplanes 2048 --memory-workers 1536 \
  --talosconfig-destination "$PWD/talosconfig"
```

**Two flag surprises before anything runs.** `talosctl cluster create` on its own now warns that it
has moved and then fails asking for root — that is the QEMU path. The docker provisioner is its own
subcommand, and it takes **no `--controlplanes` flag** (one, always) and spells memory
`--memory-controlplanes` / `--memory-workers`. Reading `--help` for the subcommand rather than the
parent saves three failed invocations.

```
generating PKI and tokens
downloading ghcr.io/siderolabs/talos:v1.13.7
creating controlplane nodes
creating worker nodes
waiting for Talos API (to bootstrap the cluster)
…
waiting for etcd members to be consistent across nodes: OK
waiting for apid to be ready: OK
waiting for all k8s nodes to report ready: OK
```

## Trying to get a shell

This is the whole point of Talos, so it is worth doing rather than reading:

```bash
podman exec talos-lab-controlplane-1 sh -c 'ls /usr/bin/ssh* /usr/sbin/sshd'
```

```
Error: crun: executable file `sh` not found in $PATH: No such file or directory:
  OCI runtime attempted to invoke a command that was not found
```

**There is no `sh`.** Not "SSH is disabled", not "the account is locked" — the binary a shell would be
is not in the image, so the container-level equivalent of SSH has nothing to invoke. Every mechanism
you would normally reach for on a node is absent by construction, which means the usual incident
reflex — get on the box and look — has no equivalent and must be replaced rather than adapted.

## What replaces it

```bash
talosctl --nodes 10.5.0.2 ls /etc
talosctl --nodes 10.5.0.2 read /etc/os-release
talosctl --nodes 10.5.0.2 services
```

```
NODE       NAME
10.5.0.2   apparmor
10.5.0.2   ca-certificates
10.5.0.2   cni
10.5.0.2   containerd
10.5.0.2   cri
```

```
NAME="Talos"
VERSION_ID=v1.13.7
PRETTY_NAME="Talos (v1.13.7)"
```

```
NODE       SERVICE      STATE     HEALTH   LAST CHANGE   LAST EVENT
10.5.0.2   apid         Running   OK       13m7s ago     Health check successful
10.5.0.2   containerd   Running   OK       13m8s ago     Health check successful
10.5.0.2   cri          Running   OK       13m7s ago     Health check successful
10.5.0.2   etcd         Running   OK       12m3s ago     Health check successful
10.5.0.2   kubelet      Running   OK       10m49s ago    Health check successful
10.5.0.2   machined     Running   OK       13m8s ago     Health check successful
10.5.0.2   trustd       Running   OK       13m7s ago     Health check successful
```

**You can read the filesystem and you cannot execute in it.** `ls` and `read` are API calls that
return bytes; there is no call that returns a prompt. That distinction is the design: everything an
operator legitimately needs to *see* is exposed, and the ability to change the machine outside its
configuration is not.

Access is mutual TLS, and `talosconfig` is where the client half lives:

```
  endpoints: ['127.0.0.1:61283']
  ca:  <base64 PEM, 660 chars>
  crt: <base64 PEM, 620 chars>
  key: <base64 PEM, 180 chars>
```

**That file is the credential.** There is no password anywhere in this system, and losing the key
means losing administrative access to the node — which is the trade Talos makes for having no other
way in.

## The Kubernetes it built

```bash
talosctl --nodes 10.5.0.2 kubeconfig ./kubeconfig --force
kubectl get nodes -o wide
```

```
NAME                       STATUS   ROLES           VERSION   OS-IMAGE          CONTAINER-RUNTIME
talos-lab-controlplane-1   Ready    control-plane   v1.36.2   Talos (v1.13.7)   containerd://2.2.6
talos-lab-worker-1         Ready    <none>          v1.36.2   Talos (v1.13.7)   containerd://2.2.6
```

```
coredns-6748b7b8bd-rj2fg                          1/1 Running
coredns-6748b7b8bd-w7wsq                          1/1 Running
kube-apiserver-talos-lab-controlplane-1           1/1 Running
kube-controller-manager-talos-lab-controlplane-1  1/1 Running
kube-flannel-n2q9p                                1/1 Running
kube-flannel-vtcmr                                1/1 Running
kube-proxy-6ccgz                                  1/1 Running
kube-proxy-sq6fb                                  1/1 Running
kube-scheduler-talos-lab-controlplane-1           1/1 Running
```

Both of those took a fix to reach, and both are below.

## Verification checklist

- [x] `talosctl cluster create docker` rejects `--controlplanes` — the docker provisioner has no such flag
- [x] Under **rootless** podman the nodes start and every Talos service restarts forever with an `oom_score_adj` permission error
- [x] After `podman machine set --rootful`, the identical command reaches `waiting for apid to be ready: OK`
- [x] `podman exec <node> sh` fails with **`executable file 'sh' not found in $PATH`**
- [x] `talosctl ls`, `read` and `services` all answer over the API, and `read /etc/os-release` reports `Talos (v1.13.7)`
- [x] `talosconfig` carries a CA, a client certificate and a key — no password anywhere
- [x] The generated kubeconfig points at `10.5.0.2:6443` and **times out** from the host; the forwarded port works
- [x] `kube-flannel` is in `CrashLoopBackOff` with `br_netfilter` missing, and **both nodes still report `Ready`**
- [x] Loading `br_netfilter` in the podman machine takes every `kube-system` pod to `Running`

## Rollback

```bash
talosctl cluster destroy --name talos-lab --provisioner docker
podman machine stop && podman machine set --rootful=false && podman machine start
```

**Put the machine back.** Rootful and rootless podman keep separate container and volume storage, so
anything you had running rootless is invisible until you switch back.

## Where this bit us

**Rootless podman cannot run Talos at all, and the failure is a restart loop rather than an error.**
Both containers start and stay up; the services inside never do:

```
service[apid](Waiting): Error running Containerd(apid), going to restart forever:
  failed to create task: "apid": failed to create shim task: OCI runtime create failed:
  runc create failed: unable to start container process: can't get final child's PID from pipe: EOF;
  runc init error(s): nsexec[14449]: failed to update /proc/self/oom_score_adj: Permission denied
```

**Talos runs its own containerd inside the container**, so this is a nested runtime, and rootless
podman denies the inner `runc` the write to `/proc/self/oom_score_adj` that it makes on every task.
`podman ps` looks fine throughout — the outer containers are up and healthy-looking, and only the
Talos log says otherwise. Switching the machine to rootful is the fix and the identical command then
bootstraps.

**`talosctl cluster create` and `talosctl cluster create docker` are different commands with
different flags.** The bare form now prints a deprecation notice and then:

```
error: please run as root user (CNI, qemu hvf requirement), we recommend running with `sudo -E`
```

which is about the QEMU provisioner and has nothing to do with the `--provisioner docker` flag that
was passed. **An error inherited from a sibling code path is the worst kind to debug**, because
following it — running the whole thing under `sudo` — is both plausible and wrong.

**The kubeconfig it writes for you does not work from the host.**

```
couldn't get current server API group list: Get "https://10.5.0.2:6443/api?timeout=32s":
  dial tcp 10.5.0.2:6443: i/o timeout
```

`10.5.0.2` is the node's address on the container network *inside the podman machine*. `talosctl`
works because its own endpoint was written as a published port; the kubeconfig was not given the same
treatment. The forwarded port is there:

```
  6443/tcp  -> 0.0.0.0:61282
  50000/tcp -> 0.0.0.0:61283
```

```bash
sed -i '' 's#https://10.5.0.2:6443#https://127.0.0.1:61282#' kubeconfig
```

Worth noticing **which of the two tools told the truth about reachability**: `talosctl` was configured
with an address that works from where it runs, and the generated kubeconfig was configured with an
address that works from inside the cluster. Neither is wrong; they answer different questions, and
the file does not say which.

**Flannel crash-looped while both nodes reported `Ready`.**

```
kube-flannel-64v2t   0/1  CrashLoopBackOff  restarts=8
coredns-…            0/1  ContainerCreating
talos-lab-worker-1   Ready
```

```
E main.go:289] Failed to check br_netfilter:
  stat /proc/sys/net/bridge/bridge-nf-call-iptables: no such file or directory
```

The module is loaded on the **host kernel**, and under the docker provisioner the host is the podman
machine, not Talos:

```bash
podman machine ssh 'sudo modprobe br_netfilter && sudo sysctl -w net.bridge.bridge-nf-call-iptables=1'
```

Deleting the flannel pods afterwards took the whole namespace to `Running`.

**`Ready` nodes with no working pod network is the trap worth keeping.** `kubectl get nodes` is
satisfied by a healthy kubelet and says nothing about whether one pod can reach another — the same
class of false pass as a container that is `running` and not working in
[[harbor-installer-on-podman-arm64]]. The check that catches it is a pod that has to be scheduled and
get an IP, which is exactly what coredns is.

## Follow-ups

- [ ] Apply a machine config change with `talosctl apply-config` against a running node and watch it reconcile — the declarative half this page describes but does not exercise
- [ ] Run `talosctl upgrade` between patch versions and confirm the A/B scheme reboots into the new image
- [ ] Use the QEMU provisioner on a Linux host, where the kernel is Talos's own and `br_netfilter` is Talos's problem rather than the VM's
- [ ] Three control planes and a deliberate `talosctl reset` of one, to see etcd membership recover
- [ ] Compare `talosctl dashboard` against the SSH-and-htop habit it replaces
- [ ] Deploy the workload from [[argo-rollouts-canary-kind]] onto this cluster, so the node OS is the only variable that changed

## Related

[[onprem-3node-kubeadm-ubuntu]] — the same cluster built the conventional way, on machines you can log into.
[[argo-rollouts-canary-kind]] — another throwaway local Kubernetes, for comparison of what each provisioner costs.
[[harbor-installer-on-podman-arm64]] — the other page here where rootless podman and a Docker-shaped tool disagreed.
[[pod-crashloopbackoff]] — the reflex this OS removes, and what replaces it.
