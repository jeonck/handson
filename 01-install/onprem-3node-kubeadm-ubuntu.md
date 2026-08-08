---
title: On-prem 3-node Kubernetes with kubeadm — from bare Ubuntu to a running pod
date: 2026-08-07
domain: install
tags: [on-prem, bare-metal, cluster-bootstrap]
stack: [ubuntu, kubernetes, kubeadm, containerd, calico, kubectl]
summary: Build a three-machine cluster on your own hardware — OS prep, containerd, kubeadm init and join, a CNI, remote kubectl access, and a workload verified pod by pod. A missing conntrack stops kubeadm init outright, and two undocumented Calico ports leave every calico-node at 0/1 on a cluster that otherwise looks finished.
source: handson
env: Ubuntu 24.04.4 LTS · Kubernetes 1.31.14 (kubeadm) · containerd 2.2.1 · Calico 3.28.2 — run on 3× AWS EC2 t3.medium, not on bare metal
verified: 2026-08-08
verifiability: partial
verifiability-note: Ran on EC2. Real NIC and driver behaviour, disabling swap, cloned product_uuid collisions, and ufw rules stay unproven on hardware.
duration: 60–90 min
risk: medium
---

> **Verified 2026-08-08 on three EC2 instances, not on bare metal.** Every command below was run in
> order on 3× `t3.medium` (2 vCPU / 4 GB / 40 GB, Ubuntu 24.04.4) in one flat `10.10.10.0/24` subnet,
> with a security group opened to exactly the ports this document lists — which is how the missing
> ones were found. Four things in the original draft did not work and have been corrected: the
> package list in §1.5, two ports in the Ports table, and the `scp` in §7. See
> [Where this bit us](#where-this-bit-us).
>
> **What that run does not cover**, because EC2 supplies it for free: real NIC and driver behaviour,
> disabling swap (the cloud image has none, so §1.2 is a no-op there), unique `product_uuid` on cloned
> templates, and `ufw` (inactive on the AMI — the port rules were verified as security-group rules
> instead). Those four are still unproven on hardware. The Terraform that builds the harness is at
> `terraform-aws-lab/lab20-onprem-k8s-verify`.

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
| all | 179/tcp | **Calico BGP (BIRD)** — see below |
| all | 5473/tcp | **Calico Typha** — see below |
| all | ICMP echo | the `ping` prerequisite check above |
| workers | 30000–32767/tcp | NodePort range |

**179 and 5473 are not on the upstream Kubernetes ports page, and leaving them closed produces a
cluster that looks fine.** The Calico install in step 4 uses the tigera operator, which enables BGP
by default and runs Typha; `calico-node`'s readiness probe is `-bird-ready -felix-ready`. With those
two ports filtered, nodes still go `Ready`, pods still get addresses and still talk to each other
over VXLAN — and every `calico-node` sits at `0/1` permanently, so the DaemonSet never converges and
no future rollout of it can complete. Both were found by building the firewall from this table and
nothing else.

Typha makes it worse by being intermittent-looking: the operator runs fewer Typha replicas than you
have nodes (two on a three-node cluster), and the nodes that happen to host a replica reach it over
loopback. So the symptom is *one arbitrary node* stuck at `0/1`, which reads like a broken machine
rather than a firewall rule.

If `ufw` is active:

```bash
# control plane
sudo ufw allow 6443/tcp
sudo ufw allow 2379:2380/tcp
sudo ufw allow 10250/tcp
sudo ufw allow 10257/tcp
sudo ufw allow 10259/tcp
sudo ufw allow 4789/udp
sudo ufw allow 179/tcp
sudo ufw allow 5473/tcp

# workers
sudo ufw allow 10250/tcp
sudo ufw allow 30000:32767/tcp
sudo ufw allow 4789/udp
sudo ufw allow 179/tcp
sudo ufw allow 5473/tcp
```

`ufw` permits ICMP echo by default, so the `ping` check in the Prerequisites table needs no rule
here. A firewall that does not — a cloud security group, or `iptables` written by hand — has to allow
it explicitly or that prerequisite fails for a reason unrelated to name resolution.

- Source: [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/) — 179 and 5473 are Calico's, and are not listed there.

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

On 2026-08-08 the Ubuntu 24.04 package was **containerd 2.2.1**, not the 1.7 this document was first
drafted against. That is a major-version jump: the generated config is `version = 3` and the CRI
plugin key moved from `io.containerd.grpc.v1.cri` to `io.containerd.cri.v1.runtime`. The `sed` above
is unaffected — the default is still `SystemdCgroup = false` and the line still matches — but any
config snippet you find online that references the old plugin path will not apply. Check what you
actually installed rather than assuming 1.7:

```bash
containerd --version
head -1 /etc/containerd/config.toml    # expect: version = 3
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

**`conntrack` and `socat` are not pulled in by any of this, and `kubeadm init` will not start without
`conntrack`.** The kubelet package declares `Depends: iptables, kubernetes-cni, mount, util-linux,
libc6` and nothing else; a full Ubuntu server install usually happens to have both binaries already,
which is why this gap survives, but a minimal or cloud image has neither. Install them explicitly:

```bash
sudo apt-get install -y conntrack socat
```

Skipping this ends step 2 immediately with `[ERROR FileExisting-conntrack]: conntrack not found in
system path`. `socat` is only a preflight *warning*, but without it `kubectl port-forward` fails
later, well away from anything that would point you back here.

```bash
command -v conntrack socat
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

> **If you are rehearsing this somewhere other than a flat LAN, `VXLANCrossSubnet` is the wrong
> setting.** It encapsulates only between subnets, so with every node in one subnet it routes pod
> traffic natively — correct and faster on a real switch, and silently dropped by any network that
> filters on IP address, an AWS VPC included. There the symptom is `Ready` nodes, running pods and
> every cross-node connection timing out. Use `encapsulation: VXLAN` in that case and keep 4789/udp
> open; on the hardware this document targets, leave it as written.

- Source: [Calico — Kubernetes quickstart](https://docs.tigera.io/calico/latest/getting-started/kubernetes/quickstart)

---

## 5. Pin the version you actually installed

Before joining workers, record what is on disk. The `env` field of this document, and every future upgrade decision, depends on it.

```bash
kubectl version -o yaml | grep -A6 serverVersion    # -A2 stops before gitVersion
containerd --version
kubectl -n calico-system get daemonset calico-node -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

The keys under `serverVersion` come out alphabetically, so `buildDate`, `compiler`, `gitCommit` and
`gitTreeState` all precede `gitVersion` — the one thing being asked for. `-A2` prints the build date
and the compiler and nothing useful.

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

`/etc/kubernetes/admin.conf` is `-rw------- root root`, so copying it directly over SSH as a normal
user fails with `Permission denied` before anything else happens. Copy the user-owned duplicate that
step 2.1 already made instead:

```bash
# from your laptop
scp <USER>@<CP_IP>:.kube/config ~/.kube/onprem.conf
chmod 600 ~/.kube/onprem.conf
```

If you skipped 2.1, read it through `sudo` rather than loosening the permissions on the original:

```bash
ssh <USER>@<CP_IP> 'sudo cat /etc/kubernetes/admin.conf' > ~/.kube/onprem.conf
chmod 600 ~/.kube/onprem.conf
```

The file already points at `<CP_IP>:6443` because of `--control-plane-endpoint`. Confirm it before trusting it:

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
- [ ] `kubectl -n calico-system get pods -o wide` — one `calico-node` per node, each **`1/1`**, not merely present
- [ ] `kubectl -n calico-system rollout status ds/calico-node` — completes rather than timing out
- [ ] A 3-replica deployment spreads across both workers
- [ ] Service call from a pod returns `200` (cross-node networking)
- [ ] `nslookup` of a service name resolves (cluster DNS)
- [ ] `kubectl get nodes` works from the workstation, not only over SSH
- [ ] `swapon --show` prints nothing on all three nodes
- [ ] `apt-mark showhold` lists kubelet, kubeadm, kubectl on all three nodes
- [ ] Reboot one worker — it rejoins `Ready` on its own and its pods come back

That last one is the check people skip, and it is the one that catches swap re-enabling itself in `/etc/fstab` and containerd not being enabled at boot.

On the 2026-08-08 run the rebooted worker was back over SSH inside a minute and `Ready` shortly after,
and the service kept answering `200` throughout on the surviving replicas. Its pod does **not** get
rescheduled elsewhere, though — it stays `Unknown` on the rebooting node for a couple of minutes and
is then restarted in place by the returning kubelet, with a new pod IP and `RESTARTS 1`. Watch for it
coming back rather than for it moving.

```bash
kubectl get deployment web        # 3/3 again is the signal, not the pod list
```

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

## Where this bit us

Four failures on the 2026-08-08 run, in the order they happened.

**`kubeadm init` refused to start: `conntrack` not in path.** A fatal preflight error, not a warning.
The package is not a dependency of kubelet and this document did not install it. Cost about ten
minutes, entirely because the error arrives at the end of §1.5's work rather than during it. §1.5 now
installs it, together with `socat` — which is only a warning at init time and would otherwise have
resurfaced much later as a broken `kubectl port-forward`.

**Every `calico-node` stuck at `0/1`, with a cluster that otherwise looked finished.** Three nodes
`Ready`, all pods `Running`, workloads scheduling normally — and `kubectl -n calico-system get pods`
showing `0/1` on all three, forever. The probe is `-bird-ready`, BIRD needs **179/tcp**, and 179 was
not in the Ports table because it is not on the upstream Kubernetes ports page either. Opening it
flipped two of the three to `1/1` within one 30-second probe interval, which is what confirmed the
cause.

**The third node stayed `0/1` after that, and looked like a broken machine.** It was **5473/tcp**:
`confd` on that node could not reach Typha, so it never wrote `bird.cfg`, so BIRD never started —
`bird: Unable to open configuration file /etc/calico/confd/config/bird.cfg`. The operator runs two
Typha replicas on a three-node cluster; the two nodes hosting one reached it over loopback and
recovered as soon as 179 opened, and the one without a replica did not. **A missing port that
presents as one node out of three is the trap here** — the instinct is to go and debug that node.

**`scp` of `admin.conf` in §7 failed on the first try**, `Permission denied`, because the file is
`0600 root:root` and SSH lands as an unprivileged user. Copy the duplicate §2.1 makes, or read it
through `sudo`. §7 now does the former.

None of these are visible without a firewall built from exactly this document's port list — which is
what the AWS harness enforces, and why it found them. Verified on EC2, so the traps below remain
inherited from upstream rather than seen here:

**cgroup driver mismatch** — containerd left on cgroupfs while kubelet uses systemd. Pods start and then get killed or ignore their limits under load. Section 1.4. ([kubeadm docs](https://kubernetes.io/docs/setup/production-environment/container-runtimes/#containerd-systemd))

**Pod CIDR mismatch** — `--pod-network-cidr` and the CNI's pool disagree. Nodes reach `Ready`, pods get addresses, and cross-node traffic goes nowhere. Sections 2 and 4.

**Swap back after reboot** — `swapoff -a` without the `/etc/fstab` edit. Survives until the first reboot, then kubelet will not start. Section 1.2. The EC2 image ships no swap at all, so this stayed untested.

**Cloned VMs sharing `product_uuid` or MAC** — nodes overwrite each other's registration. Prerequisites table. EC2 never produces duplicates, so this stayed untested.

**Expired join token** — the bootstrap token is 24-hour by default, so the join line saved on install day stops working. Regenerate with `kubeadm token create --print-join-command`. Section 3.

---

## Follow-ups

- [ ] Re-run this on real hardware and close the four gaps EC2 papered over — swap, `product_uuid` on cloned templates, `ufw` as an actual firewall, and NIC behaviour 📅 2026-09-30
- [ ] Give the cluster a default StorageClass — a bare cluster has none, so any PVC stays `Pending`. Procedure drafted in [[longhorn-storage-onprem]], still unverified
- [ ] Give the cluster working `type: LoadBalancer` services — on-prem has no cloud load balancer, so they stay `Pending` until something answers. Procedure drafted in [[metallb-l2-onprem]], still unverified
- [ ] Replace `admin.conf` sharing with per-user credentials before a second person needs access
- [ ] Set up etcd backups — a single control plane means etcd is the whole cluster
- [ ] Write down the upgrade path before the next minor release lands

## Related

[[argocd-helm-ha-install]] — the natural next step once this cluster is up, though its HA values assume three schedulable nodes and an ingress controller that this document does not install.
[[pod-crashloopbackoff]] — for when the first workload does not come up. The `CreateContainerError` and scheduling branches cover most bring-up failures.
[[k8s-node-drain-replace]] — how to take one of these three nodes out later. With two workers, draining one puts everything on the other; check capacity first.
