---
title: Remote state — what a lock and an import actually do
date: 2026-08-16
domain: runbook
tags: [iac, terraform, state, backend]
stack: [terraform, opentofu, nodejs]
summary: The two things a local backend cannot teach — importing into shared state, and a lock held by somebody else — rehearsed against a real remote backend you can run in one terminal. The remote lock error names the holder; force-unlock is still the wrong first move.
source: handson
env: Terraform 1.15.7 (darwin_arm64) · hashicorp/time 0.14.1 · Terraform http backend served by a 60-line Node 24.10 process on localhost — not S3, not DynamoDB, not Terraform Cloud
verified: 2026-08-16
verifiability: partial
verifiability-note: Verified against the http backend, which exercises Terraform's own lock protocol end to end and lets the server side be observed. S3 conditional-write locking and DynamoDB lock tables fail differently on the storage side and stay untested.
duration: 20–30 min
risk: medium
---

> **Verified 2026-08-16.** Every command, every error and every server log line below was produced on
> Terraform 1.15.7. The two gaps left open by [[terraform-state-operations]] — `import`, and lock
> behaviour on a remote backend — are closed here for the http backend.
>
> **Why not S3.** The intent was MinIO as an S3 endpoint. Its binary is ~108 MB and the download
> stalled twice on this connection, at 54 MB and 65 MB. Rather than write S3 sections from
> documentation and call the document verified, the lab moved to the http backend, which needs
> nothing but Node. What that does and does not carry over is in
> [What S3 and DynamoDB do differently](#what-s3-and-dynamodb-do-differently).

A local backend teaches you almost everything about state except the two things that actually hurt in a team: adopting existing infrastructure into shared state, and finding the state locked by somebody who is not you.

Both need a backend that lives outside your process. This lab uses Terraform's **http backend** — an official backend whose entire protocol is four HTTP methods, which means you can watch the lock being taken and refused instead of inferring it.

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

## What S3 and DynamoDB do differently

Not verified here. Named so nobody assumes this lab covers it:

- **Where the lock lives.** S3 with `use_lockfile = true` writes a lock object next to the state and relies on conditional writes; the classic setup uses a DynamoDB item instead. Both can leave the lock behind when a process dies, exactly like section 4, but you clear it with `force-unlock` *or* by deleting the object/item directly — and knowing which is safe requires seeing the storage.
- **How failures present.** A refused lock on S3 surfaces as a `PreconditionFailed`-flavoured error rather than a clean 423; a missing DynamoDB table looks like a permissions problem.
- **Versioning.** An S3 bucket with versioning gives you every prior state, which changes the rollback advice in [[terraform-state-operations]] from "take a pull first" to "take a pull first and know the version id".
- **Credentials.** Nothing in this lab exercises IAM, and most real remote-backend incidents are permissions, not locks.

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
- [ ] Not covered: S3 conditional-write locking, DynamoDB lock tables, IAM failures

## Teardown

```bash
terraform destroy -auto-approve
```

```bash
pkill -f state-server.mjs
cd .. && rm -rf tf-remote-lab
```

The server holds state in memory, so stopping it discards everything. That is right for a lab and is the one property you must not copy into anything real.

## Where this bit us

**The S3 plan died on bandwidth, not on Terraform.** Two attempts at the MinIO binary stopped at 54 MB and 65 MB of 108 MB. The choice was to write S3 sections from documentation and mark the document verified anyway, or to change the backend and say so. The second is why this document is about the http backend and why `verifiability` is `partial`.

**`Path:` empty in the lock info read as a broken backend** for a minute, until the http backend turned out to have nothing to put there. Documented at the point it appears, because the instinct is to go and check the backend block.

**Import needed a third provider.** `local_file` and `random_pet` both refuse it; `terraform_data` was the one that worked. Two attempts were spent in the previous document before the error message was taken at face value — and the finding is more useful than the demo: check the resource's import support before planning any adoption.

## Follow-ups

- [ ] Write down the team rule for `force-unlock`: who may run it, and what evidence of a dead holder is required first
- [ ] Check whether the CI pipeline passes `-lock=false` anywhere, and remove it if so

## Related

[[terraform-state-operations]] — the local-backend rehearsal this extends. It named `import` and remote locking as the two things it could not cover; both are covered here for the http backend.
[[topics]] — IaC state operations is in scope there.
