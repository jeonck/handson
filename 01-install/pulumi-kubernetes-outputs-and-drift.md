---
title: Pulumi on Kubernetes — a string that is an error message, and a preview that misses a deleted Deployment
date: 2026-09-04
domain: install
tags: [iac, kubernetes, typescript, drift]
stack: [pulumi, kubernetes, typescript, kind, podman]
summary: Infrastructure as TypeScript against a throwaway kind cluster, then the same resources in HCL. A template literal over a resource property yields a string containing an error message rather than raising one, pulumi preview reports five resources unchanged while the Deployment has been deleted and terraform plan catches it in one second, a grep for the secret returns zero on both state files for opposite reasons, and twelve services with three kinds of variation cost 72 HCL lines against 40 TypeScript — the repetition HCL is supposed to be bad at.
source: handson
env: Pulumi v3.261.0 (local file backend) · @pulumi/pulumi 3.261.0 · @pulumi/kubernetes 4.34.0 · @pulumi/random 4 · Node v24.10.0 · Terraform 1.15.7 with hashicorp/kubernetes 2.38.0 and random 3.9.0 · Kubernetes 1.36.1 on kind 0.32.0 / Podman 5.7.1 · arm64 · macOS 14.7.5
verified: 2026-09-04
verifiability: partial
verifiability-note: One provider (Kubernetes) against a single-node kind cluster, on the local file backend with a passphrase-derived key. Pulumi Cloud's own backend, its RBAC and its hosted secret handling are a different system and untested here; so are multi-stack workflows, ComponentResources, policy packs and the CI patterns this page's drift finding has consequences for.
duration: 60–90 min
risk: low
---

> **Verified 2026-09-04.** Every output, count and duration below came off the run described in `env`.
> The `wrongUrl` value is quoted exactly as Pulumi printed it.

Pulumi writes infrastructure in a real programming language, which removes a class of problems —
loops, conditionals and functions are just loops, conditionals and functions — and introduces one that
HCL does not have. **This page is about that one**, plus two behaviours worth knowing before Pulumi is
in charge of anything: where secrets end up, and what `preview` is actually comparing.

The target is a throwaway kind cluster, so nothing here needs a cloud account or a Pulumi Cloud login.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Pulumi | `pulumi version` | v3.2+ |
| Node | `node --version` | 20+ |
| Cluster | `kubectl get nodes` | one `Ready` node |

## 1. No account, no cloud state

```bash
curl -fsSL https://get.pulumi.com | sh -s -- --no-edit-path
export PATH="$HOME/.pulumi/bin:$PATH"
pulumi login --local
```

```
  Logged in to <host> as mac (file://~)
```

```bash
export PULUMI_CONFIG_PASSPHRASE='<REDACTED>'
pulumi stack init dev
find ~/.pulumi/stacks -name '*.json'
```

```
  /Users/mac/.pulumi/stacks/pulumi-lab/dev.json
```

**The default is Pulumi Cloud and `--local` opts out of it.** The whole state is that one JSON file;
back it up the way you would a Terraform state file, and note that the passphrase is not in it — lose
that and the encrypted values in section 3 are gone with it.

## 2. The program, and the one line that does not do what it looks like

```typescript title="index.ts"
const service = new k8s.core.v1.Service("web", {
    metadata: { namespace: ns.metadata.name },
    spec: { selector: labels, ports: [{ port: 80, targetPort: 80 }] },
});

// The two forms, side by side. Only one of them is a URL.
export const wrongUrl = `http://${service.metadata.name}.${ns.metadata.name}.svc.cluster.local`;
export const rightUrl = pulumi.interpolate
    `http://${service.metadata.name}.${ns.metadata.name}.svc.cluster.local`;
```

Both lines compile. Both run. `pulumi up` prints:

```
  rightUrl  : "http://web-0e72b83f.pulumi-app.svc.cluster.local"
  wrongUrl  : "http://Calling [toString] on an [Output<T>] is not supported.\n\nTo get the value
               of an Output<T> as an Output<string> consider either:\n..."
```

**The wrong form does not throw. It produces a string whose contents are the error message.** That
value is a perfectly good `string` as far as TypeScript is concerned, and it will be written into a
ConfigMap, an environment variable or a connection string without complaint.

A resource property is an `Output<T>`: a promise-like value that may not exist yet. Template literals
call `toString()` on it, and Pulumi answers with an explanation instead of a value. The fix is
`pulumi.interpolate` (or `.apply()`), and **the check is to read the output rather than to run the
program** — the program succeeding proves nothing here.

Preview also warns about a property that cannot be known yet:

```
  warning: Undefined value (clusterIp) will not show as a stack output.
```

`clusterIP` is assigned by the API server at creation, so at preview time it has no value. After
`up` the same output reads `10.96.142.106`. **An empty output at preview is normal**; an empty output
after `up` is not.

### Names are generated, and they change

```
  deployment.apps/web-883761f1
  service/web-0e72b83f
```

**Pulumi appends a random suffix to the logical name.** Delete and recreate the Deployment and the
suffix is different — `web-9ff46599` on the next `up`. Anything that referenced the old string is now
wrong, which is an argument for referring to resources through their `Output` properties rather than
by names you copied out of `kubectl`. Set `metadata.name` explicitly when a stable name is part of the
requirement.

## 3. Secrets are absent from the state file

```typescript title="index.ts"
const password = new random.RandomPassword("db", { length: 20, special: true });
export const dbPassword = password.result;
```

```bash
pulumi stack output dbPassword
pulumi stack output dbPassword --show-secrets
grep -c "$PLAINTEXT" ~/.pulumi/stacks/pulumi-lab/dev.json
```

```
  without --show-secrets : [secret]
  with --show-secrets    : M]q=L7… (20 chars)
  plaintext in state     : 0 occurrences
```

Five fields are stored encrypted, in this shape:

```json
{"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
 "ciphertext": "v1:vxrvEyXPojSBgyCZ:4z…"}
```

**This is the clearest difference from Terraform state**, which holds the same value in plaintext.
Be precise about what it buys, though: the key is derived from `PULUMI_CONFIG_PASSPHRASE`, and the
salt sits next to the code:

```yaml title="Pulumi.dev.yaml"
encryptionsalt: v1:Tlxv1zZQP3E=:v1:KyR7PlW7VjIdnnhk:l2MwKyGVn3IS2hVsfP+ay/kjV02PCA==
```

**The state file is safe to hold; the passphrase is the secret now.** That is a better position than
plaintext state, and it is not the same as "secrets are handled".

## 4. `preview` compares the program to the state, not to the cluster

Delete the Deployment behind Pulumi's back:

```bash
kubectl -n pulumi-app delete deploy --all
```

```
  immediately : 0 deployments
  after 60s   : 0
  after 150s  : 0
```

Nothing brings it back, and nothing was ever going to. **Pulumi has no controller** — it is a CLI that
runs when you run it. This is the direct counterpart to
[[crossplane-cloud-resources-as-crds]], where a deleted ConfigMap was **recreated in about two
minutes** by a controller that never stops reconciling. Same word, "declarative"; opposite operational
property, and neither is wrong — but only one of them fixes drift while you sleep.

### The check that passes

```bash
pulumi preview
pulumi stack
```

```
  Resources:
      5 unchanged

  Current stack resources (7):
      ├─ kubernetes:apps/v1:Deployment               web
```

**`preview` reports five resources unchanged, and `stack` lists the Deployment, on a cluster that has
none.** Both are answering honestly about the state file, which still says the Deployment exists.
Nobody asked the cluster.

**A CI job that runs `pulumi preview` to detect drift will pass while the infrastructure is gone.**

### The check that fails

```bash
pulumi refresh --yes
```

```
  Resources:
      - 1 deleted
      4 unchanged
```

`refresh` reads the provider and writes reality into the state, and only then does the diff mean
what people assume it means. Then:

```bash
pulumi up --yes
```

```
  + kubernetes:apps/v1:Deployment web created (0.75s)
      + 1 created
      4 unchanged
  Duration: 2s
```

**Drift detection is `pulumi refresh` followed by `pulumi preview`, or `pulumi preview --refresh`.**
`preview` alone is a diff against a file.

## 5. The same three resources in Terraform

Every claim above is only half a claim without the alternative. The same Namespace, Deployment,
Service and random password, written in HCL against the same kind cluster:

```hcl title="main.tf"
resource "kubernetes_service" "web" {
  metadata {
    name      = "web"
    namespace = kubernetes_namespace.app.metadata[0].name
  }
  spec {
    selector = local.labels
    port { port = 80, target_port = 80 }
  }
}

# The same expression that needed pulumi.interpolate. HCL has no async wrapper.
output "url" {
  value = "http://${kubernetes_service.web.metadata[0].name}.${kubernetes_namespace.app.metadata[0].name}.svc.cluster.local"
}
```

```
  url = "http://web.tf-app.svc.cluster.local"
  Apply complete! Resources: 4 added
```

**The line that cost a whole section in Pulumi is unremarkable here.** HCL evaluates lazily by
construction, so a reference to a not-yet-created attribute is the normal case rather than a wrapped
type — there is no `Output<T>` because there is no general-purpose language to leak it into.

### Measured side by side

```
                              Pulumi (TypeScript)         Terraform (HCL)
  source for same resources   index.ts, 37 lines          main.tf, 67 lines
  apply                       5 resources, 35s            4 resources, 38s
  property interpolation      error-message string        works directly
                              unless pulumi.interpolate
  resource names in cluster   web-883761f1                web
                              new suffix on recreate      exactly what you wrote
  named sensitive output      [secret] without            prints the value
                              --show-secrets
  drift: preview / plan       "5 unchanged"               "Plan: 1 to add"
  drift: auto-repair          none                        none
```

**The line counts are not the interesting row and are easy to over-read** — the TypeScript is denser
partly because object literals are terser than HCL blocks, and it carries two URL forms rather than
one. Nothing here measures what happens when the same resource has to be produced twelve times with
varying inputs, which is the case people actually reach for a language to solve.

**The drift row is the interesting one.** `terraform plan` refreshes from the provider before it
diffs, so it reported `1 to add` for the Deployment deleted behind its back, in one second.
`pulumi preview` diffs against the state file and reported `5 unchanged` for the identical situation.
Neither tool repairs drift on its own — that is [[crossplane-cloud-resources-as-crds]]'s job — but
only one of them notices by default.

### The check that gives the same answer for opposite realities

The secret comparison nearly went into this page backwards. Terraform's state:

```bash
grep -c -F -- "$PASSWORD" terraform.tfstate
```

```
  0
```

**Zero, and the password is right there in the file:**

```json
"result": "o\u0026\u0026Sv=6*{303\u003ettT6RPH",
```

Go's JSON encoder escapes `&`, `<` and `>` as `\u0026`, `\u003c` and `\u003e`. The value
`o&&Sv=6*{303>ttT6RPH` is stored complete and readable, and a literal `grep` for it matches nothing.
**A state file audited with `grep` can report clean while holding every secret it has.**

So the Pulumi measurement in section 3 was re-run with escaping accounted for, on a password that
happens to contain both `<` and `>`:

```
  password             : 94Ax}RY0?hQPCDAQ>[<_
  plaintext            : 0 occurrences
  HTML-escaped form    : 0 occurrences
  ciphertext fields    : 5
```

**Both zeroes, plus five ciphertext fields — the Pulumi claim survives the stronger test.** The two
tools give the same `grep` result for opposite realities, which is the whole reason the second check
exists.

One smaller difference in the same area:

```
  terraform output db_password   -> "o&&Sv=6*{303>ttT6RPH"
  terraform output               -> db_password = <sensitive>
  pulumi stack output dbPassword -> [secret]
```

**Asking Terraform for a sensitive output by name prints it**; only the full listing redacts. Pulumi
requires `--show-secrets` either way. Worth knowing before piping either into a log.

## 6. Twelve of the same resource, which is the case a language is for

The argument for writing infrastructure in a real language is repetition, so here is repetition: a
JSON spec of twelve services, three tiers driving replica counts, seven of them public and five
needing a database secret. Twenty-five resources, both tools, same cluster.

```json title="spec.json"
[{"name":"auth", "tier":"gold", "public":true, "db":true}, …]
```

```typescript title="index.ts"
for (const s of spec) {
    const labels = { app: s.name, tier: s.tier };
    new k8s.apps.v1.Deployment(s.name, { /* … replicas: replicas[s.tier] … */ }, opts);
    if (s.public) new k8s.core.v1.Service(s.name, { /* … */ }, opts);
    if (s.db)     new k8s.core.v1.Secret(`${s.name}-db`, { /* … */ }, opts);
}
```

```hcl title="main.tf"
locals {
  services = { for s in jsondecode(file(var.spec_file)) : s.name => s }
  replicas = { gold = 3, silver = 2, bronze = 1 }
  public   = { for k, v in local.services : k => v if v.public }
  withdb   = { for k, v in local.services : k => v if v.db }
}

resource "kubernetes_deployment" "svc" {
  for_each = local.services
  # … replicas = local.replicas[each.value.tier] …
}
resource "kubernetes_service" "svc" { for_each = local.public }
resource "kubernetes_secret"  "db"  { for_each = local.withdb }
```

**Both are flat, and the gap barely moved:**

```
                       1 service    12 services   delta
  main.tf  (HCL)         67 lines     72 lines      +5
  index.ts (TypeScript)  37 lines     40 lines      +3
```

**HCL did not blow up.** `for_each` over a map, plus a filtered map for the conditional resources,
expresses all three variations without repetition — and the folklore this section was written to test
turns out to be about `count`, not about HCL. `count` is positional, so inserting an item in the
middle renumbers everything after it; `for_each` is keyed, and the keys here are service names.

Adding a thirteenth service to the spec:

```
  terraform:  # kubernetes_deployment.svc["reports"] will be created
              # kubernetes_secret.db["reports"] will be created
              # kubernetes_service.svc["reports"] will be created
              Plan: 3 to add, 0 to change, 0 to destroy

  pulumi:     + 3 to create
              26 unchanged
```

**Neither produces spurious churn.** Three resources added, nothing else touched, in both.

### Where they actually differ: looping over something not yet known

Both tools can only repeat over values they know before creating anything. Ask either to key a loop
on an attribute the API server assigns at creation time, and the difference is not in the limitation
but in how you find out.

Terraform refuses:

```
  Error: Invalid for_each argument
    on main.tf line 15, in resource "kubernetes_config_map" "derived":
    15:   for_each = toset([kubernetes_namespace.src.metadata[0].uid])
      │ kubernetes_namespace.src.metadata[0].uid is a string, known only after apply
```

**Nothing runs.** The message names the expression, the attribute and the reason.

Pulumi accepts it. The equivalent is a resource constructed inside `.apply()`, which is legal
TypeScript and does something worth seeing:

```
  pulumi preview : + kubernetes:core/v1:ConfigMap cm-a27dae54  create
  pulumi up      : + kubernetes:core/v1:ConfigMap cm-ee87e5d1  created
  in the cluster :   cm-ee87e5d1
```

**The preview shows one resource and the apply creates a different one.** During preview the
namespace does not exist, so its `uid` is unknown and Pulumi substitutes a placeholder; the name
derived from that placeholder is `cm-a27dae54`, and it is fiction. At apply the real uid produces
`cm-ee87e5d1`. No error, no warning, and **a preview whose output does not describe what will
happen** — the same shape as `preview` reporting `5 unchanged` in section 4, reached a different way.

That is the honest form of the trade. It is not that HCL cannot loop; it is that a general-purpose
language will let you write a loop whose inputs do not exist yet, and the failure is a plausible
preview rather than a refusal.

### The timing measurement that had to be thrown away

The first run said Pulumi 12 s against Terraform 47 s, which looked like a headline. It was a cold
Terraform run — provider download and initialisation — measured against a Pulumi run that had none of
that to do. Warm, twice each, same 25 resources:

```
  pulumi up        13s   14s
  terraform apply   6s    4s
  terraform apply -parallelism=30    4s   (parallelism was not the factor)
```

**Terraform is two to three times faster here, the opposite of the first reading.** One cold run each
would have published the reverse. On this workload the difference is plausibly Node.js and the
language host starting up, but that is a guess and the measurement above is not: it says only that on
25 Kubernetes resources against a local cluster, warm, these are the numbers.

## Verification checklist

- [x] `pulumi login --local` reports `file://~` and the whole stack lives in **one JSON file** under `~/.pulumi/stacks/`
- [x] A template literal over a resource property yields a **string containing `Calling [toString] on an [Output<T>] is not supported`**, and does not raise
- [x] `pulumi.interpolate` over the identical expression yields `http://web-0e72b83f.pulumi-app.svc.cluster.local`
- [x] `clusterIp` warns `Undefined value … will not show as a stack output` at preview and reads `10.96.142.106` after `up`
- [x] Resource names carry a generated suffix, and a recreated Deployment gets a **different** one (`web-883761f1` → `web-9ff46599`)
- [x] `pulumi stack output dbPassword` prints `[secret]`; `--show-secrets` prints the 20-character value
- [x] The plaintext appears **0 times** in the state file, with 5 fields stored as `ciphertext`
- [x] The encryption salt is in `Pulumi.dev.yaml` and the passphrase is only in the environment
- [x] With the Deployment deleted in the cluster, it is **still absent after 150 seconds** — no controller
- [x] In that state `pulumi preview` reports **`5 unchanged`** and `pulumi stack` still lists the Deployment
- [x] `pulumi refresh` reports **`- 1 deleted`**, and `pulumi up` recreates it in 0.75 s
- [x] `pulumi destroy` removes all 5 resources in 7 s and the namespace is `NotFound` afterwards
- [x] The same resources in HCL are **67 lines against 37**, and apply as **4 resources in 38 s** against 5 in 35 s
- [x] The interpolation that needed `pulumi.interpolate` yields `http://web.tf-app.svc.cluster.local` in plain HCL
- [x] Terraform names the objects `web` and `tf-app` — **no generated suffix**
- [x] With the Deployment deleted, `terraform plan` reports **`Plan: 1 to add`** in one second, where `pulumi preview` reported `5 unchanged`
- [x] `grep -c -F` for the password in `terraform.tfstate` returns **0 while the value is present**, stored as `\u0026`/`\u003e` escapes
- [x] Re-checked with escaping, Pulumi's state has **0 plaintext and 0 escaped** occurrences alongside 5 `ciphertext` fields — on a password containing `<` and `>`
- [x] `terraform output <name>` prints a `sensitive` value; only `terraform output` with no argument redacts it
- [x] Twelve services with three kinds of variation take **72 HCL lines against 40 TypeScript**, up +5 and +3 from the single-resource case
- [x] Both apply the same **25 resources** — 12 Deployments, 7 Services, 5 Secrets
- [x] Adding a thirteenth service plans as exactly **3 to add** in both, with no churn — `for_each` is keyed, unlike `count`
- [x] `for_each` over an attribute known only after apply **fails at plan** with `Invalid for_each argument`
- [x] The Pulumi equivalent previews `cm-a27dae54` and creates `cm-ee87e5d1` — **a preview naming a resource that never exists**
- [x] Warm timings are `pulumi up` 13 s / 14 s against `terraform apply` 6 s / 4 s, reversing the cold-run reading of 12 s against 47 s
- [x] `-parallelism=30` changes Terraform's 5 s to 4 s, ruling parallelism out as the cause

## Rollback

```bash
pulumi destroy --yes
pulumi stack rm dev --yes
kind delete cluster --name pulumi
rm -rf ~/.pulumi          # the CLI, the local backend and every stack in it
```

The last line removes the tool and the state together — worth separating if any other stack lives
there.

## Where this bit us

**The `Output<T>` mistake is invisible at every stage except reading the value.** It type-checks,
`pulumi preview` runs, `pulumi up` succeeds, and the resource is created — with a field containing an
error message. There is no failing step to notice. **The only check that catches it is looking at the
rendered output**, which is why both forms are exported side by side on this page rather than
described. A page that only showed `pulumi.interpolate` would teach the fix and not the reason.

**`preview` saying "unchanged" is the same shape of lie as this repository keeps finding, arrived at
from the other direction.** [[crossplane-cloud-resources-as-crds]] reported `SYNCED=True` about a
deleted ConfigMap because a controller had not reconciled yet; Pulumi reports `5 unchanged` because
nothing ever asked the cluster. **Both tools answer the question they were asked**, and in both cases
the question a person believed they were asking was "does reality match my code".

**Nothing here proves the secret handling is sound, only that the state file is clean.** The passphrase
was in an environment variable for the whole run, which is exactly where it should not be in anything
real. The measurable claim is narrow — plaintext count zero — and it is worth stating that narrowly
rather than as "Pulumi encrypts your secrets".

## Follow-ups

- [ ] Run `pulumi preview --refresh` in a CI-shaped job and confirm it catches the deletion that plain `preview` missed, since that is the practical fix this page argues for
- [ ] Repeat section 6 at a scale where the state file itself is the cost — several hundred resources — since 25 is small enough that both tools are fast and neither state format is stressed
- [ ] Test the secret path against the Pulumi Cloud backend, where the key is not a local passphrase and the property being claimed is different
- [ ] Add a `ComponentResource` and check whether generated names inside it change on recreate the same way
- [ ] Point the same program at LocalStack's AWS surface and see whether it hits the `InvalidAccessKeyId` recorded in [[localstack-local-aws-and-its-limits]], which would narrow that open question

## Related

[[crossplane-cloud-resources-as-crds]] — the controller-based answer to the same problem, and the two-minute recovery this page has no equivalent of.
[[terraform-state-operations]] — the state file this one encrypts, and what operating on it looks like.
[[terraform-remote-backend-lock-import]] — locking and import, the two things a local single-file backend does not give you.
[[localstack-local-aws-and-its-limits]] — a local AWS to point this at, and the credential question still open there.
