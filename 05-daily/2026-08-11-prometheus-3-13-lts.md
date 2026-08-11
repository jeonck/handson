---
title: Topic of the day — Prometheus 3.13 LTS, a self-scrape lab and the new min_of()/max_of()
date: 2026-08-11
domain: daily
tags: [daily, observability]
stack: [kubernetes, prometheus, kind]
summary: Stand up Prometheus on kind, confirm it's actually running the 3.13 LTS build, and try the two PromQL functions that release added — which stay silently broken without a feature flag nobody defaults on.
source: daily-topic
---

## Why this topic

[[topics]] lists Observability — Prometheus, OpenTelemetry, Grafana, log pipelines, SLOs — as in scope, and even names `prometheus` in its own frontmatter `stack`. No document in this repository has actually deployed it yet. [[pod-crashloopbackoff]] ends with an open follow-up to "add an alert on OOMKilled events," and [[schedulable-node-budget]] is a runbook of checks a human has to remember to run by hand — both are exactly the kind of thing Prometheus turns into a query instead of a memory. Standing it up once is the prerequisite for either.

The immediate trigger: **Prometheus v3.13.0, released 2026-07-01, is a Long Term Support release** — LTS releases get backported fixes for longer than the normal ~6-week cadence, which makes it the sane default to pin against rather than the latest non-LTS tag. ([release notes](https://github.com/prometheus/prometheus/releases/tag/v3.13.0))

Two things in that release make a good lab hook:

- Two new **experimental** PromQL scalar functions, `min_of(a, b)` and `max_of(a, b)`, gated behind `--enable-feature=promql-experimental-functions`. ([query functions docs](https://prometheus.io/docs/prometheus/latest/querying/functions/))
- Roughly 12–15% lower per-sample overhead in chunk operations, and per-query sample-read metrics for diagnosing expensive queries. (same release notes)

## 30-minute lab

> **Not executed in this run.** This is a scheduled run with no user in the loop, and this sandbox puts `docker run`, `kind create cluster`, and `kubectl apply` behind an approval prompt nothing here can answer — `docker ps` (read-only) works, `docker run`/`kind get clusters` do not. Every command below is copied from the official Prometheus docs (linked per step) or built from the confirmed image tag and flag name above, but nobody has watched it run. Treat it the same way [[2026-08-10-argo-rollouts-canary]] treated its own lab: run it and check the box under Follow-ups before trusting the exact output shown here.

### 1. Cluster

```bash
kind create cluster --name prom-demo
```

### 2. Self-scrape config

Source: [Prometheus getting-started guide](https://prometheus.io/docs/prometheus/latest/getting_started/) — the minimal config that has Prometheus scrape its own `/metrics`.

```yaml title="prometheus.yml"
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

```bash
kubectl create configmap prometheus-config --from-file=prometheus.yml
```

### 3. Deployment, pinned to the LTS tag

Image tag confirmed present on Docker Hub as `prom/prometheus:v3.13.0` (linux/amd64, pushed by `prombot`). To find the current tag later: [Docker Hub tags](https://hub.docker.com/r/prom/prometheus/tags) or the [GitHub releases page](https://github.com/prometheus/prometheus/releases).

```yaml title="prometheus-deploy.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      containers:
      - name: prometheus
        image: prom/prometheus:v3.13.0
        args:
          - --config.file=/etc/prometheus/prometheus.yml
          - --enable-feature=promql-experimental-functions
        ports:
        - containerPort: 9090
        volumeMounts:
        - name: config
          mountPath: /etc/prometheus
      volumes:
      - name: config
        configMap:
          name: prometheus-config
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
spec:
  selector:
    app: prometheus
  ports:
  - port: 9090
    targetPort: 9090
```

```bash
kubectl apply -f prometheus-deploy.yaml
kubectl rollout status deployment/prometheus
```

### 4. Port-forward

```bash
kubectl port-forward svc/prometheus 9090:9090 &
```

### Verify

Two separate checks — the first only proves *a* Prometheus is up, the second proves it's *this* release with the flag actually applied.

```bash
# 1) which build actually answered
curl -s 'http://localhost:9090/api/v1/query?query=prometheus_build_info' \
  | jq -r '.data.result[0].metric.version'
```

Expected: `3.13.0`. `up{job="prometheus"} == 1` would also pass here — and would pass identically on a 2.x binary with the wrong image tag applied by accident. Query `prometheus_build_info` for the version, not `up` for a heartbeat.

```bash
# 2) the experimental function, which fails a specific way without the flag
curl -s --data-urlencode 'query=max_of(3, 7)' http://localhost:9090/api/v1/query \
  | jq -r '.data.result[0].value[1]'
```

Expected: `7`. Without `--enable-feature=promql-experimental-functions` this returns an API error body (`"unknown function with name \"max_of\""`) rather than a wrong number — so a truncated or swallowed error here reads as "the query failed" when the actual cause is a missing startup flag.

### Clean up

```bash
kill %1   # stop the port-forward job
kind delete cluster --name prom-demo
```

## Traps

**`localhost:9090` in the scrape config is the container's own loopback, not the Kubernetes Service.** It works here because Prometheus is scraping itself inside the same pod. Swap it for `prometheus:9090` (the Service DNS name) expecting the same result and it's now scraping over the cluster network instead of loopback — same number in this single-target lab, but the two configs behave differently the moment there's a `NetworkPolicy` or a second replica involved. Worth knowing before copying this into anything with more than one target.

**The ConfigMap does not hot-reload into a running pod.** Editing `prometheus.yml` and re-applying the ConfigMap changes nothing until the pod restarts, or until something calls the reload endpoint — which itself needs `--web.enable-lifecycle` added to the same args list, not on by default. A stale config after `kubectl apply` looks like the edit didn't take; it took, the process just hasn't read it yet.

**The experimental-functions flag is all-or-nothing.** `--enable-feature=promql-experimental-functions` turns on every experimental PromQL function at once, not just `min_of`/`max_of` — there is no per-function toggle. Anyone else's dashboard on the same server that happens to call a different experimental function (intentionally or via a copy-pasted query) starts working too, which is a config change with a wider blast radius than the one line implies.

## If we applied this here

- [[pod-crashloopbackoff]]'s open follow-up — alert on `kube_pod_container_status_last_terminated_reason` for OOMKilled — needs **kube-state-metrics** exposed as a scrape target, not just Prometheus itself. This lab proves the scrape/query loop works; it does not stand up kube-state-metrics, which is the actual next step and its own lab.
- [[schedulable-node-budget]]'s Longhorn check (`kubectl get volumes.longhorn.io -o custom-columns=...ROBUSTNESS`) is a command a human has to remember to run. Longhorn ships a `longhorn_volume_robustness` metric (`2` = degraded, `3` = faulted) for exactly this — turning that runbook step into `longhorn_volume_robustness >= 2` as an alert rule would catch the "silent, nothing alerts" failure mode that runbook calls out by name, instead of relying on someone running the pre-check before every install. Unconfirmed here: whether Longhorn's metrics endpoint is enabled by default in the install this repository already ran, or needs a values change in [[longhorn-storage-onprem]].
- Nothing in [[onprem-3node-kubeadm-ubuntu]] or any install doc here currently reserves resources or a schedulable-node budget entry for a monitoring stack — per [[schedulable-node-budget]]'s standing decision (2 schedulable nodes), Prometheus plus kube-state-metrics is one more thing competing for that budget and needs sizing before it's real, not just labbed.

## Follow-ups

- [ ] Run the lab above end to end on kind and confirm both `curl` checks actually return what's claimed here 📅 2026-08-14
- [ ] Check whether Longhorn's Prometheus metrics endpoint is enabled by default in [[longhorn-storage-onprem]]'s install, or needs a values change
- [ ] Once confirmed, size kube-state-metrics + Prometheus against the schedulable-node budget in [[schedulable-node-budget]] before installing either for real

## Related

[[schedulable-node-budget]] — manual checks this could turn into alert rules, and the node budget any monitoring stack has to be sized against.
[[pod-crashloopbackoff]] — the open OOMKilled-alert follow-up this is a prerequisite for.
[[2026-08-10-argo-rollouts-canary]] — same sandbox limitation, same "run it and check the box" pattern for the unexecuted lab.
[[topics]] — why this topic was selected.
