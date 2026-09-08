---
title: Flink event-time windows — two records vanish, the job stays RUNNING, and one metric says so
date: 2026-09-08
domain: install
tags: [streaming, event-time, watermark, sql]
stack: [apache-flink, flink-sql, podman, docker-compose]
summary: A two-container Flink cluster and a twelve-event stream whose correct answer is countable by hand. With a two-second watermark the job emits eight of the twelve records, drops two, and reports RUNNING with no error anywhere — the only signal is numLateRecordsDropped. Widening the watermark recovers them and delays every window, and raising parallelism to two moves the watermark four seconds further behind on identical input.
source: handson
env: Apache Flink 2.0.2 (apache/flink:2.0, arm64) · Flink SQL Client · filesystem connector · Podman 5.7.1 with docker-compose · macOS 26.6.2 arm64
verified: 2026-09-08
verifiability: partial
verifiability-note: A filesystem source paced by one file per second stands in for a real broker, so the arrival ordering is controlled rather than realistic and nothing here exercises Kafka offsets, partitions or replay. Checkpoint recovery, exactly-once sink semantics and a genuinely idle source partition are all untested; the parallelism result is two subtasks on one TaskManager, not a distributed cluster.
duration: 60–90 min
risk: low
---

> **Verified 2026-09-08.** Every count below was produced by the pipeline shown, against an input
> whose correct answer was computed by hand first.

Event time is the reason to use Flink rather than a cron job over batches, and it is also where a
stream pipeline goes wrong quietly. **A record that arrives after the watermark has passed its window
is dropped. Not failed, not logged, not retried — dropped**, while every dashboard the job exposes
says it is healthy.

This page builds the smallest pipeline that shows it, on an input small enough to count by hand.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Podman | `podman --version` | 5.x |
| Compose | `podman compose version` | present |
| Image | `podman manifest inspect docker.io/apache/flink:2.0` | includes `arm64` |

Nothing else. **The Flink image carries its own JVM and SQL client**, so no Java and no Python on the
host — which is the reason this page is SQL rather than PyFlink. The image has no Python at all, and
`java -version` on this Mac reports `Unable to locate a Java Runtime`.

## 1. A cluster in two containers

```yaml title="compose.yml"
services:
  jobmanager:
    image: docker.io/apache/flink:2.0
    command: jobmanager
    ports: ["8081:8081"]
    environment:
      FLINK_PROPERTIES: |
        jobmanager.rpc.address: jobmanager
        rest.address: 0.0.0.0
    volumes: ["./data:/data"]
  taskmanager:
    image: docker.io/apache/flink:2.0
    command: taskmanager
    depends_on: [jobmanager]
    environment:
      FLINK_PROPERTIES: |
        jobmanager.rpc.address: jobmanager
        taskmanager.numberOfTaskSlots: 4
    volumes: ["./data:/data"]
```

```bash
podman compose up -d
curl -s http://127.0.0.1:8081/overview
```

```json
{"taskmanagers": 1, "slots-total": 4, "jobs-running": 0, "flink-version": "2.0.2"}
```

**Wait for `taskmanagers: 1`, not for the containers to start.** The first poll after `up -d` returns
`taskmanagers: 0` because the TaskManager has not registered yet; a job submitted then sits waiting
for slots rather than failing, which looks like a hung job.

## 2. Twelve events whose answer is known

```csv title="events.txt"
2026-09-08 00:00:01,a
2026-09-08 00:00:03,a
2026-09-08 00:00:05,b
2026-09-08 00:00:08,a
2026-09-08 00:00:12,a
2026-09-08 00:00:14,b
2026-09-08 00:00:04,a     <- arrives 7th, belongs in the first window
2026-09-08 00:00:16,a
2026-09-08 00:00:18,b
2026-09-08 00:00:09,b     <- arrives 10th, belongs in the first window
2026-09-08 00:00:21,a
2026-09-08 00:00:25,a
```

Ten-second tumbling windows, counted by hand before running anything:

```
  [00:00:00, 00:00:10)  total 6   (a=4, b=2)
  [00:00:10, 00:00:20)  total 4   (a=2, b=2)
  [00:00:20, 00:00:30)  total 2   (a=2)
                        ------
                        12 rows
```

**Computing the expected answer first is the whole method here.** A streaming result that is merely
plausible cannot be checked; one that must equal `a=4, b=2` can.

## 3. The pipeline

```sql title="wm2.sql"
SET 'parallelism.default' = '1';
SET 'execution.checkpointing.interval' = '2s';

CREATE TABLE clicks (
  ts   TIMESTAMP(3),
  k    STRING,
  WATERMARK FOR ts AS ts - INTERVAL '2' SECOND
) WITH (
  'connector' = 'filesystem',
  'path' = '/data/in',
  'format' = 'csv',
  'source.monitor-interval' = '1s'
);

CREATE TABLE counts (
  win_start TIMESTAMP(3), k STRING, n BIGINT
) WITH (
  'connector' = 'filesystem',
  'path' = '/data/out/wm2',
  'format' = 'csv',
  'sink.rolling-policy.rollover-interval' = '2s',
  'sink.rolling-policy.check-interval' = '1s'
);

INSERT INTO counts
SELECT window_start, k, COUNT(*)
FROM TABLE(TUMBLE(TABLE clicks, DESCRIPTOR(ts), INTERVAL '10' SECONDS))
GROUP BY window_start, window_end, k;
```

```bash
podman exec flink-jobmanager-1 ./bin/sql-client.sh -f /data/wm2.sql
```

**Use `-f` with a file, not `-e`.** `sql-client.sh -e "SELECT 1;"` opens the interactive result view
and never returns; it took a ten-minute timeout to notice. A file plus
`SET 'sql-client.execution.result-mode' = 'tableau';` prints and exits.

The source is a directory polled every second, and the events are fed one file per second:

```bash
n=0
while IFS= read -r line; do
  n=$((n+1)); printf '%s\n' "$line" > "data/in/e$(printf '%02d' $n).csv"; sleep 1
done < events.txt
```

**The pacing is load-bearing.** Written as one file, all twelve rows are read between two watermark
emissions and nothing is ever late — the pipeline would produce the right answer for the wrong reason.

## 4. What came out

```
  "2026-09-08 00:00:00",a,3      <- hand-counted answer: 4
  "2026-09-08 00:00:00",b,1      <- hand-counted answer: 2
  "2026-09-08 00:00:10",a,2      ✓
  "2026-09-08 00:00:10",b,2      ✓
```

**Two records are missing from the first window and nothing said so.** The job:

```
  state = RUNNING
    Source: clicks[1] -> WatermarkAssigner[2] -> Calc[3]     RUNNING
    GlobalWindowAggregate[6] -> Calc[7] -> StreamingFileWri   RUNNING
```

No failed task, no restart, no exception in the log. **The dashboard is not lying — it reports task
health, and the tasks are healthy.** Records leaving through the late path are not a task failure.

One metric names it:

```
  WatermarkAssigner[2].numRecordsIn        = 12
  GlobalWindowAggregate[6].numRecordsOut   = 4
  GlobalWindowAggregate[6].numLateRecordsDropped = 2
  WatermarkAssigner[2].currentOutputWatermark = 1788825623000   (00:00:23)
```

### The ledger closes, which is how you know the account is complete

```
  12 records in
   =  4  in window [00:00:00, 00:00:10)   (a=3, b=1)
   +  4  in window [00:00:10, 00:00:20)   (a=2, b=2)
   +  2  dropped as late
   +  2  still held in [00:00:20, 00:00:30), which needs watermark ≥ 00:00:30 and is at 00:00:23
   = 12
```

**Reconciling to the input count is the check.** "Four rows came out" is compatible with any amount of
loss; `4 + 4 + 2 + 2 = 12` is not. Without the unclosed-window term the missing four look like four
lost records, which is the wrong diagnosis and the wrong fix.

The final watermark is arithmetic you can verify: latest event `00:00:25` minus the two-second bound
is `00:00:23`, and `1788825623000` is exactly that instant.

## 5. Widening the watermark, and what it costs

The identical input and pacing, with `WATERMARK FOR ts AS ts - INTERVAL '10' SECOND`:

```
  "2026-09-08 00:00:00",a,4      ✓ matches the hand count
  "2026-09-08 00:00:00",b,2      ✓
```

```
  numLateRecordsDropped = 0
  currentOutputWatermark = 1788825615000   (00:00:15)
```

**Both records are back and one window has gone missing.** With a two-second bound the watermark
reached `00:00:23` and `[00:00:10, 00:00:20)` had already emitted; with ten seconds it sits at
`00:00:15` and that window has not closed. Nothing is lost — it is waiting.

**That is the trade, and it is not a tuning detail:** the watermark bound buys correctness with
latency, one second for one second. Choosing it means deciding how late a record may be and still
count, and the answer belongs to the business rather than to Flink.

## 6. The watermark is the minimum across subtasks

Same data, same two-second bound, `parallelism.default = 2`:

```
  "2026-09-08 00:00:00",a,3
  "2026-09-08 00:00:00",b,1
```

```
  0.WatermarkAssigner[2].numRecordsIn = 6      1.WatermarkAssigner[2].numRecordsIn = 6
  0.numLateRecordsDropped = 2                  1.numLateRecordsDropped = 0
  currentInputWatermark (min across subtasks) = 1788825619000   (00:00:19)
```

**One fewer window than the parallelism-1 run, from a configuration change alone.** The splits divided
six and six; the subtask that trailed pinned the global watermark at `00:00:19`, one second short of
the `00:00:20` that window `[00:00:10, 00:00:20)` needs.

The rule underneath: **a downstream operator's watermark is the minimum over its inputs**, so the
slowest source subtask sets the pace for the whole job. The same drop count with a later result is
the shape to expect when parallelism changes and output does not.

Worth noticing while reading these metrics:

```
  Source__clicks[1].currentOutputWatermark = -9223372036854775808
```

`Long.MIN_VALUE`, on a job that is working. **The source emits no watermark; the `WatermarkAssigner`
does**, and reading the wrong operator's metric makes a healthy pipeline look stalled.

## Verification checklist

- [x] `apache/flink:2.0` publishes an **arm64** manifest, and `/overview` reports `flink-version 2.0.2`
- [x] The cluster is usable only once `taskmanagers` reaches **1**; it reads `0` immediately after `up -d`
- [x] The hand-counted answer is `[0,10) a=4 b=2`, `[10,20) a=2 b=2`, `[20,30) a=2`, **12 rows total**
- [x] With a 2-second watermark the sink emits **`a=3, b=1`** for the first window — two short
- [x] The job and both vertices report **`RUNNING`** in that state, with no failure or restart
- [x] `numRecordsIn` is **12** and `numLateRecordsDropped` is **2** on `GlobalWindowAggregate`
- [x] The ledger closes: **4 + 4 + 2 dropped + 2 in an unclosed window = 12**
- [x] `currentOutputWatermark` is `1788825623000` = **00:00:23**, exactly `max(ts) - 2s`
- [x] With a 10-second watermark the first window reads **`a=4, b=2`** and `numLateRecordsDropped` is **0**
- [x] In that run the watermark is **00:00:15** and window `[10,20)` has *not* emitted — the latency cost
- [x] At parallelism 2 the same input drops the same 2 records but the watermark reaches only **00:00:19**, emitting one window fewer
- [x] `Source__clicks[1].currentOutputWatermark` is **`Long.MIN_VALUE`** on a working job

## Rollback

```bash
podman compose down
rm -rf data/in data/out
```

Nothing is written outside the compose project directory.

## Where this bit us

**`sql-client.sh -e` hangs and gives no hint that it has.** It opens the interactive changelog viewer,
prints nothing, and waits — which read as a broken cluster rather than a wrong flag, and cost a
ten-minute command timeout before the shape of the problem was visible. `-f` on a file is the
non-interactive form.

**The REST API's `jobs[0]` was a finished smoke test, not the running pipeline.** Two `SELECT 1` jobs
from earlier were still in the job list, and reading metrics from the first entry produced
`metrics=0` and a vertex named `Source: Values[1]` — which looks like "this job has no metrics"
rather than "you are looking at the wrong job". **Filter by `state == RUNNING`**, and read the vertex
name back to confirm it is the pipeline you think it is.

**The first attempt at the parallelism section expected a total stall and did not get one.** The
hypothesis was that an idle subtask would pin the watermark at `Long.MIN_VALUE` and no window would
ever fire; what happened was a four-second lag and one fewer window. Both subtasks received splits, so
neither was idle. **The finding written up is the one that occurred**, and the genuinely idle case —
which needs a source partition that receives nothing at all — is in the follow-ups rather than
described as though it had been seen.

## Follow-ups

- [ ] Reproduce a truly idle source partition, with a broker topic whose partition receives no records, and confirm whether the watermark pins at `Long.MIN_VALUE` and `table.exec.source.idle-timeout` releases it
- [ ] Replace the filesystem source with Kafka and repeat sections 4–6, since arrival order there is a property of partitions and offsets rather than of a shell loop
- [ ] Recover the two dropped records instead of only counting them — the DataStream API has a late side output, and Flink SQL does not, so measure what `table.exec.emit.allow-lateness` actually does to the result
- [ ] Kill the TaskManager mid-stream and confirm from the checkpoint what the counts are after recovery, which is the claim about exactly-once this page does not test
- [ ] Chart `numLateRecordsDropped` against the watermark bound over several values, to turn the latency/completeness trade in section 5 into a curve rather than two points

## Related

[[kafka-strimzi-onprem]] — the broker this pipeline should read from, and where partition ordering starts to matter.
[[prometheus-instrument-and-query]] — where `numLateRecordsDropped` belongs once the job is not being watched by hand.
[[grafana-correlate-three-signals]] — the dashboard that would have to show this metric for the drop to be noticed at all.
[[valkey-redis-dragonfly-on-kubernetes]] — another page whose headline is a component reporting healthy while refusing work.
