---
title: Airflow 3 locally — the date your task gets is not the time it ran, and manual runs have none
date: 2026-08-28
domain: install
tags: [airflow, orchestration, scheduling, python, containers]
stack: [airflow, python, podman, docker-compose]
summary: A single-container Airflow 3.1.3 used to interrogate its own scheduling. A scheduled run reported logical_date 00:00:00 while executing at 04:31:09, a manual run of the same task died with KeyError 'logical_date' because Airflow 3 gives manual runs no logical date at all, and a DAG that has never run was parsed 1259 times in 90 seconds.
source: handson
env: Airflow 3.1.3 (apache/airflow image, `standalone`) · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-28
verifiability: partial
verifiability-note: One container running `airflow standalone` with the bundled SQLite metadata database and no external executor, so nothing here says anything about worker behaviour, parallelism or production deployment — [[airflow-orchestration-onprem]] covers that half. The date semantics and the manual-run KeyError are properties of the scheduler and reproduce anywhere. The parse-rate measurement is real and attributed but its cause was not established; it is reported as an observation, not an explanation.
duration: 40–60 min
risk: low
---

> **Verified 2026-08-28.** Every date, count and traceback below came from a running Airflow. The
> `KeyError` was produced by a task written the obvious way, and the parse count is a DAG that has
> never executed once.

[[airflow-orchestration-onprem]] is about getting Airflow onto a cluster — executors, the metadata
database, where logs go. This is the other half: **once it runs, the thing that catches people is
what a "date" means to a task**, and no amount of correct installation helps with that.

## One container, two DAGs

```yaml title="compose.yml"
services:
  airflow:
    image: docker.io/apache/airflow:3.1.3
    command: standalone
    environment:
      AIRFLOW__CORE__LOAD_EXAMPLES: "false"
      _AIRFLOW_WWW_USER_USERNAME: admin
      _AIRFLOW_WWW_USER_PASSWORD: ${AIRFLOW_ADMIN_PASSWORD:?set it before compose up}
    volumes:
      - ./dags:/opt/airflow/dags:z
      - airflow-db:/opt/airflow
    ports: ["8080:8080"]
```

`standalone` runs the api-server, scheduler, dag-processor and triggerer in one container against
SQLite. **It is not a deployment and it is the right shape for this** — the questions below are about
the scheduler, not about workers.

```
  {"version":"3.1.3", …}
  dag_id        | fileloc                            | is_paused
  interval_demo | /opt/airflow/dags/interval_demo.py | True
  parse_counter | /opt/airflow/dags/parse_counter.py | True
```

## The three dates

```python title="dags/interval_demo.py"
with DAG(
    dag_id="interval_demo",
    # Deliberately in the past: this is what makes catchup visible.
    start_date=pendulum.datetime(2026, 8, 25, tz="UTC"),
    schedule="@daily",
    catchup=False,
):

    @task
    def show(**ctx):
        print("logical_date        =", ctx["logical_date"])
        print("data_interval_start =", ctx["data_interval_start"])
        print("data_interval_end   =", ctx["data_interval_end"])
        print("run_id              =", ctx["run_id"])
        # The only line here that is 'now'.
        print("wall_clock_now      =", dt.datetime.now(dt.timezone.utc))
```

Unpausing it produced one scheduled run, and its output is the whole lesson:

```
logical_date        = 2026-08-28 00:00:00+00:00
data_interval_start = 2026-08-28 00:00:00+00:00
data_interval_end   = 2026-08-28 00:00:00+00:00
run_id              = scheduled__2026-08-28T00:00:00+00:00
wall_clock_now      = 2026-08-28 04:31:09.590646+00:00
```

**Four and a half hours separate the date the task was given from the moment it ran.** That gap is
not lag — it is the design. `logical_date` names *which slice of time this run is responsible for*,
and the run happens whenever the scheduler gets to it: on unpause, on a backfill, on a retry three
days later. A task that calls `datetime.now()` to decide which data to process produces a different
answer every time it is retried; a task that uses `logical_date` produces the same answer forever.

**That is the entire argument for idempotent tasks**, and it is why the retry button is safe in one
design and dangerous in the other.

`run_after` is the third date and the one that is genuinely "when should this start" — visible in the
run listing next to the logical date:

```
  run_id                                | state   | run_after                | logical_date
  scheduled__2026-08-28T00:00:00+00:00  | success | 2026-08-28T00:00:00Z     | 2026-08-28T00:00:00Z
  manual__2026-08-28T04:31:09.784268Z   | failed  | 2026-08-28T04:31:09.784Z |
```

Note the empty cell.

## Verification checklist

- [x] `airflow dags list` shows both DAGs with **no import errors**
- [x] A scheduled run reports `logical_date 00:00:00` while `wall_clock_now` is `04:31:09` — a 4.5 hour gap in one task's own output
- [x] `catchup=False` with a start date three days in the past produces **one** run, not three
- [x] A **manual** run of the identical task fails with `KeyError: 'logical_date'`, traced to the line that reads it
- [x] The manual run's `logical_date` column is **empty** in `dags list-runs`
- [x] `parse_counter`, with `schedule=None` and never triggered, is parsed **1259 times in 90 seconds**
- [x] Every one of those parses is a freshly forked `airflow dag-processor` process (`ppid=15`, pids incrementing)
- [x] `airflow config get-value dag_processor min_file_process_interval` reports **30** while that is happening

## Rollback

```bash
podman compose down -v
```

## Where this bit us

**A manually triggered run has no logical date, and the obvious code dies on it.** The same task that
succeeded on the scheduled run:

```
  exc_type:  KeyError
  exc_value: 'logical_date'
   at interval_demo.py line 19 | show
```

Not `None` — **absent from the context dictionary entirely.** In Airflow 2 every run had an
`execution_date`; in Airflow 3 a manual run is explicitly not associated with a data interval, so the
key is not there to read. Anything ported from 2.x that does `context["logical_date"]`,
`context["execution_date"]`, or templates `{{ ds }}` will work under the scheduler and fail the first
time someone clicks Trigger.

The fix is to treat it as optional and decide what a manual run should mean:

```python
logical = ctx.get("logical_date") or pendulum.now("UTC")
```

**Which is a decision, not a default** — "run it for now" and "refuse to run without a date" are both
defensible, and picking one deliberately is the point. The failure mode this replaces is a pipeline
that is correct on schedule and wrong every time a human intervenes, which is exactly when someone is
watching.

**`catchup=False` does not mean "no runs for the past".** The DAG's `start_date` was three days
earlier and unpausing produced a run immediately — one, for the current interval, not three. The
setting suppresses the *backfill* of missed intervals, and the first scheduled interval still fires
as soon as the DAG is unpaused. Expecting nothing to happen until the next midnight is the common
misreading, and on a DAG that writes somewhere it is the difference between a quiet afternoon and an
unexpected write.

**Top-level code runs constantly, for DAGs that never run at all.** `parse_counter` has
`schedule=None`, has never been triggered, and its module-level code appended a line every time the
file was parsed:

```python
# THIS IS TOP-LEVEL CODE. The dag-processor executes it every refresh interval,
# whether or not the DAG ever runs. Anything expensive here is paid all day.
with _marker.open("a") as fh:
    fh.write(...)
```

```
  total lines: 1259        (in 90 seconds)
        1 pid=9999 ppid=15 argv=…/airflow dag-processor
        1 pid=9997 ppid=15 argv=…/airflow dag-processor
        1 pid=9995 ppid=15 argv=…/airflow dag-processor
```

**Fourteen parses a second, each in a newly forked process**, attributed rather than guessed — the
marker records pid, ppid and argv, and every line is the dag-processor. Meanwhile:

```
  airflow config get-value dag_processor min_file_process_interval  ->  30
```

**Those two facts do not reconcile, and this page does not claim to explain them.** The configured
minimum is thirty seconds; the observed rate is thirty seconds' worth every two seconds. It may be
specific to `standalone`, to a two-file dags folder that completes a pass instantly, or a genuine
throttling bug — establishing which is the first follow-up. What is safe to take from it either way
is the shape of the risk: **a database call, an API request or a secrets lookup at module level in a
DAG file is executed by the scheduler on a cadence you did not choose, forever, whether or not the
DAG is ever scheduled.** Put that code inside a task, where it runs once per run and is retried
rather than repeated.

## Follow-ups

- [ ] Establish why parsing ran at ~14/s against `min_file_process_interval = 30` — compare `standalone` with a separately-run `airflow dag-processor`, and with a dags folder holding a hundred files
- [ ] Repeat the date experiment with `catchup=True` and a start date a week back, and count the runs the unpause creates
- [ ] Check what `{{ ds }}` and `{{ data_interval_start }}` render to in a manual run, since the `KeyError` above is the Python path and templates may fail differently
- [ ] Move the same DAGs onto the cluster from [[airflow-orchestration-onprem]] and confirm the semantics are identical under CeleryExecutor — they should be, and "should be" is why it is worth checking
- [ ] Write a task that is deliberately non-idempotent, retry it, and record the damage as the concrete case for using `logical_date`
- [ ] Measure the parse cost of a DAG file that opens a database connection at module level, which is the realistic version of `parse_counter`

## Related

[[airflow-orchestration-onprem]] — installing Airflow properly on a cluster; this page is what to know once it is running.
[[dagster-local-quickstart]] — the same problem framed as assets rather than schedules, where the date question mostly disappears.
[[dagster-dbt-integration]] — orchestrating dbt, and a failing test that stops the graph.
[[prometheus-instrument-and-query]] — the other page in this repo about a number that means something different from what it looks like.
