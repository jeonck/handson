---
title: OpenSearch — a single node, and the range query that quietly lies
date: 2026-08-23
domain: install
tags: [search, logs, indexing, retention, containers]
stack: [opensearch, opensearch-dashboards, minio, podman, docker-compose]
summary: A single-node OpenSearch 3.8 with security on, interrogated about its own guesses. Dynamic mapping typed a quoted "412" as text, and duration_ms >= 200 then returned a document whose value was 87 — no error, just string comparison. An index template fixes it and does nothing to the index that already exists, and an ISM policy then rolls that index over and deletes it while writers keep addressing one alias.
source: handson
env: OpenSearch 3.8.0 (Lucene 10.5.0) · OpenSearch Dashboards 3.8.0 (Chromium via Playwright for the UI steps) · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-23
verifiability: partial
verifiability-note: Verified on a single node with the demo TLS certificates and the built-in admin user. The full ISM lifecycle — rollover, a warm state with read_only/force_merge/index_priority, and deletion — was exercised end to end, but with lab-sized minute-scale transitions and a tightened scheduler rather than a real policy measured in days. The warm tier's allocation half needs more than one node. The Dashboards steps — tenant selection, index pattern creation, Discover, and a three-panel dashboard imported from a file and restored after the volume was destroyed — were driven through the real UI and screenshotted. Snapshot and restore were exercised across a destroyed and rebuilt cluster, both to a filesystem repository and to S3-compatible object storage (MinIO, not AWS — so IAM roles and real S3 semantics are unproven). Multi-node repository access, multi-node allocation and real certificates are unexercised — and cluster behaviour under node loss is the thing a single node structurally cannot show.
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
      # Without this the system:admin/system_index permission is parsed and
      # ignored, and protected indices answer 0 instead of refusing.
      plugins.security.system_indices.permission.enabled: "true"
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

## Snapshot and restore, into a genuinely fresh cluster

A snapshot repository is a directory, and **it has to be somewhere the cluster is allowed to write
and somewhere that outlives the data volume** — which rules out a named volume, because
`compose down -v` takes those with it:

```yaml title="compose.yml"
    environment:
      # A snapshot repository must be on an allow-listed path, and the
      # directory has to outlive the data volume to be worth anything.
      path.repo: /mnt/snapshots
    volumes:
      - os-data:/usr/share/opensearch/data
      - ./snapshots:/mnt/snapshots:Z
```

`path.repo` is an allow-list, and it is enforced:

```bash
-X PUT ".../_snapshot/bad-fs" -d '{"type":"fs","settings":{"location":"/tmp/elsewhere"}}'
```

```
  status: 500
  reason: [bad-fs] location [/tmp/elsewhere] doesn't match any of the locations specified by path.repo
```

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X PUT "https://127.0.0.1:9200/_snapshot/local-fs" \
  -d '{"type":"fs","settings":{"location":"/mnt/snapshots","compress":true}}'

curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X PUT "https://127.0.0.1:9200/_snapshot/local-fs/snap-1?wait_for_completion=true" \
  -d '{"indices":"applogs-*","include_global_state":true}'
```

```
  name: snap-1 | state: SUCCESS
  indices: ['applogs-000001']
  shards: {'total': 1, 'failed': 0, 'successful': 1} | duration: 200 ms
```

**`_verify` on the repository is worth running once** — it confirms every node can actually write
there, which is the failure a multi-node cluster hits and a single node cannot show.

### Destroying the cluster is the only honest test

```bash
podman compose down -v      # data volume gone; ./snapshots is a bind mount and stays
podman compose up -d
```

```
  applogs indices: (none)
  index template:  0 found
  ISM policy:      MISSING
```

Re-registering the same repository against the same directory **discovers** the snapshot rather than
creating anything:

```
  id      status indices successful_shards
  snap-1 SUCCESS       1                 1
```

That is the property that makes a repository a backup: **the snapshot is the files, not a record in
the cluster that made it.**

```bash
-X POST ".../_snapshot/local-fs/snap-1/_restore?wait_for_completion=true" -d '{"indices":"applogs-*"}'
```

```
  docs:        800
  duration_ms  integer
  service      keyword
  message      text
  level        keyword
  alias:       applogs applogs-000001 true
  rollover_alias setting: applogs
```

Everything index-level came back — documents, the mapping this whole page is about, the write alias,
and the ISM rollover setting. The check that matters is not the document count but that the data is
still *usable*:

```
  duration_ms >= 800 -> 42 hits
```

A numeric range on a numeric field, which is exactly what the dynamically-mapped index could not do.

### Restoring without deleting anything

The delete-then-restore sequence above is the wrong shape, and `rename_pattern` is the right one.
The scenario, made concrete: a snapshot taken at 400 documents, then 293 deleted from the live index
by mistake.

```
  docs at snapshot time: 400
  deleted:               293
  live index now:        107
```

```bash
curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST ".../_snapshot/local-fs/snap-1/_restore?wait_for_completion=true" -d '{
  "indices": "applogs-000001",
  "rename_pattern": "applogs-(.+)",
  "rename_replacement": "applogs-restored-$1",
  "include_aliases": false
}'
```

**`include_aliases: false` is not optional here** — see [Where this bit us](#where-this-bit-us).

```
  index                   docs.count health
  applogs-restored-000001        400 green
  applogs-000001                 107 green

  alias   index          is_write_index
  applogs applogs-000001 true
```

**Two indices, nothing deleted, and the alias has not moved.** The restored copy carries the
snapshot's 400 documents while the damaged live index keeps its 107, so the restore can be inspected
before anyone commits to it. The mapping came along as well — `duration_ms` is still `integer`.

Then the cutover is one call, and it is atomic:

```bash
-X POST ".../_aliases" -d '{
  "actions": [
    { "remove": { "index": "applogs-000001",          "alias": "applogs" } },
    { "add":    { "index": "applogs-restored-000001", "alias": "applogs", "is_write_index": true } }
  ]
}'
```

```
  read through the alias BEFORE the swap: 107
  read through the alias AFTER the swap:  400
```

**Both actions in one request is the whole point.** Two separate calls leave a window in which the
alias points at nothing, and every reader and writer gets an error for the duration. Writers follow
immediately and without being told:

```
  landed in: applogs-restored-000001 | result: created
```

And because nothing was destroyed, the mirrored call rolls it back — verified in both directions
rather than assumed:

```
  roll back  -> alias reads 107
  roll forward -> alias reads 401
```

```
  duration_ms >= 800 -> 21 hits
```

`applogs-000001` sits there holding the pre-restore state until someone is confident enough to
delete it, which is a decision that can now be taken calmly and separately.

### The same thing against object storage

A bind mount is not a backup target anyone would use. The `repository-s3` plugin is, and it can be
exercised against **MinIO** — the same S3 API, the same plugin code path, no cloud credential
involved. What that costs is four pieces of setup, each of which fails differently.

**The plugin is not installed.** The distribution image ships two dozen plugins and not this one:

```dockerfile title="Containerfile.s3"
FROM docker.io/opensearchproject/opensearch:3

# repository-s3 is NOT bundled with the distribution image, despite the two
# dozen plugins that are. Snapshots to object storage need it installed.
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch repository-s3
```

**The endpoint settings are node settings; the credentials are not.**

```yaml title="compose.yml"
    environment:
      # Non-AWS S3 needs the endpoint and path-style addressing.
      # The access key and secret do NOT go here - see the keystore below.
      s3.client.default.endpoint: "minio:9000"
      s3.client.default.protocol: "http"
      s3.client.default.path_style_access: "true"
      # AWS SDK v2 demands a region even when the endpoint is not AWS.
      s3.client.default.region: "us-east-1"
```

```bash
printf 'opensearch'   | bin/opensearch-keystore add --stdin --force s3.client.default.access_key
printf '<REDACTED>'   | bin/opensearch-keystore add --stdin --force s3.client.default.secret_key

curl -sk -u "admin:$OPENSEARCH_ADMIN_PASSWORD" \
  -X POST "https://127.0.0.1:9200/_nodes/reload_secure_settings"
```

```
  keystore reloaded: 1 of 1
```

**`reload_secure_settings` is the reason this does not need a restart** — the S3 client re-reads its
credentials from the keystore on demand. Then the repository itself:

```bash
-X PUT ".../_snapshot/s3-minio" -d '{
  "type": "s3",
  "settings": { "bucket": "opensearch-snapshots", "client": "default", "base_path": "opensearch" }
}'
-X POST ".../_snapshot/s3-minio/_verify"
```

```
  verify: [{'name': '0c3c4e23b114'}]
```

A snapshot then writes real S3 objects, which is worth looking at once:

```
  opensearch/index-0                                                    440B
  opensearch/index.latest                                                 8B
  opensearch/indices/2tl_DcA9TsSVF6sXgg4XVg/0/__qFnY27ZxRIaPmIDEwG6uIQ  35KiB
  opensearch/indices/2tl_DcA9TsSVF6sXgg4XVg/0/index-qrYjSY54T7OVwlWJ…   1.2KiB
  opensearch/meta-cp1k1zrRTmCXTIfTcNIitg.dat                            234B
    total objects: 9
```

**Then destroy the cluster and leave the bucket alone**, which is the arrangement that makes object
storage worth the trouble:

```bash
podman compose rm -sf opensearch
podman volume rm opensearch-lab_os-data     # the cluster's data
# opensearch-lab_minio-data survives — it is the backup
```

Re-adding the keystore entries, re-registering the same bucket, and restoring:

```
  the snapshot is discovered from the bucket
  id         status indices successful_shards
  snap-s3-1 SUCCESS       1                 1

  restored:    ['applogs-000001'] | shards: {'total': 1, 'failed': 0, 'successful': 1}
  docs back:   400
  duration_ms: integer
  range >= 800 -> 21 hits
```

### What a snapshot does not bring back

```
  index template:  0 found
  ISM policy:      MISSING
```

Templates, ISM policies and cluster settings are **cluster state**, not index data. They travel in
`include_global_state`, which defaults to `false` on restore even when the snapshot was taken with
it `true`. And under the security plugin you cannot simply ask for it — see
[Where this bit us](#where-this-bit-us).

**Which settles how the two halves of this page divide up.** Snapshots restore *data*; the files
this page has been accumulating restore *configuration*:

| Artifact | Comes back from |
|---|---|
| Documents, mappings, aliases | `snap-1` in the repository |
| Index template | `applogs-template.json` |
| ISM policy | `applogs-ism.json` |
| Index pattern, visualizations, dashboard | `applogs-objects.ndjson` |

A cluster is only as recoverable as the least reproducible of those four.

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
- [x] `_cat/indices` and `_count` **disagree** on the ISM history index — 1 versus 0, with no error
- [x] The super-admin certificate reads **6** history entries from the index `admin` sees as empty
- [x] Four protected system indices all read 0 to `admin` while holding documents; `.kibana*` does not
- [x] A role granted `system:admin/system_index` still reads **0** until `system_indices.permission.enabled` is turned on
- [x] With it on, that role reads **7** history entries and `admin` gets an explicit **403** instead of a silent zero
- [x] The granted role is still refused on an index it was not given — `403` on `applogs`
- [x] Ordinary indices are unaffected for `admin` after the change
- [x] A repository location outside `path.repo` is refused, naming the setting
- [x] `_verify` reports the node can write to the repository
- [x] After `compose down -v` the cluster is empty and re-registering the repository **discovers** `snap-1` from the files
- [x] A restore returns **800 documents**, the `integer` mapping, the write alias and the `rollover_alias` setting
- [x] `duration_ms >= 800` returns **42** hits after the restore — the data is numerically usable, not merely present
- [x] The index template and ISM policy do **not** come back, and a restore asking for global state is refused `403`
- [x] A renamed restore with default alias handling fails `illegal_state_exception` — two write indices for one alias — and leaves **no** partial index
- [x] With `include_aliases: false` the restored copy (400 docs) and the damaged live index (107 docs) **coexist**, alias unmoved
- [x] One `_aliases` call swaps reads from **107 to 400** and writes follow to the restored index
- [x] The mirrored call rolls the swap back, checked in both directions
- [x] `repository-s3` is **absent** from the distribution image and has to be installed
- [x] Registration and `_verify` return the same sentence for a missing region, a missing KMS and missing credentials — each identified only from the node log
- [x] Keystore entries added via `exec` are **gone** after the container is recreated
- [x] `reload_secure_settings` picks up new credentials with **no restart** — `1 of 1`
- [x] A snapshot writes **9 objects** into the bucket, and destroying the cluster while keeping the bucket still restores 400 documents with the `integer` mapping intact
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

**The S3 repository failed three times, and the API returned the same useless sentence each time.**

```
  [s3-minio] path [opensearch] is not accessible on cluster-manager node
```

That message is what registration and `_verify` both return, unchanged, for three completely
different causes. **Every one of them was only diagnosable from the node log**, where the `Caused by`
chain names the real problem:

```
Caused by: SdkClientException: Unable to load region from any of the providers in the chain
```

AWS SDK v2 requires a region even when the endpoint is not AWS — `s3.client.default.region`.

```
Caused by: S3Exception: Server side encryption specified but KMS is not configured
           (Service: S3, Status Code: 501)
```

`repository-s3` asks for server-side encryption, and MinIO answers `501 NotImplemented` unless it has
a KMS. Setting `server_side_encryption: false` on the repository **did not stop it** — the stored
setting reads `"false"` and the header goes out anyway — so the fix was to give MinIO its built-in
single-key KMS rather than to argue with the plugin.

And before either of those, a missing access key produced the identical sentence. **The lesson is the
diagnostic habit, not the three fixes:** when a repository will not verify, the API tells you nothing
and `podman logs` tells you everything. Reach for the log first.

**Keystore entries do not survive the container being recreated.** Adding credentials with
`podman exec ... opensearch-keystore add` writes into the container's config directory, which is not
a volume:

```
  keystore s3 entries: 0     # after `compose up -d` picked up an env change
```

Every `compose up -d` that changes the service definition silently discards them, and the next
repository call fails with the same unhelpful sentence as everything else. For anything beyond a
lab, bake the keystore into the image at build time or mount the config directory — and note this is
the same class of mistake as the ISM rule edit earlier: **state that lives inside a container is
state you are going to lose.**

**A renamed restore fails on the alias it is carrying.** The obvious `rename_pattern` call, with
alias handling left at its default:

```
  status: 500
  type:   illegal_state_exception
  reason: alias [applogs] has more than one write index [applogs-restored-000001,applogs-000001]
```

The snapshot recorded `applogs` as a **write** alias on `applogs-000001`. Restoring under a new name
re-attaches it, and an alias may have only one write index. The rename succeeds at renaming the
index and then trips over the thing it copied along with it. `include_aliases: false` is the fix,
and it is also the right default for this pattern: **you want the restored index to arrive detached,
precisely so you can decide when it takes over.**

Worth noting what did *not* happen — the failed restore left no half-made index behind:

```
  index          docs.count
  applogs-000001        107
```

That is the contrast with the delete-first sequence below, where the failure landed after the
destructive step rather than before it.

**A restore with `include_global_state` is refused, and the error blames the wrong thing.** The same
user, the same snapshot, one flag apart:

```
  {"indices":"applogs-*"}                              -> restored, 800 docs
  {"indices":"applogs-*","include_global_state":true}  -> 403
```

```
  type:   security_exception
  reason: no permissions for [cluster:admin/snapshot/restore] and User [name=admin, backend_roles=[admin], ...]
```

**`admin` plainly does have that permission** — it had just used it. The security plugin refuses
restores that carry global state, because global state includes the cluster's security
configuration and restoring it would overwrite the users and roles of the cluster you are restoring
*into*. That is a sound refusal wrapped in a message that sends you to look at role definitions.
The relevant configuration is two lines of the demo setup:

```yaml
plugins.security.enable_snapshot_restore_privilege: true
plugins.security.check_snapshot_restore_write_privileges: true
```

The practical consequence: **with the security plugin on, templates and ISM policies do not come
back from a snapshot at all.** They have to be re-applied from files, which is the argument for
keeping them as files in the first place.

**And the sequence that nearly cost the data.** A restore over an index that already exists fails,
so the natural move is to delete the index and restore again — which is what happened here:

```
  DELETE applogs-000001            -> ok
  restore with global state        -> 403
  _cat/indices applogs-*           -> (none)
```

For the length of that gap the 800 documents existed **only in the snapshot**, because the failure
came after the delete. Nothing was lost — the retry without the flag restored all 800 — but the
order is worth stating plainly: **restore into a new index name and swap an alias, or at minimum
prove the restore works before deleting anything.** `rename_pattern` and `rename_replacement` on the
restore body exist for exactly this, and are the safer default — demonstrated above, where the
restore and the live index coexisted and the cutover was a single reversible `_aliases` call.

**The ISM history index was never empty — the security plugin was hiding it.** `_ism/explain` showed
every transition live, while a search of `.opendistro-ism-managed-index-history-*` returned nothing.
The two numbers disagree, from the same cluster at the same moment:

```
_cat/indices  ->  docs.count 1,  store 8.9kb
_count        ->  {"count":0,"_shards":{"total":1,"successful":1,"failed":0}}
```

**No error, no `403`, and the shard reports success.** `_cat` reads cluster metadata and sees the
documents; the search path goes through the security plugin and comes back empty. Confirmed by
asking twice over, as the `admin` user and as super-admin with the demo `kirk` client certificate,
which bypasses the plugin entirely:

```bash
curl -sk -u "admin:<REDACTED>" "https://localhost:9200/$H/_count"
curl -sk --cert config/kirk.pem --key config/kirk-key.pem "https://localhost:9200/$H/_count"
```

```
  as admin:       {"count":0,...}
  as super-admin: {"count":6,...}
```

The cause is one line of the demo configuration:

```yaml
plugins.security.system_indices.enabled: true
```

With no explicit `system_indices.indices` list, the plugin's defaults apply, and they cover the
plugin state indices. The same comparison across several of them:

| Index | as `admin` | as super-admin | `_cat` |
|---|---|---|---|
| `.opendistro-ism-managed-index-history-…` | 0 | **6** | 6 |
| `.opendistro-ism-config` | 0 | **5** | 15 |
| `.plugins-ml-config` | 0 | **1** | 1 |
| `.opendistro_security` | 0 | **9** | 9 |
| `.kibana_1` | 0 | 0 | 0 |

`.kibana*` is **not** in that set — the saved objects were read out of it as `admin` earlier in this
page. It reads 0 here because this run had nothing imported into it, which is a useful reminder that
a zero can mean two different things.

And the history itself, once readable, is exactly the audit trail `_ism/explain` showed:

```
  applogs-000001   hot    -              Successfully initialized policy: applogs-retention
  applogs-000001   hot    rollover       Successfully rolled over index [index=applogs-000001]
  applogs-000002   hot    -              Successfully initialized policy: applogs-retention
  applogs-000001   -      -              Transitioning to warm [index=applogs-000001]
  applogs-000001   warm   read_only      Successfully set index to read-only
  applogs-000001   warm   force_merge    …
```

**The lesson is bigger than ISM.** A protected system index answers every query with zero rather
than a denial, so "the index is empty" and "you are not allowed to see this" are indistinguishable
from the response. **When a system index reads empty, compare `_cat/indices` against `_count` before
believing it** — they disagree exactly when something is being hidden.

**Granting the permission is not enough, because the permission is switched off.** Creating a role
with `system:admin/system_index` on the history pattern, mapping a user to it, and reading:

```json
{
  "cluster_permissions": ["cluster_composite_ops_ro"],
  "index_permissions": [{
    "index_patterns": [".opendistro-ism-managed-index-history-*"],
    "allowed_actions": ["read", "indices:admin/mappings/get", "system:admin/system_index"]
  }]
}
```

```
  ismreader now sees: {"count":0,...}
```

Unchanged. The permission model has a **second switch**, absent from the demo config and defaulting
off, so the permission is parsed and ignored:

```yaml
plugins.security.system_indices.permission.enabled: "true"
```

With that set, the same role and the same user:

```
  ismreader:  {"count":7,...}
  admin:      403 security_exception — no permissions for [] and User [name=admin, ...]
```

**Turning it on changes two things at once**, and the second is the more valuable:

| | default (`permission.enabled` off) | `permission.enabled: true` |
|---|---|---|
| `admin` on a system index | silent `count: 0` | **`403 security_exception`** |
| role holding `system:admin/system_index` | silent `count: 0` — ignored | **`count: 7`** |
| super-admin certificate | works | works |

So the default configuration manages to both ignore the grant *and* hide the refusal. Enabling the
permission model makes the denial honest, which is worth more than the access: **a `403` sends
someone to the role definition, a `0` sends them to look for a bug in ISM.**

The role stays properly confined — `ismreader` reading a normal index it was not granted:

```
  403  no permissions for [indices:data/read/search] and User [name=ismreader, ...]
```

and `admin` still reads ordinary indices exactly as before, so the setting scopes to protected
system indices only.

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

- [ ] Decide whether `system_indices.permission.enabled` belongs on by default in a real cluster, given it converts every existing silent zero into a `403` for callers that were quietly getting nothing
- [ ] Add an `allocation` action moving warm indices onto dedicated nodes by attribute — the half of a warm tier a single node structurally cannot show
- [ ] Wait out `soft_deletes.retention_lease.period` (or lower it) and confirm `docs.deleted` finally drops to zero
- [ ] Replace the demo certificates and drop `-k`, which is the first real step toward anything non-lab
- [ ] Create a non-admin role that can read `applogs-*` and nothing else, and confirm it is refused elsewhere
- [ ] Put `applogs-objects.ndjson` and the index template in a repository and import both from CI, so a fresh cluster comes up complete without anyone opening the UI
- [ ] Ship the logs from [[loki-logs-labels-and-cardinality]] into this index and compare what each system makes cheap — labels versus mappings is the same decision made twice
- [ ] Measure the storage cost of `text` + `.keyword` against plain `keyword` on a corpus big enough to matter
- [ ] Script the restore-and-swap as one runbook step with a verification gate between the restore and the `_aliases` call, since the safety comes from the pause rather than from the commands
- [ ] Run the same repository against real S3 with an IAM role rather than static keys, which is the credential path a production cluster actually uses and the one MinIO cannot stand in for

## Related

[[loki-logs-labels-and-cardinality]] — the other way to store logs, where the equivalent decision is which fields become labels.
[[grafana-correlate-three-signals]] — where a log store earns its place, by being one of three signals rather than a silo.
[[dbt-duckdb-local]] — the same lesson from the data side: a column's declared type is what makes a query answerable.
[[prometheus-instrument-and-query]] — bucket boundaries chosen before the data arrives, which is the same class of decision as a mapping.
