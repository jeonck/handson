---
title: Dagster locally — software-defined assets, from pip install to a materialized pipeline
date: 2026-08-20
domain: install
tags: [data-platform, orchestration, python]
stack: [dagster, python]
summary: A three-asset pipeline (raw → cleaned → summary) installed, validated, materialized, and served from a local dagster dev webserver — all from a Python venv, no cluster. Without DAGSTER_HOME set, every run's history silently disappears, which is the trap this write-up exists to flag before it costs someone a debugging session.
source: handson
env: Dagster 1.13.18 (dagster + dagster-webserver via pip) in a Python 3.13.0 venv on macOS 14.7.5
verified: 2026-08-20
verifiability: partial
verifiability-note: Verified via CLI and HTTP/GraphQL calls against a locally running dagster dev instance — no browser was used, so Dagster's own web UI (asset graph visualization, run timeline, launchpad) is unverified here. This is also a single-machine venv install, not the on-prem/Kubernetes deployment the other orchestrator document in this repo ([[airflow-orchestration-onprem]]) targets.
duration: 30–45 min
risk: low
---

> **Verified 2026-08-20.** Every command below ran for real against a real three-asset pipeline, in
> a scratch virtualenv. Outputs — including two failure cases hit on purpose — are reproduced as
> printed.

Dagster's central idea is the **software-defined asset**: instead of describing a sequence of tasks
("run A, then run B"), you describe *the data* ("this file depends on that file") and Dagster
derives the execution order, the dependency graph, and what needs to re-run when something upstream
changes. That is the paradigm this write-up exercises — not the older ops/jobs API, which still
exists but is not where Dagster's own documentation or tooling investment is going.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install dagster dagster-webserver
.venv/bin/dagster --version
```

```
dagster, version 1.13.18
```

`dagster-webserver` is a separate package from `dagster` itself — installing only `dagster` gets you
the CLI and the execution engine but no local UI server, and `dagster dev` (below) fails without it.

## The pipeline — three dependent assets

```python title="assets.py"
import json
import os

from dagster import AssetExecutionContext, Definitions, MaterializeResult, MetadataValue, asset

OUT_DIR = os.path.join(os.path.dirname(__file__), "out")


@asset
def raw_orders(context: AssetExecutionContext) -> MaterializeResult:
    """Simulates a source extract — five orders, one deliberately invalid (negative amount)."""
    orders = [
        {"id": 1, "customer": "acme", "amount": 120.0},
        {"id": 2, "customer": "acme", "amount": 45.5},
        {"id": 3, "customer": "globex", "amount": -10.0},  # bad row, on purpose
        {"id": 4, "customer": "globex", "amount": 80.0},
        {"id": 5, "customer": "initech", "amount": 200.0},
    ]
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "raw_orders.json")
    with open(path, "w") as f:
        json.dump(orders, f)
    return MaterializeResult(metadata={"row_count": len(orders), "path": MetadataValue.path(path)})


@asset(deps=[raw_orders])
def cleaned_orders(context: AssetExecutionContext) -> MaterializeResult:
    """Drops rows with amount <= 0. Depends on raw_orders by name, not by Python import."""
    with open(os.path.join(OUT_DIR, "raw_orders.json")) as f:
        orders = json.load(f)
    cleaned = [o for o in orders if o["amount"] > 0]
    dropped = len(orders) - len(cleaned)
    path = os.path.join(OUT_DIR, "cleaned_orders.json")
    with open(path, "w") as f:
        json.dump(cleaned, f)
    return MaterializeResult(
        metadata={"row_count": len(cleaned), "dropped_rows": dropped, "path": MetadataValue.path(path)}
    )


@asset(deps=[cleaned_orders])
def daily_summary(context: AssetExecutionContext) -> MaterializeResult:
    """Sums amount per customer from the cleaned data."""
    with open(os.path.join(OUT_DIR, "cleaned_orders.json")) as f:
        orders = json.load(f)
    totals: dict[str, float] = {}
    for o in orders:
        totals[o["customer"]] = totals.get(o["customer"], 0.0) + o["amount"]
    path = os.path.join(OUT_DIR, "daily_summary.json")
    with open(path, "w") as f:
        json.dump(totals, f)
    return MaterializeResult(metadata={"customers": len(totals), "totals": MetadataValue.json(totals)})


defs = Definitions(assets=[raw_orders, cleaned_orders, daily_summary])
```

`deps=[raw_orders]` is what makes `cleaned_orders` depend on `raw_orders` — Dagster reads the asset
graph from these declarations, not from import order or file layout. The three assets read and
write plain JSON files on disk here deliberately, so the dependency chain and its output are both
inspectable with nothing more than `cat`.

## Validate before you materialize

`dagster definitions validate` loads the file and checks the asset graph resolves — no subprocess
per asset, no I/O, fast enough to run on every save:

```bash
.venv/bin/dagster definitions validate -f assets.py
```

```
Validation successful for code location assets.py.
All code locations passed validation.
```

**Both sides of that check were observed.** Renaming `raw_orders` to `raw_orders_renamed` without
updating the `deps=[raw_orders]` reference below it —

```bash
sed -i.bak 's/def raw_orders/def raw_orders_renamed/' assets.py
.venv/bin/dagster definitions validate -f assets.py
```

```
ERROR - Validation failed for code location assets.py:

NameError: name 'raw_orders' is not defined

Stack Trace:
  File ".../assets.py", line 26, in <module>
    @asset(deps=[raw_orders])
                 ^^^^^^^^^^
```

— points straight at the broken line, before anything is executed. Catching this class of mistake
here rather than mid-materialization is the entire reason to run it first.

## Materialize the pipeline

```bash
.venv/bin/dagster asset materialize --select "*" -f assets.py
```

```
raw_orders - STEP_START - Started execution of step "raw_orders".
raw_orders - ASSET_MATERIALIZATION - Materialized value raw_orders.
raw_orders - STEP_SUCCESS - Finished execution of step "raw_orders" in 28ms.
cleaned_orders - STEP_START - Started execution of step "cleaned_orders".
cleaned_orders - ASSET_MATERIALIZATION - Materialized value cleaned_orders.
cleaned_orders - STEP_SUCCESS - Finished execution of step "cleaned_orders" in 38ms.
daily_summary - STEP_START - Started execution of step "daily_summary".
daily_summary - ASSET_MATERIALIZATION - Materialized value daily_summary.
daily_summary - STEP_SUCCESS - Finished execution of step "daily_summary" in 37ms.
RUN_SUCCESS - Finished execution of run for "__ASSET_JOB".
```

Each asset ran in its own subprocess, in dependency order — `raw_orders` before `cleaned_orders`
before `daily_summary`, never out of sequence. The three output files confirm the actual data, not
just a green log line:

```bash
cat out/raw_orders.json out/cleaned_orders.json out/daily_summary.json
```

```json
[{"id":1,"customer":"acme","amount":120.0},{"id":2,"customer":"acme","amount":45.5},{"id":3,"customer":"globex","amount":-10.0},{"id":4,"customer":"globex","amount":80.0},{"id":5,"customer":"initech","amount":200.0}]
[{"id":1,"customer":"acme","amount":120.0},{"id":2,"customer":"acme","amount":45.5},{"id":4,"customer":"globex","amount":80.0},{"id":5,"customer":"initech","amount":200.0}]
{"acme":165.5,"globex":80.0,"initech":200.0}
```

**Pass condition:** `cleaned_orders` has 4 rows, not 5 — order `id: 3` (amount `-10.0`) is gone —
and `daily_summary`'s `globex` total is `80.0`, not `70.0`, because the dropped row's `-10.0` is not
subtracted, simply absent. A pipeline that "ran successfully" but produced `globex: 70.0` would mean
the negative row was summed instead of filtered — the kind of silently-wrong result a green log
alone would never catch.

## `DAGSTER_HOME` — where run history actually lives

```bash
.venv/bin/dagster run list
```

```

```

Empty — not an error, just nothing. The materialize run above genuinely succeeded and genuinely
wrote three files, but with no `DAGSTER_HOME` set, Dagster uses a **temporary instance discarded
when the process exits** — the files it wrote survive because they're the pipeline's own output,
not Dagster's bookkeeping about the run itself. Set the environment variable and persistence
follows:

```bash
export DAGSTER_HOME=$(pwd)/dagster_home
mkdir -p "$DAGSTER_HOME"
cat > "$DAGSTER_HOME/dagster.yaml" <<'EOF'
telemetry:
  enabled: false
EOF
.venv/bin/dagster asset materialize --select "*" -f assets.py
.venv/bin/dagster run list
```

```
Run: f1c3c1ee-26ce-4a9c-9d62-b94da92c82b2
     Job: __ASSET_JOB
```

**Pass condition:** `dagster run list` names an actual run ID, not an empty response. `dagster.yaml`
under `DAGSTER_HOME` is also where the telemetry opt-out goes — Dagster prints a notice about
anonymous usage statistics on first run and names this exact file for disabling it.

## `dagster dev` — the local webserver and daemon

```bash
DAGSTER_HOME=$(pwd)/dagster_home .venv/bin/dagster dev -f assets.py -p 3131 -h 127.0.0.1
```

```
Instance is configured with the following daemons: ['AssetDaemon', 'BackfillDaemon',
'FreshnessDaemon', 'QueuedRunCoordinatorDaemon', 'SchedulerDaemon', 'SensorDaemon']
Serving dagster-webserver on http://127.0.0.1:3131 in process 80073
```

Verified from the command line, not a browser — the point of this pass was confirming the server
and its GraphQL API actually work, not touring the UI:

```bash
curl -sS http://127.0.0.1:3131/server_info
```

```json
{"dagster_webserver_version":"1.13.18","dagster_version":"1.13.18","dagster_graphql_version":"1.13.18"}
```

```bash
curl -sS -X POST http://127.0.0.1:3131/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ assetsOrError { ... on AssetConnection { nodes { key { path } } } } }"}'
```

```json
{"data":{"assetsOrError":{"nodes":[{"key":{"path":["cleaned_orders"]}},{"key":{"path":["daily_summary"]}},{"key":{"path":["raw_orders"]}}]}}}
```

All three assets, returned by the same GraphQL API the browser UI itself calls. This is also how a
CI smoke-test or a health check would confirm a Dagster deployment is actually serving, without a
browser in the loop — the same principle [[bruno-api-client]] applies to `hello-api`.

## Where this bit us

**Run history disappears silently without `DAGSTER_HOME`.** Nothing errors, nothing warns at the
point it matters — `dagster run list` just returns nothing, which reads as "no runs happened" rather
than "no runs were recorded." The pipeline's actual output (the JSON files) is real either way; only
Dagster's own bookkeeping about the run — timing, logs, status — is what's ephemeral. Set
`DAGSTER_HOME` before the first real run, not after noticing history is missing.

**Every CLI command exercised here prints a `SupersessionWarning` pointing at a tool that is not
installed by default.** `dagster asset materialize`, `dagster definitions validate`, and
`dagster dev` each warn that they are superseded by `dg launch`, `dg check defs`, and `dg dev`
respectively — but `dg` lives in a separate package (`dagster-dg-cli`) that `pip install dagster
dagster-webserver` does not pull in:

```bash
.venv/bin/dg --version
```

```
no such file or directory: .venv/bin/dg
```

The commands documented above still work correctly on 1.13.18 and are what a plain `pip install
dagster` actually gives you — but expect the warning on every invocation, and expect `dg` to be the
answer if a future Dagster major version removes what is documented here.

**`dagster run list` does not take `-f`.** Unlike `asset materialize` and `definitions validate`,
which need `-f assets.py` to know what code to load, `run list` reads from the instance
(`DAGSTER_HOME`) and has no code-location flag — passing `-f` to it fails with `Error: No such
option '-f'`, a reasonable but easy assumption to carry over from the other commands.

## Verification checklist

- [x] `dagster --version` reports a version with no account or config step
- [x] `dagster definitions validate` passes clean on a correct `assets.py`
- [x] The same command fails with a precise `NameError` and file/line pointer on a broken dependency reference — **broken on purpose to confirm**
- [x] `dagster asset materialize --select "*"` runs all three assets in dependency order
- [x] The materialized output is correct, not just present — the negative-amount row is dropped, and the downstream total reflects the drop rather than summing it
- [x] `dagster run list` is empty with no `DAGSTER_HOME`, and shows a real run ID once it is set — **both states observed**
- [x] `dagster dev` starts a webserver reachable by `curl`, and its GraphQL API returns the real asset graph

## Rollback

Everything lives under the scratch directory and its venv:

```bash
rm -rf .venv dagster_home out
```

If `dagster dev` is still running, stop it before deleting `dagster_home` out from under it:

```bash
pkill -f "dagster dev"
```

## Follow-ups

- [ ] Exercise the actual browser UI — asset graph visualization, the run timeline, and the launchpad were never opened, only queried via `curl`/GraphQL
- [ ] Try `dg` (`pip install dagster-dg-cli`) against the same `assets.py` and compare its output to the commands documented here
- [ ] Add a schedule or sensor — this pipeline only runs on manual/CLI trigger; `AssetDaemon` and `SensorDaemon` started with `dagster dev` but nothing here exercises them
- [ ] Deploy to the on-prem cluster alongside [[airflow-orchestration-onprem]] and compare the two orchestrators on the same hardware, rather than only on paper

## Related

[[airflow-orchestration-onprem]] — the other orchestrator documented in this repo, targeting the on-prem Kubernetes cluster rather than a local venv; drafted but not yet run, unlike this document.
[[bruno-api-client]] — the same "verify a local service via CLI/curl, not a browser" approach applied to `hello-api` instead of Dagster's webserver.
[[gitlab-ci-argocd-fastapi-onprem]] — a `dagster definitions validate` step would fit the same place in a CI pipeline that this document's [[gitlab-ci-argocd-fastapi-procedure]] gives to `pytest` and `ruff`.
[[dbt-duckdb-local]] — the same orders dataset and the same bad row, expressed as SQL models with tests instead of assets; `dagster-dbt` merges the two graphs into one lineage.
[[dagster-dbt-integration]] — that merge actually done: dbt models become Dagster assets and dbt's ref() graph becomes the lineage.
