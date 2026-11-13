---
title: Topic of the day — canary rollouts with Argo Rollouts on top of Argo CD
date: 2026-08-10
domain: daily
tags: [daily, gitops, delivery]
stack: [kubernetes, argocd, argo-rollouts, kind, ingress-nginx]
summary: A Deployment goes to 100% of pods the moment the image tag changes. Swap it for a Rollout CRD and step through a canary with pauses, then check what it takes for Argo CD to treat that as a first-class resource.
source: daily-topic
env: kind v0.33.0, node image kindest/node:v1.37.0 (Kubernetes) · Argo Rollouts v1.10.2 — no Argo CD in this lab, no traffic router configured, no CI runner (see below)
verified: 2026-11-13
verifiability: partial
verifiability-note: Ran standalone, not integrated with an actual Argo CD instance, so the Lua health-check claim below rests on documentation, not on watching Argo CD render the status.
---

## Why this topic

[[argocd-helm-ha-install]] gets manifests synced to a cluster, but the workload underneath is a plain `Deployment` — a new image goes to every pod at once, no pause, no partial traffic. Argo Rollouts replaces `Deployment` with a `Rollout` CRD that adds canary and blue-green strategies: shift 20% of traffic, pause, watch, shift more.

The [[2026-08-07-gateway-api]] daily doc's "If we applied this here" section flagged this exact gap: *"If canaries run through Argo Rollouts, confirm its Gateway API traffic-routing support first."* This lab is that follow-up.

- Latest stable release: **v1.10.2**, published 2026-11-04. ([releases](https://github.com/argoproj/argo-rollouts/releases)) — the `v1.9.1` / July 2026 line cited when this document was first drafted has since moved; the install command below always resolves `/releases/latest/`, so re-running it later will pick up whatever is current then.
- Argo CD has shipped a **built-in Lua health check for the `Rollout` CRD since Argo CD 2.0** — no custom health check config needed for it to show `Progressing` / `Healthy` / `Degraded` correctly. ([Argo CD resource health docs](https://github.com/argoproj/argo-cd/blob/master/docs/operator-manual/health.md)) — not exercised in this lab; see the banner above.
- Argo Rollouts lists **NGINX Ingress Controller and Gateway API** among its supported traffic routing providers, alongside Istio, ALB, Traefik, and SMI. ([traffic management docs](https://argo-rollouts.readthedocs.io/en/stable/features/traffic-management/)) — meaning the existing [[ingress-nginx-onprem]] setup is a valid traffic backend without adding a service mesh. Not configured in this lab either — see Traps.

## 30-minute lab

### 1. Cluster

```bash
kind create cluster --name rollouts-demo
```

### 2. Controller

Source: [installation docs](https://argo-rollouts.readthedocs.io/en/stable/installation/).

```bash
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
```

This failed the first time it ran here — see **Traps** for the fix (`--server-side`) before you paste this.

```bash
kubectl rollout status deployment/argo-rollouts -n argo-rollouts --timeout=120s
```

**CLI plugin — optional, and this run skipped it.** `kubectl argo rollouts get rollout --watch` needs a separate binary (`kubectl-argo-rollouts-linux-amd64` from the same release page). The commands below do not depend on it: every step uses plain `kubectl get`/`describe`/`patch` against the `Rollout` object instead. If your environment lets you execute a freshly downloaded binary, installing the plugin gets you the human-readable `20/80` weight view the official docs show; this run's execution sandbox refused to run it (treated as an unverified downloaded binary), which is itself worth knowing if you're reproducing this inside a locked-down CI runner rather than a workstation.

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
kubectl get rollout rollouts-demo -o jsonpath='{.status}' | python3 -m json.tool
```

The first apply always goes straight to `Healthy` at full replica count — there is no prior stable version to canary against yet, so every step collapses into one rollout. Observed: `"phase": "Healthy"`, `"readyReplicas": 5`, 8/8 steps implied complete. This is correct, not a check that failed to catch anything; the canary only shows up on the *second* rollout.

### 4. Trigger a canary

```bash
kubectl patch rollout rollouts-demo --type merge \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"rollouts-demo","image":"argoproj/rollouts-demo:yellow"}]}}}}'
```

(The upstream docs do this with `kubectl argo rollouts set image`, which is the plugin wrapping the same patch — see the CLI-plugin note in step 2 for why this run uses the patch directly.)

Observed a few seconds later:

```
kubectl get rollout rollouts-demo -o jsonpath='{.status.phase} step={.status.currentStepIndex}{"\n"}'
Paused step=1
kubectl get rs -l app=rollouts-demo
NAME                       DESIRED   CURRENT   READY   AGE
rollouts-demo-5cd66ff7ff   4         4         4       22s   # stable, 80%
rollouts-demo-5fdf49899    1         1         1       8s    # canary, 20%
```

It paused at step 1 (`pause: {}`, the one with no duration) exactly as the manifest says, with the ReplicaSets split 4/1 — `setWeight: 20` approximated as 1 of 5 pods, confirming the replica-count approximation named in Traps.

### 5. Promote or abort

The CLI plugin wraps both as patches to the `Rollout` object; without it, the same patches work directly.

```bash
# promote: clear the indefinite pause and let the controller continue
kubectl patch rollout rollouts-demo --type=merge --subresource=status \
  -p '{"status":{"pauseConditions":null}}'
```

Observed: `currentStepIndex` advanced from `1` to `3` within a few seconds (through `setWeight: 40` and into the next `pause: {duration: 10}`), then the rollout auto-advanced through the remaining duration-based pauses on its own and reached `"phase": "Healthy"`, `step=8`, with the canary ReplicaSet at 5/5 and the old one scaled to 0/0 — matching the manifest's 8-step list with no further intervention needed once past the indefinite pause.

```bash
# abort: roll back to the stable ReplicaSet instead
kubectl patch rollout rollouts-demo --type merge \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"rollouts-demo","image":"argoproj/rollouts-demo:red"}]}}}}'
# wait for it to reach Paused at step 1 again, then:
kubectl patch rollout rollouts-demo --type merge --subresource=status -p '{"status":{"abort":true}}'
```

Observed: phase went to `Degraded`, `status.abort` read `true`, the canary ReplicaSet scaled to `0/0`, and the previous stable ReplicaSet scaled back to `5/5` — `kubectl describe rollout` logged `Warning  RolloutAborted  Rollout aborted update to revision 3`. **`Degraded` here is the correct, successful outcome of a deliberate abort, not a failure to chase** — see Traps.

### Verify

```bash
kubectl get rollout rollouts-demo -o jsonpath='{.status.phase} step={.status.currentStepIndex}{"\n"}'
kubectl get rs -l app=rollouts-demo
```

Watched both pass and fail in this run:

- **Pass** (after promote, above): `Healthy step=8`, canary ReplicaSet at full `replicas`, old ReplicaSet at `0`.
- **The failure case that matters more than the pass:** a `Paused` phase with `currentStepIndex` stuck at an odd number (an indefinite `pause: {}` step) is not a failure at all — it is correct and waits for a human. The check that would actually catch a stuck rollout is `pauseConditions[].startTime` not advancing for longer than expected, or `status.conditions[type=Progressing].status` staying `Unknown` well past the point a `duration` pause should have expired.

### Clean up

```bash
kind delete cluster --name rollouts-demo
```

## Traps

**`pause: {}` vs `pause: {duration: 10}` look identical in the YAML skim.** One waits forever for a promote, the other resumes itself after 10 seconds. The basic example mixes both — miss that on a first read and the rollout looks hung when it's doing exactly what the manifest said. Confirmed: this run's rollout sat at `Paused step=1` indefinitely until the status patch above cleared it, then ran the two `duration: 10` pauses itself with no intervention.

**`kubectl apply -f install.yaml` on the aggregated manifest fails with `metadata.annotations: Too long: may not be more than 262144 bytes`.** Client-side apply stores the full manifest in a `last-applied-configuration` annotation, and the `rollouts.argoproj.io` and `analysisruns.argoproj.io` CRDs are big enough to blow the 256KiB annotation limit. Only those two CRDs failed in this run; everything else in the manifest (the smaller CRDs, RBAC, the Deployment) applied fine on the first try, which makes the error easy to miss among the successful lines above it. Fix: `kubectl apply -n argo-rollouts -f <url> --server-side`.

**`kubectl get rollout` without the plugin shows raw CRD fields, not the step/weight view.** The human-readable canary progress (`kubectl argo rollouts get rollout --watch`) only exists in the CLI plugin, and that plugin is a freshly downloaded, unsigned binary — some execution environments (this run's included) refuse to run one. `kubectl get rollout -o jsonpath='{.status}'` carries the same information (`phase`, `currentStepIndex`, `pauseConditions`, `canary`/`blueGreen` weight) without the friendlier formatting.

**A `Degraded` phase after `abort: true` is the expected, successful result — not a sign something broke.** Read on its own, `Degraded` reads like a problem. In this run it meant the abort worked: canary scaled to 0, stable scaled back to full. Check `status.abort` and the `RolloutAborted` event before troubleshooting a `Degraded` rollout as if it were stuck.

**Traffic weighting needs a traffic router, not just Kubernetes Service load balancing.** Without configuring a `trafficRouting` provider (nginx, Gateway API, Istio...), Argo Rollouts approximates weight by scaling replica counts — 20% traffic becomes "20% of pods," which is only accurate when every pod gets an even share of requests. Confirmed in this run: at `setWeight: 20` the split was exactly 4 stable / 1 canary pods (5 replicas total), not real request-level weighting. This basic example does not configure `trafficRouting` at all; that is a separate step this lab did not cover, and it is the difference between a real canary and a replica-count approximation of one.

## If we applied this here

- [[argocd-helm-ha-install]] pins `argo-cd chart 7.x`, which tracks an Argo CD app version well past 2.0 — the built-in `Rollout` Lua health check applies with no extra config needed there. (Checked by reading that document's `env` line, not by running Argo CD against a `Rollout` in this lab — still unconfirmed end to end per the banner at the top of this document.)
- Wiring `trafficRouting.nginx` against [[ingress-nginx-onprem]] would turn the replica-count approximation above into real weighted traffic — that configuration was not part of this lab and needs its own pass.
- The `pause: {}` step is a manual gate. Anything meant to run unattended in CI needs either an `AnalysisTemplate` doing automated success/failure judgement, or every `pause` on a `duration`, or someone's `promote` call added to the deploy pipeline. The `--server-side` apply fix matters doubly in CI: a client-side `kubectl apply` of this install manifest fails there the same way it failed here.

## Follow-ups

- [ ] Wire `trafficRouting.nginx` against [[ingress-nginx-onprem]] on a kind cluster and confirm the canary Ingress actually splits by weight, not by replica count 📅 2026-12-01

## Related

[[argocd-helm-ha-install]] — the Deployment this would replace with a Rollout.
[[ingress-nginx-onprem]] — candidate traffic-routing backend for real (not replica-approximated) canary weighting.
[[2026-08-07-gateway-api]] — raised this exact follow-up first.
[[topics]] — why this topic was selected.
