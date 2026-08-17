---
title: Remote state — what a lock and an import actually do
date: 2026-08-16
domain: runbook
tags: [iac, terraform, state, backend]
stack: [terraform, opentofu, nodejs]
summary: Importing into shared state and a lock held by somebody else, rehearsed against three remote backends you can run in one terminal. On S3 the lock is one conditional PUT — and on Garage that header is ignored, so use_lockfile hands you a lock that never refuses anyone.
source: handson
env: Terraform 1.15.7 (darwin_arm64) · hashicorp/time 0.14.1 · three backends on localhost — the http backend and an S3 stub, both small Node 24.10 processes, plus Garage 2.3.0 in Podman (single node, replication factor 1). Not AWS S3, not DynamoDB, not Terraform Cloud
verified: 2026-08-17
verifiability: partial
verifiability-note: All three backends exercise Terraform's own code paths end to end, including the S3 conditional-write lock and its failure on Garage. What is untested is AWS itself — IAM, versioning, real S3 semantics — and the DynamoDB lock table that most existing setups still use.
duration: 20–30 min
risk: medium
---

> **Verified 2026-08-17.** Every command, every error and every server log line below was produced on
> Terraform 1.15.7. The two gaps left open by [[terraform-state-operations]] — `import`, and lock
> behaviour on a remote backend — are closed on the http backend, on an S3 stub, and on **Garage**,
> the endpoint this cluster actually runs.
>
> **The Garage run found something.** `use_lockfile` provides no mutual exclusion there: Garage 2.3.0
> accepts a conditional `PUT` that should be refused, so two applies both take the lock and the first
> one fails on release. Section 7, with a probe you can point at any endpoint.
>
> **The S3 endpoint is a local stub, deliberately.** What is under test is Terraform's s3 backend —
> its lock protocol and its import path — not an object store. A Node process implementing only the
> calls that backend makes turns out to be enough to exercise all of it, including the
> conditional-write lock. Which S3 implementation this cluster actually runs is a separate question,
> already decided in [[s3-object-storage-options]] and installed in [[garage-object-storage-onprem]].
> See [What is still untested](#what-is-still-untested).

A local backend teaches you almost everything about state except the two things that actually hurt in a team: adopting existing infrastructure into shared state, and finding the state locked by somebody who is not you.

Both need a backend that lives outside your process. This lab uses three, in order: the **http backend**, whose entire protocol is four HTTP methods; the **s3 backend** against a stub, which is what teams actually run; and then **Garage**, which is what this cluster runs. Serving all three locally means the lock can be watched being granted and refused instead of inferred — and the third one never refuses at all.

## The lab

Three files, no account, no daemon, no container.

```javascript title="state-server.mjs"
// Minimal Terraform `http` backend: state storage plus a real lock.
// Node standard library only.
//   GET    /state -> current state, 404 when there is none yet
//   POST   /state -> store state
//   LOCK   /lock  -> 200 to grant, 423 with the holder's lock info to refuse
//   UNLOCK /lock  -> release
import { createServer } from "node:http";

let state = null;
let lock = null;

const read = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

createServer(async (req, res) => {
  const body = await read(req);
  const path = req.url.split("?")[0];
  const log = (code, note = "") =>
    console.log(`${new Date().toISOString().slice(11, 19)} ${req.method.padEnd(6)} ${path} -> ${code} ${note}`);

  if (path === "/state" && req.method === "GET") {
    if (!state) return log(404) || res.writeHead(404).end();
    log(200);
    res.writeHead(200, { "Content-Type": "application/json" }).end(state);
    return;
  }
  if (path === "/state" && req.method === "POST") {
    state = body;
    log(200, `${body.length} bytes`);
    res.writeHead(200).end();
    return;
  }
  if (path === "/lock" && req.method === "LOCK") {
    if (lock) {
      // 423 is what makes Terraform print "Error acquiring the state lock" with the
      // holder's details. Returning 200 here would let two applies run at once.
      log(423, `held by ${JSON.parse(lock).ID}`);
      res.writeHead(423, { "Content-Type": "application/json" }).end(lock);
      return;
    }
    lock = body;
    log(200, `granted to ${JSON.parse(body).ID}`);
    res.writeHead(200).end();
    return;
  }
  if (path === "/lock" && req.method === "UNLOCK") {
    lock = null;
    log(200, "released");
    res.writeHead(200).end();
    return;
  }
  log(404, "unhandled");
  res.writeHead(404).end();
}).listen(8088, () => console.log("state server on http://127.0.0.1:8088"));
```

```hcl title="versions.tf"
terraform {
  required_version = ">= 1.5.0"

  backend "http" {
    address        = "http://127.0.0.1:8088/state"
    lock_address   = "http://127.0.0.1:8088/lock"
    unlock_address = "http://127.0.0.1:8088/lock"
    lock_method    = "LOCK"
    unlock_method  = "UNLOCK"
  }

  required_providers {
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}
```

```hcl title="main.tf"
resource "terraform_data" "adopted" {
  input = "hello"
}

import {
  to = terraform_data.adopted
  id = "already-exists-outside-terraform"
}
```

`terraform_data` is deliberate. [[terraform-state-operations]] failed to demonstrate `import` because `local_file` and `random_pet` both answer `Resource Import Not Implemented` — **import is a per-resource capability, not a Terraform feature.** `terraform_data` is built in and does implement it.

```bash
mkdir tf-remote-lab && cd tf-remote-lab
# write the three files, then:
node state-server.mjs &
terraform init
```

---

## 1. Confirm the state really left the disk

The point of a remote backend is that state is not a file next to your checkout. Check the property, not the config:

```bash
ls terraform.tfstate
```

```
ls: terraform.tfstate: No such file or directory
```

```bash
curl -s http://127.0.0.1:8088/state | head -c 120
```

A local `terraform.tfstate` here would mean `init` silently fell back — which happens when the backend block is malformed and you answered a migration prompt without reading it. The absence of that file is the pass condition.

---

## 2. Import into shared state

```bash
terraform apply -auto-approve
```

```
terraform_data.adopted: Importing... [id=already-exists-outside-terraform]
terraform_data.adopted: Import complete [id=already-exists-outside-terraform]
Apply complete! Resources: 1 imported, 0 added, 1 changed, 0 destroyed.
```

`1 imported` is the pass condition. The resource existed before Terraform knew about it, and now the remote state holds it — with no create and no destroy.

Run the plan again with the `import` block still in place:

```bash
terraform plan
```

```
Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

**That second plan is the check that matters.** A successful import that leaves a permanent diff means the configuration you wrote does not match the object you adopted, and the next apply will "fix" the real thing to match your guess. Import is not finished until a plan is clean.

Delete the `import` block once applied. It is a one-time instruction, not configuration; leaving it in is harmless but misleads the next reader into thinking the adoption is still pending.

### When you do not know what to write

Terraform can draft the configuration from the real object:

```bash
terraform plan -generate-config-out=generated.tf
```

```
Warning: Config generation is experimental
```

```hcl title="generated.tf"
# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform from "adopt-me"
resource "terraform_data" "generated" {
  input            = null
  triggers_replace = null
}
```

Useful for a resource with forty attributes. Read it before keeping it — it is experimental, it emits every attribute including the ones you would rather leave defaulted, and the warning is not decoration.

An empty id fails early rather than importing nothing:

```
Error: Invalid import id argument

The import ID value evaluates to an empty string, please provide a non-empty
value.
```

---

## 3. A lock held by somebody else

Make one operation slow, then act as the second operator:

```hcl title="main.tf"
resource "time_sleep" "hold" {
  create_duration = "30s"
}
```

```bash
terraform apply -auto-approve &
sleep 6
terraform plan -lock-timeout=0
```

```
Error: Error acquiring the state lock

Error message: HTTP remote state already locked:
ID=982e33b2-2605-c7ec-4469-2fcaac69f6ca
Lock Info:
  ID:        982e33b2-2605-c7ec-4469-2fcaac69f6ca
  Path:
  Operation: OperationTypeApply
  Who:       mac@Macui-MacBookPro.local
  Version:   1.15.7
  Created:   2026-08-16 15:27:17.587854 +0000 UTC
```

**`Who` and `Version` are what a remote lock adds.** The local file lock in [[terraform-state-operations]] printed an ID, a path and an operation; this one names the person and the machine, which is the difference between guessing and asking.

> **`Path:` is empty and that is correct.** The field carries the storage location, and the http
> backend has no path to report — S3 fills it with the object key. An empty field here is not a
> misconfigured backend.

The server side says the same thing from the other direction:

```
15:27:17 LOCK   /lock -> 200 granted to 982e33b2-2605-c7ec-4469-2fcaac69f6ca
15:27:23 LOCK   /lock -> 423 held by 982e33b2-2605-c7ec-4469-2fcaac69f6ca
15:27:39 LOCK   /lock -> 423 held by 982e33b2-2605-c7ec-4469-2fcaac69f6ca
15:27:47 POST   /state -> 200 1337 bytes
15:27:47 UNLOCK /lock -> 200 released
```

Two refusals while the apply held it, then the write and the release. That log is the property; the CLI error is how it surfaces.

`-lock-timeout=0` fails immediately, which is what CI wants. Interactively `-lock-timeout=5m` waits and retries — the same 423 arrives, Terraform just keeps asking.

---

## 4. A lock nobody is holding

The real case is a CI runner killed mid-apply. Its lock outlives it, and every subsequent run fails. Simulate it by taking the lock directly:

```bash
curl -X LOCK -H 'Content-Type: application/json' \
  -d '{"ID":"stale-from-a-killed-ci-runner","Operation":"OperationTypeApply","Who":"ci@runner-7","Version":"1.15.7"}' \
  http://127.0.0.1:8088/lock
```

```bash
terraform plan -lock-timeout=0
```

```
  ID:        stale-from-a-killed-ci-runner
  Who:       ci@runner-7
```

```bash
terraform force-unlock stale-from-a-killed-ci-runner
```

```
The state has been unlocked, and Terraform commands should now be able to
obtain a new lock on the remote state.
```

```bash
terraform plan
```

```
Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

> **The ID is the safety mechanism.** `force-unlock` takes the lock ID from the error, so you cannot
> clear a lock you have not looked at. Read `Who` first and confirm that operation is genuinely
> dead — the job cancelled, the process gone. Breaking a live lock puts two writers on one state
> file, and the loser's resources become orphans that no plan will ever mention again.

---

## 5. `-lock=false` does not fail, and that is the danger

```bash
terraform plan -lock=false
```

The server log for that command contains **no LOCK line at all**. Terraform did not ask; it read and wrote state with no coordination. It works, it is quiet, and two people doing it at once corrupt the state.

The legitimate uses are narrow: a backend with no locking support, or a read-only plan during an incident where the lock is stuck and you have decided that a stale read is acceptable. Reaching for it because a lock error is in the way is how the orphan case in section 4 happens.

---

## 6. The same thing on the s3 backend

The http backend shows the protocol. The s3 backend is what runs in production, and its lock is a
different mechanism: **a conditional PUT**, not a dedicated verb.

The endpoint below implements only the calls the s3 backend makes. It is a lab prop — signatures are
accepted unverified — but the Terraform side of it is entirely real.

```javascript title="s3-server.mjs"
// Minimal S3 endpoint, just enough for Terraform's s3 backend with use_lockfile = true.
// Node standard library only. Signatures are not verified — this is a lab, not a service.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const objects = new Map(); // key -> Buffer
const etag = (buf) => '"' + createHash("md5").update(buf).digest("hex") + '"';

const xml = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // path-style: /<bucket>/<key...>
  const [, bucket, ...rest] = url.pathname.split("/");
  const key = rest.join("/");
  const body = await readBody(req);
  const log = (code, note = "") =>
    console.log(
      `${new Date().toISOString().slice(11, 19)} ${req.method.padEnd(6)} /${bucket}/${key || ""} -> ${code} ${note}`
    );

  // HeadBucket / HeadObject
  if (req.method === "HEAD") {
    if (!key) return log(200, "bucket") || res.writeHead(200).end();
    const o = objects.get(key);
    if (!o) return log(404) || res.writeHead(404).end();
    log(200);
    res.writeHead(200, { ETag: etag(o), "Content-Length": o.length }).end();
    return;
  }

  if (req.method === "GET") {
    if (!key || url.searchParams.has("list-type")) {
      const contents = [...objects.entries()]
        .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
        .join("");
      log(200, "list");
      return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name>${contents}</ListBucketResult>`);
    }
    const o = objects.get(key);
    if (!o) {
      log(404, "NoSuchKey");
      return xml(res, 404, `<Error><Code>NoSuchKey</Code><Key>${key}</Key></Error>`);
    }

    // The AWS SDK downloads with ranged GETs (ft/s3-transfer). A stub that ignores Range
    // and answers 200 with the whole body every time never tells the client how large the
    // object is, so it keeps asking for the next range forever. Answer 206 with
    // Content-Range, and 416 once the range starts past the end.
    const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = Number(range[1]);
      if (start >= o.length) {
        log(416, `range ${req.headers.range}`);
        res.writeHead(416, { "Content-Range": `bytes */${o.length}` }).end();
        return;
      }
      const end = range[2] ? Math.min(Number(range[2]), o.length - 1) : o.length - 1;
      const slice = o.subarray(start, end + 1);
      log(206, `bytes ${start}-${end}/${o.length}`);
      res.writeHead(206, {
        ETag: etag(o),
        "Content-Type": "application/json",
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${o.length}`,
      }).end(slice);
      return;
    }

    log(200, `${o.length} bytes`);
    res.writeHead(200, {
      ETag: etag(o),
      "Content-Type": "application/json",
      "Content-Length": o.length,
    }).end(o);
    return;
  }

  if (req.method === "PUT") {
    // This one line is the whole lock: S3 conditional write. Terraform sends
    // If-None-Match: * for the .tflock object, so a second writer gets 412 instead
    // of silently overwriting the first one's lock.
    if (req.headers["if-none-match"] === "*" && objects.has(key)) {
      log(412, "PreconditionFailed");
      return xml(res, 412, `<Error><Code>PreconditionFailed</Code><Key>${key}</Key></Error>`);
    }
    objects.set(key, body);
    log(200, `${body.length} bytes`);
    res.writeHead(200, { ETag: etag(body) }).end();
    return;
  }

  if (req.method === "DELETE") {
    objects.delete(key);
    log(204);
    res.writeHead(204).end();
    return;
  }

  if (req.method === "POST") {
    log(200, "post ignored");
    res.writeHead(200).end();
    return;
  }

  log(501, req.method);
  res.writeHead(501).end();
}).listen(9000, () => console.log("s3 endpoint on http://127.0.0.1:9000"));
```

```hcl title="versions.tf"
terraform {
  required_version = ">= 1.11.0"

  backend "s3" {
    bucket       = "tfstate"
    key          = "lab/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true          # the lock is an object, no DynamoDB table

    endpoints                   = { s3 = "http://127.0.0.1:9000" }
    use_path_style              = true
    access_key                  = "lab"
    secret_key                  = "labsecret"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
```

```bash
node s3-server.mjs &
terraform init -reconfigure
terraform apply -auto-approve
```

The server log shows the lock as an object with a lifetime:

```
13:51:27 PUT    /tfstate/lab/terraform.tfstate.tflock -> 200 221 bytes
13:51:27 HEAD   /tfstate/lab/terraform.tfstate -> 200
13:51:27 GET    /tfstate/lab/terraform.tfstate -> 206 bytes 0-180/181
13:51:57 PUT    /tfstate/lab/terraform.tfstate -> 200 1337 bytes
13:51:57 GET    /tfstate/lab/terraform.tfstate.tflock -> 200 221 bytes
13:51:57 DELETE /tfstate/lab/terraform.tfstate.tflock -> 204
```

`<key>.tflock` next to the state, taken before the write and deleted after. **If a run dies between
those two lines, that object is what remains** — which is the whole of section 4, in a form you can
see with `aws s3 ls`.

### The refusal is a 412, and it does not mention locking

Race two operations exactly as before:

```bash
terraform apply -auto-approve &
sleep 8
terraform plan -lock-timeout=0
```

```
Error: Error acquiring the state lock

Error message: operation error S3: PutObject, https response error
StatusCode: 412, RequestID: , HostID: , api error PreconditionFailed:
UnknownError
Lock Info:
  ID:        32ca8de1-e88d-7eec-4b18-1feeb3cf7016
  Path:      tfstate/lab/terraform.tfstate
  Operation: OperationTypeApply
  Who:       mac@Macui-MacBookPro.local
  Version:   1.15.7
```

Two differences from the http backend worth carrying in your head:

- **The error names an HTTP status, not a lock.** `412 PreconditionFailed` is S3 refusing to create
  an object that already exists. Searching that string leads to S3 documentation about conditional
  writes, not to Terraform locking — and on a bad day that is a long detour.
- **`Path` is populated** — `tfstate/lab/terraform.tfstate` — where the http backend left it empty.
  That is the field that tells you which state file, in which bucket, is actually locked.

Server-side the mechanism is two lines:

```
13:57:10 PUT    /tfstate/lab/terraform.tfstate.tflock -> 412 PreconditionFailed
13:57:10 GET    /tfstate/lab/terraform.tfstate.tflock -> 200 220 bytes
```

The conditional PUT is refused, then Terraform **reads the existing lock object** to tell you who
holds it. That second request is where `Who` and `Created` in the error come from.

### force-unlock deletes the object

```bash
terraform force-unlock stale-from-a-killed-ci-runner
```

```
13:58:37 GET    /tfstate/lab/terraform.tfstate.tflock -> 200 182 bytes
13:58:37 DELETE /tfstate/lab/terraform.tfstate.tflock -> 204
```

It reads the lock first to check the ID you supplied matches, then deletes. Which also means the
manual escape hatch on a real bucket is `aws s3 rm s3://<bucket>/<key>.tflock` — the same effect with
none of the ID check, so prefer `force-unlock` and keep the raw delete for when the CLI cannot reach
the backend at all.

After `terraform destroy`, the state object remains and the lock object does not:

```bash
aws s3 ls s3://tfstate/lab/
```

```
lab/terraform.tfstate
```

An empty state is not a deleted state. Removing the bucket object is a separate, deliberate act.

---

## 7. The same thing on Garage — where the lock quietly is not one

[[garage-object-storage-onprem]] is the S3 endpoint this cluster actually runs, so the obvious next
step was to point the same lab at it instead of a stub. Garage 2.3.0, one node, replication factor 1,
a `tfstate` bucket and a key with `RWO`.

```bash
podman run -d --name garage -p 3900:3900 \
  -v "$PWD/garage.toml:/etc/garage.toml:ro,Z" docker.io/dxflrs/garage:v2.3.0
podman exec garage /garage layout assign -z dc1 -c 1G <NODE_ID>
podman exec garage /garage layout apply --version 1
podman exec garage /garage bucket create tfstate
podman exec garage /garage key create tf-key
podman exec garage /garage bucket allow --read --write --owner tfstate --key tf-key
```

```hcl title="versions.tf"
terraform {
  backend "s3" {
    bucket       = "tfstate"
    key          = "lab/terraform.tfstate"
    region       = "garage"          # Garage's s3_region, not an AWS region
    use_lockfile = true

    endpoints                   = { s3 = "http://127.0.0.1:3900" }
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
```

Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — the key Garage printed at
creation. Do not put them in the backend block; this file is committed.

**State and import work exactly as on any S3.** `init` migrates, and the import lands:

```
Apply complete! Resources: 1 imported, 0 added, 1 changed, 0 destroyed.
```

```bash
podman exec garage /garage bucket info tfstate
```

```
Objects:         1
```

### The lock does not hold

Run the same race from section 6 — a slow apply, then a second command:

```bash
terraform apply -auto-approve &
sleep 8
terraform plan -lock-timeout=0
```

```
No changes. Your infrastructure matches the configuration.
```

**No lock error.** The second command took the lock and produced a plan while the first was still
running. The lock object is genuinely there while it happens:

```bash
podman exec garage /garage bucket info tfstate     # during the apply
```

```
Objects:         2
```

State plus `.tflock` — and Terraform created its own on top anyway. The first apply then fails on the
way out, because the object it expects to delete is the one the second command already removed:

```
Error: Error releasing the state lock

Error message: unable to retrieve file from S3 bucket 'tfstate' with key
'lab/terraform.tfstate.tflock': operation error S3: GetObject, https response
error StatusCode: 404, RequestID: , HostID: , NoSuchKey: Key not found
```

That message is the only sign anything was wrong, it arrives after the damage, and it reads like a
transient S3 problem.

### Isolating it: the endpoint ignores `If-None-Match`

Terraform's lock is one HTTP header. This probe sends it twice, signing with SigV4, and reports what
came back — no Terraform involved:

```javascript title="conditional-put-test.mjs"
// Does this S3 endpoint enforce `If-None-Match: *` on PutObject?
// That single header is what Terraform's `use_lockfile` relies on: the second writer must
// be refused with 412, or two runs both believe they hold the state lock.
//
// Usage: AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node conditional-put-test.mjs \
//          http://127.0.0.1:3900 <bucket> <region>
import { createHash, createHmac } from "node:crypto";

const [endpoint, bucket, region] = process.argv.slice(2);
const KEY = process.env.AWS_ACCESS_KEY_ID;
const SECRET = process.env.AWS_SECRET_ACCESS_KEY;
const objectKey = `conditional-put-probe-${Date.now()}`;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

function sign({ method, host, path, body, headers }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const all = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...headers };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(all[Object.keys(all).find((k) => k.toLowerCase() === h)]).trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  let k = hmac(`AWS4${SECRET}`, date);
  for (const part of [region, "s3", "aws4_request"]) k = hmac(k, part);
  const signature = createHmac("sha256", k).update(stringToSign).digest("hex");

  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function conditionalPut(n) {
  const body = `attempt ${n}\n`;
  const path = `/${bucket}/${objectKey}`;
  const host = new URL(endpoint).host;
  const headers = sign({ method: "PUT", host, path, body, headers: { "if-none-match": "*" } });
  const res = await fetch(`${endpoint}${path}`, { method: "PUT", headers, body });
  console.log(`PUT #${n} with If-None-Match: *  ->  ${res.status} ${res.statusText}`);
  return res.status;
}

const first = await conditionalPut(1);
const second = await conditionalPut(2);

console.log("");
if (first === 200 && second === 412) {
  console.log("PASS  conditional writes are enforced — use_lockfile has a real lock here");
} else if (first === 200 && second === 200) {
  console.log("FAIL  the second write was accepted. If-None-Match is ignored,");
  console.log("      so use_lockfile provides no mutual exclusion on this endpoint.");
} else {
  console.log(`UNCLEAR  first=${first} second=${second}`);
}
```

Against Garage 2.3.0:

```
PUT #1 with If-None-Match: *  ->  200 OK
PUT #2 with If-None-Match: *  ->  200 OK

FAIL  the second write was accepted. If-None-Match is ignored,
      so use_lockfile provides no mutual exclusion on this endpoint.
```

Against the stub from section 6, which does enforce it:

```
PUT #1 with If-None-Match: *  ->  200 OK
PUT #2 with If-None-Match: *  ->  412 Precondition Failed

PASS  conditional writes are enforced — use_lockfile has a real lock here
```

**The probe passes somewhere and fails somewhere**, which is what makes it worth keeping. Run it
against any S3-compatible endpoint before trusting `use_lockfile` on it — it costs one command and
the alternative is finding out during a concurrent apply.

> Garage's own documentation could not be reached from this machine (`garagehq.deb.rs` did not
> resolve), so whether this is a documented gap or a bug is unconfirmed. What is confirmed is the
> behaviour of 2.3.0 on 2026-08-17.

### What to do about it

- **Do not put Terraform state on Garage and rely on `use_lockfile`.** It silently gives you nothing.
- Keep state where the lock works — the http backend above, or a real S3/DynamoDB — and let Garage
  serve the workloads it was chosen for. Nothing else in [[s3-object-storage-options]] depends on
  conditional writes.
- If state must live on Garage, the lock has to come from somewhere else, and "we are careful about
  not applying at the same time" is not a lock.

---

## What is still untested

Narrower than before, and named so nobody assumes otherwise:

- **AWS itself.** No IAM, no bucket policy, no encryption, no versioning. Most real remote-backend
  incidents are permissions, and nothing here touches them. Bucket versioning in particular changes
  the rollback advice in [[terraform-state-operations]] from "take a pull first" to "take a pull
  first and know the version id".
- **DynamoDB locking**, which most existing setups still use. `use_lockfile` is the newer mechanism;
  a `dynamodb_table` lock fails differently again, and a missing table reads as a permissions error.
- **Real S3 latency and eventual behaviour.** A localhost stub answers instantly and consistently.

## Verification checklist

Every item below was observed, both the passing and the failing side where there is one.

- [ ] No `terraform.tfstate` next to the checkout after `init`
- [ ] `curl` against the state address returns the state Terraform is using
- [ ] An apply with an `import` block reports `1 imported`, with `0 added` and `0 destroyed`
- [ ] **The plan immediately after the import is clean** — no permanent diff
- [ ] An empty import id fails with `Invalid import id argument` rather than importing nothing
- [ ] A second command during an apply fails with `Error acquiring the state lock`, naming `Who`
- [ ] The server log shows `423` for the refused attempts and `UNLOCK` when the apply finishes
- [ ] `force-unlock <ID>` releases it, and the next plan succeeds
- [ ] `-lock=false` produces **no** LOCK request in the server log — check the absence

On the s3 backend:

- [ ] A `<key>.tflock` object appears before the state write and is deleted after
- [ ] A concurrent command fails with `StatusCode: 412 ... PreconditionFailed`, and `Path` names the state file
- [ ] The server log shows the refused conditional PUT **and** the follow-up GET that reads the holder
- [ ] `force-unlock` reads the lock object, then deletes it
- [ ] After `destroy`, the state object is still in the bucket and the `.tflock` is gone

On whatever S3 implementation you actually run:

- [ ] The conditional-PUT probe returns **PASS** — and returns **FAIL** against Garage 2.3.0, so the probe measures the endpoint rather than itself
- [ ] A second command during an apply is refused. On Garage it is not, and the first apply then fails to release its lock
- [ ] Not covered: AWS IAM, bucket versioning, DynamoDB lock tables

## Teardown

```bash
terraform destroy -auto-approve
```

```bash
pkill -f state-server.mjs
pkill -f s3-server.mjs
podman rm -f garage
cd .. && rm -rf tf-remote-lab
```

The server holds state in memory, so stopping it discards everything. That is right for a lab and is the one property you must not copy into anything real.

## Where this bit us

**A lock that never refuses looks exactly like a lock that works.** Every visible signal on Garage
was green: `init` migrated, the import landed, `.tflock` appeared in the bucket, applies finished.
The lock was doing nothing the entire time, and the only evidence was an error *after* the work, on
release, phrased as a missing key. Checking that the lock object exists — the obvious check — passes
in both the working and the broken case. The check that separates them is one conditional PUT.

**The AWS SDK downloads state with ranged GETs, and a naive endpoint loops forever.** The first S3
stub answered every GET with the whole object and a `200`. The SDK's transfer manager asks for byte
ranges — `Range: bytes=749731840-754974719` and climbing — and with no `Content-Range` telling it the
object's size it never learns there is nothing more to fetch. `terraform plan` hung, issuing a
request every 1.5 seconds, with no error on either side. `TF_LOG=DEBUG` showed the climbing `Range`
header, which was the whole diagnosis. Answer `206` with `Content-Range`, and `416` past the end.

**The first plan was to point this at MinIO, which was the wrong answer twice over.** Its binary
would not finish downloading here — two attempts stopped at 54 MB and 65 MB of 108 MB — and while
that was being fought with, [[s3-object-storage-options]] had already recorded that MinIO's
open-source line was archived in April 2026 and that this cluster runs Garage instead. Reading the
repository's own decision first would have saved the download and pointed at a better target.

**`timeout` is not on macOS.** `timeout 60 terraform apply` exits 127, and piped into a `grep` that
looks exactly like a command that produced no output. Two runs were misread as hangs before the exit
code was checked. Use `gtimeout` from coreutils, or background the command and wait on a condition.

**`Path:` empty in the lock info read as a broken backend** for a minute, until the http backend turned out to have nothing to put there. Documented at the point it appears, because the instinct is to go and check the backend block.

**Import needed a third provider.** `local_file` and `random_pet` both refuse it; `terraform_data` was the one that worked. Two attempts were spent in the previous document before the error message was taken at face value — and the finding is more useful than the demo: check the resource's import support before planning any adoption.

## Follow-ups

- [x] Repeat sections 2–5 against the s3 backend with `use_lockfile = true` — done 2026-08-17, section 6
- [x] Point the same lab at the Garage endpoint from [[garage-object-storage-onprem]] — done 2026-08-17, and it found that `use_lockfile` does not lock there
- [ ] Decide where Terraform state actually lives for this cluster, given that Garage cannot lock it 📅 2026-09-30
- [ ] Re-run the conditional-PUT probe when Garage is next upgraded, in case the header becomes supported
- [ ] Run it once against a real AWS bucket, for IAM and versioning
- [ ] Repeat against DynamoDB locking, which is still what most existing setups use
- [ ] Write down the team rule for `force-unlock`: who may run it, and what evidence of a dead holder is required first
- [ ] Check whether the CI pipeline passes `-lock=false` anywhere, and remove it if so

## Related

[[terraform-state-operations]] — the local-backend rehearsal this extends. It named `import` and remote locking as the two things it could not cover; both are covered here for the http backend.
[[s3-object-storage-options]] — which S3 implementation this cluster runs, and why it is not MinIO.
[[garage-object-storage-onprem]] — the endpoint to point this lab at next.
[[topics]] — IaC state operations is in scope there.
