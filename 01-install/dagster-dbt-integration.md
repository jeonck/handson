---
title: dbt under Dagster — one lineage graph, and a failing test that stops the mart
date: 2026-08-21
domain: install
tags: [data-platform, orchestration, transformation, data-quality, python]
stack: [dagster, dagster-dbt, dbt, duckdb, python]
summary: Twenty lines of Dagster wire an existing dbt project in so each model becomes its own asset and dbt's ref() graph becomes Dagster's lineage. When a dbt test fails, the run fails and the downstream asset is never marked materialized — Dagster's catalog stays honest instead of showing a mart that was never rebuilt.
source: handson
env: dagster 1.13.18 · dagster-dbt 0.29.18 · dbt-core 1.11.14 · dbt-duckdb 1.11.0 · DuckDB · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-21
verifiability: partial
verifiability-note: Verified locally against DuckDB with `dagster dev` and the CLI. Not exercised — deploying this as a Dagster code location on Kubernetes, schedules/sensors driving the dbt assets, partitioned dbt models, or `dagster-dbt`'s asset-check translation of dbt tests into first-class Dagster asset checks.
duration: 20–30 min
risk: low
---

> **Verified 2026-08-21.** Both the passing and the failing path were run. The asset lists in
> [Where this bit us](#where-this-bit-us) are what Dagster actually recorded, not an illustration.

[[dbt-duckdb-local]] leaves dbt as its own graph with its own CLI, and
[[dagster-local-quickstart]] leaves Dagster with a hand-written asset graph. Running both means two
lineage graphs that know nothing about each other. `dagster-dbt` collapses that: **every dbt model
becomes a Dagster asset, and dbt's `ref()` calls become Dagster's dependency edges** — no second
DAG to declare or keep in sync.

This document assumes the dbt project from [[dbt-duckdb-local]] already exists, placed at `jaffle/`.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install dagster dagster-webserver dagster-dbt dbt-duckdb
```

```
dagster       1.13.18
dagster-dbt   0.29.18
dbt-core      1.11.14
dbt-duckdb    1.11.0
```

**`dagster-dbt` pins dbt-core down.** Installed on its own, dbt resolved to 1.12.3; adding
`dagster-dbt` 0.29.18 to the same environment pulled dbt-core back to 1.11.14. The integration
package, not dbt, decides the dbt version in a combined environment — worth knowing before
promising a team a specific dbt release.

## The whole integration — one file

```python title="definitions.py"
from pathlib import Path

from dagster import AssetExecutionContext, Definitions
from dagster_dbt import DbtCliResource, DbtProject, dbt_assets

dbt_project = DbtProject(
    project_dir=Path(__file__).parent / "jaffle",
    profiles_dir=Path(__file__).parent / "jaffle",
)
dbt_project.prepare_if_dev()


@dbt_assets(manifest=dbt_project.manifest_path)
def jaffle_dbt_assets(context: AssetExecutionContext, dbt: DbtCliResource):
    yield from dbt.cli(["build"], context=context).stream()


defs = Definitions(
    assets=[jaffle_dbt_assets],
    resources={"dbt": DbtCliResource(project_dir=dbt_project)},
)
```

Three things carry the whole integration:

- **`dbt.cli(["build"], ...)`** — `build`, not `run`. [[dbt-duckdb-local]] measured why: `run`
  publishes a mart from data its own tests would have rejected. That argument does not change
  because an orchestrator is now calling it.
- **`.stream()`** — turns each dbt event into a Dagster `AssetMaterialization` as it happens, which
  is what makes the models show up as individual assets rather than one opaque step.
- **`manifest=`** — dagster-dbt reads dbt's compiled `manifest.json` to learn the graph. Nothing
  about the models is declared twice.

## Generate the manifest before anything imports the file

```bash
cd jaffle && DBT_PROFILES_DIR=$(pwd) dbt parse
```

`prepare_if_dev()` generates the manifest automatically, but **only under `dagster dev`** — it is a
no-op for `dagster definitions validate`, `dagster asset materialize`, and any production code
location. Without a manifest those all fail at import:

```
dagster_dbt.errors.DagsterDbtManifestNotFoundError:
  .../jaffle/target/manifest.json does not exist.
```

The error names the missing file plainly, which is more than most import-time failures do. Run
`dbt parse` in the build step that packages the code location.

## Run it

```bash
export PATH="$(pwd)/.venv/bin:$PATH"
dagster asset materialize --select "*" -f definitions.py
```

```
1 of 9 OK loaded seed file main_raw.raw_orders ....... [INSERT 5 in 0.05s]
  ASSET_MATERIALIZATION - Materialized value raw raw_orders.
2 of 9 OK created sql view model main.stg_orders ..... [OK in 0.04s]
  ASSET_MATERIALIZATION - Materialized value stg_orders.
7 of 9 OK created sql view model main.customer_totals  [OK in 0.02s]
  ASSET_MATERIALIZATION - Materialized value customer_totals.
Done. PASS=9 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=9
RUN_SUCCESS
```

**`DbtCliResource` finds `dbt` on `PATH`, not in the running interpreter's environment.** Invoking
`.venv/bin/dagster` directly without activating the venv gives a pydantic validation error at import
time — `The dbt executable 'dbt' does not exist` — even though `dbt` is installed in that same venv.
Activate the venv, prepend it to `PATH` as above, or pass `DbtCliResource(..., dbt_executable=...)`.

## The lineage is real, not cosmetic

```bash
curl -sS -X POST http://127.0.0.1:3132/graphql -H 'content-type: application/json' \
  -d '{"query":"{ assetNodes { assetKey { path } dependencyKeys { path } } }"}'
```

```json
{"assetKey": {"path": ["raw", "raw_orders"]},   "dependencyKeys": []}
{"assetKey": {"path": ["stg_orders"]},          "dependencyKeys": [{"path": ["raw", "raw_orders"]}]}
{"assetKey": {"path": ["customer_totals"]},     "dependencyKeys": [{"path": ["stg_orders"]}]}
```

**Pass condition: the edges match the `ref()` calls in the SQL, and nothing declared them in
Python.** `raw_orders → stg_orders → customer_totals` is the dbt graph, read out of Dagster's API.
The seed carries a `raw` key prefix because `dbt_project.yml` sets `+schema: raw` — dbt's schema
config becomes the Dagster asset key prefix, so renaming a schema renames asset keys.

## Verification checklist

- [x] `dagster definitions validate` passes once the manifest exists — and fails with a named error when it does not, **confirmed by deleting it**
- [x] Each dbt model appears as its own Dagster asset, not one combined step
- [x] Asset dependencies match the `ref()` graph, with nothing declared twice
- [x] A clean run exits `0`, reports `PASS=9 ERROR=0`, and `customer_totals` returns `globex = 80.0`
- [x] A failing dbt test produces `STEP_FAILURE` + `RUN_FAILURE` and exit `1` — **broken on purpose to confirm**
- [x] On that failing run, `customer_totals` is **absent** from the materialized assets

## Rollback

```bash
rm -rf .venv dagster_home jaffle/target jaffle/orders.duckdb
```

## Where this bit us

**A failed dbt test must not leave the orchestrator thinking the mart was rebuilt — this is the
check worth keeping.** Removing the `where amount > 0` filter so the invalid row flows through, the
same command was run twice. Dagster recorded these materializations:

| Run | Exit | Assets Dagster marked materialized |
|---|---|---|
| bad data | `1` | `raw raw_orders`, `stg_orders` |
| clean | `0` | `raw raw_orders`, `stg_orders`, `customer_totals` |

`customer_totals` is missing from the failing run — dbt `SKIP`ped it, `.stream()` therefore never
emitted a materialization for it, and Dagster's catalog shows it as not-updated. **That is the whole
value of the integration**: the asset catalog and the warehouse agree about what is stale. Had this
been wired with `dbt run` instead of `dbt build`, dbt would have exited `0`, built the mart from bad
data, and Dagster would have cheerfully recorded a fresh materialization of a wrong table — the same
failure [[dbt-duckdb-local]] measured, now with an orchestrator vouching for it.

**`prepare_if_dev()` reads as "prepare the project" and is not.** It only acts under `dagster dev`.
Everything else — validate, materialize, a deployed code location — needs `dbt parse` to have run
first. The name suggests a safe default; the behaviour is a dev-only convenience.

## Follow-ups

- [ ] Translate dbt tests into first-class Dagster **asset checks** rather than plain step failures, so a failure is attributable to a specific asset in the UI
- [ ] Add a schedule and confirm a failing dbt test surfaces as an alert, not just a red run
- [ ] Deploy this as a code location on the on-prem cluster and confirm `dbt parse` in the image build is enough for the manifest
- [ ] Split the single `@dbt_assets` function by dbt selector so unrelated model groups can be materialized independently

## Related

[[dbt-duckdb-local]] — the dbt project wired in here, and where `dbt build` versus `dbt run` is measured.
[[dagster-local-quickstart]] — Dagster on its own, with hand-written Python assets instead of dbt models.
[[airflow-orchestration-onprem]] — the alternative orchestrator; the same dbt project would be driven by an operator there rather than becoming assets.
[[trino-query-engine-onprem]] — the warehouse a non-local version of this would target in place of DuckDB.
