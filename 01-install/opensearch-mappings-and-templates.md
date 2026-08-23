---
title: OpenSearch — a single node, and the range query that quietly lies
date: 2026-08-23
domain: install
tags: [search, logs, indexing, containers]
stack: [opensearch, opensearch-dashboards, podman, docker-compose]
summary: A single-node OpenSearch 3.8 with security on, brought up from a compose file, then interrogated about its own guesses. Dynamic mapping typed a quoted "412" as text, and duration_ms >= 200 then returned a document whose value was 87 — no error, just string comparison. An index template fixes it, and does nothing to the index that already exists.
source: handson
env: OpenSearch 3.8.0 (Lucene 10.5.0) · OpenSearch Dashboards 3.8.0 · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Verified on a single node with the demo TLS certificates and the built-in admin user. Multi-node allocation, real certificates, role-based access for anyone other than admin, snapshots, and ISM rollover across a retention period are all unexercised — and cluster behaviour under node loss is the thing a single node structurally cannot show.
duration: 40–60 min
risk: low
---

> **Verified 2026-08-23.** Every mapping, error and hit count below came from a running cluster. The
> range-query results in [Where this bit us](#where-this-bit-us) are what OpenSearch returned, and
> they are wrong in a way it will never tell you about.

OpenSearch will accept your documents without being told anything about them, and that is the
problem. **Every field you do not define gets a type guessed from the first document that carries
it**, and two of those guesses decide whether your queries are correct.

## Bringing it up

```yaml title="compose.yml"
name: opensearch-lab

services:
  opensearch:
    image: docker.io/opensearchproject/opensearch:3
    environment:
      discovery.type: single-node
      # Rejected passwords are echoed into the container log in clear, so this
      # comes from the environment and never from a committed file.
      OPENSEARCH_INITIAL_ADMIN_PASSWORD: ${OPENSEARCH_ADMIN_PASSWORD:?set it before compose up}
      # Heap. Half of container memory is the usual rule; 1g is plenty here.
      OPENSEARCH_JAVA_OPTS: -Xms1g -Xmx1g
    ulimits:
      memlock: {soft: -1, hard: -1}
      nofile: {soft: 65536, hard: 65536}
    volumes:
      - os-data:/usr/share/opensearch/data
    ports: ["9200:9200"]
    healthcheck:
      test: ["CMD-SHELL", "curl -sk -u admin:$$OPENSEARCH_INITIAL_ADMIN_PASSWORD https://localhost:9200/_cluster/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 30s

  dashboards:
    image: docker.io/opensearchproject/opensearch-dashboards:3
    environment:
      OPENSEARCH_HOSTS: '["https://opensearch:9200"]'
      OPENSEARCH_USERNAME: admin
      OPENSEARCH_PASSWORD: ${OPENSEARCH_ADMIN_PASSWORD:?set it before compose up}
      # The demo certificates are self-signed; Dashboards will not talk to the
      # cluster at all unless it is told to accept them.
      OPENSEARCH_SSL_VERIFICATIONMODE: none
    ports: ["5601:5601"]
    depends_on:
      opensearch: {condition: service_healthy}

volumes:
  os-data:
```

**`${VAR:?message}` makes the password a precondition rather than a default.** With it unset,
compose refuses before starting anything:

```
set it before compose up
```

```bash
export OPENSEARCH_ADMIN_PASSWORD='<REDACTED>'
podman compose up -d
```

Two things about that password are worth knowing before you pick one — both in
[Where this bit us](#where-this-bit-us).

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" https://127.0.0.1:9200/_cluster/health
```

```
 status: yellow | nodes: 1 | shards: 6
```

`-k` is not optional: the image ships **demo certificates**, self-signed, and every client has to be
told to accept them. That is fine for a lab and is the first thing to replace for anything else.

## What OpenSearch guesses

Four log lines, indexed with no mapping defined:

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST "https://127.0.0.1:9200/applogs-dynamic/_bulk?refresh=true" \
  -H 'Content-Type: application/x-ndjson' --data-binary '
{"index":{}}
{"service":"orders","level":"error","message":"payment declined for sku SKU-999","duration_ms":"412","status":500,"@timestamp":"2026-08-23T12:00:00Z"}
{"index":{}}
{"service":"orders","level":"info","message":"order placed for sku SKU-123","duration_ms":"87","status":200,"@timestamp":"2026-08-23T12:00:05Z"}
{"index":{}}
{"service":"inventory","level":"warn","message":"cache miss for sku SKU-SLOW","duration_ms":"405","status":200,"@timestamp":"2026-08-23T12:00:07Z"}
{"index":{}}
{"service":"inventory","level":"info","message":"stock lookup ok","duration_ms":"18","status":200,"@timestamp":"2026-08-23T12:00:09Z"}
'
```

```
 errors: False | indexed: 4
```

**`errors: False` is the whole trap in two words.** Nothing was wrong, so nothing was reported. Ask
what it decided:

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  "https://127.0.0.1:9200/applogs-dynamic/_mapping"
```

```
  @timestamp     date
  duration_ms    text     + subfield: keyword
  level          text     + subfield: keyword
  message        text     + subfield: keyword
  service        text     + subfield: keyword
  status         long
```

Three guesses, and they are not equally good:

- `status` is `long` because `500` arrived unquoted.
- `duration_ms` is **`text`** because `"412"` arrived quoted. The value is a number; the JSON said
  string; OpenSearch believed the JSON.
- Every string became `text` **with a `.keyword` subfield**, which is the compromise that makes the
  next section confusing rather than simply broken.

`text` is analysed — broken into terms for full-text search. `keyword` is stored whole, for exact
matching, sorting and aggregation. **A field that is one cannot do the other's job**, and the
`.keyword` subfield exists so that dynamically-mapped strings can do both, at the cost of storing
everything twice.

## Three consequences, in increasing order of danger

```bash
# aggregate on the text field
-d '{"aggs":{"by_service":{"terms":{"field":"service"}}}}'
```

```
 type:   search_phase_execution_exception
 reason: Text fields are not optimised for operations that require per-document field data
         like aggregations and sorting, so these operations are disabled by default.
         Please use a keyword field instead.
```

**A loud, correct, actionable error** — the best possible outcome. Use the subfield and it works:

```bash
-d '{"aggs":{"by_service":{"terms":{"field":"service.keyword"}}}}'
```

```
  inventory    2
  orders       2
```

And then the third case, which does not error:

```bash
-d '{"query":{"range":{"duration_ms":{"gte":100}}}}'
```

```
 hits: 4
   duration_ms = 412 | payment declined for sku SKU-999
   duration_ms = 87  | order placed for sku SKU-123
   duration_ms = 405 | cache miss for sku SKU-SLOW
   duration_ms = 18  | stock lookup ok
```

**Four hits for "at least 100 milliseconds", including 87 and 18.** See below.

## Fixing it with an index template

```json title="applogs-template.json"
{
  "index_patterns": ["applogs-*"],
  "priority": 100,
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0,
      "refresh_interval": "5s"
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "@timestamp":  { "type": "date" },
        "service":     { "type": "keyword" },
        "level":       { "type": "keyword" },
        "status":      { "type": "short" },
        "duration_ms": { "type": "integer" },
        "message":     { "type": "text", "analyzer": "standard" }
      }
    }
  }
}
```

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X PUT "https://127.0.0.1:9200/_index_template/applogs" -d @applogs-template.json
```

```
  {'acknowledged': True}
```

`service` and `level` are `keyword` outright — no `.keyword` dance, no duplicate storage — because
a service name is an identifier, not prose. `message` stays `text` because it is prose. **That
distinction is the entire decision**, and it is made per field, once.

A new index under the pattern picks it up:

```
  @timestamp   date
  duration_ms  integer
  level        keyword
  message      text
  service      keyword
  status       short
  health,pri,rep: green 1 0
```

Green, not yellow — `number_of_replicas: 0` is in the template. And reindexing the old documents
coerces the strings on the way in:

```bash
-X POST "https://127.0.0.1:9200/_reindex?refresh=true" -d '{
  "source": {"index": "applogs-dynamic"},
  "dest":   {"index": "applogs-000001"}
}'
```

```
  created: 4 | failures: 0 | took: 105 ms
```

**`"412"` became `412` with no failures** — `coerce` is on by default for numeric fields, so a
string that happens to parse is accepted. That is the same leniency that created the problem, now
working in your favour.

Aggregations that needed a subfield now work on the field itself:

```
  inventory   n=2  avg=211.5ms  p95=405.0ms
  orders      n=2  avg=249.5ms  p95=412.0ms
```

## Verification checklist

- [x] A weak `OPENSEARCH_INITIAL_ADMIN_PASSWORD` **fails the container**, exit `1`, with the regex rule named
- [x] `${VAR:?}` aborts `compose config` before any container starts
- [x] Cluster reports `green` for templated indices and `yellow` for the default-replica one
- [x] `_cluster/allocation/explain` names the `same_shard` decider as the reason — not guessed
- [x] Dynamic mapping types a quoted `"412"` as `text` and an unquoted `500` as `long`
- [x] Aggregating on a `text` field fails loudly; the `.keyword` subfield succeeds
- [x] `range >= 100` on the `text` field returns **4 of 4** documents, including `87` and `18`
- [x] The same query on `integer` returns **2**, and four different thresholds match Python's numeric comparison
- [x] Creating the template does **not** change the existing index — still `text`, still `yellow`
- [x] `_reindex` coerces `"412"` to `412` with `failures: 0`
- [x] `dynamic: strict` rejects a typo'd field with `400`; the dynamic index accepts it and keeps it
- [x] Dashboards reports `overall: green` — and `401` without credentials

## Rollback

```bash
podman compose down -v          # containers and the data volume
```

Single indices, without tearing the cluster down:

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" -X DELETE "https://127.0.0.1:9200/applogs-*"
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" -X DELETE "https://127.0.0.1:9200/_index_template/applogs"
```

## Where this bit us

**A range query on a `text` field compares strings, returns no error, and is wrong.** Running four
thresholds against the dynamically-mapped index, next to Python's comparison of the same values as
strings:

```
  duration_ms >= 9    ->                      (n=0)
  duration_ms >= 100  -> 18 405 412 87        (n=4)
  duration_ms >= 200  -> 405 412 87           (n=3)
  duration_ms >= 90   ->                      (n=0)
```

```python
>>> sorted(v for v in ['412','87','405','18'] if v >= '200')
['405', '412', '87']
```

**Identical, at every threshold.** `"87" >= "200"` is true because `8` sorts after `2`. So a query
for "slower than 200ms" returns an 87ms request, and a query for "slower than 9ms" returns nothing
at all. Compare the same queries once the field is `integer`:

| threshold | as `text` | as `integer` |
|---|---|---|
| `>= 9` | *(nothing)* | 18 87 405 412 |
| `>= 90` | *(nothing)* | 405 412 |
| `>= 100` | 18 87 405 412 | 405 412 |
| `>= 200` | 87 405 412 | 405 412 |

Not one of the four agrees. **The aggregation failure earlier was a gift** — it stopped and told you
the field was the wrong type. The range query has exactly the same underlying problem and answers
anyway, which is why the check that matters here is not "does the query run" but "does a threshold
you can reason about return the documents you can count by hand."

**An index template does nothing to indices that already exist.** After `acknowledged: true`:

```
  duration_ms is still: text
  service     is still: text
  health,rep: yellow 1
```

Templates are applied **at index creation**, and that is all. The existing index keeps its mapping,
its replica count and its behaviour forever, because **a mapping cannot be changed in place** — a
field's type is baked into the on-disk structures. The path is always: new index, reindex, swap an
alias. Plan for that on day one rather than discovering it when the index is 200GB.

**The container exits 137 and the request just hangs.** The first run died with no error from the
client at all — the indexing request sat there until it timed out. The container had been killed:

```
opensearch-lab-opensearch-1 | Exited (137) | true
```

`137` is `128 + 9`: SIGKILL, out of memory. The log said so beforehand, in a way easy to skim past:

```
writing cluster state took [27664ms] which is above the warn threshold of [10s]
publication of cluster state version [22] is still waiting for {...} after [33.1s]
```

The podman VM had **2048MB total**, and OpenSearch alone settles at **1.76GB** with a 1g heap, before
Dashboards asks for its share. Give the machine real memory before anything else:

```bash
podman machine stop
podman machine set --memory 6144
podman machine start
```

**A hang is the symptom, not an error.** Any OpenSearch that stops answering deserves
`podman ps -a` and a look at the exit code before you debug the query.

**A rejected password is written to the container log in clear.**

```
Password admin123 failed validation: "Password does not match validation regex".
Please re-try with a minimum 8 character password and must contain at least one uppercase
letter, one lowercase letter, one digit, and one special character
```

The rule itself is helpful. Echoing the attempt is not: a password typo'd into a `compose up` on a
CI runner lands in that runner's log, and near-misses of a real password are worth as much to an
attacker as the password. It is also a reason to keep the value in the environment rather than a
file — the file gets committed, and the log gets shipped.

**`dynamic: strict` is the difference between a typo and a permanent new field.** Sending
`mesage` instead of `message` to the templated index:

```
  status: 400
  type:   strict_dynamic_mapping_exception
  reason: mapping set to strict, dynamic introduction of [mesage] within [_doc] is not allowed
```

The same document against the dynamic index:

```
  result: created
  new field now in the mapping: True -> text
```

Accepted, and `mesage` is now part of the mapping — permanently, because mappings do not shrink
either. Every typo, every rogue debug field and every user-controlled key becomes a mapping entry,
which is how a "mapping explosion" starts: thousands of fields, a cluster state too large to
publish, and the `writing cluster state took [27664ms]` warning from earlier for real reasons.

**A single node cannot be green with default settings.** Every index created without a template
requests one replica, and OpenSearch will not put a replica on the node that holds the primary. The
API says so without ambiguity, which is worth using rather than guessing:

```
 can_allocate: no
  - same_shard : a copy of this shard is already allocated to this node
```

Yellow on a single-node lab is correct and expected. **Yellow on a real cluster means a copy of your
data is missing**, and getting used to ignoring it in a lab is how it gets ignored in production.

## Follow-ups

- [ ] Add an ISM policy with rollover and a delete phase, then age an index through it — the retention half this page sets up with `applogs-000001` and never uses
- [ ] Put a write alias in front of the index so the reindex-and-swap above is transparent to writers
- [ ] Replace the demo certificates and drop `-k`, which is the first real step toward anything non-lab
- [ ] Create a non-admin role that can read `applogs-*` and nothing else, and confirm it is refused elsewhere
- [ ] Ship the logs from [[loki-logs-labels-and-cardinality]] into this index and compare what each system makes cheap — labels versus mappings is the same decision made twice
- [ ] Measure the storage cost of `text` + `.keyword` against plain `keyword` on a corpus big enough to matter
- [ ] Take a snapshot to a filesystem repository and restore it into a fresh cluster

## Related

[[loki-logs-labels-and-cardinality]] — the other way to store logs, where the equivalent decision is which fields become labels.
[[grafana-correlate-three-signals]] — where a log store earns its place, by being one of three signals rather than a silo.
[[dbt-duckdb-local]] — the same lesson from the data side: a column's declared type is what makes a query answerable.
[[prometheus-instrument-and-query]] — bucket boundaries chosen before the data arrives, which is the same class of decision as a mapping.
