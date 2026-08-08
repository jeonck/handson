---
title: On-prem 3-node Kubernetes with kubeadm — from bare Ubuntu to a running pod
date: 2026-08-07
domain: install
tags: [on-prem, bare-metal, cluster-bootstrap]
stack: [ubuntu, kubernetes, kubeadm, containerd, calico, kubectl]
summary: Build a three-machine cluster on your own hardware — OS prep, containerd, kubeadm init and join, a CNI, remote kubectl access, and a workload verified pod by pod. The cgroup driver and the pod CIDR are where a first cluster stalls.
source: handson
env: Target — Ubuntu 24.04 LTS · Kubernetes 1.31 (kubeadm) · containerd 1.7 · Calico 3.28
verified:
duration: 60–90 min
risk: medium
---

> ⚠️ **This procedure has not been executed in this environment yet.** It is assembled from upstream
> documentation (kubeadm, containerd, Calico), so `verified` is empty and the site will list it as
> needing verification. Run it once on real hardware, then fill in `verified` and correct whatever
> was wrong. Until then, treat every command as unproven.

Three physical or virtual machines you own, from a fresh Ubuntu install to a pod you can `kubectl get` from your laptop. No cloud provider, no load balancer, no shared storage — the plain case that on-prem work actually starts from.

**One control plane, two workers.** This is not an HA control plane: losing the control-plane node loses the API server. That is a deliberate trade for a first cluster — stacked etcd HA needs at least three control-plane nodes and a load balancer in front of the API, which is a different document.

## Topology

| Role | Hostname | IP | Minimum |
|---|---|---|---|
| control plane | `k8s-cp1` | `<CP_IP>` | 2 vCPU · 4 GB RAM · 40 GB disk |
| worker | `k8s-w1` | `<W1_IP>` | 2 vCPU · 4 GB RAM · 40 GB disk |
| worker | `k8s-w2` | `<W2_IP>` | 2 vCPU · 4 GB RAM · 40 GB disk |

Network ranges — these must not overlap with your LAN, or pod traffic collides with real hosts:

| Range | Value | Set where |
|---|---|---|
| Pod CIDR | `10.244.0.0/16` | `kubeadm init --pod-network-cidr` **and** the CNI config |
| Service CIDR | `10.96.0.0/12` | kubeadm default |

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| OS | `lsb_release -d` | Ubuntu 24.04 LTS (22.04 also works) |
| Static addressing | `ip -4 addr show` | fixed IP, not DHCP-assigned on reboot |
| Name resolution between nodes | `ping -c1 k8s-w1` | replies from every node |
| Clock | `timedatectl status` | `System clock synchronized: yes` |
| Unique machine identity | `sudo cat /sys/class/dmi/id/product_uuid` | different on all three |
| Sudo without a TTY prompt loop | `sudo -v` | succeeds |

The `product_uuid` check matters when the machines were cloned from one VM template. Identical UUIDs (or identical MAC addresses) make kubelet register the wrong node object, and the second node silently replaces the first.

## Ports

Open these before starting, or the join in step 6 times out with no useful error.

| Node | Port | Purpose |
|---|---|---|
| control plane | 6443/tcp | Kubernetes API |
| control plane | 2379–2380/tcp | etcd client and peer |
| control plane | 10257/tcp, 10259/tcp | controller-manager, scheduler |
| all | 10250/tcp | kubelet API |
| all | 4789/udp | Calico VXLAN overlay |
| workers | 30000–32767/tcp | NodePort range |

If `ufw` is active:

```bash
# control plane
sudo ufw allow 6443/tcp
sudo ufw allow 2379:2380/tcp
sudo ufw allow 10250/tcp
sudo ufw allow 10257/tcp
sudo ufw allow 10259/tcp
sudo ufw allow 4789/udp

# workers
sudo ufw allow 10250/tcp
sudo ufw allow 30000:32767/tcp
sudo ufw allow 4789/udp
```

- Source: [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)

---

## 1. OS preparation — run on all three nodes

Everything in this section is identical on every machine. Do all three before moving on; a half-prepared worker fails at join time, which is a worse place to discover it.

### 1.1 Hostname and hosts file

kubelet registers the node under its hostname, so set it before anything else — changing it after `kubeadm init` means resetting the node.

```bash
# on each node, with its own name
sudo hostnamectl set-hostname k8s-cp1     # k8s-w1 / k8s-w2 on the workers
exec bash                                  # pick up the new prompt
```

```bash
# same content on all three nodes
cat <<'EOF' | sudo tee -a /etc/hosts
<CP_IP>  k8s-cp1
<W1_IP>  k8s-w1
<W2_IP>  k8s-w2
EOF
```

If DNS already resolves these names on your network, skip the hosts file. Two sources of truth for node names is its own outage.

### 1.2 Disable swap

kubelet refuses to start with swap enabled unless you explicitly opt in. Turn it off now and out of `/etc/fstab`, or the cluster dies on the next reboot.

```bash
sudo swapoff -a
sudo sed -i.bak '/\sswap\s/s/^/#/' /etc/fstab
```

Ubuntu server images often carry a `/swap.img` entry, which the `sed` comments out. Verify it actually went away:

```bash
swapon --show      # must print nothing
free -h            # Swap row must be 0B
```

### 1.3 Kernel modules and sysctl

Pod traffic crosses a bridge, and iptables has to see it. Without `br_netfilter` and these sysctls, pods start fine and simply cannot talk to each other — a failure that looks like an application bug.

```bash
cat <<'EOF' | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF

sudo modprobe overlay
sudo modprobe br_netfilter
```

```bash
cat <<'EOF' | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF

sudo sysctl --system
```

```bash
lsmod | grep -E 'overlay|br_netfilter'
sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables
```

- Source: [Container runtimes — prerequisites](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)

### 1.4 containerd

```bash
sudo apt-get update
sudo apt-get install -y containerd
```

The packaged default config does not work with kubeadm as shipped. Generate a full config and switch the cgroup driver:

```bash
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd
```

**`SystemdCgroup = true` is the single most common reason a first cluster half-works.** Ubuntu boots with systemd as the cgroup manager; kubelet defaults to the systemd driver too. Leave containerd on cgroupfs and you get two managers fighting over the same cgroup tree — kubelet starts, pods start, and then containers are killed or resource limits are ignored under load.

Confirm the value actually changed — a containerd version whose default config already reads `SystemdCgroup = true` leaves the `sed` a no-op, which is fine, but a differently formatted line means it silently did nothing:

```bash
grep SystemdCgroup /etc/containerd/config.toml
sudo systemctl status containerd --no-pager
```

- Source: [Configuring the systemd cgroup driver](https://kubernetes.io/docs/setup/production-environment/container-runtimes/#containerd-systemd)

### 1.5 kubeadm, kubelet, kubectl

The repository URL carries the minor version. `v1.31` here installs 1.31.x only — moving to 1.32 later means editing this file, deliberately.

```bash
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
sudo mkdir -p /etc/apt/keyrings

curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
```

`apt-mark hold` is not optional. An unattended `apt upgrade` that bumps kubelet a minor version out from under the control plane breaks the version skew policy, and the node goes `NotReady` at 03:00 for no visible reason.

```bash
kubeadm version -o short
kubectl version --client -o yaml | head -5
apt-mark showhold
```

kubelet will restart-loop until `kubeadm init` or `join` gives it a config. That is expected at this point — do not chase it.

- Source: [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/)

---

## 2. Initialize the control plane — `k8s-cp1` only

```bash
sudo kubeadm init \
  --apiserver-advertise-address=<CP_IP> \
  --control-plane-endpoint=<CP_IP>:6443 \
  --pod-network-cidr=10.244.0.0/16 \
  --node-name=k8s-cp1
```

Why each flag:

- `--apiserver-advertise-address` — pins the API to the right NIC. On a multi-homed machine kubeadm may otherwise pick the management interface, and workers cannot reach it.
- `--control-plane-endpoint` — writes an endpoint rather than a bare IP into the generated kubeconfigs. Adding control-plane nodes later needs this; retrofitting it means regenerating certificates.
- `--pod-network-cidr` — must match what you configure in the CNI in step 4. A mismatch is the second classic first-cluster failure.

Success ends with a `kubeadm join …` line. **Copy it somewhere before you clear the terminal** — it carries the token and the CA cert hash. It is regenerable (step 6), but not readable after the fact.

If `init` fails, read the preflight output rather than re-running: it names the exact unmet condition (swap on, port in use, cgroup driver mismatch). To retry cleanly, run the reset in the [Rollback](#rollback) section first.

### 2.1 kubeconfig for the local user

```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

```bash
kubectl get nodes
```

Expect exactly one node, `NotReady`. **`NotReady` is correct here** — there is no pod network yet, so kubelet reports the node as unusable. Step 4 fixes it. Do not start debugging kubelet at this point.

```bash
kubectl get pods -n kube-system
```

CoreDNS pods sit in `Pending`, for the same reason.

---

## 3. Save the join command

On the control plane:

```bash
kubeadm token create --print-join-command
```

This prints a complete, currently valid join line. Tokens expire after 24 hours by default; re-running this command mints a new one whenever you need it.

---

## 4. Install the CNI — control plane only

Nothing schedules until pods have a network. This uses Calico via its operator; Flannel or Cilium work equally well, and each has its own CIDR configuration.

```bash
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/tigera-operator.yaml
```

```bash
curl -fsSLO https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/custom-resources.yaml
```

**Edit `custom-resources.yaml` before applying it.** The shipped file uses `192.168.0.0/16`, which is not the CIDR passed to `kubeadm init` above — and on-prem it very often collides with the office LAN as well.

```yaml
# custom-resources.yaml — the ipPools entry
    ipPools:
      - blockSize: 26
        cidr: 10.244.0.0/16        # must equal --pod-network-cidr
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
```

```bash
kubectl create -f custom-resources.yaml
```

Watch it converge — this takes a couple of minutes on first pull:

```bash
kubectl -n calico-system get pods -w
```

```bash
kubectl get nodes
```

The control-plane node flips to `Ready` once `calico-node` is running on it. That transition is the signal to proceed.

- Source: [Calico — Kubernetes quickstart](https://docs.tigera.io/calico/latest/getting-started/kubernetes/quickstart)

---

## 5. Pin the version you actually installed

Before joining workers, record what is on disk. The `env` field of this document, and every future upgrade decision, depends on it.

```bash
kubectl version -o yaml | grep -A2 serverVersion
containerd --version
kubectl -n calico-system get daemonset calico-node -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

---

## 6. Join the workers — on `k8s-w1` and `k8s-w2`

Run the line from step 3 on each worker, as root:

```bash
sudo kubeadm join <CP_IP>:6443 \
  --token <TOKEN> \
  --discovery-token-ca-cert-hash sha256:<HASH>
```

It ends with `This node has joined the cluster`. If it hangs at `[preflight] Running pre-flight checks`, the worker cannot reach 6443 — check the firewall rules from the Ports section and confirm from the worker:

```bash
nc -zv <CP_IP> 6443
```

Back on the control plane:

```bash
kubectl get nodes -o wide
```

All three should report `Ready` within a minute or two, as Calico rolls out onto the new nodes.

### 6.1 Optional — let the control-plane node run workloads

With only three machines you may want all of them schedulable. The control plane carries a `NoSchedule` taint by default:

```bash
kubectl describe node k8s-cp1 | grep -i taint
```

```bash
# only if you accept that a workload can now compete with etcd and the API server
kubectl taint nodes k8s-cp1 node-role.kubernetes.io/control-plane:NoSchedule-
```

On a 4 GB control-plane node this is a bad trade: a memory-hungry pod evicting etcd takes the cluster down, not just the app. Leave the taint unless the hardware has room.

---

## 7. Reach the cluster from your workstation

Working over SSH on the control plane gets old fast, and it also means every operator shares one shell history.

```bash
# from your laptop
scp <USER>@<CP_IP>:/etc/kubernetes/admin.conf ~/.kube/onprem.conf
chmod 600 ~/.kube/onprem.conf
```

`admin.conf` already points at `<CP_IP>:6443` because of `--control-plane-endpoint`. Confirm it before trusting it:

```bash
grep 'server:' ~/.kube/onprem.conf
```

```bash
export KUBECONFIG=~/.kube/onprem.conf
kubectl get nodes
```

To keep it alongside other clusters instead of swapping the variable:

```bash
KUBECONFIG=~/.kube/config:~/.kube/onprem.conf kubectl config view --flatten > ~/.kube/merged
mv ~/.kube/merged ~/.kube/config
kubectl config get-contexts
kubectl config use-context kubernetes-admin@kubernetes
```

> `admin.conf` is a **cluster-admin credential with no expiry short enough to save you.** It is the equivalent of a root key for this cluster. Do not commit it, do not paste it into a ticket, and set up real user certificates or OIDC before more than one person needs access.

---

## 8. Verify with a real workload

A `Ready` node list is not proof. Schedule something, watch it land on both workers, and confirm the three things that break independently: scheduling, pod-to-pod networking across nodes, and DNS.

```bash
kubectl create deployment web --image=nginx:1.27 --replicas=3
kubectl expose deployment web --port=80
```

```bash
kubectl get pods -o wide
```

Read the `NODE` column: replicas should be spread across `k8s-w1` and `k8s-w2`. All three on one node means the other worker is not schedulable — check its taints and `kubectl describe node`.

Watch a pod through its lifecycle:

```bash
kubectl get pods -w
kubectl describe pod <POD>
kubectl logs <POD>
```

Cross-node pod networking, via the service:

```bash
kubectl run curltest --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- \
  curl -s -o /dev/null -w '%{http_code}\n' http://web
```

`200` means the overlay is carrying traffic between nodes. A hang here is almost always the sysctl or the VXLAN port from section 1.3 and the Ports table.

Cluster DNS:

```bash
kubectl run dnstest --rm -it --restart=Never --image=busybox:1.36 -- \
  nslookup web.default.svc.cluster.local
```

Tear down the test workload:

```bash
kubectl delete deployment web
kubectl delete service web
```

---

## Verification checklist

Everything here has to pass before you call the cluster built — and before you fill in `verified`.

- [ ] `kubectl get nodes` — three nodes, all `Ready`, all on the expected version
- [ ] `kubectl get pods -A` — no pod outside `Running`/`Completed`, restart counts at 0
- [ ] `kubectl -n kube-system get pods -l k8s-app=kube-dns` — CoreDNS `Running`, 2 replicas
- [ ] `kubectl -n calico-system get pods -o wide` — one `calico-node` per node
- [ ] A 3-replica deployment spreads across both workers
- [ ] Service call from a pod returns `200` (cross-node networking)
- [ ] `nslookup` of a service name resolves (cluster DNS)
- [ ] `kubectl get nodes` works from the workstation, not only over SSH
- [ ] `swapon --show` prints nothing on all three nodes
- [ ] `apt-mark showhold` lists kubelet, kubeadm, kubectl on all three nodes
- [ ] Reboot one worker — it rejoins `Ready` on its own and pods reschedule

That last one is the check people skip, and it is the one that catches swap re-enabling itself in `/etc/fstab` and containerd not being enabled at boot.

---

## Rollback

Per node, to return it to a pre-cluster state:

```bash
sudo kubeadm reset -f
sudo rm -rf /etc/cni/net.d $HOME/.kube
```

`reset` deliberately leaves iptables rules and network interfaces behind. Clear the Kubernetes ones only if this machine has no other iptables-based service on it:

```bash
# destructive — this flushes ALL iptables rules on the host, not only Kubernetes rules
sudo iptables -F && sudo iptables -t nat -F && sudo iptables -t mangle -F && sudo iptables -X
sudo ip link delete vxlan.calico 2>/dev/null || true
sudo systemctl restart containerd kubelet
```

Order matters when tearing down the whole cluster: reset the workers first, then the control plane. Resetting the control plane first leaves the workers pointed at an API server that is gone, and their `reset` then blocks trying to deregister.

To remove the packages as well:

```bash
sudo apt-mark unhold kubelet kubeadm kubectl
sudo apt-get purge -y kubelet kubeadm kubectl
```

---

## Failure points documented upstream

**This section is not "where this bit us" — nobody has run this procedure here yet.** These are the failure modes the upstream documentation and release notes call out. Replace this section with what actually happened on your first run, and delete anything you never hit.

**cgroup driver mismatch** — containerd left on cgroupfs while kubelet uses systemd. Pods start and then get killed or ignore their limits under load. Section 1.4. ([kubeadm docs](https://kubernetes.io/docs/setup/production-environment/container-runtimes/#containerd-systemd))

**Pod CIDR mismatch** — `--pod-network-cidr` and the CNI's pool disagree. Nodes reach `Ready`, pods get addresses, and cross-node traffic goes nowhere. Sections 2 and 4.

**Swap back after reboot** — `swapoff -a` without the `/etc/fstab` edit. Survives until the first reboot, then kubelet will not start. Section 1.2.

**Cloned VMs sharing `product_uuid` or MAC** — nodes overwrite each other's registration. Prerequisites table.

**Expired join token** — the bootstrap token is 24-hour by default, so the join line saved on install day stops working. Regenerate with `kubeadm token create --print-join-command`. Section 3.

---

## Follow-ups

- [ ] Run this procedure end to end on real hardware, correct it, and set `verified`
- [ ] Decide on storage — a bare cluster has no default StorageClass, so any PVC stays `Pending`
- [ ] Decide how services get reached from the LAN — on-prem has no cloud load balancer, so `type: LoadBalancer` stays `Pending` until MetalLB or an equivalent is in place
- [ ] Replace `admin.conf` sharing with per-user credentials before a second person needs access
- [ ] Set up etcd backups — a single control plane means etcd is the whole cluster
- [ ] Write down the upgrade path before the next minor release lands

## Related

[[argocd-helm-ha-install]] — the natural next step once this cluster is up, though its HA values assume three schedulable nodes and an ingress controller that this document does not install.
[[pod-crashloopbackoff]] — for when the first workload does not come up. The `CreateContainerError` and scheduling branches cover most bring-up failures.
[[k8s-node-drain-replace]] — how to take one of these three nodes out later. With two workers, draining one puts everything on the other; check capacity first.
