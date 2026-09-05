---
title: Pulumi on Kubernetes — a string that is an error message, and a preview that misses a deleted Deployment
date: 2026-09-04
domain: install
tags: [iac, kubernetes, typescript, drift]
stack: [pulumi, kubernetes, typescript, kind, podman]
summary: Infrastructure as TypeScript against a throwaway kind cluster, with no Pulumi Cloud account. Interpolating a resource property into a template literal produces a string containing an error message rather than raising one, secrets are absent in plaintext from the state file, and pulumi preview reports five resources unchanged while the Deployment it describes has been deleted from the cluster.
source: handson
env: Pulumi v3.261.0 (local file backend) · @pulumi/pulumi 3.261.0 · @pulumi/kubernetes 4.34.0 · @pulumi/random 4 · Node v24.10.0 · Kubernetes 1.36.1 on kind 0.32.0 / Podman 5.7.1 · arm64 · macOS 14.7.5
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
- [ ] Compare the same three resources written in Terraform, to put the `Output<T>` cost against HCL's inability to loop naturally rather than asserting the trade
- [ ] Test the secret path against the Pulumi Cloud backend, where the key is not a local passphrase and the property being claimed is different
- [ ] Add a `ComponentResource` and check whether generated names inside it change on recreate the same way
- [ ] Point the same program at LocalStack's AWS surface and see whether it hits the `InvalidAccessKeyId` recorded in [[localstack-local-aws-and-its-limits]], which would narrow that open question

## Related

[[crossplane-cloud-resources-as-crds]] — the controller-based answer to the same problem, and the two-minute recovery this page has no equivalent of.
[[terraform-state-operations]] — the state file this one encrypts, and what operating on it looks like.
[[terraform-remote-backend-lock-import]] — locking and import, the two things a local single-file backend does not give you.
[[localstack-local-aws-and-its-limits]] — a local AWS to point this at, and the credential question still open there.
