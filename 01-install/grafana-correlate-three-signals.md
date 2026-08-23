---
title: Grafana — wiring metrics, logs and traces together so one ID walks between them
date: 2026-08-23
domain: install
tags: [observability, grafana, correlation, monitoring]
stack: [grafana, prometheus, loki, tempo, opentelemetry, podman, docker-compose]
summary: Three datasources and a dashboard provisioned as files, with the links between them declared in the same config. All three hops were clicked — a log line to its trace, an exemplar to the 443ms request under a p95, a span back to its service's logs — and every panel was checked by replaying its stored query, which caught a ratio panel that reads "No data" whenever nothing is wrong.
source: handson
env: Grafana 13.2.0 · Prometheus 3.14.0 · Loki 3.7.6 (Homebrew) / 3.5.7 (image) · Tempo 2.9.1 · Podman 5.7.1 with docker-compose 5.3.1 · prometheus-client 0.26.0 · macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Datasource provisioning, health, cross-datasource link configuration and both correlation hops — logs to traces and metrics to traces — were verified against running backends with real IDs resolved on both sides. All three links were clicked in the Grafana UI, the traces-to-logs selector was checked against two spans of one trace rather than one, and the provisioned dashboard was verified by replaying every panel's stored query. Alerting, long-term storage and multi-tenancy are unexercised.
duration: 45–60 min
risk: low
---

> **Verified 2026-08-23.** Two real IDs were walked end to end: one fetched from Tempo and found in
> a Loki log line, and one carried out of a Prometheus histogram bucket by an exemplar and resolved
> back to its trace — both through Grafana's datasource proxy. All three links were then clicked in
> the UI, and every screenshot below is what Grafana rendered.

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

## Traces → logs: from a span to that service's lines

The reverse of the derived field, and the one configured by `tracesToLogsV2`. Expanding any span in
the trace view puts a link in its detail panel. **It reads `Logs for this trace`, not "for this
span"** — the label follows `filterByTraceID: true` with no `filterBySpanID`, so it scopes to the
whole trace.

That label is misleading about the half that matters. Reading the link's target on two different
spans of the same trace:

```
db.lookup   (inventory span)  ->  {service="inventory"} | …
validate    (orders span)     ->  {service="orders"}    | …
```

**The stream selector is per-span even though the label says "trace".** That is the `tags` block
doing its job — the clicked span's `service.name` resource attribute becomes the `service` label in
the selector. Click a span in `inventory` and you get inventory's lines; the same trace's `orders`
lines are excluded. Checking both spans is what makes this a real check: a broken mapping would
produce one constant selector, and against a single-service trace it would look identical.

The full query Grafana generates is worth reading once:

```logql
{service="inventory"}
  | label_format log_line_contains_trace_id=`{{ contains "48f83bf418…" __line__ }}`
  | log_line_contains_trace_id="true" or trace_id="48f83bf418…"
```

**It covers both places a trace ID can live.** The `label_format` + `contains __line__` half greps
the unindexed line — the arrangement [[loki-logs-labels-and-cardinality]] argues for — and the
`or trace_id="…"` half matches a label, for people who indexed it anyway. Grafana does not know
which you chose, so it asks for both.

Following the link:

<img src="/01-install/img/grafana-trace-to-logs.png" width="620" alt="Grafana Explore split view with a Tempo trace on the left and, on the right, a Loki result reading 1 line displayed with common labels service=inventory and the matching stock lookup log line">

```
1 line displayed          Total bytes processed: 708 B
Common labels: env=lab  log_line_contains_trace_id=true  service=inventory

2026-08-23 12:47:42.02  stock lookup sku=SKU-SLOW cache_hit=False trace_id=48f83bf418b9eefa945dd5891d54a5d3
```

One line, from the one service whose span was clicked, for the one request. The time window comes
from `spanStartTimeShift: '-2m'` / `spanEndTimeShift: '2m'` — the link's range was
`12:45:41 → 12:49:41` around a span that started at `12:47:41`, which is what those two settings are
for: log lines are written slightly before and after the span they describe.

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

### The marker, clicked

The API proves the data exists; the diamond on the chart is what an on-call engineer actually uses.
With `Exemplars: true` on the query, hovering one gives:

<img src="/01-install/img/grafana-exemplar-marker-tooltip.png" width="620" alt="Grafana Explore showing a p95 line with diamond exemplar markers, and a hover tooltip listing Value 0.443, le 0.5, trace_id 51644ed23cf67230ff9640a6fe6d88e2, and a Query with Tempo link">

The tooltip is the exemplar's contents laid out: the observed `Value` of **0.443**, the bucket it
landed in (`le: 0.5`), the scrape target it came from, and the `trace_id`. **`Query with Tempo` is
the link `exemplarTraceIdDestinations` generates** — the `name: trace_id` in that config is what
tells Grafana which label holds the ID.

Clicking it splits the pane and resolves the trace:

<img src="/01-install/img/grafana-exemplar-to-tempo-trace.png" width="620" alt="Grafana Explore split view with the Prometheus query on the left and a Tempo trace on the right, showing orders: handle_order, trace ID 51644ed23cf67230ff9640a6fe6d88e2 and Duration 443.45ms">

```
orders: handle_order
Trace ID  51644ed23cf67230ff9640a6fe6d88e2
Duration  443.45ms          Services 1
```

**`0.443` on the metric, `443.45ms` on the trace.** The histogram bucket that number fell into was
`le="0.5"` — a bucket 250ms wide, which is all the metric could ever have told you. The exemplar
carried the exact duration and the identity of the request out of that bucket, and two clicks later
the span is on screen. **This is the one thing a histogram cannot do on its own**, and the reason
[[prometheus-instrument-and-query]]'s interpolated p95 was a dead end for finding a specific request.

## One screen, provisioned as files

Three links are three clicks from three different starting points. A dashboard is the version you
leave running, and it is two more files — a provider and the dashboard itself:

```yaml title="provisioning/dashboards/all.yml"
apiVersion: 1

providers:
  - name: handson
    type: file
    # Provisioned dashboards are read-only in the UI unless this is true.
    allowUiUpdates: false
    options:
      path: /abs/path/to/provisioning/dashboards/json
      foldersFromFilesStructure: false
```

**`path` must be absolute**, and the dashboard JSON needs two things a UI export will not give you:

```json title="dashboards/json/three-signals.json"
{
  "uid": "three-signals",
  "title": "Three signals — orders",
  "editable": false,
  "panels": [
    {
      "title": "p95 latency — click a diamond to open its trace",
      "datasource": { "type": "prometheus", "uid": "prom" },
      "targets": [{
        "expr": "histogram_quantile(0.95, sum by (le) (rate(orders_request_seconds_bucket[1m])))",
        "exemplar": true
      }]
    }
  ]
}
```

- A **stable `uid`**, so the file always updates the same dashboard instead of creating a new one on
  every restart.
- Datasources referenced by the **same hand-written uids** as the datasource file. A dashboard
  exported from the UI instead contains `"datasource": "${DS_PROMETHEUS}"` plus an `__inputs` block,
  which is the import format — provisioning does not fill those in, and the panels come up empty.

`"exemplar": true` on the target is what carries the metrics → traces link onto a panel; without it
the query works and the diamonds simply are not there.

<img src="/01-install/img/grafana-three-signals-dashboard.png" width="620" alt="A Grafana dashboard with three rows: metrics showing error ratio 8.04 percent, in-flight count and requests per second by status, a p95 latency panel with exemplar diamonds, a logs row with Loki lines and a log-derived error rate, and a traces row listing the slowest traces with clickable trace IDs">

Three rows, one time range, one refresh. The value of the arrangement is that the panels disagree
usefully: the error ratio comes from a counter and the error rate beside the logs comes from
`rate({level="error"}[1m])` over log text, so the two are computed from independent pipelines and a
gap between them means one of them is lying.

### Checking a dashboard the way it will be read

A dashboard renders happily with panels that return nothing, so "it loaded" is not a check. The one
that can fail is to pull the dashboard **back out of the API** and run each panel's stored query
against its own datasource:

```python title="check_panels.py"
dash = get("/api/dashboards/uid/three-signals")["dashboard"]
for p in dash["panels"]:
    if p["type"] == "row":
        continue
    for t in p["targets"]:
        ...  # query t["expr"] against t["datasource"]["type"], count the results
```

```
 id  panel                                         source         n  sample
  1  Error ratio                                   prometheus     1  0.094017094017094
  2  In flight                                     prometheus     1  2
  3  Requests/sec by status                        prometheus     2  1.9272727272727272
  4  p95 latency — click a diamond to open its tr  prometheus     1  0.46210937499999993
  5  Logs — trace_id in the line becomes a Tempo   loki          50  order failed sku=SKU-4 trace_id=2b51052670461aab
  6  Error lines/sec (from logs)                   loki          26  0.016666666666666666
  7  Slowest traces (>250ms)                       tempo         20  orders 373ms

panels with no data: 0 of 7
```

It reads the dashboard as Grafana stored it, not as it was written, so a panel that failed to
provision shows up as a missing row rather than a passing test. **The first run of this reported `1 of
7` empty**, which is the finding below.

## Six processes become one file

Everything above was started by hand in six terminals. The compose version is the same configuration
with one substitution applied everywhere — **`127.0.0.1` becomes a service name** — plus a load
generator so `up` produces a populated dashboard instead of an empty one:

```yaml title="compose.yml"
name: three-signals

services:
  orders:
    build:
      context: ./app
      # docker-compose only auto-detects 'Dockerfile'. Name it or it is not found.
      dockerfile: Containerfile
    command: uvicorn orders:app --host 0.0.0.0 --port 8000
    environment:
      OTLP_ENDPOINT: http://tempo:4318
      LOKI_URL: http://loki:3100
      INVENTORY_URL: http://inventory:8000
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request as u; u.urlopen('http://localhost:8000/docs')\""]
      interval: 5s
      timeout: 3s
      retries: 20
    depends_on:
      tempo: {condition: service_healthy}
      loki: {condition: service_healthy}

  prometheus:
    image: docker.io/prom/prometheus:v3.14.0
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --enable-feature=exemplar-storage
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro,Z
      - prom-data:/prometheus
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/ready"]
      interval: 5s
      timeout: 3s
      retries: 20
```

Addresses come from the environment with localhost defaults, so **the same source runs both ways**:

```python title="app/common.py"
LOKI = os.getenv("LOKI_URL", "http://127.0.0.1:3100") + "/loki/api/v1/push"
OTLP = os.getenv("OTLP_ENDPOINT", "http://127.0.0.1:4318") + "/v1/traces"
INVENTORY = os.getenv("INVENTORY_URL", "http://127.0.0.1:8911")
```

Four addresses move in the app and three in the datasource file. **The dashboard JSON needs no edit
at all** — it references datasources by the uids `prom`/`loki`/`tempo`, and those did not change.
That is the payoff for hand-writing the uids rather than accepting generated ones.

```bash
podman compose up -d
```

```
orders up http://orders:8000/metrics        # the scrape target, by service name
panels with no data: 0 of 7
```

Same replay of every stored panel query as before, now against containers: seven panels, all with
data, from nothing but the files. The correlation chain survives the move — an exemplar of `3.15s`
resolved in Tempo to a two-service trace, and the same ID was found in **both** services' Loki
streams — so the links depend on the uids and the labels, not on anything host-specific.

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
- [x] `podman compose up -d` brings all seven containers up and **0 of 7** panels are empty, from files alone
- [x] Prometheus scrapes `http://orders:8000/metrics` — the compose service name, not an IP
- [x] The exemplar → trace → logs chain resolves across the container network, with the ID in **both** services' streams
- [x] Gating on `service_healthy` removes the start-up outlier: **3.153s → 0.448s** slowest request, measured both ways
- [x] A healthcheck whose argument contains a space is silently word-split — caught because it made the container `unhealthy`
- [x] The dashboard appears at `/d/three-signals/` after start-up with **no clicking** — provisioned from the file
- [x] Every one of the **7 panels** returns data, checked by replaying the dashboard's stored queries — and caught one that did not
- [x] The p95 panel renders **16 exemplar markers**, so the metrics → traces link works on a dashboard and not only in Explore
- [x] Editing the provisioned dashboard is refused with `400 Cannot save provisioned dashboard`
- [x] Changing the JSON on disk reloads it **without restarting Grafana**
- [x] A span's detail panel offers a logs link, and following it returns **1 line** — the clicked service's, for that trace
- [x] Two spans of the same trace generate **different** stream selectors (`inventory` vs `orders`) — the `tags` mapping is per-span
- [x] The `orders` log line for that same trace is **absent** from the `inventory` span's result, so the selector is filtering rather than decorating
- [x] Grafana renders exemplar markers on the p95 chart, and the tooltip carries `trace_id` plus a `Query with Tempo` link
- [x] Clicking that link opens the trace — the tooltip's `0.443` and the trace's `443.45ms` are the same request

## Rollback

```bash
podman compose down -v          # containers and their volumes
```

Running it by hand instead:

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

**`depends_on` waits for the container to start, not to be ready — and it costs a real request.**
The first compose run logged this from the load generator:

```
loadgen: [Errno 111] Connection refused
```

and produced one request of **3.153 seconds** at nine seconds in, against a slow path that tops out
near 0.42s. Loki takes about fifteen seconds past container start to answer `/ready`, and the app
pushes its log line inside the request path. Adding healthchecks and `condition: service_healthy`
and cold-starting again:

```
before:  exemplars 48, max 3.153s, 1 over 1s
after:   exemplars 35, max 0.448s, 0 over 1s
```

No connection errors either. **`depends_on: [loki]` means "after `podman start` returned", which is
a claim about the container runtime and not about the software inside it.**

**A healthcheck argument containing a space is silently split, and the failure blames your code.**
The app's check was written in exec form:

```yaml
test: ["CMD", "python", "-c", "import urllib.request as u; u.urlopen('http://localhost:8000/docs')"]
```

The container went `unhealthy`, and compose refused to start anything depending on it. The health
log said:

```
  File "<string>", line 1
    import
          ^
SyntaxError: Expected one or more names after 'import'
```

**Only the word `import` reached Python.** Running the identical command through `podman exec`
returned `200`, which is what makes this so confusing — the command is right and the delivery is
broken. The four `wget` checks in the same file all went `healthy`, and every one of their arguments
is space-free. `CMD-SHELL` passes a single string to `sh -c` and works:

```yaml
test: ["CMD-SHELL", "python -c \"import urllib.request as u; u.urlopen('http://localhost:8000/docs')\""]
```

Worth saying plainly: **the gate itself is real.** Compose stopped and reported
`dependency failed to start: container three-signals-orders-1 is unhealthy` rather than starting the
load generator against a broken app. A healthcheck that has only ever passed would not have shown
that.

**`podman compose` is docker-compose wearing a hat, and it does not know what a Containerfile is.**

```
unable to prepare context: unable to evaluate symlinks in Dockerfile path: …/app/Dockerfile: no such file or directory
```

`podman build` accepts `Containerfile` as a matter of course; `podman compose` shells out to
`docker-compose` (it prints so on every invocation), which only auto-detects `Dockerfile`. Either
rename the file or name it explicitly with `dockerfile: Containerfile`. The error names a file you
never created, which is a poor clue to a tool substitution happening one layer down.

**A ratio panel reads "No data" exactly when nothing is wrong.** The first panel check came back
`1 of 7` empty — the error ratio, on a service that was serving traffic and returning 500s. The
cause is PromQL, not Grafana:

```promql
sum(rate(orders_requests_total{status="500"}[1m]))
```

```
[]
```

**`sum()` over a selector that matches nothing returns no series, not zero.** Divide by anything and
the result is still nothing, so the panel renders "No data". Verified deliberately against a status
that never occurs, and with the fix, back to back:

```promql
sum(rate(orders_requests_total{status="503"}[1m])) / sum(rate(orders_requests_total[1m]))
→ []

(sum(rate(orders_requests_total{status="503"}[1m])) or vector(0)) / sum(rate(orders_requests_total[1m]))
→ 0
```

`or vector(0)` is load-bearing on every ratio panel. The failure mode is the nastiest kind: the
panel is blank in the healthy case and correct during an incident, so it looks broken precisely
when nobody is investigating it, and gets "fixed" by someone who assumes the query is wrong.

**Grafana logs two `level=error` lines at start-up that mean nothing.**

```
level=error msg="Failed to read plugin provisioning files from directory" path=…/provisioning/plugins
level=error msg="can't read alerting provisioning files from directory" path=…/provisioning/alerting
```

Both are missing optional subdirectories of a provisioning tree that is otherwise working — the
dashboard and all three datasources loaded from the same tree. Creating empty `plugins/` and
`alerting/` directories silences them. Worth knowing before grepping the log for `error` after a
provisioning change and finding two that were always there.

**The API says the provisioned dashboard is saveable, then refuses to save it.**

```
meta.provisioned: True
meta.canSave:     True

POST /api/dashboards/db -> HTTP 400
  message: Cannot save provisioned dashboard
```

`allowUiUpdates: false` is enforced where it counts, but `canSave` still reports `true`. Same shape
as the datasource health check below: **the metadata Grafana reports about itself is less reliable
than asking it to do the thing.**

**Instrumenting the HTTP client means the telemetry traces itself.** The waterfall carries a
`POST (1.78ms)` span inside `validate` that no application code asked for:

```
orders   validate      9.36ms
orders     POST        1.78ms      <- the push to Loki
```

`HTTPXClientInstrumentor` is what propagates `traceparent` to the downstream service, and it does
not distinguish a business call from the log shipper's own request. Harmless at this size and
genuinely confusing at scale — it inflates span counts, and a log-shipping outage shows up as
latency inside unrelated spans. Real agents ship logs out of process for exactly this reason; if you
push from inside the request path, suppress the exporter's own client.

**A correlation is only as good as the ID the application remembers to log.** Nothing in Grafana,
Loki or Tempo can create the link — the trace ID has to be pulled out of the active span and written
into the log line by the code. `current_trace_id()` is three lines and is the single point where the
whole scheme fails silently: no error, no warning, just a `TraceID` field that never appears.

## Follow-ups

- [x] Emit Prometheus exemplars and close the metrics → traces hop — done above, marker clicked through to the trace, with both silent failure modes recorded
- [x] Add a provisioned dashboard so the setup survives a fresh install as files rather than clicks — done above, three rows on one screen
- [x] Test the Tempo → Logs direction from a span — done above; the link label says "trace" while the selector is per-span
- [ ] Replace `service.name`/`service`/`job` with one consistent name across all three signals and see how much of the `tags` translation disappears
- [x] Put the whole thing in a compose file so the six processes start together rather than by hand — done above, plus a load generator
- [ ] Provision an alert rule against the same p95 query and check it fires, since `provisioning/alerting/` is the directory Grafana already complains about
- [ ] Re-bucket the histogram: the p95 panel sits at ~450ms against a slow path capped near 420ms, the same interpolation artefact measured in [[prometheus-instrument-and-query]]

## Related

[[prometheus-instrument-and-query]] — metrics, and the histogram whose exemplars complete the third hop here.
[[opentelemetry-tracing-two-services]] — traces, exported here to Tempo instead of the console.
[[loki-logs-labels-and-cardinality]] — logs, and why the trace ID belongs in the line, which is what makes the derived field work.
