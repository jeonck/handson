---
title: Argo CD HA install with Helm — from empty cluster to first sync
date: 2026-08-07
domain: install
tags: [gitops, cd, kubernetes]
stack: [kubernetes, argocd, helm, ingress-nginx]
summary: Stand up Argo CD in HA on a fresh Kubernetes cluster, expose it through an ingress, and bootstrap app-of-apps. Pinning the chart version and getting the gRPC path right are where this goes wrong.
source: handson
env: Kubernetes 1.31 (EKS) · Helm 3.16 · ingress-nginx 1.11 · argo-cd chart 7.x
verified: 2026-08-07
duration: 40–60 min
risk: medium
---

Standing up a GitOps control plane on a cluster that does not have one. Written for a **managed cluster (EKS/GKE/AKS)** and assumes ingress-nginx is already running. SSO (OIDC) and Argo CD Image Updater are out of scope — wire those in first and every login failure has two possible causes instead of one.

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

```yaml
# argocd-values.yaml
global:
  domain: argocd.example.com

# HA: a 3-node redis-ha plus replicas on each component.
# On a single-node test cluster redis-ha stays Pending forever because of anti-affinity.
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
and this install hits the timeout above on hardware that looks like it should be enough. Count with
[[schedulable-node-budget]] before running the command, not after the ten minutes are gone.

```bash
kubectl -n argocd get pods -o wide
kubectl -n argocd get events --sort-by=.lastTimestamp | tail -20
```

On a single-node environment set `redis-ha.enabled: false` and re-run. In production, add nodes instead — see the scheduling section of [[pod-crashloopbackoff]].

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

```yaml
# bootstrap/root.yaml
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
- [ ] Bring Argo CD itself under the root app so it becomes self-managed
- [ ] Back up `argocd-cm`, `argocd-rbac-cm`, and the Application manifests into Git

## Related

[[pod-crashloopbackoff]] — when pods keep restarting right after the install.
[[k8s-node-drain-replace]] — replacing the node Argo CD landed on. The controller runs at 1 replica, so drain order matters.
