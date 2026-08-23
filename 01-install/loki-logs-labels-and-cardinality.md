---
title: Loki — logs you can query, and the one label that multiplies your streams by 25
date: 2026-08-23
domain: install
tags: [observability, logs, logql, monitoring]
stack: [loki, logql]
summary: A single-binary Loki taking logs over its HTTP API and answering LogQL, including parsing a field out of a line and filtering on it numerically. Putting a trace ID in a label took the stream count from 3 to 28 for 25 log lines — one stream per request — while a line filter found the same trace across both services without any label at all.
source: handson
env: Loki 3.7.6 (Homebrew, single binary, filesystem storage) · macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Verified against a single-binary Loki with filesystem storage, pushing over the HTTP API rather than with an agent. Promtail/Alloy log collection, object-storage backends, retention and compaction, multi-tenancy and Grafana as a query UI are all unexercised — the cardinality and timestamp findings hold regardless, since they are ingestion-side.
duration: 25–40 min
risk: low
---

> **Verified 2026-08-23.** Every query result and both rejections below came from a running Loki on
> this machine. The 3-to-28 stream count is a measurement, not an estimate.

[[prometheus-instrument-and-query]] gives you rates and percentiles; [[opentelemetry-tracing-two-services]]
gives you one request's path. Logs are the third thing, and the one people most often ship as an
unindexed pile. **Loki's design choice is that it indexes labels and not content** — which makes it
cheap, and makes exactly one mistake expensive.

## Install and configure

```bash
brew install loki
```

```
loki, version  (branch: , revision: unknown)
```

The version string is empty — a packaging artifact of the Homebrew bottle, not a broken binary.
`brew info loki` reports the real version, `3.7.6`.

```yaml title="loki.yml"
auth_enabled: false

server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3100
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: ./data
  storage:
    filesystem:
      chunks_directory: ./data/chunks
      rules_directory: ./data/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  # Rejecting old lines is Loki's default and the first thing a lab hits.
  reject_old_samples: true
  reject_old_samples_max_age: 168h
```

```bash
loki -config.file=loki.yml -verify-config   # exit 0
loki -config.file=loki.yml
```

**`/ready` tells you plainly when it is not**, and it is worth waiting on rather than assuming:

```
Ingester not ready: waiting for 15s after being ready
```

## Pushing logs without an agent

Promtail or Alloy is what you would run in production. The HTTP API is what they call, and using it
directly makes the data model impossible to misread:

```bash
curl -X POST "http://127.0.0.1:3100/loki/api/v1/push" \
  -H 'Content-Type: application/json' -d '{
  "streams": [
    {"stream": {"service":"orders","env":"lab","level":"info"},
     "values": [["'"$NOW"'", "order placed sku=SKU-123 trace_id=0xc28ad003 duration_ms=87"]]},
    {"stream": {"service":"orders","env":"lab","level":"error"},
     "values": [["'"$((NOW+1000000))"'", "payment declined sku=SKU-999 trace_id=0xd41f9a22 duration_ms=412"]]},
    {"stream": {"service":"inventory","env":"lab","level":"warn"},
     "values": [["'"$((NOW+2000000))"'", "cache miss sku=SKU-SLOW trace_id=0xc28ad003 duration_ms=405"]]}
  ]}'
```

```
http=204
```

**A `stream` is the set of labels; the `values` are timestamped lines.** Timestamps are nanoseconds
since epoch as *strings* — a number is rejected, and so is a millisecond value silently interpreted
as a date in 1970.

## Four LogQL queries

```logql
{env="lab"}
```

```
  [orders    error] payment declined sku=SKU-999 trace_id=0xd41f9a22 duration_ms=412
  [orders    info ] order placed sku=SKU-123 trace_id=0xc28ad003 duration_ms=87
  [inventory warn ] cache miss sku=SKU-SLOW trace_id=0xc28ad003 duration_ms=405
```

Every LogQL query starts with a **stream selector in braces**, and it is not optional — this is the
indexed part, and it is what decides how much data Loki has to read.

```logql
{env="lab", level="error"}
```

```
  [orders    error] payment declined sku=SKU-999 trace_id=0xd41f9a22 duration_ms=412
```

```logql
{env="lab"} |= "SKU-SLOW"
```

```
  [inventory warn ] cache miss sku=SKU-SLOW trace_id=0xc28ad003 duration_ms=405
```

`|=` is a **substring scan over the line content**, which is not indexed. It is fast because the
selector already narrowed the streams — which is the whole architectural bet.

```logql
{env="lab"} | pattern "<_> duration_ms=<dur>" | dur > 400
```

```
  [orders    error] payment declined sku=SKU-999 trace_id=0xd41f9a22 duration_ms=412
  [inventory warn ] cache miss sku=SKU-SLOW trace_id=0xc28ad003 duration_ms=405
```

**That last one is the feature worth knowing.** `pattern` extracts a field out of unstructured text
at query time, and `| dur > 400` then filters numerically on it. The field was never indexed, never
declared, and did not have to be a label — you can decide at 3am that `duration_ms` is interesting
and query on it retroactively.

## Verification checklist

- [x] `loki -verify-config` exits `0` on the config above
- [x] `/ready` reports not-ready before it reports ready, so waiting on it is meaningful
- [x] A push of three labelled streams returns `204`
- [x] A stream selector, a label filter, a line filter and a `pattern` + numeric filter all return the expected lines
- [x] Adding `trace_id` as a label takes `env="lab"` from **3 streams to 28** for 25 lines — measured via `/series`
- [x] The same trace is findable by line filter across two services with **no** `trace_id` label
- [x] A line older than `reject_old_samples_max_age` is rejected with `400` and a message naming both timestamps
- [x] Loki adds a `service_name` label nobody sent

## Rollback

```bash
pkill -f "loki -config.file"
rm -rf data
```

## Where this bit us

**One high-cardinality label turned 25 log lines into 25 streams.** Counting streams before and
after pushing the same volume of logs, the only difference being a `trace_id` label:

```
before:  streams for env=lab: 3
after:   streams for env=lab: 28
```

Three streams described *all* traffic from two services at three log levels. Adding `trace_id`
created one stream per request — and in production, per request forever. **A Loki label must have a
small, bounded set of values**: service, env, level, region. Anything unbounded — trace ID, user ID,
request ID, SKU — belongs in the line.

The reason this is safe to do is the query that follows. The identical trace is retrievable across
both services with no label at all:

```logql
{env="lab"} |= "0xc28ad003"
```

```
  [orders]    order placed sku=SKU-123 trace_id=0xc28ad003 duration_ms=87
  [inventory] cache miss sku=SKU-SLOW trace_id=0xc28ad003 duration_ms=405
```

Two services, one trace, joined by a substring scan of unindexed content. **The label bought nothing
and would have cost a stream per request** — which is the trade Loki is built around, and the one
mistake that turns it from cheap into unusable.

**Old log lines are rejected outright, with a `400` and a very specific message.** Backfilling a
day's logs from a file, or replaying anything, hits this immediately:

```
entry for stream '{env="lab", service="orders"}' has timestamp too old:
2026-08-15T03:18:31-05:00, oldest acceptable timestamp is: 2026-08-16T11:18:31-05:00
```

The message is unusually good — it names the offending timestamp *and* the boundary, so the fix is
arithmetic rather than guesswork. It is `reject_old_samples_max_age` (168h by default), and the
right response is usually to raise it deliberately for a backfill rather than discover the limit
during one.

**Loki adds a label you never sent.** The rejection message above mentions
`service_name="orders"`, and querying `/series` confirms it is stored:

```json
{"env": "lab", "level": "error", "service": "orders", "service_name": "orders"}
```

Loki 3.x derives `service_name` from a list of candidate labels when one is not supplied. Harmless
here, and worth knowing before you count your own cardinality and come up one label short — or write
a dashboard variable against a label list containing an entry you did not create.

## Follow-ups

- [ ] Run Promtail or Alloy against a real log file instead of pushing over HTTP, which is how logs actually arrive
- [ ] Emit the `trace_id` from [[opentelemetry-tracing-two-services]] into the log line and jump from a slow trace straight to its logs — the pairing this page is one half of
- [ ] Add `metrics` queries (`rate({env="lab"} |= "error" [5m])`) and confirm a log-derived rate matches the counter in [[prometheus-instrument-and-query]]
- [ ] Point Grafana at all three and see whether the correlation actually works in a UI, which is the only place it pays off
- [ ] Test retention and compaction, neither of which a lab this short can reach

## Related

[[prometheus-instrument-and-query]] — metrics: how often and how slow, in aggregate.
[[opentelemetry-tracing-two-services]] — traces: one request's path across services, and the `trace_id` these logs should carry.
[[fastapi-mvc-layering]] — the application that would emit all three signals.
[[grafana-correlate-three-signals]] — the derived field that turns this page's in-line trace ID into a clickable trace.
