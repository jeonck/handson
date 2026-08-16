---
title: Topic of the day — OpenTofu 1.12's `destroy = false` and dynamic `prevent_destroy`
date: 2026-08-13
domain: daily
tags: [daily, iac, not-executed]
stack: [opentofu, terraform, local-provider]
summary: Practise the two new lifecycle meta-arguments in OpenTofu 1.12 — forgetting a resource instead of destroying it, and gating prevent_destroy on a variable instead of a hard-coded literal — entirely offline against the local provider.
source: daily-topic
---

## Why this topic

[[topics]] lists IaC in scope — "Terraform / OpenTofu, module design, state operations, drift" — and no document in this repository has exercised OpenTofu or a `lifecycle` block yet: the only Terraform in the repo is [[k8s-node-drain-replace]], which runs `terraform plan -target=module.eks.module.eks_managed_node_group` against a live EKS module and warns "if this is managed by IaC, do not delete it from the console or CLI — handle it through Terraform." That runbook is exactly the kind of state operation these two features touch, and IaC has not been a daily-topic subject in the last 30 days (recent picks were [[2026-08-10-argo-rollouts-canary]], [[2026-08-11-prometheus-3-13-lts]], [[2026-08-12-cosign-sbom-signing]], [[2026-08-07-gateway-api]] — GitOps, observability, CI supply chain, and networking, not IaC).

**OpenTofu v1.12.0 was released 2026-05-14** ([release blog](https://opentofu.org/blog/opentofu-1-12-0/)) and shipped two lifecycle meta-arguments confirmed in the project's own changelog ([CHANGELOG.md at v1.12.3](https://github.com/opentofu/opentofu/blob/v1.12.3/CHANGELOG.md)):

- **`destroy` on a resource's `lifecycle` block.** Changelog, verbatim: *"New `lifecycle` meta-argument `destroy`: when set to `false` OpenTofu will plan to just remove the affected object from state without asking the provider to destroy it first, similar to `destroy = false` in `removed` blocks."* ([PR #3409](https://github.com/opentofu/opentofu/pull/3409))
- **Dynamic `prevent_destroy`.** Changelog, verbatim: *"A `prevent_destroy` argument in the `lifecycle` block for managed resources can now refer to other symbols in the same module, such as to the module's input variables."* ([issue #3474](https://github.com/opentofu/opentofu/issues/3474), [#3507](https://github.com/opentofu/opentofu/issues/3507))

Both are genuinely new — before 1.12, `prevent_destroy` had to be a literal `true`/`false`, so a shared module could not protect production while leaving dev destroyable without two copies of the module or a wrapper. `destroy = false` did not exist at all on ordinary `resource` blocks before 1.12; the only prior way to drop something from state without destroying it was the imperative `tofu state rm`.

## 30-minute lab

> **Not executed in this run.** This is a scheduled run with no user in the loop, and this sandbox has no `tofu`/`terraform` binary installed (`which tofu terraform` returns nothing) — installing one and running `tofu apply` are both operations this sandbox cannot get approved with nobody to answer the prompt. Every command below is built from the confirmed install docs and the changelog/blog wording quoted above, but nobody has watched this exact sequence run end to end. Treat it the way [[2026-08-12-cosign-sbom-signing]] treated its own unexecuted lab: run it and check the Follow-ups box before trusting the exact output shown here.

### 1. Install OpenTofu

Source: [official standalone installer docs](https://opentofu.org/docs/intro/install/standalone/).

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://get.opentofu.org/install-opentofu.sh -o install-opentofu.sh
chmod +x install-opentofu.sh
./install-opentofu.sh --install-method standalone
rm -f install-opentofu.sh
tofu version   # expect: OpenTofu v1.12.x
```

No cloud account and no cloud provider plugin needed for this lab — everything below uses `hashicorp/local`, which only touches the local filesystem.

### 2. A resource with a variable-gated `prevent_destroy`

```bash
mkdir tofu-lifecycle-demo && cd tofu-lifecycle-demo
```

```hcl title="main.tf"
terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

variable "protect_demo" {
  type    = bool
  default = true
}

resource "local_file" "demo" {
  filename = "${path.module}/demo.txt"
  content  = "hello from opentofu lifecycle demo\n"

  lifecycle {
    prevent_destroy = var.protect_demo
  }
}
```

`prevent_destroy = var.protect_demo` referencing an input variable is exactly the case the changelog names — before 1.12 this argument had to be the literal `true` or `false`.

```bash
tofu init
tofu apply -auto-approve
```

### 3. Watch `prevent_destroy` block a destroy, then override it dynamically

```bash
tofu destroy -auto-approve
```

Expected: OpenTofu refuses and exits non-zero, because `var.protect_demo` defaults to `true`. The exact error text is not confirmed here — the docs state only that OpenTofu will "reject with an error any plan that would destroy the infrastructure object" ([resource lifecycle docs](https://opentofu.org/docs/language/resources/behavior/#lifecycle-customizations)) without quoting the literal message. Record the real text when this step actually runs.

Now override the variable instead of editing the file — this is the payoff, a module with one protected default that a dev workflow can still tear down without forking it:

```bash
tofu destroy -auto-approve -var="protect_demo=false"
```

Expected: succeeds this time, `demo.txt` is gone.

### 4. `destroy = false` — forget instead of destroy

```bash
tofu apply -auto-approve   # recreate demo.txt
```

Edit `main.tf`, replace the `lifecycle` block:

```hcl
  lifecycle {
    destroy = false
  }
```

```bash
tofu destroy -auto-approve
echo "exit code: $?"
```

### Verify

Source for the exit-code claim: [CHANGELOG.md at v1.12.3](https://github.com/opentofu/opentofu/blob/v1.12.3/CHANGELOG.md), verbatim: *"Resources with `destroy = false` are forgotten rather than destroyed, and the command will exit with a non-zero status code to indicate that some resources were not fully removed."*

```bash
ls demo.txt          # expect: still there — the file was never touched on disk
tofu state list       # expect: empty — the resource is gone from state
```

Expected: `demo.txt` still exists on disk and `tofu state list` prints nothing, while the `tofu destroy` in step 4 exited non-zero. **A non-zero exit here is the documented correct outcome, not a failure** — a script that treats any non-zero `tofu destroy` exit as "something broke" will misread this one. That is the trap this check exists to catch.

### Clean up

```bash
cd ..
rm -rf tofu-lifecycle-demo
```

## Traps

**A non-zero exit from `tofu destroy` with `destroy = false` does not mean the destroy failed.** It means the opposite — the resource was deliberately kept and only forgotten. A CI pipeline gating on `tofu destroy`'s exit code needs to special-case this, or every teardown that uses `destroy = false` reads as a broken pipeline run. Not reproduced here — flagged from the changelog wording, not from a failed run.

**`destroy = false` is persisted in state once applied**, per the resource lifecycle docs fetched above — OpenTofu will not plan a real destroy for that resource again "unless you explicitly change it back to `true`." Setting it, applying, then deleting the `lifecycle` block entirely from config is not the same as setting it back to `true` — confirm which one actually clears it before relying on this in a real module; this was not exercised here.

**`prevent_destroy` referencing a variable still needs that variable's value at plan time.** A CI job that runs `tofu destroy` without passing `-var="protect_demo=false"` (or the equivalent `.tfvars` / `TF_VAR_` environment variable) gets the default — silently protective in a pipeline that expects to tear an environment down. The dynamic form makes this easy to get right per-environment, but only if every caller actually sets the variable.

## If we applied this here

[[k8s-node-drain-replace]] already tells the reader "if this is managed by IaC, do not delete it from the console or CLI — handle it through Terraform," and runs `terraform plan -target=module.eks.module.eks_managed_node_group`. A dynamic `prevent_destroy` on that node group module — defaulting to `true` in the production workspace and overridable per-environment — would turn that prose warning into something OpenTofu itself enforces at plan time, instead of relying on the runbook being read. `destroy = false` is a narrower fit there: it would help only for the rare case of intentionally handing a node group off to be managed outside this state (e.g., migrating it to a different root module) without an actual instance-terminate — not the common path in that runbook, which does want the real resource destroyed.

That runbook targets EKS and Terraform, not OpenTofu — this lab does not confirm either feature works identically against Terraform itself (only against OpenTofu 1.12, and only against the `local` provider, not `aws`). That gap is the real blocker to adopting this in [[k8s-node-drain-replace]] as written.

## Follow-ups

- [ ] Run the lab above end to end, capture the actual `prevent_destroy` rejection message and the actual `tofu destroy` exit code for `destroy = false` 📅 2026-08-16
- [ ] Confirm whether Terraform itself (not OpenTofu) has shipped an equivalent to either feature, since [[k8s-node-drain-replace]] runs Terraform, not OpenTofu
- [ ] If confirmed, propose a dynamic `prevent_destroy` for `module.eks.module.eks_managed_node_group` in whatever repo backs [[k8s-node-drain-replace]]

## Related

[[topics]] — why this topic was selected.
[[k8s-node-drain-replace]] — the only Terraform state operation in this repository today, and the runbook this lab's findings would feed back into.
[[2026-08-12-cosign-sbom-signing]] — same sandbox limitation, same "run it and check the box" pattern for the unexecuted lab.
