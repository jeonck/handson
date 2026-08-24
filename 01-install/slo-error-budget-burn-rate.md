---
title: SLOs and error budgets — burn-rate alerts that page once, and the SLI that records nothing
date: 2026-08-24
domain: install
tags: [sre, observability, slo, alerting, monitoring]
stack: [prometheus, promql, alertmanager, python, fastapi, prometheus-client, podman, docker-compose]
summary: A 99.5% availability SLO expressed as Prometheus recording rules, with multi-window burn-rate alerts wired through Alertmanager to a webhook that proves delivery. Injecting 50% errors moved the 5m SLI to 49.5% and paged in two minutes while the slow-burn alert stayed pending — and the healthy service recorded no SLI at all until an `or vector(0)` was added.
source: handson
env: Prometheus 3.14.0 · Alertmanager 0.28.1 · prometheus-client 0.26.0 · FastAPI 0.141.1 · Python 3.13 · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-24
verifiability: partial
verifiability-note: The rules, the burn-rate arithmetic, the firing and resolving path through Alertmanager and the failure modes below were all exercised against a running stack. What a lab cannot supply is time — every window of 30 minutes or more returned identical values here because less than 30 minutes of history existed, so the multi-window design is verified structurally rather than over a real 28-day budget. Alert routing, silences and on-call escalation are unexercised.
duration: 45–60 min
risk: low
---

> **Verified 2026-08-24.** Every ratio, alert state and payload below came from a running stack. The
> two SLIs that record nothing at all are in [Where this bit us](#where-this-bit-us), and both were
> measured rather than reasoned about.

[[prometheus-instrument-and-query]] ends with metrics you can query. This is the question those
metrics exist to answer: **is the service reliable enough, and if not, how fast is it getting worse?**

An SLO is not a dashboard. It is three numbers and a rule about when to wake someone.

## The three numbers

- **SLI** — a ratio of good events to total events. Here: non-5xx responses, and responses under
  200ms.
- **SLO** — the target. **99.5%** over 24 hours in this lab; production uses 28 days.
- **Error budget** — what the SLO permits you to fail: `1 − 0.995 = 0.005`, half a percent. At
  10 req/s that is roughly **4,300 failed requests a day** you are *allowed*.

**Burn rate is the fourth number and the one that matters operationally.** A burn rate of 1 spends
the budget exactly over the window. A burn rate of 14.4 spends a 28-day budget in **two days**, which
is why 14.4 is the conventional paging threshold:

```
fast burn: 14.4 × (1 − 0.995) = 0.072   ->  7.2% error ratio
slow burn:  6   × (1 − 0.995) = 0.03    ->  3.0% error ratio
```

## A service whose failure rate you can turn on

The SLI rules are written against two conventional metric shapes, so the lab's app has to produce
them:

```python title="app.py"
REQUESTS = Counter("http_requests_total", "Requests", ["handler", "status"])
LATENCY = Histogram(
    "http_request_duration_seconds", "Request duration", ["handler"],
    # 0.2 is the latency SLI threshold, so it MUST be a bucket boundary.
    buckets=(0.05, 0.1, 0.2, 0.5, 1.0, 2.0),
)

STATE = {"error_rate": 0.0, "slow_rate": 0.0}


@app.post("/inject")
def inject(error_rate: float = 0.0, slow_rate: float = 0.0):
    STATE.update(error_rate=error_rate, slow_rate=slow_rate)
    return STATE
```

**An injectable failure rate is the whole reason this lab can prove anything.** An SLO you have only
ever seen satisfied is an SLO you have not tested.

## The recording rules

```yaml title="prometheus/slo_rules.yml"
groups:
  - name: sli-recording
    interval: 15s
    rules:
      # 'or vector(0)' is load-bearing: with no 5xx in the window the numerator
      # matches nothing, sum() returns no series, and the ratio records nothing
      # at all rather than zero.
      - record: sli:http_error_ratio:rate5m
        expr: |
          (sum(rate(http_requests_total{status=~"5.."}[5m])) or vector(0))
          / sum(rate(http_requests_total[5m]))
      # …the same shape at 30m, 1h, 6h and 24h…

      # Latency SLI: the share of requests NOT served under 200ms.
      - record: sli:http_slow_ratio:rate5m
        expr: |
          1 - (
            sum(rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
            / sum(rate(http_request_duration_seconds_count[5m]))
          )

      # Fraction of the 24h error budget still unspent. 1 = untouched, 0 = gone.
      - record: slo:error_budget_remaining:ratio24h
        expr: |
          1 - (sli:http_error_ratio:rate24h / (1 - 0.995))
```

**The `sli:` and `slo:` prefixes are a convention worth keeping.** A recording rule's name is the
only documentation most people will read, and `level:metric:operation` tells them it is derived
rather than scraped.

Lint before running, because a rule file that fails to parse takes the whole group with it:

```bash
podman run --rm -v "$PWD/prometheus:/p:Z" --entrypoint promtool \
  docker.io/prom/prometheus:v3.14.0 check rules /p/slo_rules.yml
```

```
Checking /p/slo_rules.yml
  SUCCESS: 10 rules found
```

**Both sides of that check were run.** Removing one closing parenthesis:

```
  FAILED:
/p/slo_rules.yml: 9:15: group "sli-recording", rule 1, "sli:http_error_ratio:rate5m":
  could not parse expression: 3:1: parse error: unclosed left parenthesis
```

It names the file, the line, the group **and** the rule. That is the difference between a config
check worth running and one worth skipping.

## The burn-rate alerts

```yaml title="prometheus/slo_rules.yml"
  - name: slo-burn-rate-alerts
    rules:
      - alert: ErrorBudgetFastBurn
        expr: |
          sli:http_error_ratio:rate5m > (14.4 * (1 - 0.995))
          and
          sli:http_error_ratio:rate1h > (14.4 * (1 - 0.995))
        for: 2m
        labels: {severity: page, slo: demo-availability}
        annotations:
          summary: "Fast error-budget burn on the demo API (14.4x)"
          description: "5m error ratio is {{ $value | humanizePercentage }}"

      - alert: ErrorBudgetSlowBurn
        expr: |
          sli:http_error_ratio:rate30m > (6 * (1 - 0.995))
          and
          sli:http_error_ratio:rate6h > (6 * (1 - 0.995))
        for: 15m
        labels: {severity: ticket, slo: demo-availability}
```

**The `and` between two windows is the entire point of the design.** A short window alone pages on
every thirty-second blip. A long window alone notices an outage an hour late. Requiring both means
the alert fires only when a spike is *sustained* — the short window gives speed, the long window
gives confidence, and the pager stays quiet for noise.

The two severities are doing different jobs too: `page` wakes someone for a budget that will be gone
in two days; `ticket` files work for a slow leak that would take weeks. **Same SLO, two responses.**

## Healthy, then not

With the load generator at ~10 req/s and nothing injected:

```
raw_total=1334.0  err5m=0.0  budget=1.0  slow5m=0.0
```

```
  ErrorBudgetFastBurn    inactive for=120s  alerts=0
  ErrorBudgetSlowBurn    inactive for=900s  alerts=0
```

Then half the requests start failing and a third get slow:

```bash
curl -s -X POST "http://127.0.0.1:8000/inject?error_rate=0.5&slow_rate=0.3"
```

```
t+  0s  err 5m=0.000 30m=0.000 1h=0.000 6h=0.000 24h=0.000
t+100s  err 5m=0.103 30m=0.062 1h=0.062 6h=0.062 24h=0.062
t+175s  err 5m=0.216 30m=0.104 1h=0.104 6h=0.104 24h=0.104
t+275s  err 5m=0.435 30m=0.154 1h=0.154 6h=0.154 24h=0.154
```

**The 5m window moves first and moves furthest**, which is exactly the property the fast-burn alert
is built on. (Everything from 30m upward is identical, for a reason worth its own section below.)

```
  ErrorBudgetFastBurn    firing
      -> firing   since 02:18:52  5m error ratio is 49.54%
  ErrorBudgetSlowBurn    pending
      -> pending  since 02:17:37  30m error ratio is 17.41%
```

**Fast burn pages; slow burn is still pending after fifteen minutes have not yet elapsed.** That is
the design working, not a bug — and it is the observation that makes the two-alert scheme make sense.

Alertmanager has it, and the webhook proves delivery rather than assuming it:

```
  ErrorBudgetFastBurn page active
```

```json
{"status": "firing", "alertname": "ErrorBudgetFastBurn", "severity": "page",
 "slo": "demo-availability", "value": "5m error ratio is 36.38%"}
```

The latency SLI tracked the injection closely enough to trust it — `slow_rate=0.3` injected,
**0.3145** measured.

## And then it stops

```bash
curl -s -X POST "http://127.0.0.1:8000/inject?error_rate=0&slow_rate=0"
```

```
t+  0s  err5m=0.497095  fastburn=1.0
t+150s  err5m=0.216522  fastburn=1.0
t+250s  err5m=0.068261  fastburn=EMPTY (no series)
t+300s  err5m=0.0       fastburn=EMPTY (no series)
```

**The alert clears when the 5m ratio crosses back under 0.072, and the ratio decays over exactly the
window length.** Nothing resets it early — a five-minute window takes five minutes to forget, which
is the cost of the smoothing that made it trustworthy.

```json
{"status": "resolved", "alertname": "ErrorBudgetFastBurn", "severity": "page",
 "slo": "demo-availability", "value": "5m error ratio is 8.815%"}
```

**Checking that an alert resolves is half the test and the half usually skipped.** An alert that
fires and never clears trains people to ignore it within a week.

## Verification checklist

- [x] `promtool check rules` reports `SUCCESS: 10 rules found` — and **fails naming the exact group and rule** when a parenthesis is removed
- [x] Prometheus loads **8 recording** and **2 alerting** rules, and the target reports `up`
- [x] A healthy service records `err5m = 0.0` and `budget = 1.0`, with both alerts `inactive`
- [x] Without `or vector(0)` the same healthy service records **no series at all** — checked both ways
- [x] Injecting 50% errors drives `sli:http_error_ratio:rate5m` to **0.435**, past the `0.072` threshold
- [x] `ErrorBudgetFastBurn` reaches `firing` while `ErrorBudgetSlowBurn` is still `pending` — the two windows behave differently
- [x] The alert reaches **Alertmanager** and a webhook receiver, with `humanizePercentage` rendering `49.54%`
- [x] Stopping the injection clears the alert and delivers a **`resolved`** payload
- [x] The latency SLI reads **0.3145** against an injected `slow_rate` of `0.3`
- [x] A latency threshold that is not a bucket boundary (`le="0.25"`) records **nothing**
- [x] The error-budget expression returns **−22.88** under sustained failure, and `clamp_min` returns `0`

## Rollback

```bash
podman compose down -v
```

Rules only, without stopping anything:

```bash
curl -X POST http://127.0.0.1:9090/-/reload    # needs --web.enable-lifecycle
```

## Where this bit us

**A perfectly healthy service produced no SLI at all.** The obvious ratio, with no errors in the
window:

```promql
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
```

```
EMPTY (no series)
```

```promql
(sum(rate(http_requests_total{status=~"5.."}[5m])) or vector(0)) / sum(rate(http_requests_total[5m]))
```

```
0.0
```

`sum()` over a selector matching nothing returns **no series, not zero** — the same failure that hid
a Grafana panel in [[grafana-correlate-three-signals]], and it is worse in a recording rule. The rule
records nothing, so `sli:http_error_ratio:rate24h` does not exist, so
`slo:error_budget_remaining:ratio24h` does not exist, so **the error-budget panel is blank precisely
while you are meeting your SLO.** Someone then "fixes" it during an incident, when the series has
conveniently appeared.

**A latency SLO whose threshold is not a bucket boundary measures nothing, silently.** The histogram
here has boundaries at `0.05, 0.1, 0.2, 0.5, 1.0, 2.0`. Asking for the SLI at 200ms and at 250ms:

```
  le="0.2"   ->  0.0
  le="0.25"  ->  EMPTY (no series)
```

There is no `le="0.25"` series to match, the subtraction produces nothing, and the recording rule
writes nothing. **The SLO threshold has to be chosen before the buckets are, or at least at the same
time** — which is the same "boundaries chosen before you have the data" problem
[[prometheus-instrument-and-query]] hit from the quantile side. A latency SLO is a promise you can
only make at the resolution your buckets allow.

**Every window of 30 minutes or more returned exactly the same number.**

```
t+275s  err 5m=0.435 30m=0.154 1h=0.154 6h=0.154 24h=0.154
```

Not a coincidence and not a bug: the cluster was under thirty minutes old, so `[30m]`, `[1h]`, `[6h]`
and `[24h]` all covered the identical set of samples. **The multi-window burn-rate design is
structurally unable to discriminate until the long window is actually full**, which means a fresh
Prometheus cannot distinguish a two-minute spike from a six-hour outage no matter what the rules say.

The related measurement, on a ~4.7-minute-old server:

```
rate(http_requests_total[5m])   ->  5.88 /s
rate(http_requests_total[30m])  ->  0.98 /s
rate(http_requests_total[1h])   ->  0.49 /s
rate(http_requests_total[24h])  ->  0.020 /s
```

**A rate over a window longer than the available history is diluted in proportion to the window**,
because the increase is divided by the full window duration regardless. The 24h figure is 288× low.
That does *not* corrupt the SLIs — the dilution cancels between numerator and denominator of a ratio,
which is a good reason SLOs are defined as ratios — but any panel or alert using an **absolute** rate
over a long window is badly wrong for the first day of a cluster's life, and reads reassuringly low
rather than obviously broken.

**The error-budget expression is unbounded below and will happily render −22.88.**

```
  raw:      -22.876154
  clamped:  0.0
```

`1 − (ratio / 0.005)` has no floor, so thirty times over budget is `−29`. As a number it is
informative; on a gauge labelled "budget remaining" it is nonsense, and on a bar chart it inverts the
axis. Use `clamp_min(…, 0)` for anything a human looks at and keep the raw series for alerting, where
the sign is the only part that matters.

## Follow-ups

- [ ] Run the same rules for long enough that `[24h]` is genuinely full, and confirm the long windows begin to diverge from the short ones — the one property this lab structurally cannot show
- [ ] Add a burn-rate *recording* rule (`sli:http_error_ratio:rate5m / 0.005`) so dashboards show multiples of budget rather than raw ratios, which is what the 14.4 and 6 thresholds actually mean
- [ ] Route `severity: page` and `severity: ticket` to different Alertmanager receivers and confirm each lands in the right place, since the labels currently distinguish nothing downstream
- [ ] Add an Alertmanager silence during a deliberate deploy and check the burn alert stays quiet without the rule changing
- [ ] Express the same SLO against the request-duration SLI and page on latency burn, not just availability
- [ ] Point [[grafana-correlate-three-signals]] at these recording rules so the error budget is a panel next to the traces that explain it

## Related

[[prometheus-instrument-and-query]] — the instrumentation these rules are built on, and the bucket-boundary problem from the quantile side.
[[grafana-correlate-three-signals]] — alerting through Grafana instead of Alertmanager, and the same `or vector(0)` trap in a panel.
[[opentelemetry-tracing-two-services]] — what you reach for once a burn alert tells you *that* something is wrong.
[[k8s-node-drain-replace]] — planned work that will spend error budget, which is what the budget is for.
