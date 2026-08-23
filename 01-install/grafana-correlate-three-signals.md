---
title: Grafana — wiring metrics, logs and traces together so one ID walks between them
date: 2026-08-23
domain: install
tags: [observability, grafana, correlation, monitoring]
stack: [grafana, prometheus, loki, tempo, opentelemetry, podman]
summary: Three datasources provisioned as files, with the links between them declared in the same config — a Loki derived field turning trace_id in a log line into a Tempo button, and a histogram exemplar carrying a trace ID from a p95 spike to the 355ms trace that produced it. Both hops were walked with real IDs through Grafana's own proxy.
source: handson
env: Grafana 13.2.0 · Prometheus 3.14.0 · Loki 3.7.6 · Tempo (grafana/tempo:latest under Podman 5.7.1) · prometheus-client 0.26.0 · macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Datasource provisioning, health, cross-datasource link configuration and both correlation hops — logs to traces and metrics to traces — were verified against running backends with real IDs resolved on both sides. The derived-field link was confirmed rendering in the Grafana UI; the exemplar hop was verified through Grafana's proxy API rather than by clicking a chart marker. No dashboards, alerting or long-term storage.
duration: 45–60 min
risk: low
---

> **Verified 2026-08-23.** Two real IDs were walked end to end: one fetched from Tempo and found in
> a Loki log line, and one carried out of a Prometheus histogram bucket by an exemplar and resolved
> back to a 355ms trace — both through Grafana's datasource proxy. The screenshot below is the link
> Grafana rendered from the first.

[[prometheus-instrument-and-query]], [[opentelemetry-tracing-two-services]] and
[[loki-logs-labels-and-cardinality]] each end at the same place: the signal is useful, and getting
from it to the next one is manual. **Correlation is not a property of any one backend — it is
configuration in the thing that queries all three.**

## The pieces

```bash
brew install grafana          # 13.2.0
podman run -d --name tempo -p 3200:3200 -p 4318:4318 \
  -v "$PWD/tempo.yml:/etc/tempo.yml:Z" -v "$PWD/tempo-data:/var/tempo:Z" \
  docker.io/grafana/tempo:latest -config.file=/etc/tempo.yml
```

Tempo is not in Homebrew, and a container is the shortest path. It needs an OTLP receiver, which is
the endpoint the instrumented services already speak:

```yaml title="tempo.yml"
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    local:
      path: /var/tempo/blocks
    wal:
      path: /var/tempo/wal
```

The tracing setup from [[opentelemetry-tracing-two-services]] changes by one exporter — console out,
OTLP in:

```python title="otel_setup.py"
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="http://127.0.0.1:4318/v1/traces")))


def current_trace_id() -> str:
    """The id a log line must carry for Grafana's derived field to find it."""
    return format(trace.get_current_span().get_span_context().trace_id, "032x")
```

## The correlation is one provisioning file

Datasources as files rather than clicks, because **the links between them are the part worth
reviewing in a diff**:

```yaml title="provisioning/datasources/all.yml"
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    uid: prom
    url: http://127.0.0.1:9090
    jsonData:
      # Metrics -> traces: a histogram exemplar carries a trace_id.
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo

  - name: Loki
    type: loki
    uid: loki
    url: http://127.0.0.1:3100
    jsonData:
      # Logs -> traces: pull trace_id out of the LINE (not a label) and
      # turn it into a link. This is why trace_id must not be a Loki label.
      derivedFields:
        - name: TraceID
          matcherType: regex
          matcherRegex: 'trace_id=(\w+)'
          url: '${__value.raw}'
          datasourceUid: tempo

  - name: Tempo
    type: tempo
    uid: tempo
    url: http://127.0.0.1:3200
    jsonData:
      # Traces -> logs: jump from a span back to that service's log lines.
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: '-2m'
        spanEndTimeShift: '2m'
        filterByTraceID: true
        tags:
          - key: service.name
            value: service
      # Traces -> metrics: from a span to the RED metrics for that service.
      tracesToMetrics:
        datasourceUid: prom
        tags:
          - key: service.name
            value: job
```

**`uid` is what makes this work.** Every cross-link references another datasource by `uid`, so the
uids must be stable and hand-written — the generated ones change per install and break every link.

The `tags` blocks are translations, not decoration: a span's `service.name` becomes Loki's `service`
label and Prometheus' `job` label. **Correlation across backends is mostly a naming problem**, and
this is where you pay for having named the same concept three ways.

```bash
grafana server --homepath /opt/homebrew/opt/grafana/share/grafana \
  cfg:default.paths.provisioning=$PWD/provisioning \
  cfg:default.paths.data=$PWD/gf-data
```

```bash
curl -u admin:admin http://127.0.0.1:3000/api/datasources
```

```
  Loki        uid=loki   loki
  Prometheus  uid=prom   prometheus
  Tempo       uid=tempo  tempo
```

## Making one ID exist in two backends

The whole scheme depends on the *same* identifier appearing in a trace and in a log line. That is an
application responsibility, and it is three lines:

```python title="emit.py"
with tracer.start_as_current_span("checkout") as span:
    tid = current_trace_id()
    httpx.get("http://127.0.0.1:8910/order/SKU-SLOW", timeout=10)

# The log line carries the trace id as TEXT, not as a Loki label.
values = [[str(now), f"checkout slow sku=SKU-SLOW trace_id={tid} duration_ms=420"]]
```

```
trace_id: 20febf991bda116ebbe0965833a67baa
loki push: 204
```

Then ask **Grafana** — not the backends directly — whether both know that ID:

```bash
curl -u admin:admin \
  "http://127.0.0.1:3000/api/datasources/proxy/uid/tempo/api/traces/$TID"
```

```
services=['inventory', 'loadgen', 'orders']  spans=11
```

```bash
curl -u admin:admin --get \
  "http://127.0.0.1:3000/api/datasources/proxy/uid/loki/loki/api/v1/query_range" \
  --data-urlencode "query={env=\"lab\"} |= \"$TID\""
```

```
  [loadgen] checkout slow sku=SKU-SLOW trace_id=20febf991bda116ebbe0965833a67baa duration_ms=420
```

**Pass condition: the same 32-character ID resolves in both, through Grafana's proxy.** Querying the
backends directly would prove they hold the data; going through the proxy proves Grafana can reach
them with the credentials and URLs it was provisioned with, which is the part that actually breaks.

## The link, rendered

<img src="/01-install/img/grafana-loki-derived-traceid.png" width="620" alt="Grafana Explore showing a Loki log line with trace_id highlighted, and a Links section containing a TraceID field with a Tempo button">

The highlighted `trace_id=…` in the log text is the derived field matching, and **Links → TraceID →
`Tempo`** is the button it generates. One click goes from this log line to the 11-span trace above.

Two details in that screenshot are worth reading:

- The **Fields** list shows `TraceID` at 100% for this query — the derived field is computed at query
  time from the line, and exists for every line that matches the regex.
- Under **Indexed labels** there is `env`, and no `trace_id`. That is the arrangement
  [[loki-logs-labels-and-cardinality]] measured: the ID lives in the text, the index stays small, and
  the link works anyway.

## Metrics → traces: the exemplar hop

`exemplarTraceIdDestinations` closes the triangle — a p95 spike on a Prometheus histogram offers a
jump to the trace that produced one of those samples. Unlike the other two links, **this one is not
purely configuration**: the application has to attach the trace ID to the observation.

```python title="app.py"
from prometheus_client import REGISTRY, Counter, Histogram
from prometheus_client.openmetrics.exposition import (
    CONTENT_TYPE_LATEST as OPENMETRICS_CONTENT_TYPE,
    generate_latest as generate_openmetrics,
)

with tracer.start_as_current_span("handle_order") as span:
    ...
    tid = format(span.get_span_context().trace_id, "032x")
    # The exemplar rides along with the bucket increment, not as a separate metric.
    LATENCY.labels("/orders").observe(dur, exemplar={"trace_id": tid})


@app.get("/metrics")
def metrics():
    # Exemplars exist ONLY in the OpenMetrics exposition. generate_latest() from
    # the top-level package emits the legacy format and drops them silently.
    return Response(generate_openmetrics(REGISTRY), media_type=OPENMETRICS_CONTENT_TYPE)
```

An exemplar is the `#`-suffixed tail on a bucket line, and reading one raw makes the mechanism
obvious:

```
orders_request_seconds_bucket{endpoint="/orders",le="0.05"} 1.0 # {trace_id="7b79f881…"} 0.0186919 1787504714.36
```

Bucket count, then trace ID, then **the actual observed value** (18.7ms) and a timestamp. The raw
duration that the histogram threw away is preserved in the exemplar — for one sample per bucket per
scrape.

Prometheus needs a flag to keep them, and the scrape config needs the OpenMetrics-aware path:

```bash
prometheus --config.file=prometheus.yml --storage.tsdb.path=./data \
  --web.listen-address=127.0.0.1:9090 \
  --enable-feature=exemplar-storage
```

Then ask **Grafana** for the exemplars behind the p95 query:

```bash
curl -u admin:admin --get \
  "http://127.0.0.1:3000/api/datasources/proxy/uid/prom/api/v1/query_exemplars" \
  --data-urlencode 'query=orders_request_seconds_bucket' \
  --data-urlencode "start=$START" --data-urlencode "end=$END"
```

```
exemplars: 8   slower than 250ms: 3
slowest: trace_id=e41e4639d1b5a4ebf04502083725ab57  value=0.355s
```

And resolve the slowest one in Tempo — again through the proxy, so the link Grafana would follow is
the link being tested:

```
trace e41e4639d1b5a4ebf04502083725ab57
  orders  handle_order  355.2ms  {'slow_path': True}
```

**Pass condition: the exemplar's value and the span's duration are the same request.** `0.355s` from
the metric, `355.2ms` from the trace, one 32-character ID linking them. That is the hop the other two
labs could not make — a percentile pointing at the individual request underneath it.

## Verification checklist

- [x] All three datasources appear with the hand-written uids `prom`, `loki`, `tempo`
- [x] Loki and Tempo report `OK` from Grafana's datasource health API
- [x] Prometheus answers a PromQL query **through Grafana's proxy**, despite what its health check says
- [x] A single request produces a trace ID retrievable from Tempo via Grafana — 11 spans, 3 services
- [x] The same ID is found in a Loki log line via Grafana
- [x] The stored `matcherRegex` extracts that exact ID when tested against the real log line
- [x] Grafana renders a `TraceID` field with a `Tempo` link on the expanded log row
- [x] A histogram exemplar carries a trace ID out of Prometheus via Grafana's proxy — 8 exemplars, 3 over 250ms
- [x] The slowest exemplar's `0.355s` resolves in Tempo to a `handle_order` span of `355.2ms` — same request, both signals
- [x] Prometheus stores **0** exemplars without `--enable-feature=exemplar-storage` and **8** with it — checked both ways

## Rollback

```bash
pkill -f "grafana server"; pkill -f "loki -config.file"; pkill -f "prometheus --config"
pkill -f "uvicorn"; podman rm -f tempo
rm -rf gf-data tempo-data data
```

## Where this bit us

**Grafana's datasource health check reported a failure for a datasource that works.**

```
prom  -> None | Plugin not registered
loki  -> OK   | Data source successfully connected.
tempo -> OK   | Data source is working
```

Prometheus queries fine — through Grafana's own proxy, `sum(rate(orders_requests_total[1m]))`
returned `1.0998733333333333`. The `/health` endpoint for this core datasource reports
`Plugin not registered` on 13.2.0 regardless. **Check a datasource by asking it a question, not by
asking Grafana whether it is happy** — the health endpoint is a convenience, and here it is a false
negative that would send someone rewriting a working config.

**`trace_id` appeared in the Fields list twice, meaning two different things.** Earlier queries in
this stack showed `trace_id` at 87% *and* `TraceID` at 14%. The first is the Loki **label** from the
cardinality experiment in [[loki-logs-labels-and-cardinality]]; the second is the **derived field**
parsed from the line. They look interchangeable in the UI and are not: one costs a stream per
request forever, the other costs nothing and is computed at query time. Seeing both side by side is
the clearest argument for the second.

**`generate_latest()` drops every exemplar and reports nothing wrong.** The first exemplar run
produced a clean `/metrics` endpoint, a healthy scrape and zero exemplars anywhere. The cause is one
import: exemplars are part of the **OpenMetrics** exposition, and `prometheus_client.generate_latest`
emits the legacy text format, which has no syntax for them. It does not warn, does not error, and
the bucket lines look perfectly normal — they are simply missing their `#` tail. `grep '#' ` on the
raw `/metrics` output is the check, and it is the only one that fails.

**Prometheus discards exemplars unless you ask it to keep them.** With the app emitting correctly,
`/api/v1/query_exemplars` still returned an empty list. Measured both ways against the same traffic:

```
without --enable-feature=exemplar-storage: 0
with    --enable-feature=exemplar-storage: 8
```

Exemplar storage is still behind a feature flag, and its absence is indistinguishable from an
application that never emitted any. **Two silent layers stacked on each other** — a wrong exposition
format and a missing flag — each producing the same empty result, which is why the checklist above
records the with/without numbers rather than just the working one.

**A correlation is only as good as the ID the application remembers to log.** Nothing in Grafana,
Loki or Tempo can create the link — the trace ID has to be pulled out of the active span and written
into the log line by the code. `current_trace_id()` is three lines and is the single point where the
whole scheme fails silently: no error, no warning, just a `TraceID` field that never appears.

## Follow-ups

- [x] Emit Prometheus exemplars and close the metrics → traces hop — done above, with both silent failure modes recorded
- [ ] Click the exemplar marker in a Grafana chart and confirm the Tempo link renders, the way the derived field was confirmed — the API proved the data, not the button
- [ ] Add a provisioned dashboard so the setup survives a fresh install as files rather than clicks
- [ ] Test the Tempo → Logs direction from a span, which is configured via `tracesToLogsV2` but only exercised in the logs → traces direction here
- [ ] Replace `service.name`/`service`/`job` with one consistent name across all three signals and see how much of the `tags` translation disappears
- [ ] Put the whole thing in a compose file so the four processes start together rather than by hand

## Related

[[prometheus-instrument-and-query]] — metrics, and the histogram whose exemplars complete the third hop here.
[[opentelemetry-tracing-two-services]] — traces, exported here to Tempo instead of the console.
[[loki-logs-labels-and-cardinality]] — logs, and why the trace ID belongs in the line, which is what makes the derived field work.
