---
title: dbt with DuckDB locally — models, tests, and why `dbt build` is not `dbt run`
date: 2026-08-20
domain: install
tags: [data-platform, transformation, data-quality, python]
stack: [dbt, duckdb, python]
summary: A five-file dbt project on DuckDB, transforming raw orders into a per-customer mart with built-in tests. The finding is measured, not asserted — with one bad row, `dbt build` exits 1 and refuses to build the mart, while `dbt run` exits 0 and silently ships a wrong total.
source: handson
env: dbt-core 1.12.3 · dbt-duckdb 1.11.0 · DuckDB 1.5.5 · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-20
verifiability: partial
verifiability-note: Verified against a local DuckDB file. Warehouse-specific behaviour (Snowflake/BigQuery/Postgres adapters), incremental models, snapshots and `dbt docs` are unexercised here.
duration: 20–30 min
risk: low
---

> **Verified 2026-08-20.** Every command and every number below was run. The wrong total in
> [Where this bit us](#where-this-bit-us) is the value DuckDB actually returned, not an illustration.

The repo already has orchestration ([[dagster-local-quickstart]], [[airflow-orchestration-onprem]]),
compute ([[spark-on-k8s-onprem]], [[trino-query-engine-onprem]]) and storage
([[garage-object-storage-onprem]]). dbt is the transformation layer between them: SQL models with
dependencies, plus tests that run in the same graph rather than after it.

DuckDB makes this a local exercise — no warehouse, no credentials, no cluster. The same project
files point at Postgres or Snowflake by editing `profiles.yml` alone.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install dbt-duckdb
.venv/bin/dbt --version
```

```
Core:
  - installed: 1.12.3
Plugins:
  - duckdb: 1.11.0
```

## The whole project — five files

`dbt init` is interactive; for a project this size, writing the files is faster and reproducible.

```yaml title="dbt_project.yml"
name: orders_demo
version: "1.0"
profile: orders_demo
seeds:
  orders_demo:
    +schema: raw
```

```yaml title="profiles.yml"
orders_demo:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: orders.duckdb
```

`profiles.yml` normally lives in `~/.dbt/`. Keeping it in the project and exporting
`DBT_PROFILES_DIR=$(pwd)` keeps the lab self-contained — **do not commit a real one**, it is where
warehouse credentials go.

```text title="seeds/raw_orders.csv"
id,customer,amount
1,acme,120.0
2,acme,45.5
3,globex,-10.0
4,globex,80.0
5,initech,200.0
```

Row 3 is invalid on purpose — the same deliberately-bad dataset [[dagster-local-quickstart]] uses,
so the two documents' outputs are directly comparable.

```sql title="models/stg_orders.sql"
select id, customer, amount
from {{ ref('raw_orders') }}
where amount > 0
```

```sql title="models/customer_totals.sql"
select customer, sum(amount) as total
from {{ ref('stg_orders') }}
group by customer
```

**`ref()` is the entire dependency mechanism.** dbt reads it to build the DAG and to decide
execution order — nothing declares "customer_totals depends on stg_orders" anywhere else.

```yaml title="models/schema.yml"
version: 2
models:
  - name: stg_orders
    columns:
      - name: id
        data_tests: [unique, not_null]
      - name: customer
        data_tests: [not_null]
  - name: customer_totals
    columns:
      - name: customer
        data_tests: [unique, not_null]
```

`unique`, `not_null`, `accepted_values` and `relationships` are built in — no package needed. For
anything else, a **singular test** is just a query that must return zero rows:

```sql title="tests/no_negative_amounts.sql"
select id, amount
from {{ ref('stg_orders') }}
where amount <= 0
```

## Build it

```bash
export DBT_PROFILES_DIR=$(pwd)
.venv/bin/dbt build
```

```
1 of 9 OK loaded seed file main_raw.raw_orders .................. [INSERT 5 in 0.04s]
2 of 9 OK created sql view model main.stg_orders ................ [OK in 0.03s]
3 of 9 PASS no_negative_amounts ................................. [PASS in 0.02s]
4 of 9 PASS not_null_stg_orders_customer ........................ [PASS in 0.01s]
5 of 9 PASS not_null_stg_orders_id .............................. [PASS in 0.01s]
6 of 9 PASS unique_stg_orders_id ................................ [PASS in 0.01s]
7 of 9 OK created sql view model main.customer_totals ........... [OK in 0.01s]
8 of 9 PASS not_null_customer_totals_customer ................... [PASS in 0.01s]
9 of 9 PASS unique_customer_totals_customer ..................... [PASS in 0.01s]

Done. PASS=9 WARN=0 ERROR=0 SKIP=0 NO-OP=0 REUSED=0 TOTAL=9
```

**Read the step numbers, not just the summary.** Steps 3–6 are `stg_orders`'s tests, and they run
*before* step 7 builds `customer_totals`. `dbt build` interleaves tests into the DAG; a model is
only built once its inputs have passed. That ordering is the entire point of the next section.

```
('acme', 165.5), ('globex', 80.0), ('initech', 200.0)
```

`globex` is `80.0` — the `-10.0` row was filtered out by `stg_orders`.

## Verification checklist

- [x] `dbt build` on clean data reports `PASS=9 ERROR=0` and exits `0`
- [x] `customer_totals` returns `globex = 80.0`, proving the bad row was excluded
- [x] Tests for `stg_orders` execute at steps 3–6, *before* `customer_totals` is built at step 7
- [x] With the filter removed, the singular test reports `FAIL 1` and `dbt build` exits `1` — **broken on purpose to confirm**
- [x] With the same bad data, `dbt run` exits `0` and writes a wrong total — the failure case the checklist exists to catch

## Rollback

```bash
rm -rf .venv orders.duckdb target logs
```

## Where this bit us

**`dbt run` exits `0` on data it should have rejected, and ships a wrong number.** Removing the
`where amount > 0` filter so the `-10.0` row flows through, the two commands were run against
identical data:

| Command | Exit code | `customer_totals` |
|---|---|---|
| `dbt build` | `1` | **not built** — `SKIP relation main.customer_totals` |
| `dbt run` | `0` | built, and `globex` = `70.0` |

The correct answer is `80.0`. `dbt run` summed the invalid `-10.0` into the mart, reported success,
and left a plausible-looking total that nothing downstream would question. `dbt build` refused to
build the mart at all, because `stg_orders`'s test failed first — and skipping is the point: no
stale-but-wrong table gets published.

**`dbt run && dbt test` is not equivalent to `dbt build`, even though it looks like it.** Tests run
after every model is already written, so a failing test tells you the bad data is *already in the
warehouse*. Use `dbt build` in CI; the `run`/`test` split is for interactive work where you want the
tables regardless.

**A piped exit code is not the command's exit code.** `dbt build 2>&1 | tail -22` reported `EXIT=0`
on the failing run — that is `tail`'s status, not dbt's. Checking `dbt build >/dev/null 2>&1; echo $?`
gave the real answer, `1`. Worth knowing before wiring this into a pipeline and concluding dbt does
not signal failure. Same class of mistake as the port collision in [[bruno-api-client]]: the check
looked fine because it was measuring the wrong thing.

## Follow-ups

- [ ] Point `profiles.yml` at the CloudNativePG instance from [[postgresql-cnpg-onprem]] and confirm the identical project files run unchanged against a real warehouse
- [ ] Add an incremental model and a snapshot — neither is exercised here, and both are where dbt's state handling actually gets hard
- [ ] Run `dbt build` as a stage in [[gitlab-ci-argocd-fastapi-procedure]]'s pipeline, which already has the JUnit-report pattern from [[bruno-api-client]] to copy
- [x] Orchestrate this from [[dagster-local-quickstart]] with `dagster-dbt`, so the dbt DAG and the asset graph are one lineage instead of two — done in [[dagster-dbt-integration]]

## Related

[[dagster-local-quickstart]] — same orders dataset and the same deliberately-bad row, orchestrated as assets rather than SQL models.
[[trino-query-engine-onprem]] — the query engine a warehouse-backed version of this would target instead of a local DuckDB file.
[[postgresql-cnpg-onprem]] — the on-prem database this project could point at by editing `profiles.yml` alone.
[[bruno-api-client]] — the same lesson about a check that measures the wrong thing and passes anyway.
[[dagster-dbt-integration]] — this project wired into Dagster, where each model becomes an asset and a failing test keeps the mart out of the catalog.
