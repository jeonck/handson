---
title: Argo CD HA install with Helm — from empty cluster to first sync
date: 2026-08-07
domain: install
tags: [gitops, cd, kubernetes]
stack: [kubernetes, argocd, helm, ingress-nginx]
summary: Stand up Argo CD in HA on a fresh Kubernetes cluster, expose it through an ingress, and bootstrap app-of-apps. Pinning the chart version and getting the gRPC path right are where this goes wrong — and redis-ha needs three schedulable nodes, which a three-machine on-prem cluster does not have.
source: handson
env: Kubernetes 1.31 (EKS) · Helm 3.16 · ingress-nginx 1.11 · argo-cd chart 7.x — the on-prem variant in section 2.1 has not been run anywhere
verified: 2026-08-07
verifiability: partial
verifiability-note: Verified on EKS with three schedulable nodes. The reduced values for a two-node budget (section 2.1) are derived from this document's own failure mode, not executed.
duration: 40–60 min
risk: medium
---

Standing up a GitOps control plane on a cluster that does not have one. Written for a **managed cluster (EKS/GKE/AKS)** and assumes ingress-nginx is already running. SSO (OIDC) and Argo CD Image Updater are out of scope — wire those in first and every login failure has two possible causes instead of one.

> **On the on-prem cluster, the values below do not apply as written.** `redis-ha` needs three
> schedulable nodes and that cluster has two by decision — see [[schedulable-node-budget]]. Section
> 2.1 has the reduced values. Read that before section 2 rather than after, because the failure this
> avoids costs ten minutes of `helm --wait` before it says anything.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster access | `kubectl auth can-i create namespace` | `yes` |
| Helm | `helm version --short` | `v3.14` or newer |
| Ingress controller | `kubectl get ingressclass` | `nginx` present |
| DNS | `dig +short argocd.example.com` | ingress LB address |
| TLS | `kubectl -n argocd get secret argocd-tls`, or a cert-manager ClusterIssuer | one of the two |

If DNS is not pointed yet, do not start this document. Verifying through `port-forward` and exposing later means you meet the gRPC problem below on rollout day instead of today.

## 1. Namespace and a pinned chart version

```bash
kubectl create namespace argocd
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update argo
```

**Pin the chart version.** Running `helm upgrade --install` without one means a different Argo CD lands on the next deploy.

```bash
helm search repo argo/argo-cd --versions | head -5
```

Take `CHART VERSION` from the first line. Record that value and the `APP VERSION` (Argo CD itself) in this document's `env` frontmatter.

```bash
export ARGOCD_CHART_VERSION="<version you picked>"
export ARGOCD_HOST="argocd.example.com"
```

## 2. values file

```yaml title="argocd-values.yaml"
global:
  domain: argocd.example.com

# HA: a 3-node redis-ha plus replicas on each component.
# Needs three SCHEDULABLE nodes — anti-affinity, not node count. Below that the
# pods stay Pending forever. Section 2.1 for a cluster that cannot meet it.
redis-ha:
  enabled: true

controller:
  replicas: 1          # keep the application controller at 1 until you shard it
repoServer:
  replicas: 2
server:
  replicas: 2
  # TLS terminates at the ingress, so the server should accept plaintext.
  # Without this flag nginx -> argocd-server ends in an infinite redirect (ERR_TOO_MANY_REDIRECTS).
  extraArgs:
    - --insecure
  ingress:
    enabled: true
    ingressClassName: nginx
    hostname: argocd.example.com
    annotations:
      nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    tls: true
applicationSet:
  replicas: 2

configs:
  params:
    server.insecure: true
```

Replace `global.domain` and `ingress.hostname` with the real host. This is the minimum that gets the web UI up.

## 2.1 On a cluster with fewer than three schedulable nodes

> ⚠️ **Not verified.** Everything above ran on EKS with three schedulable nodes. This section is
> derived from the failure mode in section 3, not from a run. Correct it after the first one.

Count first — machines are not the number:

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

At two, the only value that has to change is `redis-ha`. The controller is already at 1, and
`repoServer`, `server` and `applicationSet` at 2 replicas spread across two nodes without complaint —
`redis-ha` is the single blocker, because it is the only component using anti-affinity across three.

```yaml title="argocd-values-onprem.yaml"
# Everything from argocd-values.yaml, with this one block replaced.
redis-ha:
  enabled: false          # falls back to the chart's single-pod redis
```

**What that gives up: redis stops being redundant.** Argo CD's redis is a cache rather than a source
of truth, so losing it does not lose Applications or Git state — but while it is down the UI and the
CLI degrade, and the pod is on one of two nodes rather than spread across three. On the on-prem
cluster this is the accepted cost of keeping the control-plane taint; the reasoning is recorded once
in [[schedulable-node-budget]], not re-argued here.

The rest of this document is unchanged. Install with this values file in place of the other.

## 3. Install

```bash
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --version "$ARGOCD_CHART_VERSION" \
  --values argocd-values.yaml \
  --wait --timeout 10m
```

When `--wait` blows past 10 minutes it is almost always `redis-ha`. Fewer than three nodes, or a single zone, and anti-affinity cannot be satisfied, so the pods sit in Pending.

**"Three nodes" means three *schedulable* nodes.** A three-machine cluster built by
[[onprem-3node-kubeadm-ubuntu]] keeps a `NoSchedule` taint on the control plane, so it offers two —
and this install hits the timeout above on hardware that looks like it should be enough. That is
what section 2.1 exists for; count with [[schedulable-node-budget]] before running the command, not
after the ten minutes are gone.

```bash
kubectl -n argocd get pods -o wide
kubectl -n argocd get events --sort-by=.lastTimestamp | tail -20
```

The `FailedScheduling` event on a pending `redis-ha` pod carries the scheduler's own reason — read it
rather than assuming this is the cause, since insufficient CPU produces the same `Pending`:

```bash
kubectl -n argocd describe pod -l app.kubernetes.io/name=argocd-redis-ha | grep -A3 FailedScheduling
```

Below three schedulable nodes, set `redis-ha.enabled: false` (section 2.1) and re-run. Adding nodes
is the other answer and the better one where the hardware exists — see the scheduling section of
[[pod-crashloopbackoff]]. On the on-prem cluster the choice is already made and recorded in
[[schedulable-node-budget]]: the taint stays, so `redis-ha` goes.

## 4. First login

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d; echo
```

```bash
argocd login "$ARGOCD_HOST" --username admin --grpc-web
```

`--grpc-web` is the part that matters. Plenty of ingress-nginx setups will not pass HTTP/2 gRPC through cleanly, and without the flag the login dies with `rpc error: code = Unavailable`. Once you have logged in with it, the context saved in `~/.config/argocd/config` keeps working.

Change the password and delete the bootstrap secret.

```bash
argocd account update-password
kubectl -n argocd delete secret argocd-initial-admin-secret
```

## 5. app-of-apps bootstrap

Driving Argo CD from the UI turns every click into an unrecorded change. Create exactly one root Application by hand and let Git own everything below it.

```yaml title="bootstrap/root.yaml"
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/<org>/<gitops-repo>.git
    targetRevision: main
    path: apps            # the Application manifests in here create everything else
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```bash
kubectl apply -f bootstrap/root.yaml
argocd app wait root --health --timeout 300
```

For a private repository, register credentials first.

```bash
argocd repo add https://github.com/<org>/<gitops-repo>.git \
  --username <user> --password <token>
```

## 6. Verification checklist

All of it has to pass before you call this installed. Skip one and you will not trust this document during a real incident.

- [ ] `kubectl -n argocd get pods` — every pod `Running`, `RESTARTS` at 0
- [ ] `https://argocd.example.com` logs in from a browser with no certificate warning
- [ ] `argocd app list` — the CLI can list apps (this is the gRPC path check)
- [ ] `argocd app get root` — `Synced` / `Healthy`
- [ ] Change one line of a manifest in Git, push, and see it applied within 3 minutes (selfHeal works)
- [ ] `kubectl -n argocd delete pod -l app.kubernetes.io/name=argocd-server`, then reload the UI — HA recovery works
- [ ] `redis-ha` matches the schedulable-node count: three pods `Running` at three nodes, or `redis-ha.enabled: false` and one `redis` pod at two. **Not `Pending`** — a `Pending` redis-ha pod leaves the rest of Argo CD working, so the install can look finished
- [ ] Initial admin secret deleted

## 7. Rollback

```bash
helm history argocd -n argocd
helm rollback argocd <REVISION> -n argocd --wait
```

Full removal has an order to it. Applications carry a finalizer, so deleting the chart first leaves the namespace stuck in `Terminating`.

```bash
kubectl -n argocd delete applications --all      # first
helm uninstall argocd -n argocd                  # then this
kubectl delete namespace argocd
```

## Where this bit us

**`ERR_TOO_MANY_REDIRECTS`** — ingress TLS without `--insecure`. argocd-server redirects HTTP to HTTPS, the ingress sends it back as plaintext, and the loop never ends. Check both `server.extraArgs` and `configs.params.server.insecure`.

**UI works, CLI does not** — gRPC. Either pass `--grpc-web`, or open a second host (`grpc.argocd.example.com`) whose ingress carries `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"`. Trying to serve HTTP and gRPC from one host has mostly been a waste of an afternoon.

**Unpinned chart** — three weeks later, CI for an unrelated PR ran `helm upgrade` and pulled a new Argo CD minor with changed CRDs. Pin with `--version` and let renovate/dependabot raise an explicit PR instead.

## Follow-ups

- [ ] Wire up OIDC (SSO), then disable the local `admin` account 📅 2026-08-21
- [ ] Run section 2.1 on the on-prem cluster and correct it — it is currently the only unexecuted part of this document 📅 2026-09-30
- [ ] Bring Argo CD itself under the root app so it becomes self-managed
- [ ] Back up `argocd-cm`, `argocd-rbac-cm`, and the Application manifests into Git

## Related

[[pod-crashloopbackoff]] — when pods keep restarting right after the install.
[[k8s-node-drain-replace]] — replacing the node Argo CD landed on. The controller runs at 1 replica, so drain order matters.
[[schedulable-node-budget]] — decides `redis-ha` before this document is opened. On the on-prem cluster the answer is already `false`.
[[onprem-3node-kubeadm-ubuntu]] — the cluster whose taint decision produces the two-node budget in section 2.1.
