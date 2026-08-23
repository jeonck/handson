---
title: OpenTelemetry tracing — one trace across two services, and where the 420ms actually went
date: 2026-08-23
domain: install
tags: [observability, tracing, python, distributed-systems]
stack: [opentelemetry, python, fastapi, httpx]
summary: Two FastAPI services, auto-instrumented, with a request that crosses the HTTP boundary and comes back as a single 9-span trace. The slow request took 420ms and the waterfall put 405ms of it in the downstream database span with cache.hit=false — the question a p95 cannot answer, since a percentile describes a population and a trace describes one request.
source: handson
env: opentelemetry-api/sdk 1.44.0 · opentelemetry-instrumentation-fastapi 0.65b0 · FastAPI 0.141.1 · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Verified with two local processes and the ConsoleSpanExporter, so span structure, cross-process context propagation and durations are all real. No collector, no backend and no sampling were involved — OTLP export, tail sampling, and what a UI like Jaeger adds are unexercised, and those are where production tracing actually gets hard.
duration: 30–45 min
risk: low
---

> **Verified 2026-08-23.** The trace IDs, the parent chain and every duration below were parsed out
> of two real processes' span output. The 405ms span is what the run produced, not an illustration.

[[prometheus-instrument-and-query]] ends with a p95 that could not say *which* request was slow, or
why. That is not a flaw in the setup — **a percentile is a property of a population, and no
aggregate can point at one request.** Tracing answers the other question: this specific call took
420ms, and here is where it went.

## Two services, because one is not distributed

```bash
pip install fastapi "uvicorn[standard]" httpx \
  opentelemetry-api opentelemetry-sdk \
  opentelemetry-instrumentation-fastapi opentelemetry-instrumentation-httpx
```

```
opentelemetry-api                        1.44.0
opentelemetry-sdk                        1.44.0
opentelemetry-instrumentation-fastapi    0.65b0
```

**Note the version scheme**: the API and SDK are `1.44.0`, the instrumentation packages are `0.65b0`.
They are released together but numbered differently, and a mismatched pair is the usual reason
instrumentation silently produces nothing.

```python title="otel_setup.py"
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter


def setup(service_name: str) -> trace.Tracer:
    provider = TracerProvider(
        resource=Resource.create({"service.name": service_name})
    )
    # Console here so the spans are readable in a terminal. Swap for
    # OTLPSpanExporter(endpoint=...) to send them to a collector instead.
    provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
    trace.set_tracer_provider(provider)
    return trace.get_tracer(service_name)
```

`service.name` is the one resource attribute that is not optional — it is what separates the two
services in every backend, and an unset one shows up as `unknown_service`.

```python title="inventory.py"
tracer = setup("inventory")
app = FastAPI()


@app.get("/stock/{sku}")
def stock(sku: str):
    # One SKU is deliberately slow, so a trace has something to find.
    with tracer.start_as_current_span("db.lookup") as span:
        span.set_attribute("db.system", "postgresql")
        span.set_attribute("sku", sku)
        slow = sku == "SKU-SLOW"
        span.set_attribute("cache.hit", not slow)
        time.sleep(0.4 if slow else random.uniform(0.005, 0.02))
    return {"sku": sku, "qty": 7}


FastAPIInstrumentor.instrument_app(app)
```

```python title="orders.py"
tracer = setup("orders")
app = FastAPI()


@app.get("/order/{sku}")
def order(sku: str):
    with tracer.start_as_current_span("validate") as span:
        span.set_attribute("sku", sku)
    # httpx is instrumented, so the trace context rides along in the headers.
    r = httpx.get(f"http://127.0.0.1:8911/stock/{sku}", timeout=5)
    return {"ordered": sku, "stock": r.json()}


FastAPIInstrumentor.instrument_app(app)
HTTPXClientInstrumentor().instrument()
```

**`HTTPXClientInstrumentor().instrument()` is the line that makes this a distributed trace.** Without
it the outbound call is invisible and `inventory` starts a brand-new trace, leaving two unrelated
traces that no backend can join. Instrumenting the *client* is what injects the `traceparent` header;
instrumenting the server is what reads it.

## One request, one trace, two services

```bash
curl "http://127.0.0.1:8910/order/SKU-SLOW"
```

Grouping every emitted span by trace ID:

```
total spans: 18 across 2 traces

trace 0xc28ad003fdb7a2f99652070781c711fa  services=['inventory', 'orders']  spans=9
   orders     GET /order/{sku}                   parent=None
   orders     validate                           parent=0x0fa6d2e80056dd1b
   orders     GET                                parent=0x0fa6d2e80056dd1b
   inventory  GET /stock/{sku}                   parent=0xf4ea138f6f610df1
   inventory  db.lookup                          parent=0xb3657e333ddc6c8f
   orders     GET /order/{sku} http send         parent=0x0fa6d2e80056dd1b
```

**Pass condition: one trace ID, both service names, and a parent chain that crosses the process
boundary.** `inventory`'s server span names `orders`' client span as its parent — two operating
system processes, one causal chain, joined by a header. That single fact is the whole reason
distributed tracing exists, and it is worth checking explicitly, because the failure mode is two
perfectly valid traces that simply never mention each other.

## Where the time went

```
trace 0xc28ad003fdb7a2f99652…  total 420ms

  orders     GET /order/{sku}       419.9ms 100.0%
  orders     validate                 0.0ms   0.0%  {'sku': 'SKU-SLOW'}
  orders     GET                    409.5ms  97.5%
  inventory  GET /stock/{sku}       408.2ms  97.2%
  inventory  db.lookup              405.1ms  96.5%  {'db.system': 'postgresql', 'cache.hit': False}
```

Read it as a waterfall and it answers three questions in order: the request took 420ms, 97% of that
was spent waiting on a downstream service, and 96.5% was one database lookup — which conveniently
carries `cache.hit: False` as an attribute.

**Attributes are what turn a slow span into a cause.** `db.lookup 405ms` says where; `cache.hit:
False` says why. Attributes cost nothing to add at instrumentation time and are the difference
between a trace that localises a problem and one that merely confirms it.

Comparing against a normal request from the same run makes the case that this is a real outlier
rather than baseline behaviour:

```
sku           total  db.lookup  cache.hit
SKU-123         87ms        18ms       True
SKU-SLOW       420ms       405ms      False
```

**Neither row is available from a metric.** A histogram would have put both requests into buckets
and told you the p95 moved; it could not tell you which SKU, which service, or that the cache was
the discriminator.

## Verification checklist

- [x] Both services emit spans with distinct `service.name` values
- [x] A single request produces **one** trace ID appearing in both services' output
- [x] `inventory`'s server span has `orders`' client span as its parent — context crossed the process boundary
- [x] The slow trace totals 420ms with 405ms inside `db.lookup` — measured from span timestamps
- [x] The `cache.hit` attribute distinguishes the slow trace from the fast one
- [x] A normal request through the same code path totals 87ms, so the 420ms is an outlier not a baseline

## Rollback

```bash
pkill -f "uvicorn inventory:app"
pkill -f "uvicorn orders:app"
rm -rf .venv
```

## Where this bit us

**Instrumenting the server without the client produces two traces that look fine.** The obvious
setup — `FastAPIInstrumentor` on both services and nothing else — yields valid spans on both sides
and no link between them, because nothing injects `traceparent` into the outbound request. Every
span is present, every service reports healthy, and the one thing you installed tracing to see is
missing. The check that catches it is the one in the checklist above: **count distinct trace IDs for
a single request.** It should be one.

**`ConsoleSpanExporter` is a debugging tool that quietly becomes a performance problem.** It writes
every span as pretty-printed JSON to stdout — around 25 lines per span, 9 spans for one request
here. That is ideal for a page like this, where the spans are the evidence, and wrong for anything
serving traffic. `BatchSpanProcessor` at least batches the writes; the exporter itself is the part to
replace with OTLP before this leaves a laptop.

**Importing two instrumented services into one process logs a warning and silently keeps the first
one.** Checking that both modules import cleanly gave:

```
Overriding of current TracerProvider is not allowed
```

`set_tracer_provider` is global and effectively write-once per process. Harmless here — it was an
import check, and the services run separately — but the same warning in a real application means
some of your spans are being attributed to the wrong `service.name`, and it is a warning rather than
an error.

**The two package families are versioned differently on purpose.** `opentelemetry-sdk` is `1.44.0`
while `opentelemetry-instrumentation-fastapi` is `0.65b0` — the instrumentation packages are still
pre-1.0 and pinned to matching SDK ranges. Upgrading one family without the other is the common way
to end up with an app that starts fine and emits nothing.

## Follow-ups

- [ ] Replace `ConsoleSpanExporter` with OTLP into a collector and view the same trace in Jaeger — the waterfall above is a UI's whole job
- [ ] Add sampling and confirm what fraction of traces survive; at 100% this lab never has to decide what to drop
- [ ] Correlate with metrics: record `trace_id` as an exemplar on the histogram from [[prometheus-instrument-and-query]], so a p95 spike links to a specific slow trace
- [ ] Instrument a real database client rather than a `sleep`, and check whether the SQL statement lands in the span attributes — and whether it should, given it may contain data
- [ ] Break the chain on purpose by removing `HTTPXClientInstrumentor` and confirm the trace count goes from 1 to 2, pinning the failure mode described above

## Related

[[prometheus-instrument-and-query]] — the metrics half, and the p95 that motivated this page.
[[fastapi-mvc-layering]] — the app that would carry this instrumentation for real.
[[langgraph-control-flow]] — spans and graph nodes are the same shape; a trace is what a graph run looks like after the fact.
[[loki-logs-labels-and-cardinality]] — where this page's `trace_id` should end up in a log line, so a slow trace leads to its logs.
[[grafana-correlate-three-signals]] — the same traces exported to Tempo and linked from logs in a UI.
