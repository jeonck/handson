---
title: Topic of the day — Prometheus's `runtime.log_level` changes verbosity on a config reload, no restart, and a 200 from `/-/reload` doesn't prove it worked
date: 2026-11-21
domain: daily
tags: [daily, observability]
stack: [prometheus, docker]
summary: Prometheus 3.15+ can turn its own log level up or down from the config file on a `/-/reload`, no process restart — but the HTTP 200 that confirms the reload only proves the YAML parsed, and a reload that both quiets logging and adds a scrape target can leak one stray DEBUG line from the new target's own startup.
source: daily-topic
env: Docker 29.4.2 · prom/prometheus:v3.16.0 (single container, no Kubernetes/kind needed for this one)
verified: 2026-11-21
verifiability: lab
duration: 30–40 min
risk: low
---

## Why this topic

[[topics]] lists Observability — Prometheus, OpenTelemetry, Grafana, log pipelines, SLOs — in scope. This repository already runs Prometheus in two documents, [[prometheus-instrument-and-query]] and [[slo-error-budget-burn-rate]], and a third, [[2026-08-11-prometheus-3-13-lts]], stood it up on kind to try new PromQL functions. None of the three ever reloads a running Prometheus or touches its own operational logging — all three start it once, scrape or query it, and tear it down. That is exactly the gap this topic fills, and it is more than 30 days since the last Prometheus daily pick (2026-08-11), on a different angle (PromQL functions, not operations).

**Prometheus v3.15.0, released 2026-09-24**, shipped the feature directly, per the official GitHub release notes (fetched today):

- FEATURE: *"Configuration: Allow changing the process log level through `runtime.log_level` on configuration reload."* (#19511)
- CHANGE: *"Logging: Deprecate `--log.level`; use `runtime.log_level` configuration to supply the default level."*

The [configuration reference](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) (fetched today) confirms the syntax and that it survived into the current release:

```yaml
runtime:
  # The minimum severity of messages emitted by the process logger.
  # This setting can be changed by reloading the configuration.
  [ log_level: <string> | default = info ]
```

**Prometheus v3.16.0, released 2026-11-04** (the version this lab actually ran), is the current latest release — checked its own release notes to confirm this area shipped no further change since 3.15. [[2026-11-20-argocd-3-6-server-side-diff-default]] considered 3.16.0 yesterday and passed on it for being "purely additive and opt-in" — that verdict was about 3.16's *new* experimental query-cost feature, a different change. `runtime.log_level` shipped two months earlier, in 3.15.0, and is directly operational rather than additive: it is the knob you reach for mid-incident to turn up verbosity on a Prometheus you do not want to restart, which is why it earns the slot today instead.

The PR that implemented it, [prometheus/prometheus#19511](https://github.com/prometheus/prometheus/pull/19511) (fetched today), is also where the deprecation's actual behavior comes from: a reviewer rejected adding a runtime warning for the deprecated flag ("I propose we kill warning log, it will be too spammy"), and the merged commit is titled "config: keep log level deprecation silent." That decision is directly checkable and is one of today's Traps.

## 30-minute lab

### 1. Start Prometheus with `runtime.log_level: info`, confirm it's quiet

```yaml title="prometheus.yml"
global:
  scrape_interval: 15s

runtime:
  log_level: info

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
```

```bash
docker run -d --name prom-loglevel -p 9090:9090 \
  -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml" \
  prom/prometheus:v3.16.0 \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.enable-lifecycle
```

Observed — every startup line is `level=INFO`:

```bash
docker logs prom-loglevel 2>&1 | grep -oE 'level=[A-Z]+' | sort | uniq -c
```

```
     21 level=INFO
```

### 2. Reload to `debug`, with no restart

```bash
sed -i 's/log_level: info/log_level: debug/' prometheus.yml
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST http://localhost:9090/-/reload
docker inspect --format '{{.State.StartedAt}}' prom-loglevel
```

Observed:

```
HTTP 200
2026-11-21T02:06:17.794658206Z
```

The `StartedAt` timestamp is identical before and after — confirmed by capturing it right after `docker run` and again here. The reload did not restart the container.

### 3. The false pass: HTTP 200 alone doesn't prove the level changed

Idle self-scrape produces almost no DEBUG output — querying `/api/v1/query`, `/api/v1/targets`, `/api/v1/labels` and `/federate` repeatedly after the reload above produced zero DEBUG lines in this lab. A 200 from `/-/reload` only proves the YAML parsed and applied; it says nothing about whether the verbosity you asked for actually shows up anywhere. To see the level really take effect, something has to generate a message Prometheus tags DEBUG — an idle, already-stable scrape target won't.

### 4. Lower the level back to `info` and add a scrape target in the same reload

```yaml title="prometheus.yml"
global:
  scrape_interval: 15s

runtime:
  log_level: info

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
  - job_name: broken
    static_configs:
      - targets: ["broken-target:80"]
```

```bash
curl -s -X POST -o /dev/null -w "reload(info) %{http_code}\n" http://localhost:9090/-/reload
```

Observed, immediately after the `200`:

```
time=2026-11-21T02:08:33.793Z level=INFO  msg="Loading configuration file"
time=2026-11-21T02:08:33.793Z level=DEBUG source=manager.go:353 msg="Starting provider" component="discovery manager scrape" provider=static/1 subs=map[broken:{}]
time=2026-11-21T02:08:33.793Z level=INFO  msg="Completed loading of configuration file" ...
```

See Traps — this is real, reproduced on request, and not a mistake in the lab's own config.

### 5. Break it on purpose: an invalid level

```bash
sed -i 's/log_level: info/log_level: verbose/' prometheus.yml
curl -s -X POST http://localhost:9090/-/reload
```

Observed:

```
HTTP 500
failed to reload config: couldn't load configuration (--config.file="/etc/prometheus/prometheus.yml"): parsing YAML file /etc/prometheus/prometheus.yml: unrecognized log level verbose
```

```bash
curl -s "http://localhost:9090/api/v1/query?query=up" -o /dev/null -w "HTTP %{http_code}\n"
```

```
HTTP 200
```

The failed reload is rejected outright — the previous good config (and its log level) stays active, confirmed by the server continuing to answer queries normally.

### Verify

```bash
docker run --rm prom/prometheus:v3.16.0 --help 2>&1 | grep -A2 'log.level'
```

Observed:

```
      --log.level=info           Only log messages with the given severity
                                 or above. One of: [debug, info, warn,
                                 error] Deprecated: set runtime.log_level in the
                                 configuration file instead.
```

Expected: the help text names the flag deprecated — that's the only place it does. Confirmed no deprecation warning appears anywhere in the actual logs by also running `docker logs <container> 2>&1 | grep -i deprecat`, which returned nothing in every container started in this lab.

### Clean up

```bash
docker rm -f prom-loglevel broken-target
docker network rm prom-lab-net
```

## Traps

**A `200` from `/-/reload` is a stand-in for "the log level changed," not the property itself.** It only proves the YAML was valid and was applied. An idle, already-running scrape target generates essentially no DEBUG output, so the honest way to confirm verbosity actually increased is to make something happen that is tagged DEBUG — not to trust the reload's status code.

**Dropping the log level and adding a scrape target in the same reload can leak one DEBUG line from the new target's own startup, timestamped identically to the surrounding INFO lines.** Step 4 above reduced `runtime.log_level` from `debug` back to `info` while also adding the `broken` job for the first time. The new job's discovery sub-manager's `"Starting provider"` message still came through as `level=DEBUG`, sandwiched between the `INFO`-level `"Loading configuration file"` and `"Completed loading of configuration file"` lines of the exact same reload. Repeating steps 2–4 in order reproduces it every time: the leak only shows up for a *new* sub-component whose startup happens to land inside a reload that is simultaneously turning verbosity down. It is not a sign the new config failed to apply — the very next line confirms the reload completed and nothing since has logged at DEBUG again.

**`--log.level` is deprecated quietly, by design.** The implementing PR's review thread explicitly rejected a runtime warning as "too spammy," and the merged commit is titled "config: keep log level deprecation silent." The flag still fully works — `--log.level=debug` with no `runtime.log_level` in the config produces DEBUG output from the first line of startup — and the only place that tells you it's deprecated is `--help`.

**`runtime.log_level` in the config always outranks `--log.level`, even on a cold start, not just after a reload.** Starting fresh with `--log.level=warn` on the command line and `runtime.log_level: debug` in the config produced DEBUG lines from the very first log message — the config won outright before any reload happened, not merely "when the flag is omitted" as the release note's wording might suggest in isolation.

**`/-/reload` needs `--web.enable-lifecycle` or it is a no-op that looks like permission, not a missing feature.** Without the flag, `POST /-/reload` returns `403 Lifecycle API is not enabled.` — not a connection error, not a 404 — which is easy to misread as an auth problem rather than a startup flag you forgot.

## If we applied this here

- [[slo-error-budget-burn-rate]]'s stack already runs Prometheus behind Alertmanager — mid-incident, dialing `runtime.log_level` to `debug` without a restart is exactly the kind of thing worth having pre-staged in that document's runbook, rather than discovered live.
- [[prometheus-instrument-and-query]] never reloads its Prometheus at all; nothing there would break by adding a `runtime.log_level` block, but nothing there exercises reload either, so the ordering trap in Step 4 has no analog to check against yet.
- Neither existing document sets `--web.enable-lifecycle`, so `/-/reload` would currently 403 against either of their containers as written.

## Follow-ups

- [ ] Confirm whether the Step 4 DEBUG leak also occurs for an existing scrape target whose own config changes in the same reload that lowers the log level, not just a brand-new target 📅 2026-12-05

## Related

[[prometheus-instrument-and-query]] — Prometheus install this repository already has; never reloaded.
[[slo-error-budget-burn-rate]] — the document most likely to actually want this knob mid-incident.
[[2026-08-11-prometheus-3-13-lts]] — this repository's first Prometheus daily-topic pick, a different angle (PromQL functions, not operations).
[[2026-11-20-argocd-3-6-server-side-diff-default]] — yesterday's pick, which passed on a different Prometheus 3.16 feature for being purely additive.
[[topics]] — why this topic was selected.
