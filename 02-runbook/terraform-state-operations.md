---
title: Terraform state surgery, rehearsed before you need it
date: 2026-08-16
domain: runbook
tags: [iac, terraform, state]
stack: [terraform, opentofu]
summary: Rename, drift, lock contention and dropping a resource without destroying it — practised in a throwaway directory with no cloud account. A rename without a moved block destroys and recreates, and the plan says so if you read it.
source: handson
env: Terraform 1.15.7 (darwin_arm64) · hashicorp/local 2.9.0, random 3.9.0, time 0.14.1 · local backend on macOS 14.7.5 — no cloud provider, no remote backend
verified: 2026-08-16
verifiability: partial
verifiability-note: Ran on local providers with the local backend. An import block could not be exercised — neither offline provider implements import — and remote-backend locking (S3/DynamoDB, Terraform Cloud) is untested.
duration: 25–40 min
risk: medium
---

> **Verified 2026-08-16.** Every command and every output below was run in one scratch directory on
> Terraform 1.15.7. Both sides of each check were observed — the clean case and the failing case —
> except the two named in [What could not be rehearsed](#what-could-not-be-rehearsed).
>
> `risk: medium` is about where you point these commands, not about the lab. In a scratch directory
> this is free. Against real state, `state rm` and `force-unlock` orphan or corrupt things that no
> amount of re-running fixes.

State operations get learned during an incident, at the worst possible moment, on the state file that matters. This is the rehearsal: a directory you can delete, providers that need no account, and the four operations that actually come up.

The lab needs **no cloud credentials** — `hashicorp/local`, `random` and `time` create files and timers. Everything transfers to a real provider; only the resource types change.

## The lab

```hcl title="versions.tf"
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
```

```hcl title="main.tf"
resource "random_pet" "name" {
  length = 2
}

resource "local_file" "note" {
  filename = "${path.module}/out/note.txt"
  content  = "owner = ${random_pet.name.id}\n"
}
```

```bash
mkdir tf-state-lab && cd tf-state-lab
# write versions.tf and main.tf, then:
terraform init
terraform apply -auto-approve
```

```bash
terraform state list
```

```
local_file.note
random_pet.name
```

`terraform state list` is the only inventory that matters. The `.tf` files say what you *want*; state says what Terraform believes it *has*. Every operation below is about closing a gap between those two.

---

## 1. Drift — is anything different from what state believes?

The useful form is not `terraform plan` read by a human. It is the exit code, which is a check that can fail in CI:

```bash
terraform plan -detailed-exitcode
echo "exit=$?"
```

| Exit code | Meaning |
|---|---|
| `0` | no changes — state matches reality and configuration |
| `1` | the plan itself errored |
| `2` | changes are pending — drift, or an unapplied edit |

Straight after an apply this returns `0`. Now change something behind Terraform's back, which is what a colleague editing the console actually looks like:

```bash
echo "tampered by hand" > out/note.txt
terraform plan -detailed-exitcode >/dev/null
echo "exit=$?"
```

```
exit=2
```

Both sides observed: `0` on a clean directory, `2` after an out-of-band edit. **A drift check that has only ever returned `0` is an unproven check** — break something on purpose once, so you know it can go red.

> **Expected output that reads wrong.** The plan for that tampered file says:
>
> ```
>   # local_file.note will be created
> Plan: 1 to add, 0 to change, 0 to destroy.
> ```
>
> and `-refresh-only` reports `# local_file.note has been deleted`. The file is plainly still there.
> The `local` provider identifies a file by a hash of its content, so *edited* and *gone* are the
> same observation to it. Do not go hunting for a deleted file; it means the content no longer
> matches. Real providers with a stable object ID say `will be updated in-place` instead.

To record the drift as the new truth instead of reverting it:

```bash
terraform plan -refresh-only
terraform apply -refresh-only
```

That writes reality into state and changes nothing in the world. It is the right move when someone made a deliberate change and you are catching up to it; the wrong move when the change was an accident, where a plain `apply` puts it back.

---

## 2. Rename a resource without destroying it

The single most expensive state mistake, and the easiest to avoid. Rename `local_file.note` to `local_file.owner_note` — first the way that costs you the resource:

```bash
# main.tf: resource "local_file" "note" -> "owner_note", nothing else
terraform plan
```

```
  # local_file.note will be destroyed
  # local_file.owner_note will be created
Plan: 1 to add, 0 to change, 1 to destroy.
```

Terraform tracks resources by address. A new name is a new resource, and the old one is garbage. On a file that is harmless; on a database it is an outage, and the plan told you in two lines that are easy to skim past.

Now the same edit with a `moved` block:

```hcl title="main.tf"
resource "local_file" "owner_note" {
  filename = "${path.module}/out/note.txt"
  content  = "owner = ${random_pet.name.id}\n"
}

moved {
  from = local_file.note
  to   = local_file.owner_note
}
```

```bash
terraform plan
```

```
  # local_file.note has moved to local_file.owner_note
Plan: 0 to add, 0 to change, 0 to destroy.
```

**`0 to destroy` is the pass condition**, and it is the whole point of the exercise. Both outputs above came from the identical rename; the only difference is the four-line block.

```bash
terraform apply -auto-approve
terraform state list
```

```
local_file.owner_note
random_pet.name
```

`moved` blocks are declarative and reviewable — a colleague sees the rename in the diff. The CLI equivalent, `terraform state mv local_file.note local_file.owner_note`, does the same thing invisibly and leaves nothing behind for the next reader. Prefer the block; keep the command for state that has already diverged.

Leave the `moved` block in place for at least one release cycle so that anyone applying an older checkout still converges, then delete it.

---

## 3. Lock contention — what a second operator looks like

Terraform locks state for the duration of an operation. To see it, make one operation slow and start another beside it:

```hcl title="main.tf"
resource "time_sleep" "hold" {
  create_duration = "25s"
}
```

```bash
terraform apply -auto-approve &
sleep 4
terraform plan -lock-timeout=0
```

```
Error: Error acquiring the state lock

Error message: resource temporarily unavailable
Lock Info:
  ID:        6ded703d-2aa1-d1b8-feaa-2c3262013cb9
  Path:      terraform.tfstate
  Operation: OperationTypeApply
```

That is the mechanism working. The block tells you who holds it and what they are doing — on a shared backend it also carries the user and the host, which is usually enough to walk over and ask.

`-lock-timeout=0` fails immediately, which is what CI should do. Interactively, `-lock-timeout=5m` waits instead of failing, which is kinder when a colleague's apply is nearly finished.

> **`terraform force-unlock <ID>` is the last resort, not the fix.** It removes the lock without
> knowing whether the other operation is still running. Run it while an apply is in flight and two
> processes write the same state file. Confirm the holder is genuinely dead — the process gone, the
> CI job cancelled — before you touch it.

---

## 4. Stop managing something without destroying it

Splitting a module, handing a resource to another team, adopting something into a different workspace — all of them need the resource out of *this* state with the object left alone.

```hcl title="main.tf"
removed {
  from = time_sleep.hold

  lifecycle {
    destroy = false
  }
}
```

Delete the `resource` block itself at the same time; the `removed` block replaces it.

```bash
terraform plan
```

```
 # time_sleep.hold will no longer be managed by Terraform, but will not be destroyed
Plan: 0 to add, 0 to change, 0 to destroy.
```

```bash
terraform apply -auto-approve
terraform state list
```

```
local_file.owner_note
random_pet.name
```

Two pass conditions, and both matter: `0 to destroy` in the plan, and the address gone from `state list`. Checking only the second would also pass if Terraform had destroyed the thing.

**Omitting `lifecycle { destroy = false }` inverts the meaning** — the resource is then removed from state *and* destroyed. The keyword that saves the object is the one that looks like boilerplate.

`terraform state rm time_sleep.hold` does the same in one command, with no record in the configuration and no review. Same advice as the rename: use the block, keep the command for emergencies.

---

## What could not be rehearsed

Two things this lab cannot show, found by trying:

**`import` needs a provider that implements it.** Both offline providers refuse:

```
Error: Resource Import Not Implemented

This resource does not support import. Please contact the provider developer
for additional information.
```

`local_file` and `random_pet` both produce that, so an `import` block cannot be practised without a real API behind it. Worth knowing in itself: **import support is per-resource, not a Terraform feature you can assume.** Check the provider's documentation for the resource before planning an adoption; discovering this during a migration is expensive.

**Remote backend locking.** The local backend takes a file lock, and the error above is what that produces. S3 with DynamoDB, or Terraform Cloud, fail differently and can leave a lock behind when a runner is killed — which is the situation `force-unlock` exists for and the one this lab never reaches. [[terraform-remote-backend-lock-import]] closes this on both the http and s3 backends, including a stale lock and `force-unlock`; on S3 the refusal arrives as a `412 PreconditionFailed`. DynamoDB locking is still untested.

---

## Verification checklist

Each of these was watched passing *and* failing, except where noted.

- [ ] `terraform plan -detailed-exitcode` returns `0` on a clean directory
- [ ] The same command returns `2` after an out-of-band edit — **break something on purpose to confirm**
- [ ] A rename without a `moved` block plans `1 to add, 1 to destroy`
- [ ] The identical rename with a `moved` block plans `0 to destroy`
- [ ] `terraform state list` shows the new address and not the old one after applying the move
- [ ] A second command during an apply fails with `Error acquiring the state lock`, naming the holder
- [ ] A `removed` block with `destroy = false` plans `0 to destroy`, and the address leaves `state list`
- [ ] `terraform destroy` leaves `state list` empty and the `out/` directory gone
- [ ] Not covered here: `import`, and lock behaviour on a remote backend

## Rollback

The lab is a directory. There is nothing to undo anywhere else:

```bash
terraform destroy -auto-approve
```

```bash
cd .. && rm -rf tf-state-lab
```

Against real state the equivalent is different in kind, which is the reason for practising here first: keep a copy before surgery.

```bash
terraform state pull > state-backup-$(date -u +%Y%m%dT%H%M%SZ).json
```

Terraform writes `terraform.tfstate.backup` on the local backend automatically, but only the immediately previous version, and a remote backend gives you whatever versioning the bucket has. An explicit pull before `state rm` or `force-unlock` costs one command.

## Where this bit us

**`import` blocks fail on providers that do not implement import.** The error names the provider developer, not the resource, so the first read suggests a Terraform version problem or a malformed block. It is neither — `local_file` and `random_pet` simply have no import implementation. Two attempts were spent on this before the message was taken at face value.

**A content change reported as a deletion.** `local_file` hashing its content means `-refresh-only` says `has been deleted` about a file sitting on disk. Twenty seconds of confusion in a lab; on a real resource the same shape of message would send someone looking for a deleted object that never existed.

**The teardown of the lock demo has to wait.** `terraform apply &` backgrounded with a 25-second `time_sleep` holds the lock for 25 seconds, and the next command in a script hits the same lock error the demo just produced — this time as noise. Wait it out rather than reaching for `force-unlock`, which was exactly the wrong reflex to build while writing this.

## Follow-ups

- [x] Rehearse `import` once with a provider that implements it — done in [[terraform-remote-backend-lock-import]] with `terraform_data`, including `-generate-config-out`
- [ ] Put `terraform plan -detailed-exitcode` in CI on a schedule, so drift is found before the next apply rather than during it
- [ ] Decide the team rule: `moved`/`removed` blocks in review, `state mv`/`state rm` only during an incident with a state backup taken first

## Related

[[onprem-3node-kubeadm-ubuntu]] — the EC2 harness that verifies it is Terraform, and renaming anything in that harness is section 2 of this document.
[[topics]] — IaC state operations is in scope there, which is why this exists.
