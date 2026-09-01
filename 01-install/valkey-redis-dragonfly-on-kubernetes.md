---
title: Valkey, Redis and Dragonfly on Kubernetes — one manifest, three answers
date: 2026-08-31
domain: install
tags: [cache, kubernetes, compatibility, probes]
stack: [kubernetes, redis, valkey, dragonfly, kind, podman]
summary: The same Deployment run against Redis 8, Valkey 8 and Dragonfly on one kind cluster. Redis and Valkey answered twenty core commands identically down to the error strings, Dragonfly refused to start at all because its memory floor scales with the CPU limit, and all three sat Ready in the Service endpoints while rejecting every write.
source: handson
env: kind 0.32.0 on Podman 5.7.1 (applehv, 4 CPU / 6 GiB) · Kubernetes 1.36.1 · containerd 2.3.1 · arm64 · redis 8.10.1 · valkey 8.1.10 · dragonfly df-v1.40.1
verified: 2026-08-31
verifiability: partial
verifiability-note: One single-node arm64 kind cluster with 4 cores, so nothing here measures throughput — which is the entire reason Dragonfly exists, and four cores in a VM cannot settle it. Replication, failover, cluster mode and snapshot-format interop between engines are all unexercised; the RDB test used one engine's own file.
duration: 90–120 min
risk: low
---

> **Verified 2026-08-31.** Every command, error string and number below came off the cluster
> described in `env`. Two of the results contradict what this page set out to show, and both are
> written up as they came out.

Redis's 2024 licence change produced Valkey, the Linux Foundation fork, while Dragonfly arrived
separately as a multi-threaded engine speaking the same protocol. All three claim Redis API
compatibility. **This page runs one Deployment against all three and records where that claim stops
holding**, on Kubernetes specifically — probes, resource limits and readiness, not benchmarks.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster | `kubectl get nodes` | one `Ready` node |
| Provider | `podman machine list` | a running machine, ≥4 GiB |
| kind on podman | `echo $KIND_EXPERIMENTAL_PROVIDER` | `podman` |

## 1. One shape, three engines

The comparison only means something if the manifest is identical, so it is generated from a single
file with three substitutions.

```yaml title="base.yaml"
# Three engines, one shape. Anything that differs later is the engine's doing,
# not the manifest's — which is the only way the comparison means anything.
apiVersion: apps/v1
kind: Deployment
metadata: {name: ENGINE, labels: {app: ENGINE}}
spec:
  replicas: 1
  selector: {matchLabels: {app: ENGINE}}
  template:
    metadata: {labels: {app: ENGINE}}
    spec:
      containers:
        - name: server
          image: IMAGE
          args: ARGS
          ports: [{containerPort: 6379, name: resp}]
          resources:
            requests: {cpu: 200m, memory: 256Mi}
            limits:   {cpu: "2",   memory: 512Mi}
          readinessProbe:
            exec: {command: ["sh","-c","redis-cli -p 6379 PING | grep -q PONG"]}
            initialDelaySeconds: 2
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata: {name: ENGINE}
spec:
  selector: {app: ENGINE}
  ports: [{port: 6379, targetPort: 6379, name: resp}]
```

```bash
gen() { sed -e "s|ENGINE|$1|g" -e "s|IMAGE|$2|" -e "s|ARGS|$3|" base.yaml > "$1.yaml"; }
gen redis     "docker.io/redis:8"                 '["redis-server","--maxmemory","200mb","--save",""]'
gen valkey    "docker.io/valkey/valkey:8"         '["valkey-server","--maxmemory","200mb","--save",""]'
gen dragonfly "docker.dragonflydb.io/dragonflydb/dragonfly:latest" '["dragonfly","--maxmemory=200mb","--alsologtostderr"]'
kubectl apply -f redis.yaml -f valkey.yaml -f dragonfly.yaml
```

**The probe is deliberately the one everybody writes.** It is also wrong, in a way that takes until
section 6 to show.

One detail that does hold: `redis-cli` ships in all three images, so the *same* probe command runs
unmodified everywhere — `/usr/local/bin/redis-cli` in Redis and Valkey, `/usr/bin/redis-cli` in
Dragonfly.

## 2. Where the shared shape stops working

```
NAME                         READY   STATUS    RESTARTS
dragonfly-6675bf99f4-2s2l6   0/1     Error     5
redis-96759578f-tj7qj        1/1     Running   0
valkey-75944fbcd7-7n767      1/1     Running   0
```

```
I dfly_main.cc:1186] Max memory limit is: 200.00MiB
I proactor_pool.cc:149] Running 2 io threads
E dfly_main.cc:319] There are 2 threads, so 512.00MiB are required. Exiting...
```

**Dragonfly derives its io thread count from the CPU limit and demands 256 MiB per thread.** The
`limits.cpu: "2"` that Redis and Valkey ignore is what makes Dragonfly reject a 200 MiB `maxmemory`.
Four runs pin the rule, two either side of the line:

```
  cpu=1   maxmemory=200mb   Failed    Running 1 io threads  There are 1 threads, so 256.00MiB are required. Exiting...
  cpu=1   maxmemory=300mb   Running   Running 1 io threads
  cpu=2   maxmemory=300mb   Failed    Running 2 io threads  There are 2 threads, so 512.00MiB are required. Exiting...
  cpu=2   maxmemory=600mb   Running   Running 2 io threads
```

**Raising the CPU limit on a Dragonfly pod can stop it booting.** That is the opposite of the
reflex — more CPU, more headroom — and it makes `resources` a coupled pair on this engine where the
other two treat them independently.

## 3. What each one says it is

```bash
redis-cli -h <ENGINE> INFO server | grep -E 'redis_version|server_name|valkey_version|dragonfly_version'
```

```
  redis      redis_version=8.10.1    (no server_name)
  valkey     redis_version=7.2.4     server_name:valkey  valkey_version:8.1.10
  dragonfly  redis_version=7.4.0     dragonfly_version:df-v1.40.1
```

**Two of the three report a `redis_version` that is not their version.** Valkey 8.1.10 announces
7.2.4 and Dragonfly 1.40.1 announces 7.4.0, both as compatibility shims for clients that gate
features on that field. A client library reading `redis_version` to decide whether `FUNCTION` exists
gets an answer about a different program.

The field that actually identifies the engine is `server_name` for Valkey and `dragonfly_version`
for Dragonfly — and Redis 8 sets neither, so **the reliable test is the presence of the other
engines' fields, not any value Redis provides.**

`COMMAND COUNT` splits 447 / 242 / 324, which looks like a compatibility gap and is mostly not one:

```
  name timeseries   name vectorset   name bf   name search   name ReJSON
```

**Redis 8 bundles five modules by default.** Valkey's `MODULE LIST` is empty. The 205-command lead is
search, JSON, bloom, time-series and vector-set, not core divergence — worth knowing before reading
the count as a verdict.

## 4. The core command surface

One client, three servers, twenty commands with operational weight:

```
command                redis 8.10.1             valkey 8.1.10            dragonfly 1.40.1
OBJECT ENCODING k      embstr                   embstr                   ERR unknown command
EVAL "return 1" 0      1                        1                        1
FUNCTION STATS         running_script           running_script           ERR Unknown subcommand
WAIT 0 0               0                        0                        0
EXPIRE k 100 NX        1                        1                        1
OBJECT FREQ k          ERR An LFU maxmemory po  ERR An LFU maxmemory po  ERR unknown command
MEMORY USAGE k         40                       40                       8
MEMORY DOCTOR          Hi Sam, this instance i  Hi Sam, this instance i  ERR Unknown subcommand
DEBUG SLEEP 0          ERR DEBUG command not a  ERR DEBUG command not a  ERR Unknown subcommand
DEBUG OBJECT k         ERR DEBUG command not a  ERR DEBUG command not a  encoding:raw bucket_id:
CLIENT NO-EVICT on     OK                       OK                       ERR Unknown subcommand
CLIENT NO-TOUCH on     OK                       OK                       ERR Unknown subcommand
LATENCY RESET          0                        0                        ERR Unknown subcommand
ACL WHOAMI             default                  default                  User is default
CLUSTER INFO           ERR This instance has c  ERR This instance has c  ERR Cluster is disabled
FAILOVER ABORT         ERR No failover in prog  ERR No failover in prog  ERR unknown command
BGREWRITEAOF           Background append only   Background append only   ERR unknown command
REPLICAOF NO ONE       OK                       OK                       OK
```

**Redis 8 and Valkey 8 are identical on every row, down to the error strings** — including the
`MEMORY DOCTOR` greeting and the exact LFU refusal text. On this surface the fork has not diverged at
all.

Dragonfly differs on eleven, and two of those differences are worth naming:

- **`DEBUG OBJECT` runs on Dragonfly and is refused by Redis and Valkey.** Redis 8 ships with debug
  commands disabled, so a tool built against `DEBUG OBJECT` works on the *less* compatible engine and
  fails on the reference one. Compatibility is not a scalar.
- **`MEMORY USAGE k` returns 40, 40 and 8 for the same key holding the same value.** A capacity script
  reading that field gets a five-fold different answer with no error to notice.

## 5. `EVAL` returning 1 does not mean Lua works

The table above shows `EVAL "return 1" 0` succeeding on all three, which is exactly the kind of check
this repository keeps warning about — it reads whether the command dispatches, not whether scripting
works. A script that touches data:

```bash
redis-cli -h <ENGINE> EVAL "redis.call('SET','undeclared','x') return redis.call('GET','undeclared')" 0
```

```
  redis      x
  valkey     x
  dragonfly  ERR Error running script: @user_script:2: -ERR script tried accessing undeclared key, key: undeclared
```

Declare the key and it passes:

```bash
redis-cli -h dragonfly EVAL "redis.call('SET',KEYS[1],'x') return 1" 1 declared
```

```
  1
```

**Dragonfly requires every key a script touches to be declared in `KEYS`**, because it shards across
threads and needs the key set up front to route the transaction. Redis and Valkey have always
*recommended* this and never enforced it, so a codebase full of scripts that reach for keys directly
runs on two of the three engines and fails on the third — at runtime, per script, not at startup.

## 6. The readiness probe passes while every write is refused

The probe in section 1 is the standard one. Fill any of these engines past `maxmemory`:

```bash
redis-cli -h <ENGINE> INFO memory | grep -E '^used_memory:'
redis-cli -h <ENGINE> CONFIG GET maxmemory-policy
redis-cli -h <ENGINE> PING
redis-cli -h <ENGINE> SET __probe__ 1
```

```
  redis      used_memory=243.61M  maxmemory=200MiB  policy=noeviction  evicted_keys=0
             PING -> PONG          SET -> OOM command not allowed when used memory > 'maxmemory'.
  valkey     used_memory=220.2M   maxmemory=200MiB  policy=noeviction  evicted_keys=0
             PING -> PONG          SET -> OOM command not allowed when used memory > 'maxmemory'.
  dragonfly  used_memory=602.6M   maxmemory=600MiB  policy=(unset)     evicted_keys=0
             PING -> PONG          SET -> ERR Out of memory
```

```
NAME                       READY   STATUS    RESTARTS
redis-7c584f797d-v9j6h     1/1     Running   1
```
```
endpoints: 10.244.0.13
```

**The pod is Ready, it is in the Service endpoints, it serves reads, and it rejects every write.**
`PING` answers `PONG` because the server is alive; being alive is not the property the probe is
supposed to establish. This is the same shape as the `SYNCED=True` in
[[crossplane-cloud-resources-as-crds]] — a check reading a stand-in for the thing it claims to verify.

Two things make it worse than it looks:

- **`noeviction` is the default policy.** Passing `--maxmemory` without `--maxmemory-policy` does not
  give you an LRU cache, it gives you a hard write ceiling; `evicted_keys: 0` is the proof that
  nothing was making room.
- **All three engines behave the same way here.** This is not an engine choice, it is the probe.

A probe that issues a write catches it, measured on Redis while over the ceiling:

```bash
redis-cli SET __probe__ 1 | grep -q OK
```

```
  ping-probe : PASS  (misses it)
  write-probe: FAIL  (catches it)
```

**That is a real trade and not a free fix** — it writes to your datastore every `periodSeconds`, adds
a key to the keyspace, and on a replica it fails for a different reason entirely. The honest reading
is that readiness cannot be established by a liveness-shaped check, and where a write probe is too
costly the memory ceiling belongs in alerting instead of in the probe.

### The failure this page went looking for and did not find

The plan was to show `PING` answering `PONG` while an RDB loads. It does not. Polling the pod IP
directly at 100 ms through a 41.7 MB / 2 M-key restart:

```
  21 samples  PING=[PONG]      GET=[v1]
   4 samples  PING=[Connection refused]                    GET=[Connection refused]
  11 samples  PING=[LOADING Redis is loading the dataset]  GET=[LOADING Redis is loading the dataset]
 295 samples  PING=[PONG]      GET=[v1]
```

**`PING` is rejected during loading on Redis 8**, so the naive probe is correct for that case — about
1.1 s of `LOADING` behind 0.4 s of refused connections. The widely repeated advice to avoid `PING`
because it passes during load did not reproduce here. Recorded because a check that *does* fail when
it should is worth knowing about as much as one that does not.

## Verification checklist

- [x] All three Deployments are created from one `base.yaml` with only image and args substituted
- [x] `redis-cli` exists in all three images and the identical probe command returns `PASS` in each
- [x] Redis and Valkey reach `1/1 Running` on the shared manifest; **Dragonfly reaches `0/1 Error`**
- [x] Dragonfly's log names the reason: `There are 2 threads, so 512.00MiB are required`
- [x] The floor is `256 MiB × io threads`, watched failing and passing on both sides at cpu=1 and cpu=2
- [x] `redis_version` reports **7.2.4 on Valkey 8.1.10** and **7.4.0 on Dragonfly 1.40.1**
- [x] `MODULE LIST` shows five modules on Redis 8 and is **empty on Valkey**, accounting for the 447-vs-242 command count
- [x] Redis 8 and Valkey 8 return **identical strings on all 20 core commands**, error text included
- [x] `DEBUG OBJECT` succeeds on Dragonfly and is refused by Redis and Valkey — the inversion, not the expected direction
- [x] `MEMORY USAGE` on one identical key returns **40 / 40 / 8**
- [x] `EVAL "return 1" 0` succeeds on all three while a script touching an undeclared key **fails only on Dragonfly**
- [x] The same script with the key declared in `KEYS` succeeds on Dragonfly
- [x] Over `maxmemory`, all three answer `PING` with `PONG` while refusing `SET`, and the pod stays `1/1` with its endpoint in the Service
- [x] `maxmemory-policy` is `noeviction` by default and `evicted_keys` stays `0`
- [x] A write probe returns `FAIL` in the state where the ping probe returns `PASS`
- [x] During RDB load `PING` returns `LOADING`, **not** `PONG` — the expected false pass did not occur

## Rollback

```bash
kubectl delete -f redis.yaml -f valkey.yaml -f dragonfly.yaml
kind delete cluster --name cache-lab
```

## Where this bit us

**The first compatibility battery reported that every command was unknown, including `SET`.** The
test loop set `IFS='|'` to walk its command list and never restored it, so `redis-cli` received
`SET k v` as a single argument. A second attempt returned empty for every row because `${@:2}` is
bash and the container's `sh` is dash. **Both runs produced a clean, plausible, completely wrong
table** — the first one implying all three engines were broken. What fixed it was checking the
instrument before trusting it: one known-good command and one known-bad one, `GET k -> hello` and
`NOSUCHCMD -> ERR unknown command`, before running anything that mattered.

**A passing `EVAL` was the same mistake at a higher level.** `EVAL "return 1" 0` returned `1` on all
three, which went into the table as compatibility. It only measured that the command dispatches.
The Lua incompatibility that actually matters — undeclared keys — was invisible until a fill script
built on `redis.call('SET', ...)` silently wrote nothing to Dragonfly and left `DBSIZE=1`.

**`DEBUG POPULATE 16000000` returned `OK` and created 13,102,432 keys.** It stopped at the memory
ceiling and reported success anyway. The failure was only visible by reading `DBSIZE` back, which is
worth remembering for any bulk load: **the return value describes the request, not the outcome.**

**Nothing here says which engine is faster, and the interesting claim is exactly that one.**
Dragonfly's reason to exist is multi-threaded throughput, and a 4-core arm64 VM running all three
side by side cannot measure it. This page settles compatibility and Kubernetes behaviour; anyone
choosing on performance still has that work in front of them.

## Follow-ups

- [ ] Benchmark the three on a machine with enough cores to make Dragonfly's threading meaningful — 4 cores in a VM proves nothing either way
- [ ] Replace the `PING` probe with a `startupProbe` for load plus a memory-ceiling alert, and check whether that pair catches both states without writing on every interval
- [ ] Test whether Valkey can load a Redis-written RDB and vice versa — the migration question this page never touched
- [ ] Run replication and failover across the three, since `REPLICAOF NO ONE` returning `OK` on all three is the shallowest possible evidence
- [ ] Grep an existing codebase for `redis.call` on keys absent from `KEYS` to size the Dragonfly migration cost
- [ ] Check whether Valkey's `redis_version: 7.2.4` shim confuses the client libraries actually in use here

## Related

[[crossplane-cloud-resources-as-crds]] — the same false-pass shape: a status field standing in for the property it claims.
[[local-rag-retrieval-failure-modes]] — another check that read a proxy and passed on a broken result.
[[pod-crashloopbackoff]] — the crash loop Dragonfly lands in, and how to read it.
[[argo-rollouts-canary-kind]] — the other document that builds its lab on a throwaway kind cluster.
[[postgresql-cnpg-onprem]] — stateful workload on Kubernetes, with the persistence this page deliberately skipped.
