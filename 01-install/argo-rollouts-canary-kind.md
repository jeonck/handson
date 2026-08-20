---
title: Argo Rollouts — a canary deploy, its numbers, and recovering from a bad one
date: 2026-08-20
domain: install
tags: [gitops, cd, kubernetes, progressive-delivery]
stack: [kubernetes, argo-rollouts, kind, podman]
summary: Argo Rollouts controller and CLI plugin installed on a local kind cluster, a real canary progressed through weighted steps with exact pod-count verification at each stage, a deliberately broken image pushed mid-rollout, and recovered with a single undo. Bare kubectl shows none of this — the plugin is not optional, it is the only window into what a Rollout is actually doing.
source: handson
env: kind 0.32.0 (podman provider) · Kubernetes 1.36.1 · Argo Rollouts controller latest (installed 2026-08-20) · kubectl-argo-rollouts plugin v1.9.0 · Podman 5.7.1 on macOS 14.7.5
verified: 2026-08-20
verifiability: partial
verifiability-note: Verified on a single-node kind cluster with the built-in "basic" canary (no traffic-management plugin, so the split is by pod-replica ratio, not an actual weighted service mesh route). Istio/SMI/NGINX-Ingress traffic routing, AnalysisTemplate-driven automated rollback, and blue-green strategy are all unexercised here.
duration: 30–40 min
risk: low
---

> **Verified 2026-08-20.** Every command below ran against a real kind cluster. Every pod count and
> weight percentage quoted is what `kubectl` actually reported at that moment, not the documented
> intent.

Argo CD deploys what Git says is true, all at once. Argo **Rollouts** is the separate controller
that adds the missing piece — deploying it gradually, watching whether it stays healthy at each
step, and giving you a single command to stop and go back the moment it does not. This is not part
of Argo CD itself; it is a different CRD (`Rollout` instead of `Deployment`) and a different
controller, installed separately.

## Install — controller and CLI plugin

```bash
kind create cluster --name argo-rollouts-demo
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
```

```bash
brew install argoproj/tap/kubectl-argo-rollouts
kubectl argo rollouts version
```

```
kubectl-argo-rollouts: v1.9.0+838d4e7
```

**The plugin is not optional tooling — it is the only way to see what a `Rollout` is doing.** Bare
`kubectl get rollout` and the plugin's `kubectl argo rollouts get rollout` were run against the
identical resource, seconds apart:

```bash
kubectl get rollout rollouts-demo
```

```
NAME            DESIRED   CURRENT   UP-TO-DATE   AVAILABLE   AGE
rollouts-demo   5         5         5            5           2m49s
```

```bash
kubectl argo rollouts get rollout rollouts-demo
```

```
Status:          ✔ Healthy
Strategy:        Canary
  Step:          5/5
  SetWeight:     100
  ActualWeight:  100
```

The bare `kubectl` output carries no strategy, no step, no weight — a `Rollout` frozen mid-canary
for hours looks identical to a healthy one from that view. A team that only ever runs `kubectl get`
will not know a rollout is stuck.

## A canary Rollout

```yaml title="rollout.yaml"
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rollouts-demo
spec:
  replicas: 5
  strategy:
    canary:
      steps:
        - setWeight: 20
        - pause: {}
        - setWeight: 60
        - pause: { duration: 15 }
        - setWeight: 100
  selector:
    matchLabels:
      app: rollouts-demo
  template:
    metadata:
      labels:
        app: rollouts-demo
    spec:
      containers:
        - name: rollouts-demo
          image: argoproj/rollouts-demo:blue
          ports:
            - containerPort: 8080
          resources:
            requests: { cpu: 5m, memory: 16Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: rollouts-demo
spec:
  selector: { app: rollouts-demo }
  ports:
    - port: 80
      targetPort: 8080
```

`argoproj/rollouts-demo:blue`/`:yellow` are Argo's own demo images, built for exactly this — each
tag serves a distinct color so a canary split is visible rather than asserted. No traffic-management
plugin (Istio, SMI, NGINX Ingress annotations) is installed here, so this is **basic canary**: the
"weight" is achieved by the ratio of canary-to-stable *pod replicas* behind the one Service, not an
actual weighted route. `pause: {}` with no duration pauses indefinitely, waiting for a human;
`pause: { duration: 15 }` resumes on its own after 15 seconds.

```bash
kubectl apply -f rollout.yaml
```

## Watching a canary actually progress

```bash
kubectl argo rollouts set image rollouts-demo rollouts-demo=argoproj/rollouts-demo:yellow
```

```
Status:          ॥ Paused
Message:         CanaryPauseStep
Step:            1/5
SetWeight:       20
ActualWeight:    20
Images:          argoproj/rollouts-demo:blue (stable)
                 argoproj/rollouts-demo:yellow (canary)
```

```bash
kubectl get pods -l app=rollouts-demo
```

**Pass condition, checked against the actual pods, not the printed percentage:** exactly 1 pod
running `:yellow` and 4 running `:blue` — `1/5 = 20%`. `SetWeight` is what the step asked for;
whether the pod count backs it up is worth confirming once, the same way [[bruno-api-client]]
confirms an HTTP status is really `200` rather than trusting a client's summary line.

`pause: {}` holds here until told otherwise:

```bash
kubectl argo rollouts promote rollouts-demo
```

```
Step:            3/5
SetWeight:       60
ActualWeight:    60
```

3 `:yellow` pods, 2 `:blue` — `3/5 = 60%`, matching again. The next step's `pause: { duration: 15 }`
needs no `promote` — waiting past 15 seconds resolved it on its own:

```
Status:          ✔ Healthy
Step:            5/5
SetWeight:       100
Images:          argoproj/rollouts-demo:yellow (stable)
```

All 5 pods `:yellow`, and `:yellow` is now the **stable** image — the label that determines what the
*next* rollout compares against, not just a status string.

## A bad canary, and getting back out

```bash
kubectl argo rollouts set image rollouts-demo rollouts-demo=argoproj/rollouts-demo:does-not-exist-xyz
```

```
Status:          ◌ Progressing
Message:         more replicas need to be updated
SetWeight:       20
ActualWeight:    0
Images:          argoproj/rollouts-demo:does-not-exist-xyz (canary)
                 argoproj/rollouts-demo:yellow (stable)

⚠ ErrImagePull   rollouts-demo-9f94797f9-ng528   ready:0/1
```

**`SetWeight: 20` and `ActualWeight: 0` are not the same number, and the gap is the whole point.**
`SetWeight` is the step's *intent* — Argo Rollouts scaled a canary pod up trying to reach 20%.
`ActualWeight` is what is actually serving traffic, and it stays `0` because a pod stuck on
`ErrImagePull` never becomes ready. This is the same shape of lie [[gitlab-ci-argocd-fastapi-onprem]]
warns about with Argo CD's `Synced` status — a number that looks like progress while nothing is
actually different for a real request. This rollout has no `AnalysisTemplate` configured, so nothing
here aborts it automatically; it would sit `Progressing` indefinitely without a human or an
automated analysis step intervening.

```bash
kubectl argo rollouts undo rollouts-demo
```

```
Status:          ✔ Healthy
Step:            5/5
SetWeight:       100
Images:          argoproj/rollouts-demo:yellow (stable)
```

One command, and every pod is back on the last known-good image — no partial canary state left
behind to clean up by hand.

## Verification checklist

- [x] `kubectl argo rollouts version` reports the plugin version against a real cluster
- [x] Bare `kubectl get rollout` shows no strategy, step, or weight — confirmed missing, not assumed
- [x] `setWeight: 20` after an image change produces exactly 1 canary pod out of 5
- [x] `promote` past an indefinite `pause: {}` advances to the next step and its own correct pod ratio
- [x] `pause: { duration: 15 }` resumes on its own with no `promote` call
- [x] A nonexistent image tag produces `ErrImagePull` and `ActualWeight` stuck below `SetWeight` — **broken on purpose to confirm**
- [x] `undo` returns every pod to the last stable image in one command

## Rollback

```bash
kind delete cluster --name argo-rollouts-demo
```

The cluster is disposable — nothing here persists or costs anything once deleted.

## Where this bit us

**`SetWeight` and `ActualWeight` are the entire signal for "is the canary actually working," and
they are easy to conflate while reading quickly.** Both numbers show `100` on a fully healthy
rollout and both show the same value at each successful step, which is exactly what makes the one
case where they *diverge* — a broken canary stuck below its target weight — easy to miss on a
glance rather than a read.

**A rollout with no `AnalysisTemplate` does not roll itself back.** `Status: Progressing` on a
canary stuck on `ErrImagePull` is a permanent state, not a transient one — Argo Rollouts scaled the
canary pod up and is waiting for it to become ready, which it never will. Nothing here notices that
on its own; a human running `kubectl argo rollouts get rollout` or `undo`, or a configured
`AnalysisTemplate` checking a real metric, is what actually stops it.

**`kubectl get rollout` on its own is worse than useless for judging a canary's health** — it is
actively misleading, since a rollout with a plainly stuck canary reports `DESIRED 5 / AVAILABLE 5`
exactly like a fully healthy one. Anyone operating this without the plugin installed is reading a
resource that cannot tell them what they actually need to know.

## Follow-ups

- [ ] Configure an `AnalysisTemplate` against a real metric (even just an HTTP success-rate check against `rollouts-demo`'s Service) so a broken canary aborts itself instead of waiting on a human
- [ ] Install NGINX Ingress or a service mesh and repeat this with true weighted traffic routing instead of basic pod-ratio canary — confirm the same `SetWeight`/`ActualWeight` split holds for an actual request distribution, not just a pod count
- [ ] Exercise `kubectl argo rollouts abort` (stop and revert without a full `undo`) and compare its effect to `undo`
- [ ] Try the BlueGreen strategy and its `activeService`/`previewService` split, which this document never touches
- [ ] Wire a `Rollout` into [[gitlab-ci-argocd-fastapi-procedure]]'s pipeline in place of the plain `Deployment` in step 5.2, so the three-signal check in step 6.4 has an actual canary window to verify during, not just an instant cutover

## Related

[[argocd-helm-ha-install]] — Argo CD itself, which this extends; a `Rollout` is a drop-in replacement for the `Deployment` kind Argo CD would otherwise sync directly.
[[gitlab-ci-argocd-fastapi-onprem]] — section 7's `Synced`-is-not-`Healthy` argument, which `SetWeight` vs `ActualWeight` is the same lesson one layer deeper.
[[bruno-api-client]] — checking the property itself rather than a summary line, applied there to an HTTP status and here to a pod count.
[[onprem-3node-kubeadm-ubuntu]] — a real cluster this could be re-verified against, in place of the disposable kind cluster used here.
