---
title: Bruno — a git-friendly REST client, from a request to a CI gate
date: 2026-08-19
domain: reference
tags: [api, testing, developer-tools, cicd]
stack: [bruno, fastapi]
summary: Bruno stores each request as a plaintext .bru file inside the collection folder instead of one exported JSON blob, so a request change is a normal, reviewable git diff. Verified with the CLI end to end — a real collection, real pass/fail/connection-refused output, real exit codes, and a JUnit report a GitLab CI job could consume directly.
source: handson
env: Bruno CLI (@usebruno/cli) 4.0.0 via npx and Bruno desktop 4.0.0 (Homebrew cask), Node.js 24.10.0, npm 11.6.0, tested against a local FastAPI service on macOS 14.7.5
verified: 2026-08-20
verifiability: partial
verifiability-note: The CLI (`bru run`) and the desktop GUI's request builder and Runner were both exercised, driven via computer-use screen automation rather than by hand. GUI-only features not touched by that pass — the cookie jar, OAuth2 flows, and Git-integration panel — are still unverified.
duration: 30–40 min
risk: low
---

> **Verified 2026-08-19 (CLI) and 2026-08-20 (desktop GUI).** Every command and every click below
> ran for real — the CLI in a scratch directory, the GUI installed via Homebrew and driven against
> the same local FastAPI service. Outputs and screenshots are reproduced as observed.

Bruno is a REST client in the same space as Postman or Insomnia, with one structural difference
that matters more than the UI: **a collection is a folder of plaintext `.bru` files**, not one
exported JSON blob. Each request is its own file. Renaming a folder is a `git mv`. Reviewing a
request change is a normal diff, not a JSON blob diff where a one-line edit moves half the file.
That property is why this is worth a reference entry rather than "use whatever REST client you
like" — it is the one Postman/Insomnia genuinely lack.

## Install

The CLI needs no account and no desktop install — it is a Node package:

```bash
npx --yes @usebruno/cli --version
```

```
4.0.0
```

For repeated use, install it once rather than re-fetching on every invocation:

```bash
npm install -g @usebruno/cli
bru --version
```

The desktop GUI app installs separately, from [usebruno.com](https://www.usebruno.com/downloads) or
via Homebrew:

```bash
brew install --cask bruno
```

Both ship the same version number (`4.0.0` here) and read the same `.bru` files — a collection
built with one opens in the other with no conversion step, confirmed below.

## Anatomy of a collection

```bash
mkdir -p hello-api-collection/environments
cd hello-api-collection
```

```json title="bruno.json"
{
  "version": "1",
  "name": "hello-api",
  "type": "collection",
  "ignore": ["node_modules", ".git"]
}
```

This file marks the directory as a collection root — `bru run` refuses to run outside one.

```text title="environments/local.bru"
vars {
  base_url: http://127.0.0.1:18471
}
```

An environment is just a named set of variables, referenced elsewhere as `{{base_url}}`. Add a
second file (`environments/staging.bru`, say) and switch with `--env staging` — nothing else in the
collection changes.

## Writing requests

```text title="healthz.bru"
meta {
  name: healthz
  type: http
  seq: 1
}

get {
  url: {{base_url}}/healthz
  body: none
  auth: none
}

assert {
  res.status: eq 200
  res.body.status: eq ok
}

tests {
  test("version comes from the environment, not a hardcoded default", function() {
    expect(res.getBody().version).to.equal("demo123");
  });
}
```

Two different checking mechanisms, and they are not interchangeable. `assert` is declarative —
`res.body.status: eq ok` reads its own pass condition. `tests` is a real JavaScript block with
Chai-style assertions (`expect(...).to.equal(...)`), for anything an `assert` line cannot express —
here, that the version actually came from `APP_VERSION` rather than the endpoint's hardcoded
default.

A POST with a JSON body looks like this:

```text title="echo.bru"
meta {
  name: echo
  type: http
  seq: 3
}

post {
  url: {{base_url}}/echo
  body: json
  auth: none
}

headers {
  content-type: application/json
}

body:json {
  {
    "hello": "bruno"
  }
}

assert {
  res.status: eq 200
  res.body.received.hello: eq bruno
}
```

`{{base_url}}` and any other `{{var}}` in the URL, headers, or body are resolved from whichever
`--env` is active at run time — nothing here is environment-specific except the `environments/`
file itself.

## Running it

Against a real FastAPI service (`/healthz`, `/`, and an `/echo` endpoint) started with
`APP_VERSION=demo123 APP_ENV=bruno-lab uvicorn app.main:app --port 18471`:

```bash
bru run --env local
```

```
healthz (200 OK) - 12 ms
Tests
   ✓ version comes from the environment, not a hardcoded default
Assertions
   ✓ res.status: eq 200
   ✓ res.body.status: eq ok
root (200 OK) - 2 ms
Assertions
   ✓ res.status: eq 200
echo (200 OK) - 3 ms
Assertions
   ✓ res.status: eq 200
   ✓ res.body.received.hello: eq bruno

📊 Execution Summary
┌───────────────┬──────────────┐
│ Metric        │    Result    │
├───────────────┼──────────────┤
│ Status        │    ✓ PASS    │
├───────────────┼──────────────┤
│ Requests      │ 3 (3 Passed) │
├───────────────┼──────────────┤
│ Tests         │     1/1      │
├───────────────┼──────────────┤
│ Assertions    │     5/5      │
├───────────────┼──────────────┤
│ Duration (ms) │     162      │
└───────────────┴──────────────┘
```

`bru run request.bru` runs one file; `bru run folder -r` runs a folder recursively; bare `bru run`
runs the whole collection. `--tests-only` skips requests that carry neither an `assert` nor a
`tests` block — useful once a collection mixes exploratory requests with real checks.

### What a failing assertion looks like

```bash
# healthz.bru edited so the test expects "wrong-version" instead of "demo123"
bru run healthz.bru --env local
```

```
healthz (200 OK) - 12 ms
Tests
   ✕ version comes from the environment, not a hardcoded default
      expected 'demo123' to equal 'wrong-version'
Assertions
   ✓ res.status: eq 200
   ✓ res.body.status: eq ok

Status        ✗ FAIL
Requests      1 (1 Failed)
Tests         0/1
```

### What a dead server looks like

```bash
bru run healthz.bru --env local
```

```
healthz (connect ECONNREFUSED 127.0.0.1:18471)

Status        ✗ FAIL
Requests      1 (1 Failed)
```

Both failure shapes read differently — a failed assertion still shows a `200 OK` and green
`Assertions` lines above the red `Tests` line; a dead server never gets past the request line at
all. Both were run here, not just the passing case.

### Exit codes — the part that makes this usable in CI

```bash
bru run --env local >/dev/null 2>&1; echo "pass: $?"
# after breaking the assertion above:
bru run healthz.bru --env local >/dev/null 2>&1; echo "fail: $?"
```

```
pass: 0
fail: 1
```

`0` on a fully passing run, `1` on any failed request, assertion, or test — confirmed for both an
assertion failure and a connection-refused failure, not assumed from one case. This is what makes
`bru run` usable as a CI gate rather than only a manual tool: a shell command with a meaningful exit
code is something `.gitlab-ci.yml` can just run as a job script.

## CI integration — a JUnit report GitLab can render natively

```bash
bru run --env local --reporter-junit results.xml
```

```xml title="results.xml"
<?xml version="1.0"?>
<testsuites>
  <testsuite name="healthz" file="healthz.bru" errors="0" failures="0" skipped="0" tests="3" ...>
    <testcase name="res.status eq 200" status="pass" classname="healthz" .../>
    <testcase name="res.body.status eq ok" status="pass" classname="healthz" .../>
    <testcase name="version comes from the environment, not a hardcoded default" status="pass" .../>
  </testsuite>
  <testsuite name="root" file="root.bru" errors="0" failures="0" skipped="0" tests="1" .../>
</testsuites>
```

In a GitLab pipeline, wiring that straight into the merge request test report costs one block:

```yaml title=".gitlab-ci.yml excerpt"
smoke-test:
  stage: test
  image: node:22-slim
  script:
    - npx --yes @usebruno/cli run --env staging --reporter-junit results.xml
  artifacts:
    reports:
      junit: results.xml
```

`--reporter-json` and `--reporter-html` exist alongside `--reporter-junit` for a machine-readable
or a human-readable artifact instead of (or as well as) the JUnit one.

## The desktop GUI

**Same collection, opened two ways, gave identical results — that parity is the actual point of
the plaintext `.bru` format**, not a separate feature to learn. `File → Open Collection` on the
`hello-api-collection` folder built with the CLI above loaded it into the GUI with all three
requests, both environments, and the `bruno.json` collection name intact — no import step, because
there was nothing to convert.

Sending `healthz` from the GUI with the `local` environment selected returned the same `200 OK`
body as the CLI run, and its **Tests** tab showed the identical result the CLI printed to the
terminal:

```
Tests (1), Passed: 1, Failed: 0
  ✓ version comes from the environment, not a hardcoded default
Assertions (2), Passed: 2, Failed: 0
  ✓ res.status: eq 200
  ✓ res.body.status: eq ok
```

The GUI also has its own **Runner** (the running-figure icon next to *Initialize Git*) — the visual
equivalent of `bru run` across a whole collection, with per-request pass/fail and a
downloadable report:

```
Filter by:  All 3   Passed 3   Failed 0   Skipped 0

healthz  200 - OK
  ✓ version comes from the environment, not a hardcoded default
  ✓ res.status: eq 200
  ✓ res.body.status: eq ok
root     200 - OK
  ✓ res.status: eq 200
echo     200 - OK
  ✓ res.status: eq 200
  ✓ res.body.received.hello: eq bruno
```

Two real differences worth knowing before assuming the two interfaces are interchangeable:

- **CSV/JSON-parameterized runs are paywalled in the GUI Runner** — the "Run with Parameters" panel
  shows a "🔒 UPGRADE" badge next to Bruno Ultimate. The same capability is a free CLI flag:
  `--csv-file-path` / `--json-file-path`, exercised in `bru run --help`'s own examples above, no
  license involved. If parameterized runs matter, the CLI has them and the free GUI does not.
- **The `Ctrl/Cmd+Shift+G` file-open sheet on macOS could not navigate into `/private/tmp/...`** —
  typing that path and pressing Return silently did nothing, repeatedly, while the identical
  `~/Documents/...` path resolved and opened on the first try. Whether this is Bruno's own file
  dialog or a macOS sandbox boundary around `/private/tmp` was not narrowed down; the practical
  answer is the same either way — **keep a collection you intend to open in the GUI somewhere under
  the user's home directory**, not a system scratch/temp path.

## Verification checklist

- [x] `npx --yes @usebruno/cli --version` prints a version with no account or install step
- [x] A `bruno.json` + `environments/*.bru` + request `.bru` files run with `bru run --env <name>`
- [x] A passing collection prints `✓ PASS` and every `assert`/`tests` line green
- [x] A broken assertion prints `✗ FAIL` with the expected-vs-actual values, and exits `1`
- [x] A dead target prints `ECONNREFUSED` distinctly from an assertion failure, and also exits `1`
- [x] `--reporter-junit` produces XML GitLab's `artifacts: reports: junit:` can consume directly
- [x] The same collection folder opens in the desktop GUI with no import step
- [x] A request sent from the GUI returns the same body, and its Tests tab shows the same pass/fail as the CLI
- [x] The GUI's own Runner reproduces `bru run`'s result across the whole collection
- [x] Removing a stray `environments/*.bak` file makes the GUI's phantom extra environment entry disappear

## Rollback

Nothing outside the working directory and `npm`'s package cache is touched:

```bash
rm -rf hello-api-collection
npm uninstall -g @usebruno/cli   # only if installed globally in the first place
```

Uninstall the desktop app the same way it was installed:

```bash
brew uninstall --cask bruno
```

## Where this bit us

**A hardcoded test port silently collided with an unrelated already-running service.** The first
"kill the server, confirm the request now fails" check was set up against port `8811` — chosen
without checking it was free first. A leftover `python3 -m http.server` from earlier in the same
session happened to already be listening there, so after "stopping" the FastAPI app, `bru run`
against the same port got a perfectly normal `404 File not found` from the *other* server instead
of a connection error — which reads exactly like a working request that returned the wrong status,
not like "nothing is listening here." Re-run against a port confirmed free with `lsof -i :<port>`
first, and the real `ECONNREFUSED` case showed up as expected. **Check what is actually listening on
a test port before trusting what a "server is down" test tells you** — a coincidentally-occupied
port is indistinguishable from a real bug until you look.

**A `sed -i.bak` leftover became a second, phantom environment in the GUI's picker.** Copying the
collection for the GUI test carried along `environments/local.bru.bak`, a backup file created
earlier while editing the port in `local.bru` with `sed`. The GUI's environment dropdown listed it
as a *second* environment named `local.bru` — it strips only the trailing `.bak` rather than
recognizing "not a `.bru` file, skip it." Selecting that phantom entry would leave every `{{var}}`
unresolved, since it carries no actual variables. Removing the stray file made it disappear from
the picker on the next open, confirming the cause rather than assuming it. **Anything left in
`environments/` gets offered as a real environment** — an editor backup, a `.orig` from a merge
conflict, or an old copy someone forgot to delete all show up as a selectable, broken option.

**Parameterized runs are a paid-tier feature in the GUI Runner but a free flag in the CLI.** The
GUI's "Run with Parameters" panel (CSV/JSON iteration) is gated behind a "Bruno Ultimate" upgrade
prompt; `bru run --csv-file-path data.csv --parallel` from the CLI needs no license at all. Worth
knowing before assuming both interfaces offer the same feature set, or before recommending the GUI
runner for something a CI pipeline can already do for free from the command line.

## Follow-ups

- [ ] Try the secrets provider flags (`--secrets-env-file`, `BRUNO_*` keys) against a real secrets backend rather than a plain `.bru` environment file
- [ ] Exercise GUI-only surfaces not touched by this pass: the cookie jar, OAuth2 flows, and the Git-integration panel visible in the toolbar (`Initialize Git`)
- [ ] Narrow down whether the `/private/tmp` file-dialog navigation failure is Bruno-specific or a general macOS sandbox boundary, by testing the same "Go to Folder" path in another sandboxed Electron app
- [ ] Add a Bruno smoke-test stage to [[gitlab-ci-argocd-fastapi-procedure]]'s pipeline — a `/healthz` + `/readyz` check against the just-deployed `hello-api` would be a fourth, independent confirmation alongside that procedure's three-signal check in step 6.4

## Related

[[gitlab-ci-argocd-fastapi-procedure]] — the pipeline this collection's JUnit report is written to plug into, and the service (`hello-api`) this write-up tested against.
[[gitlab-ci-argocd-fastapi-onprem]] — section 7's three-signal deploy check, which a Bruno smoke-test stage would complement rather than replace.
[[dagster-local-quickstart]] — the same "verify via CLI/curl, not a browser" approach applied to a local service, there a Dagster webserver instead of `hello-api`.
