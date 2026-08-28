---
title: Crossplane — cloud resources as Kubernetes objects, and a status that says Ready about something deleted
date: 2026-08-28
domain: install
tags: [kubernetes, crossplane, iac, aws, controllers]
stack: [crossplane, provider-aws-s3, provider-kubernetes, localstack, kind, helm]
summary: Crossplane 2.4 on kind, where installing one provider registers 25 S3 CRDs and an S3 bucket becomes a thing kubectl can create. Deleting a managed object had it back two minutes later with the declared values — and for those two minutes the managed resource reported SYNCED=True READY=True about something that did not exist.
source: handson
env: Crossplane 2.4.0 · provider-aws-s3 v2.7.0 · provider-kubernetes v1.3.1 · LocalStack 4 · kind v0.32.0 (Kubernetes v1.36.1) · Podman 5.7.1 · macOS 14.7.5
verified: 2026-08-28
verifiability: partial
verifiability-note: No real cloud account was touched and none should be needed to follow this. The AWS provider was installed, registered its CRDs and made real AWS API calls against LocalStack — STS succeeded, S3 CreateBucket did not, and that failure is recorded unresolved rather than papered over. The reconciliation behaviour, which is the substance of the page, was proven with provider-kubernetes against real Kubernetes objects. Compositions, XRDs and claims are described but not built here; nothing was tested against real AWS, so IAM, quotas, eventual consistency and cost are all out of scope.
duration: 60–90 min
risk: low
---

> **Verified 2026-08-28.** Every condition, count and timing below came from a running cluster. The
> two minutes in which Crossplane reported `Ready` about a ConfigMap that had been deleted are the
> reason this page exists.

Terraform describes infrastructure in its own language and reconciles when you run it.
**Crossplane makes a cloud resource a Kubernetes object** — so it is reconciled by a controller that
never stops running, and `kubectl` is the interface. That difference is worth understanding
concretely, and the interesting part is not the creating.

## Crossplane on a throwaway cluster

```bash
kind create cluster --name xp-lab

helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system --create-namespace --wait
```

```
  crossplane-867fc94669-dcf24                1/1 Running
  crossplane-rbac-manager-869868d674-vhr57   1/1 Running
  crossplane version: 2.4.0
```

**Crossplane itself knows nothing about any cloud.** It is a package manager and a reconciliation
engine; the resource types arrive with a provider.

## A provider is a package of CRDs

```yaml title="provider.yaml"
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v2.7.0
```

```
NAME                          INSTALLED   HEALTHY   PACKAGE
provider-aws-s3               True        True      xpkg.upbound.io/upbound/provider-aws-s3:v2.7.0
upbound-provider-family-aws   True        True      xpkg.upbound.io/upbound/provider-family-aws:v2.7.0
```

**The family provider was never requested.** Installing a service provider pulls the shared
credential and config machinery alongside it, which is how the AWS providers avoid every service
package carrying its own copy.

```
  s3 CRDs: 25
```

**That number is the whole idea.** Twenty-five S3 concepts — buckets, policies, lifecycle
configurations, replication, ownership controls — are now Kubernetes API types with schemas,
validation and RBAC. A cloud resource has become something `kubectl explain` can describe.

## Pointing it somewhere that costs nothing

Real AWS credentials mean real charges and real blast radius, so this lab sends every AWS call to
LocalStack in the same cluster:

```yaml title="providerconfig.yaml"
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef: {namespace: crossplane-system, name: aws-creds, key: creds}
  # Every AWS call is redirected at LocalStack. Swap this block for nothing at
  # all and the same manifests hit real AWS — which is the point and the danger.
  endpoint:
    hostnameImmutable: true
    url:
      type: Static
      static: http://localstack.localstack.svc.cluster.local:4566
```

```yaml title="bucket.yaml"
apiVersion: s3.aws.upbound.io/v1beta2
kind: Bucket
metadata:
  name: handson-lab-bucket
spec:
  forProvider:
    region: us-east-1
  providerConfigRef: {name: default}
```

**Read that manifest twice.** It is a `kubectl apply` away from an S3 bucket, and the only thing
standing between it and a real one is a `ProviderConfig` in a different file. That is the promise and
the hazard in the same three lines.

This bucket did **not** reach `Ready` — LocalStack rejected the provider's S3 credentials, and that
is recorded in [Where this bit us](#where-this-bit-us) rather than tidied away. What the attempt does
prove is that the whole chain is live: Crossplane reconciled the object, the provider read the
`ProviderConfig`, and real AWS SDK calls went out and came back.

## The part that matters: reconciliation

To show what a controller that never stops does, this uses `provider-kubernetes`, whose managed
resources are ordinary Kubernetes objects:

```yaml title="k8s-config.yaml"
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata: {name: app-settings}
spec:
  providerConfigRef: {name: default}
  forProvider:
    manifest:
      apiVersion: v1
      kind: ConfigMap
      metadata: {name: app-settings, namespace: default}
      data:
        tier: "gold"
        region: "us-east-1"
```

```
NAME           KIND        PROVIDERCONFIG   SYNCED   READY   AGE
app-settings   ConfigMap   default          True     True    30s

  data: {"region":"us-east-1","tier":"gold"}
```

Now break it by hand, which is the only way to find out whether "declarative" means anything:

```bash
kubectl -n default patch configmap app-settings --type merge -p '{"data":{"tier":"bronze"}}'
kubectl -n default delete configmap app-settings
```

```
  t+  1m  object[synced ready]=True True  configmap_exists=0
  t+  2m  object[synced ready]=True True  configmap_exists=1
  recreated after ~2m, tier=gold
```

**It came back, with the declared value.** The `bronze` edit is gone too — Crossplane does not
merge your change, it restores the manifest it was given. That is the behaviour Terraform gives you
only when someone runs `apply`, and it is why the object is worth having in the cluster.

**And look at the first line again.** For the whole first minute the managed resource reported
`SYNCED=True READY=True` about a ConfigMap that had already been deleted.

## Verification checklist

- [x] Crossplane 2.4.0 installs and both pods reach `Running`
- [x] One `Provider` manifest installs **two** providers — the requested one and the AWS family
- [x] The S3 provider registers **25 CRDs**, so cloud resources become `kubectl`-visible types
- [x] `kubectl get bucket` resolves to the **wrong API group** and reports `NotFound` for a bucket that exists
- [x] The AWS provider calls **STS `GetCallerIdentity`** before any S3 call, and fails when only `s3` is enabled
- [x] `provider-kubernetes` creates a real ConfigMap with the declared data and reports `SYNCED=True READY=True`
- [x] Deleting that ConfigMap has it **recreated in ~2 minutes** with `tier=gold`, discarding a hand-made `bronze` edit
- [x] During that gap the managed resource still reports `SYNCED=True READY=True` — a stale status, not a live one
- [x] Two provider versions guessed from memory returned `MANIFEST_UNKNOWN`; the real ones came from GitHub releases

## Rollback

```bash
kind delete cluster --name xp-lab
```

**Deleting the cluster is not deleting your cloud resources.** With a real provider the managed
resources are finalized on delete, and destroying the cluster first orphans everything it created —
delete the managed resources, watch them go, and only then delete the cluster.

## Where this bit us

**A managed resource reported `Ready` about something that did not exist.**

```
  object now:     app-settings   ConfigMap   default   True   True   8m26s
  configmap now:  Error from server (NotFound): configmaps "app-settings" not found
```

`SYNCED=True` means *"as of the last reconcile"*, and the next one had not happened yet. Crossplane
polls; it does not watch the external system. For roughly two minutes the cluster's own answer to
"is this fine" was yes, about a resource that had been deleted — and on a cloud provider, where poll
intervals are measured in minutes to keep API costs down, that window is longer.

**So a Crossplane condition is not a health check for the thing it manages.** It is a record of the
last conversation the controller had. Anything that needs to know the resource exists *now* has to
ask the resource, which is the same lesson [[harbor-installer-on-podman-arm64]] reached from a
container that was `running` and not working.

**`kubectl get bucket` looked in the wrong place, and said `NotFound` about a bucket that existed.**

```
$ kubectl get buckets.s3.aws.upbound.io -A
NAME                 SYNCED   READY   EXTERNAL-NAME        AGE
handson-lab-bucket   False            handson-lab-bucket   4m29s

$ kubectl get bucket handson-lab-bucket -o jsonpath=…
Error from server (NotFound): buckets.s3.aws.m.upbound.io "handson-lab-bucket" not found
```

Crossplane 2 providers ship **two API groups for every resource** — the cluster-scoped
`s3.aws.upbound.io` and the namespaced `s3.aws.m.upbound.io` — and the short name `bucket` resolves
to the namespaced one. **A `NotFound` that names a group you did not use is the tell**, and reading
that group name out of the error is faster than any amount of re-applying. Use the fully-qualified
`buckets.s3.aws.upbound.io` in scripts.

**The AWS provider will not touch S3 until STS answers.**

```
connect failed: cannot initialize the Terraform plugin SDK async external client:
  cannot get terraform setup: cannot get account id: cannot get the caller identity:
  GetCallerIdentity query failed … api error InternalFailure:
  Service 'sts' is not enabled. Please check your 'SERVICES' configuration variable.
```

A LocalStack started with `SERVICES=s3` is not enough: the provider resolves the account id first,
every time it builds a client. **The error is unusually good** — it names the service and the
variable — and it is worth knowing before you spend time on the S3 side of a problem that is not
there.

**Unresolved: LocalStack rejected the provider's credentials while accepting the same ones from its
own CLI.**

```
create failed: … operation error S3: CreateBucket, https response error StatusCode: 403,
  api error InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records.
```

```bash
# in the same pod, same credentials
awslocal s3 mb s3://probe-bucket
make_bucket: probe-bucket
```

Enabling `iam`, removing `iam`, and setting `S3_SKIP_SIGNATURE_VALIDATION=1` all left it unchanged.
**The bucket never reached `Ready` and this page does not pretend otherwise.** What it does establish
is that everything up to the S3 call works, so the remaining variable is LocalStack's S3 credential
emulation against a signed request from the upjet provider rather than anything in the Crossplane
configuration. It is the first follow-up.

**Two provider versions guessed from memory did not exist.**

```
MANIFEST_UNKNOWN: manifest unknown; unknown tag=v1.21.1
MANIFEST_UNKNOWN: manifest unknown; unknown tag=v0.19.0
```

`xpkg.upbound.io` needs authentication to *list* tags and not to *resolve* one, so there is no quick
way to discover versions from the registry — but the GitHub releases API answers instantly:

```bash
curl -sL https://api.github.com/repos/crossplane-contrib/provider-upjet-aws/releases/latest \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])"
```

**Two failed installs cost more than one lookup.** The same applies to any `xpkg` reference, and
pinning a version you have confirmed exists is cheaper than discovering the tag is wrong from a
cluster condition.

## Follow-ups

- [ ] Settle the LocalStack `InvalidAccessKeyId` — try an older LocalStack, or the non-upjet `provider-aws`, to isolate whether the signed request or the emulator is at fault
- [ ] Build an XRD and a Composition so one claim produces several managed resources, which is the abstraction Crossplane exists for and this page only names
- [ ] Set `spec.managementPolicies` to `["Observe"]` and confirm a resource can be adopted without being modified — the safe way to bring existing cloud resources under management
- [ ] Shorten the provider poll interval and measure how the drift-correction window changes against API call volume
- [ ] Delete a managed resource and watch the finalizer block the Kubernetes object until the external resource is gone, which is the deletion-ordering guarantee this page's rollback warns about
- [ ] Run the same bucket manifest against real AWS in a throwaway account, with a budget alarm, and compare what [[packer-aws-ami]] had to clean up by hand

## Related

[[terraform-state-operations]] — the other model, where reconciliation happens when a human runs it and the state file is the record.
[[packer-aws-ami]] — real AWS resources created and deleted by hand, for the cost and cleanup this page avoids.
[[argo-rollouts-canary-kind]] — another controller reconciling toward a declared state, on the workload side.
[[harbor-installer-on-podman-arm64]] — the same false-pass shape: a status that says fine about something that is not.
