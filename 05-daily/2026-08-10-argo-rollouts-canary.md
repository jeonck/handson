---
title: Topic of the day — canary rollouts with Argo Rollouts on top of Argo CD
date: 2026-08-10
domain: daily
tags: [daily, gitops, delivery]
stack: [kubernetes, argocd, argo-rollouts, kind, ingress-nginx]
summary: A Deployment goes to 100% of pods the moment the image tag changes. Swap it for a Rollout CRD and step through a canary with pauses, then check what it takes for Argo CD to treat that as a first-class resource.
source: daily-topic
---

## Why this topic

[[argocd-helm-ha-install]] gets manifests synced to a cluster, but the workload underneath is a plain `Deployment` — a new image goes to every pod at once, no pause, no partial traffic. Argo Rollouts replaces `Deployment` with a `Rollout` CRD that adds canary and blue-green strategies: shift 20% of traffic, pause, watch, shift more.

The [[2026-08-07-gateway-api]] daily doc's "If we applied this here" section flagged this exact gap: *"If canaries run through Argo Rollouts, confirm its Gateway API traffic-routing support first."* This lab is that follow-up.

- Latest stable release: **v1.9.1**, July 17, 2026 — a security patch for CVE-2026-35469 on top of the v1.9.0 GA line from March 20, 2026. ([releases](https://github.com/argoproj/argo-rollouts/releases))
- Argo CD has shipped a **built-in Lua health check for the `Rollout` CRD since Argo CD 2.0** — no custom health check config needed for it to show `Progressing` / `Healthy` / `Degraded` correctly. ([Argo CD resource health docs](https://github.com/argoproj/argo-cd/blob/master/docs/operator-manual/health.md))
- Argo Rollouts lists **NGINX Ingress Controller and Gateway API** among its supported traffic routing providers, alongside Istio, ALB, Traefik, and SMI. ([traffic management docs](https://argo-rollouts.readthedocs.io/en/stable/features/traffic-management/)) — meaning the existing [[ingress-nginx-onprem]] setup is a valid traffic backend without adding a service mesh.

## 30-minute lab

> **Not executed in this run.** This session's sandbox blocks `docker`, `kind create cluster`, and `kubectl` behind an approval prompt that nothing here can answer — there is no user in the loop on a scheduled run. Every command below is copied from the official Argo Rollouts docs (linked per step), not invented, but nobody has watched it run yet. Run it and check the box under Follow-ups.

### 1. Cluster

```bash
kind create cluster --name rollouts-demo
```

### 2. Controller and CLI plugin

Source: [installation docs](https://argo-rollouts.readthedocs.io/en/stable/installation/).

```bash
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x ./kubectl-argo-rollouts-linux-amd64
sudo mv ./kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

kubectl argo rollouts version
```

### 3. A Rollout instead of a Deployment

Source: [getting-started basic example](https://raw.githubusercontent.com/argoproj/argo-rollouts/master/docs/getting-started/basic/rollout.yaml). Same shape as a `Deployment`, `kind: Rollout` and a `strategy.canary.steps` list instead of `spec.strategy.rollingUpdate`.

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
      - setWeight: 40
      - pause: {duration: 10}
      - setWeight: 60
      - pause: {duration: 10}
      - setWeight: 80
      - pause: {duration: 10}
  revisionHistoryLimit: 2
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
        - name: http
          containerPort: 8080
          protocol: TCP
        resources:
          requests:
            memory: 32Mi
            cpu: 5m
```

```yaml title="service.yaml"
apiVersion: v1
kind: Service
metadata:
  name: rollouts-demo
spec:
  ports:
  - port: 80
    targetPort: http
    protocol: TCP
    name: http
  selector:
    app: rollouts-demo
```

```bash
kubectl apply -f rollout.yaml
kubectl apply -f service.yaml
kubectl argo rollouts get rollout rollouts-demo --watch
```

### 4. Trigger a canary

```bash
kubectl argo rollouts set image rollouts-demo \
  rollouts-demo=argoproj/rollouts-demo:yellow
```

Watch the same `get rollout --watch` pane: it should step to `SetWeight: 20`, then sit at `Paused` — the first step is `pause: {}` with no duration, so it waits for a human, not a timer.

### 5. Promote or abort

```bash
kubectl argo rollouts promote rollouts-demo   # advance past the indefinite pause
kubectl argo rollouts abort rollouts-demo     # or: roll back instead
```

### Verify

```bash
kubectl argo rollouts get rollout rollouts-demo
```

Expected: the canary/stable weight split shown as a ratio (e.g. `20/80` at step 1), status `Healthy` once all steps complete, and a revision history entry for the promoted image. A `Degraded` status with the old image still at 100% weight means a step's `pause` never got promoted — check for an indefinite `pause: {}` sitting unattended before assuming the rollout is stuck for some other reason.

### Clean up

```bash
kind delete cluster --name rollouts-demo
```

## Traps

**`pause: {}` vs `pause: {duration: 10}` look identical in the YAML skim.** One waits forever for `kubectl argo rollouts promote`, the other resumes itself after 10 seconds. The basic example mixes both — miss that on a first read and the rollout looks hung when it's doing exactly what the manifest said.

**`kubectl get rollout` without the plugin shows raw CRD fields, not the step/weight view.** The human-readable canary progress (`kubectl argo rollouts get rollout --watch`) only exists in the CLI plugin. Forgetting to install it makes a perfectly healthy canary look opaque.

**Traffic weighting needs a traffic router, not just Kubernetes Service load balancing.** Without configuring a `trafficRouting` provider (nginx, Gateway API, Istio...), Argo Rollouts approximates weight by scaling replica counts — 20% traffic becomes "20% of pods," which is only accurate when every pod gets an even share of requests. This basic example does not configure `trafficRouting` at all; that is a separate step this lab did not cover, and it is the difference between a real canary and a replica-count approximation of one.

## If we applied this here

- [[argocd-helm-ha-install]] would sync a `Rollout` instead of a `Deployment` with no extra Argo CD config for health status — the Lua check ships in Argo CD 2.0+. What is unconfirmed: whether the Argo CD version actually pinned in that install guide is ≥2.0 (near-certain, but not restated there — worth a one-line check next time that doc is touched).
- Wiring `trafficRouting.nginx` against [[ingress-nginx-onprem]] would turn the replica-count approximation above into real weighted traffic — that configuration was not part of this lab and needs its own pass.
- The `pause: {}` step is a manual gate. Anything meant to run unattended in CI needs either an `AnalysisTemplate` doing automated success/failure judgement, or every `pause` on a `duration`, or someone's `promote` call added to the deploy pipeline.

## Follow-ups

- [ ] Run the lab above end to end on kind and confirm the `--watch` output actually matches what is claimed here 📅 2026-08-11
- [ ] Configure `trafficRouting.nginx` against the existing ingress-nginx setup and verify real traffic splitting, not replica-count approximation 📅 2026-08-24
- [ ] Check the Argo CD version pinned in [[argocd-helm-ha-install]] is ≥2.0 so the built-in Rollout health check applies

## Related

[[argocd-helm-ha-install]] — the Deployment this would replace with a Rollout.
[[ingress-nginx-onprem]] — candidate traffic-routing backend for real (not replica-approximated) canary weighting.
[[2026-08-07-gateway-api]] — raised this exact follow-up first.
[[topics]] — why this topic was selected.
