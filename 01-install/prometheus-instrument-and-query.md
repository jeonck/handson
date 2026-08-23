---
title: Prometheus — instrumenting a service, and three queries that lie if you read them wrong
date: 2026-08-23
domain: install
tags: [observability, metrics, python, monitoring]
stack: [prometheus, promql, python, fastapi, prometheus-client]
summary: A FastAPI service instrumented with a counter, a histogram and a gauge, scraped by a real Prometheus, then queried. The p95 came back at 216ms for a service that never took longer than 120ms — histogram quantiles are interpolated between bucket edges, and coarse buckets invent latency that never happened.
source: handson
env: Prometheus 3.14.0 · promtool 3.14.0 · prometheus-client 0.26.0 · FastAPI 0.141.1 · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-23
verifiability: lab
duration: 30–45 min
risk: low
---

> **Verified 2026-08-23.** Every number below came from a real scrape of a real service. The p95 in
> [Where this bit us](#where-this-bit-us) is what Prometheus actually returned, and it is wrong in a
> way worth understanding.

A dashboard is downstream of two decisions most teams make once and never revisit: **which metric
types you emit**, and **which query you put on the panel**. Both are easy to get subtly wrong in a
way that still renders a plausible-looking graph. This builds the smallest real setup — one
instrumented service, one Prometheus — and then interrogates it.

## Install

```bash
brew install prometheus
prometheus --version
```

```
prometheus, version 3.14.0
promtool, version 3.14.0
```

`promtool` ships alongside and is the reason a bad config never has to reach a running server.

## Instrumenting the service

```bash
pip install fastapi "uvicorn[standard]" prometheus-client
```

```python title="app.py"
import random
import time

from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

app = FastAPI()

# Counter: only ever goes up. Ask it for a rate, never for a value.
REQUESTS = Counter(
    "orders_requests_total", "Requests handled", ["endpoint", "status"]
)
# Histogram: buckets, so quantiles can be computed server-side.
LATENCY = Histogram(
    "orders_request_seconds", "Request duration", ["endpoint"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
)
# Gauge: a value that goes both ways.
INFLIGHT = Gauge("orders_inflight", "Requests currently being served")


@app.get("/orders")
def orders():
    with INFLIGHT.track_inprogress():
        start = time.perf_counter()
        time.sleep(random.uniform(0.005, 0.12))
        status = "500" if random.random() < 0.15 else "200"
        LATENCY.labels("/orders").observe(time.perf_counter() - start)
        REQUESTS.labels("/orders", status).inc()
        return Response('{"ok":true}', status_code=int(status), media_type="application/json")


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
```

**The three metric types are three different questions**, and the names encode the contract:

| Type | Suffix | Answers | Never ask it for |
|---|---|---|---|
| `Counter` | `_total` | "how fast is this happening" | its current value |
| `Histogram` | `_seconds` | "how long, at which percentile" | an exact quantile — see below |
| `Gauge` | none | "how many right now" | history it never kept |

The endpoint is plain text, and reading it once is the fastest way to understand what a histogram
actually is:

```bash
curl -sS localhost:8900/metrics | grep '^orders_'
```

```
orders_requests_total{endpoint="/orders",status="200"} 108.0
orders_request_seconds_bucket{endpoint="/orders",le="0.005"} 0.0
orders_request_seconds_bucket{endpoint="/orders",le="0.01"} 3.0
orders_request_seconds_bucket{endpoint="/orders",le="0.025"} 18.0
orders_request_seconds_bucket{endpoint="/orders",le="0.05"} 47.0
orders_request_seconds_bucket{endpoint="/orders",le="0.1"} 94.0
orders_request_seconds_bucket{endpoint="/orders",le="0.25"} 121.0
orders_request_seconds_count{endpoint="/orders"} 121.0
orders_request_seconds_sum{endpoint="/orders"} 7.940148165798746
```

A histogram is **not** a list of durations. It is a set of cumulative counters — "94 requests took
≤ 0.1s" — plus a sum and a count. Every individual timing is gone. That is the whole reason the
quantile problem below exists.

## Scraping it

```yaml title="prometheus.yml"
global:
  scrape_interval: 5s
  evaluation_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]

  - job_name: orders
    static_configs:
      - targets: ["localhost:8900"]
        labels:
          env: lab
```

```bash
promtool check config prometheus.yml
```

```
SUCCESS: prometheus.yml is valid prometheus config file syntax
```

**Both sides of that check were run.** Changing `scrape_interval: 5s` to `5` gives:

```
FAILED: parsing YAML file bad.yml: not a valid duration string: "5"
```

A config check that has only ever passed is not a check. This one catches the class of typo that
otherwise starts a server which silently scrapes nothing.

```bash
prometheus --config.file=prometheus.yml --storage.tsdb.path=./data \
  --web.listen-address=127.0.0.1:9090
```

**Confirm the targets, do not assume them** — a running Prometheus with zero healthy targets looks
identical to a working one until a query returns empty:

```bash
curl -sS "http://localhost:9090/api/v1/targets?state=active"
```

```
orders       up       http://localhost:8900/metrics
prometheus   up       http://localhost:9090/metrics
```

## Three queries

After driving 120 requests through the service:

```promql
orders_requests_total
```

```
108  {endpoint="/orders", env="lab", job="orders", status="200"}
 13  {endpoint="/orders", env="lab", job="orders", status="500"}
```

**That is almost always the wrong question.** It is "how many since this process started", which
answers nothing operational and resets on deploy. What you want is a rate:

```promql
sum(rate(orders_requests_total{status="500"}[1m]))
  /
sum(rate(orders_requests_total[1m]))
```

```
0.08090370476646465
```

An 8% error ratio — computed from two rates, so a restart in the middle does not corrupt it, and the
`env`/`instance` labels are aggregated away by `sum` rather than producing one series per pod.

```promql
histogram_quantile(0.95, sum by (le) (rate(orders_request_seconds_bucket[1m])))
```

```
0.21639067530569803
```

**216ms at p95 — from a service whose slowest possible response is 120ms.** That number is not a
bug in Prometheus and it is not noise; see below.

## Verification checklist

- [x] `/metrics` exposes counter, histogram bucket/sum/count, and gauge series
- [x] `promtool check config` passes — and **fails on a malformed duration**, confirmed by breaking it
- [x] Both scrape targets report `up` in the targets API
- [x] `rate()` over the error counter yields a plausible ratio (~8% against a 15% injected rate)
- [x] `histogram_quantile` returns **216ms** for a service capped at 120ms — measured, not assumed
- [x] Restarting the service drops `orders_requests_total` from 77 to 20
- [x] `increase()` across that restart reports more than the post-restart raw value

## Rollback

```bash
pkill -f "uvicorn app:app"
pkill -f "prometheus --config"
rm -rf data .venv
```

## Where this bit us

**`histogram_quantile` reported a p95 higher than any request that ever happened.** The service
sleeps `uniform(0.005, 0.12)`, so nothing can exceed ~120ms. Prometheus returned **216ms**. The
bucket counts explain it exactly:

```
le="0.1"   94        ← 94 of 121 requests were at or under 100ms
le="0.25"  121       ← all 121 were under 250ms
```

The 95th percentile falls at request ~115, which lands in the `(0.1, 0.25]` bucket. **Prometheus has
no idea where inside that bucket the value sits** — the individual timings were discarded at
collection — so it interpolates linearly across the bucket and lands on 216ms. The true answer is
somewhere just above 100ms.

**A histogram quantile is only as precise as the bucket boundaries you chose before you had the
data.** The fix is boundaries that bracket the real distribution — here, something like
`0.05, 0.075, 0.1, 0.125, 0.15` — and the general rule is that a quantile falling in your widest
bucket is a quantile you should not quote. Compare against `sum / count`, which is exact:

```promql
orders_request_seconds_sum / orders_request_seconds_count
```

```
0.06562105922147723
```

A 66ms mean and a "216ms p95" from the same 121 requests is the smell. The mean is arithmetic on
real numbers; the p95 is a guess between two fenceposts.

**A counter forgets everything when the process restarts, and `rate` is what hides that.** Restarting
the service mid-scrape:

```
before restart: 77
after restart:  20
```

```promql
sum(orders_requests_total)                 → 25
sum(increase(orders_requests_total[3m]))   → 37.98
```

The raw sum reports 25 — the new process's counters, as if the earlier traffic never happened. A
"total requests today" panel built on a raw counter silently zeroes on every deploy. `increase()`
detects the reset and accounts for the pre-restart traffic, which is why it reports more.

**Note the `37.98`.** `increase()` returns a non-integer because it *extrapolates* over the window
from the samples it has — it is an estimate of how much a counter grew, not a count of events. Do
not put it in a panel labelled "orders processed" and expect it to reconcile with the database.

**Killing a process by port can kill the wrong process.** While scripting the restart above,
`kill -9 $(lsof -ti :8900)` repeatedly took Prometheus down with the app. Prometheus holds a client
connection to the scraped port, so `lsof -ti :8900` lists **both** the server and its scraper. The
symptom was confusing — the app restarted fine and every subsequent query failed with connection
refused against 9090. `pkill -f "uvicorn app:app"` targets the process rather than the port.

## Follow-ups

- [ ] Re-bucket the histogram to bracket the real distribution and confirm p95 lands near 110ms rather than 216ms — the direct fix for the finding above
- [ ] Add alerting rules and `promtool test rules`, so an alert's firing condition has a unit test
- [ ] Point Grafana at this Prometheus and see which of the three queries a default panel reaches for
- [ ] Record trace exemplars on the histogram so a p95 spike links straight to a slow trace in [[opentelemetry-tracing-two-services]]
- [ ] Add a label with unbounded values (a user ID) and watch series count explode — cardinality is the failure this lab is too small to hit
- [ ] Scrape the FastAPI app from [[fastapi-mvc-layering]] instead of this synthetic one, so the metrics describe an app with real endpoints
- [ ] Repeat against the on-prem cluster in [[onprem-3node-kubeadm-ubuntu]] with a ServiceMonitor, where target discovery replaces `static_configs`

## Related

[[fastapi-mvc-layering]] — the app that would be instrumented for real, rather than a synthetic endpoint.
[[langgraph-control-flow]] — a validation node is the same instinct as a metric: notice the failure before a human does.
[[dbt-duckdb-local]] — the same lesson from the data side, that a green signal can describe something that did not happen.
[[opentelemetry-tracing-two-services]] — the tracing half: what a p95 cannot tell you, namely which request was slow and where its time went.
[[loki-logs-labels-and-cardinality]] — the logs half, and why a trace ID belongs in the line rather than in a label.
