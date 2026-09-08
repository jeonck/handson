---
title: Flink event-time windows — records that vanish, a job that emits nothing, and the same data giving two answers
date: 2026-09-08
domain: install
tags: [streaming, event-time, watermark, kafka]
stack: [apache-flink, flink-sql, kafka, podman, docker-compose]
summary: A Flink cluster and streams whose correct answers are countable by hand, first on a file source and then on Kafka. A two-second watermark drops two records while the job reports RUNNING; an empty Kafka partition pins the watermark at Long.MIN_VALUE so nothing is dropped and nothing is emitted; replaying a topic from the beginning gives a different answer from consuming it live; and a TaskManager killed mid-stream recovers to exactly ten records per window, while the control meant to prove that turns out to measure the sink's commit protocol instead.
source: handson
env: Apache Flink 2.0.2 (apache/flink:2.0, arm64) · Flink SQL Client · filesystem connector · flink-sql-connector-kafka 4.0.1-2.0 · Apache Kafka 4.0.0 (KRaft, single broker) · Podman 5.7.1 with docker-compose · macOS 26.6.2 arm64
verified: 2026-09-08
verifiability: partial
verifiability-note: Sections 1–6 use a filesystem source paced by a shell loop, so arrival order there is controlled rather than realistic; section 7 repeats the findings on a single-broker Kafka with two partitions, which exercises offsets and idle partitions but not replication, rebalance or a multi-broker failure. Section 8 recovers a killed TaskManager from a checkpoint and gets exact counts, but its control was confounded by the sink's commit protocol and so isolates neither state recovery nor duplicate suppression on its own. Every parallelism result is two subtasks on one TaskManager rather than a distributed cluster.
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

## 7. The same pipeline on Kafka, where the source decides the answer

The filesystem source could not distinguish a backlog from a live stream, because the pacing was a
shell loop rather than a property of the source. Kafka can, and the difference turns out to change the
result.

Add a broker and the connector — the Flink image does not carry it, and mounting the single JAR is
enough:

```yaml title="compose.yml (added)"
  kafka:
    image: docker.io/apache/kafka:4.0.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
```

```yaml title="compose.yml (both Flink services)"
    volumes:
      - "./data:/data"
      - "./lib/flink-sql-connector-kafka-4.0.1-2.0.jar:/opt/flink/lib/flink-sql-connector-kafka-4.0.1-2.0.jar"
```

**Mount the file, not the directory.** A volume over `/opt/flink/lib` hides the image's own JARs, and
`/opt/flink/lib/ext` is not scanned — Flink reads that one directory and no deeper. The version is
`4.0.1-2.0`: connectors are released separately from Flink and the suffix is the Flink minor they
target, so it is worth reading the Maven metadata rather than guessing.

```sql title="the source, replacing the filesystem table"
CREATE TABLE clicks (
  ts TIMESTAMP(3),
  k  STRING,
  WATERMARK FOR ts AS ts - INTERVAL '2' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'clicks',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'g1',
  'scan.startup.mode' = 'latest-offset',
  'format' = 'csv'
);
```

### An empty partition stops the job without stopping it

The topic has two partitions, and every record carries the same key, so all twelve land in one:

```bash
kafka-get-offsets.sh --bootstrap-server kafka:9092 --topic clicks
```

```
  clicks:0:0
  clicks:1:12
```

At `parallelism.default = 2` each source subtask owns one partition. The one reading partition 1 is
perfectly healthy:

```
  0.Source__clicks[1].numRecordsIn         = 12
  0.Source__clicks[1].currentOutputWatermark = 1788825623000   (00:00:23)
```

The window operator is not:

```
  0.GlobalWindowAggregate[5].numRecordsIn        = 12
  0.GlobalWindowAggregate[5].numRecordsOut       = 0
  0.GlobalWindowAggregate[5].numLateRecordsDropped = 0
  0.GlobalWindowAggregate[5].currentInputWatermark = -9223372036854775808
```

```
  sink rows: 0        job state: RUNNING
```

**Every record arrived, none was dropped, none came out, and nothing is wrong.** The subtask reading
the empty partition never emits a watermark, a downstream watermark is the minimum over its inputs,
and the minimum of `00:00:23` and `Long.MIN_VALUE` is `Long.MIN_VALUE` — forever.

This is worse than section 4. There the loss was two records and a metric named it; here **the loss is
the entire output**, and `numLateRecordsDropped = 0` actively reassures you. The only honest signal is
a watermark that is not a timestamp.

```sql
SET 'table.exec.source.idle-timeout' = '5s';
```

```
  "2026-09-08 00:00:00",a,4
  "2026-09-08 00:00:00",b,2
  "2026-09-08 00:00:10",a,2
  "2026-09-08 00:00:10",b,2
```

A subtask that has produced nothing for five seconds is marked idle and dropped out of the minimum.
**A partition that is merely quiet is indistinguishable from one that is slow**, which is why this is
a timeout you choose rather than a default you get.

### Replaying the topic gives a different answer from consuming it live

Look again at what the fix produced: `a=4, b=2` — the hand-counted answer, with **zero** late drops.
Section 4 lost two records from exactly this data.

The difference is not the watermark, the SQL, or the broker. It is that the twelve records were
already sitting in the topic and `scan.startup.mode = 'earliest-offset'` read the whole backlog faster
than a watermark could be emitted between them.

Starting at `latest-offset` and producing one record per second into the running job:

```
  "2026-09-08 00:00:00",a,3
  "2026-09-08 00:00:00",b,1
  "2026-09-08 00:00:10",a,2
  "2026-09-08 00:00:10",b,2
```

```
  0.GlobalWindowAggregate[5].numLateRecordsDropped = 2
  1.GlobalWindowAggregate[5].numLateRecordsDropped = 0
```

```
  backlog replay (earliest-offset)  ->  a=4, b=2   0 dropped
  live stream    (latest-offset)    ->  a=3, b=1   2 dropped
```

**Same records, same SQL, same watermark bound, two different answers**, decided only by whether the
data was already in the topic when the job started.

The operational consequence is the one worth carrying: **reprocessing a topic from the beginning does
not reproduce what the live job computed.** A backfill run is faster than real time, so records that
were late in production are not late in the replay, and the "corrected" numbers a replay produces are
a different measurement rather than a better one. Comparing the two is a way to size how much
lateness a pipeline is actually absorbing.

## 8. Killing the TaskManager mid-stream

The exactly-once claim is the reason people accept the operational weight of Flink, and it has a
property that can be checked exactly. Sixty events, one per second of event time from `00:00:00` to
`00:00:59`, produced into Kafka four per second:

```
  six 10-second windows, ten records each — the hand-counted answer
```

**Any duplicate pushes a window above ten and any loss below it**, so the check needs no
interpretation.

```yaml title="compose.yml (added to both Flink services)"
        state.backend.type: hashmap
        state.checkpoints.dir: file:///data/ckpt
        execution.checkpointing.interval: 2s
        restart-strategy.type: fixed-delay
        restart-strategy.fixed-delay.attempts: 100
        restart-strategy.fixed-delay.delay: 5 s
```

**Without an explicit restart strategy the job does not come back**, and the checkpoint it would have
recovered from is irrelevant. Both settings are needed for this to be a recovery test rather than a
crash test.

```bash
# producer runs; eight seconds in, the TaskManager is killed and restarted five seconds later
podman kill  flink-taskmanager-1
podman start flink-taskmanager-1
```

```
  [16:56:21] producer started (60 records, 0.25s apart)
  [16:56:29] killing taskmanager mid-stream
  [16:56:35] taskmanager restarted
  [16:56:38] producer finished
```

Kafka kept accepting throughout — `kafka-get-offsets.sh` reports `ck:0:60` — so roughly twenty records
were written while Flink had nowhere to run.

### The result

```
  "2026-09-08 00:00:00",a,10
  "2026-09-08 00:00:10",a,10
  "2026-09-08 00:00:20",a,10
  "2026-09-08 00:00:30",a,10
  "2026-09-08 00:00:40",a,10
```

```
  checkpoints: 40 completed · 8 failed · restored = True
  restored from: file:/data/ckpt/fc4143b9ebd0.../chk-23
```

**Five windows, ten each, exact.** The eight failed checkpoints are the outage; the restore is the
recovery. And the ledger closes on sixty again: fifty emitted, ten held in `[00:00:50, 00:01:00)`,
which needs a watermark of `00:01:00` and has `00:00:57`.

**The recovery demonstrably did work rather than being unnecessary.** With no checkpoint to restore,
this source restarts at `latest-offset` — the twenty-odd records produced during the five-second
outage would have been skipped and the windows spanning them would have come in under ten. They did
not.

### The control did not isolate what it was meant to

The same run with `execution.checkpointing.interval` set to `1 h`, so that no checkpoint completes:

```
  checkpoints: 0 completed · 0 failed · restored = False
  sink output: no committed files
```

That looks like a clean contrast and it is the wrong explanation. The output directory is not empty:

```
  .part-bf54a269-…-0-0.inprogress.b65edf68-…
  .part-bf54a269-…-0-0.inprogress.da99a795-…
```

**Two in-progress files and nothing committed.** The filesystem sink stages rows and publishes them on
checkpoint, so with checkpointing off it never publishes anything — crash or no crash. The zero output
is the sink's commit protocol, not lost state, and this control therefore says nothing about state
recovery.

It says something else worth knowing: **turning checkpointing off does not merely remove recovery, it
stops the sink producing output at all.** A pipeline that appears to be running and writing while its
output directory holds only dotfiles is this configuration, and `ls` without `-a` shows an empty
directory.

Isolating state recovery needs a sink that commits without checkpoints — `print`, or a Kafka sink at
at-least-once — and that run is in the follow-ups rather than described here as though it had been
done.

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
- [x] `apache/kafka:4.0.0` publishes an **arm64** manifest, and the connector for Flink 2.0 is **`4.0.1-2.0`**
- [x] Mounting the connector at `/opt/flink/lib/ext` does nothing; the single-file mount into `/opt/flink/lib` works
- [x] With one key, `kafka-get-offsets.sh` shows **`clicks:0:0` and `clicks:1:12`** — one partition empty by construction
- [x] In that state the window operator has `numRecordsIn 12`, `numRecordsOut 0`, `numLateRecordsDropped 0` and watermark **`Long.MIN_VALUE`**, with the job `RUNNING` and the sink empty
- [x] `table.exec.source.idle-timeout = 5s` releases it and the sink emits four rows
- [x] Backlog replay from `earliest-offset` yields **`a=4, b=2` with 0 drops**; live consumption from `latest-offset` at one record per second yields **`a=3, b=1` with 2 drops** — same records, same SQL, same bound
- [x] Sixty events over six windows give a hand-counted answer of **ten per window**, so a duplicate or a loss is visible without interpretation
- [x] Killing the TaskManager mid-stream and restarting it leaves five closed windows at **exactly ten each**
- [x] The job reports **`restored = True`** from `chk-23`, with 40 checkpoints completed and 8 failed across the outage
- [x] The ledger closes at 60: fifty emitted plus ten held in the unclosed `[00:00:50, 00:01:00)`
- [x] With `execution.checkpointing.interval` at `1 h` the sink commits **nothing** and leaves two `.inprogress` dotfiles — the filesystem sink publishes on checkpoint, so this control does **not** isolate state recovery

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

- [ ] Measure the backlog-versus-live gap as a number on a real topic — the ratio of records late under live consumption to records late under replay is a direct reading of how much lateness a pipeline absorbs

- [ ] Recover the two dropped records instead of only counting them — the DataStream API has a late side output, and Flink SQL does not, so measure what `table.exec.emit.allow-lateness` actually does to the result
- [ ] Repeat section 8's control with a sink that commits without checkpoints — `print`, or Kafka at at-least-once — which is the run that would actually isolate state recovery from the sink's commit protocol
- [ ] Chart `numLateRecordsDropped` against the watermark bound over several values, to turn the latency/completeness trade in section 5 into a curve rather than two points

## Related

[[kafka-strimzi-onprem]] — the broker this pipeline should read from, and where partition ordering starts to matter.
[[prometheus-instrument-and-query]] — where `numLateRecordsDropped` belongs once the job is not being watched by hand.
[[grafana-correlate-three-signals]] — the dashboard that would have to show this metric for the drop to be noticed at all.
[[valkey-redis-dragonfly-on-kubernetes]] — another page whose headline is a component reporting healthy while refusing work.
