---
title: OpenSearch — a single node, and the range query that quietly lies
date: 2026-08-23
domain: install
tags: [search, logs, indexing, retention, containers]
stack: [opensearch, opensearch-dashboards, podman, docker-compose]
summary: A single-node OpenSearch 3.8 with security on, interrogated about its own guesses. Dynamic mapping typed a quoted "412" as text, and duration_ms >= 200 then returned a document whose value was 87 — no error, just string comparison. An index template fixes it and does nothing to the index that already exists, and an ISM policy then rolls that index over and deletes it while writers keep addressing one alias.
source: handson
env: OpenSearch 3.8.0 (Lucene 10.5.0) · OpenSearch Dashboards 3.8.0 (Chromium via Playwright for the UI steps) · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Verified on a single node with the demo TLS certificates and the built-in admin user. The full ISM lifecycle — rollover, a warm state with read_only/force_merge/index_priority, and deletion — was exercised end to end, but with lab-sized minute-scale transitions and a tightened scheduler rather than a real policy measured in days. The warm tier's allocation half needs more than one node. The Dashboards steps — tenant selection, index pattern creation, Discover, and a three-panel dashboard imported from a file and restored after the volume was destroyed — were driven through the real UI and screenshotted. Multi-node allocation, real certificates, role-based access for anyone other than admin, saved visualizations and snapshots are unexercised — and cluster behaviour under node loss is the thing a single node structurally cannot show.
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

## Rollover and retention with ISM

A mapping decides whether a query is correct; **ISM decides whether the index still exists.** Index
State Management is a policy attached to indices, with states, actions and timed transitions.

```json title="applogs-ism.json"
{
  "policy": {
    "description": "applogs: hot -> warm (read_only + force_merge) -> delete",
    "default_state": "hot",
    "ism_template": [
      { "index_patterns": ["applogs-*"], "priority": 100 }
    ],
    "states": [
      {
        "name": "hot",
        "actions": [
          {
            "rollover": {
              "min_doc_count": 5,
              "min_index_age": "30m",
              "min_primary_shard_size": "10gb"
            }
          }
        ],
        "transitions": [
          { "state_name": "warm", "conditions": { "min_index_age": "2m" } }
        ]
      },
      {
        "name": "warm",
        "actions": [
          { "read_only": {} },
          { "force_merge": { "max_num_segments": 1 } },
          { "index_priority": { "priority": 50 } }
        ],
        "transitions": [
          { "state_name": "delete", "conditions": { "min_index_age": "7m" } }
        ]
      },
      { "name": "delete", "actions": [ { "delete": {} } ], "transitions": [] }
    ]
  }
}
```

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X PUT "https://127.0.0.1:9200/_plugins/_ism/policies/applogs-retention" -d @applogs-ism.json
```

Three things in that policy do the work:

- **`ism_template`** attaches the policy to any index matching `applogs-*` **at creation**. Without
  it you attach policies by hand to every new index, which defeats rollover.
- **The `rollover` conditions are an OR.** Whichever of docs, age or shard size trips first rolls the
  index. Real policies use size and age; `min_doc_count: 5` is here so a lab finishes.
- **`min_index_age` in the transitions is measured from index creation**, not from the rollover.
  Two and seven minutes are absurd and deliberate — a real policy says `2d` and `30d`.

**The `warm` state is where an index stops being written and starts being cheap.** Its three actions
run in order and each is separately verifiable: `read_only` blocks writes, `force_merge` collapses
segments, and `index_priority` demotes the index so a cluster restart recovers today's data first.

The index template needs one more setting, and the index needs a write alias:

```json
"settings": {
  "plugins.index_state_management.rollover_alias": "applogs"
}
```

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X PUT "https://127.0.0.1:9200/applogs-000001" \
  -d '{"aliases": {"applogs": {"is_write_index": true}}}'
```

**The `-000001` suffix is not decoration.** Rollover increments the numeric suffix, so the bootstrap
index has to have one. Applications then write to `applogs` and never learn the real index name.

### Watching it happen

With the scheduler tightened (see below), polling `_ism/explain`:

```
t+ 40s  applogs-000001[hot/None]           Successfully initialized policy: applogs-retention
t+100s  applogs-000001[hot/rollover]       Successfully rolled over index   -> applogs-000002 created
t+140s  applogs-000001[None/None]          Transitioning to warm [index=applogs-000001]
t+200s  applogs-000001[warm/read_only]     Successfully set index to read-only    blocks.write=true
t+240s  applogs-000001[warm/force_merge]   Successfully completed force merge     segments 8 -> 1
t+340s  applogs-000001[warm/force_merge]   Successfully confirmed segments force merged
t+400s  applogs-000001[warm/index_priority] Successfully set index priority to 50  priority=50
t+460s  applogs-000001[None/None]          Transitioning to delete [index=applogs-000001]
```

**`force_merge` reports twice** — `Successfully completed force merge`, then
`Successfully confirmed segments force merged`. ISM re-checks the segment count afterwards rather
than trusting the merge call, which is worth copying as a habit.

`applogs-000001` is simply absent by `t+160s`. It was deleted, with its six documents:

```
  index          docs.count health
  applogs-000002          0 green
```

### What `warm` actually did

Each of the three actions leaves something you can test. `read_only` is the one with teeth:

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST "https://127.0.0.1:9200/applogs-000001/_doc?refresh=true" -d '{...}'
```

```
  status: 403
  type:   cluster_block_exception
  reason: index [applogs-000001] blocked by: [FORBIDDEN/8/index write (api)];
```

While the same write through the alias is untouched, because the alias points at the hot index:

```
  landed in: applogs-000002 | result: created
```

```
  docs readable: 8
```

**Reads still work.** That is the whole proposition of a warm tier: the data stays queryable and
stops being mutable, which lets the segments be merged once and left alone.

**Pass condition: the index is gone, not merely marked.** A retention policy that transitions to a
`delete` state without the index disappearing is a policy that has done nothing, and the state name
alone will not tell you.

The alias moved with it, which is the point of the whole arrangement:

```
  alias   index          is_write_index
  applogs applogs-000002 true
```

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST "https://127.0.0.1:9200/applogs/_doc?refresh=true" -d '{...}'
```

```
  landed in: applogs-000002 | result: created
```

**The writer never changed its target and never knew a rollover happened.** That is the property
worth checking explicitly — an alias that does not follow the rollover is the failure this design
exists to prevent, and it looks identical until someone queries for yesterday's data.

## Dashboards: an index pattern, and what it exposes

Everything so far went through the API. Dashboards needs one more object before it can show any of
it: an **index pattern**, which is a saved object naming a set of indices and, optionally, the field
to treat as time.

**Dashboards Management → Index patterns → Create index pattern**, `applogs*`, then `@timestamp` as
the time field. The result is the most useful screen in the product for anyone who has read this far:

<img src="/01-install/img/opensearch-index-pattern-fields.png" width="620" alt="OpenSearch Dashboards index pattern page for applogs* showing 11 fields with Searchable and Aggregatable columns; message is searchable but not aggregatable while service and level are both">

**The `Aggregatable` column is this entire page rendered as a checkmark.** `service` and `level` are
`keyword`, so both dots are filled. `duration_ms` is a number. `message` is `text`, so it is
searchable and **not aggregatable** — the same fact that produced the `fielddata is disabled` error
earlier, shown here before anyone writes a query.

Confirmed against the saved object itself rather than read off the screen:

```bash
curl -s -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  "http://127.0.0.1:5601/api/saved_objects/_find?type=index-pattern&fields=fields"
```

```
    duration_ms  type=number  searchable=True aggregatable=True
    level        type=string  searchable=True aggregatable=True
    message      type=string  searchable=True aggregatable=False
    service      type=string  searchable=True aggregatable=True
```

**The pattern is a snapshot, not a live view.** Those flags were copied from the mapping at creation
time. Add a field later and it is missing until the pattern is refreshed — the circular-arrow button
on that page.

### Discover, and the filter that hides your data

<img src="/01-install/img/opensearch-discover.png" width="620" alt="OpenSearch Dashboards Discover showing the applogs* pattern over the last 24 hours with Results 60 of 60, a histogram with two clusters of documents, and expanded log rows">

Sixty documents were indexed, half timestamped within the last few minutes and half several hours
old. The same Discover screen, same data, two time ranges:

| Time range | Results |
|---|---|
| Last 15 minutes *(the default)* | **26 / 60** |
| Last 24 hours | **60 / 60** |

**The default is fifteen minutes, and it is the most common reason a new index pattern looks
empty.** Nothing is wrong, nothing is logged, and the histogram is blank. Before debugging ingestion,
widen the range — and note the count in the table above drifts downward on its own as documents age
out of a relative window, which is worth knowing before comparing two screenshots taken minutes
apart.

### One place the UI oversells what the mapping allows

Clicking `message` in the field sidebar offers **Top 5 values** and a **Visualize** button, on a
field the same product just marked `aggregatable=False`:

<img src="/01-install/img/opensearch-field-popover-text.png" width="620" alt="Discover field sidebar popover for the message field showing Top 5 values with percentages and a Visualize button, for a text field that is not aggregatable">

Those percentages are computed **client-side from the documents already on screen**, not by asking
OpenSearch. That is why whole strings like `order placed sku=SKU-955` appear — a real terms
aggregation on an analysed `text` field would return single tokens, and in fact returns nothing at
all:

```bash
-d '{"aggs":{"m":{"terms":{"field":"message"}}}}'
```

```
  FAILS: Text fields are not optimised for operations that require per-document field data...
```

```bash
-d '{"aggs":{"s":{"terms":{"field":"service"}}}}'
```

```
  buckets: [('orders', 31), ('inventory', 29)]
```

**A sidebar summary is not evidence that a field can be aggregated.** It is a sample of the current
result set, and it looks identical for a field that will fail the moment a dashboard panel asks the
cluster the same question.

## Visualizations and a dashboard, as a file

Clicking a dashboard together is fine once. **Defining it as a file is what survives the next
`compose down -v`**, and OpenSearch Dashboards has an import/export format built for exactly that:
NDJSON, one saved object per line.

Three panels, each chosen to lean on a different mapping decision:

| Panel | Aggregation | Depends on |
|---|---|---|
| Log levels over time | date histogram split by `level` | `@timestamp` being `date`, `level` being `keyword` |
| Requests by service | terms on `service` | `service` being `keyword` |
| Duration percentiles by service | percentiles on `duration_ms` | `duration_ms` being `integer`, not `text` |

**Not one of them would work against the dynamically-mapped index from earlier.** The dashboard is
the mapping decisions, cashed in.

```python title="gen_objects.py"
# The field list comes from OpenSearch's own _field_caps, because an
# index-pattern saved object created through the API has no fields attribute.
caps = get(f"https://127.0.0.1:9200/{INDEX}/_field_caps?fields=*")["fields"]
fields = [{"name": name, "type": KIND.get(es_type, "string"), "esTypes": [es_type],
           "searchable": info.get("searchable", False),
           # This flag is the mapping decision, carried into the UI.
           "aggregatable": info.get("aggregatable", False), ...}
          for name, byte in sorted(caps.items())
          for es_type, info in [next(iter(byte.items()))]]

SRC_VIS = json.dumps({"query": {...}, "filter": [],
                      # Names the reference; without it the panel renders
                      # 'Trying to initialize aggs without index pattern'.
                      "indexRefName": "kibanaSavedObjectMeta.searchSourceJSON.index"})
```

```bash
curl -s -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST "http://127.0.0.1:5601/api/saved_objects/_import?overwrite=true" \
  -H 'osd-xsrf: true' -H 'securitytenant: global' \
  -F file=@applogs-objects.ndjson
```

```
  import: True 5
```

`osd-xsrf: true` is mandatory on every write to the Dashboards API — without it the request is
rejected outright. `securitytenant` is the one in [Where this bit us](#where-this-bit-us).

<img src="/01-install/img/opensearch-dashboard.png" width="620" alt="OpenSearch Dashboards showing the applogs overview dashboard with a stacked bar chart of log levels over time, a donut of requests by service, and a table of duration percentiles by service">

The percentile table is the payoff, and it is only possible because `duration_ms` is a number:

```
  service     50th      95th   99th
  inventory   592.714   875    895
  orders      142.412   249.6  258
```

### Does it survive `compose down -v`?

**No, and that is the point of having the file.** Saved objects live in `.kibana*` indices inside the
same data volume as the documents:

```
  index                    docs.count
  .kibana_1                        12
  .kibana_92668751_admin_1          1
```

Destroying the volume and bringing the stack back up:

```
  saved objects found: 0
```

Re-indexing the documents and re-importing the one NDJSON file rebuilds the whole thing — the
screenshot above is from **after** the restore, not before. **A dashboard you cannot recreate from a
file is a dashboard you will lose**, and the export API is one call:

```bash
curl -s -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST "http://127.0.0.1:5601/api/saved_objects/_export" \
  -H 'osd-xsrf: true' -H 'Content-Type: application/json' \
  -d '{"objects":[{"type":"dashboard","id":"applogs-dashboard"}],"includeReferencesDeep":true}'
```

`includeReferencesDeep` is what pulls the three visualizations and the index pattern along with it.
Exporting the dashboard alone gives you a file that imports cleanly and renders nothing.

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
- [x] An index pattern `applogs*` is created through the UI with `@timestamp` as the time field, and lists **11 fields**
- [x] The pattern records `message` as `aggregatable=False` and `service`/`level` as `True` — read from the saved object, not the screen
- [x] Discover shows **26/60** at the default 15 minutes and **60/60** at 24 hours, on identical data
- [x] The field sidebar offers Top 5 values for `message` while a terms aggregation on it **fails** — the summary is client-side
- [x] Three visualizations and a dashboard import from one NDJSON file and **render**, checked by reading the panel titles, not the import response
- [x] The percentile table returns real numbers — `inventory` p95 `875` vs `orders` p95 `249.6` — which only works because `duration_ms` is `integer`
- [x] `compose down -v` destroys the saved objects (`saved objects found: 0`), and re-importing the file rebuilds them
- [x] An import with no tenant header lands in the **private** tenant: `.kibana_1` holds only config
- [x] The same cluster shows the dashboard in Global and **not** in Private, from two browser sessions
- [x] An `ism_template` attaches the policy at index creation, with no per-index step
- [x] Rollover fires on `min_doc_count` and creates `applogs-000002`
- [x] The write alias **follows** the rollover, and a document written to `applogs` afterwards lands in `-000002`
- [x] `read_only` in the warm state makes a direct write fail `403 cluster_block_exception`, while the alias keeps accepting writes
- [x] The warm index stays **readable** — 8 documents still counted after it went read-only
- [x] `force_merge` takes the index from **8 segments to 1**, and ISM re-confirms the count afterwards
- [x] `index_priority` is applied and readable as `index.priority = 50`
- [x] A merge to one segment leaves `docs.deleted` non-zero — soft deletes are retained for the 12h lease
- [x] Store size after a merge is **unchanged when read immediately** and 58% lower a minute later, so the check needs a settling period
- [x] The retention transition **deletes the index** — `applogs-000001` is absent from `_cat/indices`, not just marked
- [x] An index with a rollover action and no `rollover_alias` reports `Missing rollover_alias index setting` and stays stuck in `hot`
- [x] `coordinator.sweep_period` below `5m` is rejected, and the rejection discards the whole settings update

## Rollback

```bash
podman compose down -v          # containers and the data volume
```

**`${VAR:?}` applies to `down` too.** With the variable unset, teardown fails the same way start-up
does — `exit status 1` — which is briefly alarming when you are trying to clean up. Any value will
do, since nothing is being started:

```bash
OPENSEARCH_ADMIN_PASSWORD=x podman compose down -v
```

Single indices, without tearing the cluster down:

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" -X DELETE "https://127.0.0.1:9200/applogs-*"
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" -X DELETE "https://127.0.0.1:9200/_index_template/applogs"
```

## Where this bit us

**`force_merge` reclaims less than you expect, and `_stats/store` will lie to you while you check.**
Measured directly on a throwaway index, 200 documents each written with `refresh=true`, then merged
to one segment. The first reading, five seconds after the merge:

```
  before: segments=10  store=82217 bytes
  after:  segments=1   store=82217 bytes      <- identical, and wrong
```

**Store statistics lag well behind the merge.** Re-read a minute later the same index was `34746`
bytes — a 58% reduction that the first measurement completely missed. Any before/after storage claim
needs a settling period and a repeated read, or it is noise. The segment *count* updates promptly;
the byte count does not.

Then the part that surprised us. Deleting 120 of the 200 documents and force-merging again:

```
  after deletes, before merge:  segments=2  store=47684b  docs=80  deleted=120
  after force_merge:            segments=1  store=13300b  docs=80  deleted=120
```

Storage fell by 72% — and **`docs.deleted` stayed at 120**, in a segment that had just been rewritten:

```
  index      shard segment docs.count docs.deleted   size
  merge-demo 0     _65             80          120   12.6kb
```

The reason is a default nobody sets:

```
  index.soft_deletes.enabled              = true
  index.soft_deletes.retention_lease.period = 12h
```

Deletes in OpenSearch are **soft** — the document's content goes, but a tombstone is retained so a
replica can catch up by replaying history rather than copying the whole shard. Those tombstones are
held for the retention-lease period, twelve hours by default, and `force_merge` will not drop them
early. So the common advice that "force merge reclaims space from deleted documents" is right about
the content and wrong about the timing: **the space comes back at the merge, the `docs.deleted`
count does not go to zero until the lease lets it.** Do not use `docs.deleted` as the check that a
merge worked; use the segment count and, patiently, the store size.

**A saved object imports successfully and then fails to render, three different ways.** Every one of
these returned `success: True, count: 5` from the import API, and every one produced a broken
dashboard. **Import success means the JSON parsed, not that anything works.**

<img src="/01-install/img/opensearch-dashboard-broken.png" width="620" alt="OpenSearch dashboard with three empty panels, each showing the error Trying to initialize aggs without index pattern">

First, a reference that nothing points at:

```
Trying to initialize aggs without index pattern
```

The visualization had a correct `references` entry naming the index pattern, and that is not enough
— `kibanaSavedObjectMeta.searchSourceJSON` must contain `"indexRefName"` giving the **name** of the
reference to resolve. The reference is the target; `indexRefName` is the pointer.

Second, the same key on an object that has no such reference. Adding `indexRefName` to the
*dashboard* — which references visualizations, not an index pattern — made the dashboard route
silently give up and redirect to the dashboard list. **The URL said `#/view/applogs-dashboard` while
the page showed the index of dashboards**, with no error anywhere, which took a while to recognise as
a failure at all.

Third, an index pattern with no field list:

```
Could not locate that index-pattern-field (id: @timestamp)
Could not locate that index-pattern-field (id: service)
Could not locate that index-pattern-field (id: duration_ms)
```

An index pattern created **through the UI** has its `fields` attribute populated from the cluster's
field caps. One created through the saved-objects API has whatever you put there, and `{title,
timeFieldName}` alone is accepted. The fix is to build `fields` from `_field_caps` yourself, which is
also how the `aggregatable` flags from earlier get into the UI in the first place.

**The check that catches all three is rendering the dashboard and reading the panels** — not the
import response, and not `_find` listing the objects, both of which were happy throughout.

**Saved objects imported over the API land in the caller's *private* tenant.** After a clean import
with no tenant header, the Global tenant index held nothing but config:

```
  .kibana_1                 -> config
  .kibana_92668751_admin_1  -> config, index-pattern, 3 visualizations, dashboard
```

The tenant selector in the UI shows why: reading the radio buttons directly,

```
  {'id': 'global',  'checked': False}
  {'id': 'private', 'checked': True}     <- the default
```

**Private is pre-selected**, so a user who accepts the dialog and a script that omits the header both
end up somewhere nobody else can see. Demonstrated by logging in twice against the same restored
cluster:

```
  tenant=private  dashboard listed: False
  tenant=global   dashboard listed: True
```

`-H 'securitytenant: global'` on the import is the fix, and it belongs in any script that provisions
dashboards. This is the same trap as the first-login dialog, arrived at through the API — and the
API version is worse, because there is no dialog to remind you.

**The security plugin blocks the whole UI on first login with a tenant chooser.** Before any
navigation is possible:

```
Select your tenant
Global  — shared between every OpenSearch Dashboards user
Private — exclusive to each user and can't be shared
```

It looks like a dismissible nicety and is not: **an index pattern saved in the Private tenant is
invisible to everyone else, including you in a later session that picked Global.** Saved objects —
index patterns, visualizations, dashboards — are stored per tenant. Choosing Global here is what
makes the work above shared, and "my index pattern disappeared" almost always means someone was in
the other one.

**ISM is slow by default, and nothing about that is obvious.** Reading the shipped values rather
than assuming them:

```
  plugins.index_state_management.job_interval             = 5      (minutes)
  plugins.index_state_management.jitter                   = 0.6
  plugins.index_state_management.coordinator.sweep_period = 10m
```

A newly created index waits up to **10 minutes** to be picked up, then its job runs every **5
minutes**, and `jitter: 0.6` adds up to 60% randomly on top. **A condition met now can take a
quarter of an hour to act**, which is correct for a cluster with thousands of indices and
maddening when you are testing a policy and concluding it is broken. For a lab:

```json
{
  "persistent": {
    "plugins.index_state_management.job_interval": 1,
    "plugins.index_state_management.jitter": 0.0,
    "plugins.index_state_management.coordinator.sweep_period": "5m"
  }
}
```

**`sweep_period` has a floor, and the rejection takes the whole request with it.** Asking for `1m`:

```
failed to parse value [1m] for setting [plugins.index_state_management.coordinator.sweep_period],
must be >= [5m]
```

```
  acknowledged: None
  persistent: {}
```

The cluster settings API is **atomic** — one invalid value and none of the other settings in the same
body are applied. The `400` is clear if you read it, and the trap is a script that fires the update,
ignores the response, and proceeds believing `job_interval` is now 1.

**A rollover action with no `rollover_alias` fails quietly and the index sits in `hot` forever.**
Running the identical policy against an index created without that setting:

```
  state:  hot
  action: rollover | failed: None
  message: Missing rollover_alias index setting [index=badlogs-000001]
```

Note `failed: None` — ISM does not consider this a terminal failure, it just keeps retrying, so the
index accumulates documents indefinitely while a policy is attached and apparently healthy. **The
managed-index list is not the check; `_ism/explain` and its `info.message` are.** The setting has to
be on the index, which in practice means in the index template, which means it has to exist before
the first index is created.

**Every transition above uses `min_index_age`, measured from index creation** — not from the
rollover, and not from the previous transition. Two consequences worth internalising before copying
this policy: a long-lived hot index eats its own retention window, because the clock started when it
was created rather than when it stopped being written; and a `delete` state does exactly what it
says, with no snapshot and no undo. **Test a retention policy against indices you are willing to
lose**, which is what this page did — the eight documents in `applogs-000001` are gone and were
meant to be.

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

- [ ] Work out why `.opendistro-ism-managed-index-history-*` stayed empty while `_ism/explain` showed every transition — the audit trail is the part an operator would want after the fact
- [ ] Add an `allocation` action moving warm indices onto dedicated nodes by attribute — the half of a warm tier a single node structurally cannot show
- [ ] Wait out `soft_deletes.retention_lease.period` (or lower it) and confirm `docs.deleted` finally drops to zero
- [ ] Replace the demo certificates and drop `-k`, which is the first real step toward anything non-lab
- [ ] Create a non-admin role that can read `applogs-*` and nothing else, and confirm it is refused elsewhere
- [ ] Put `applogs-objects.ndjson` and the index template in a repository and import both from CI, so a fresh cluster comes up complete without anyone opening the UI
- [ ] Ship the logs from [[loki-logs-labels-and-cardinality]] into this index and compare what each system makes cheap — labels versus mappings is the same decision made twice
- [ ] Measure the storage cost of `text` + `.keyword` against plain `keyword` on a corpus big enough to matter
- [ ] Take a snapshot to a filesystem repository and restore it into a fresh cluster

## Related

[[loki-logs-labels-and-cardinality]] — the other way to store logs, where the equivalent decision is which fields become labels.
[[grafana-correlate-three-signals]] — where a log store earns its place, by being one of three signals rather than a silo.
[[dbt-duckdb-local]] — the same lesson from the data side: a column's declared type is what makes a query answerable.
[[prometheus-instrument-and-query]] — bucket boundaries chosen before the data arrives, which is the same class of decision as a mapping.
