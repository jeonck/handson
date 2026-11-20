---
title: Topic of the day — Argo CD 3.6 makes Server-Side Diff the default for ServerSideApply=true Applications
date: 2026-11-20
domain: daily
tags: [daily, gitops-and-delivery]
stack: [kubernetes, argocd, kind, kubectl]
summary: Argo CD 3.6's upgrade notes say a ServerSideApply=true Application now dry-runs against the live API server during diff, so a rejection can surface before Sync — confirmed the dry-run/admission mechanism directly with kubectl, but a ResourceQuota rejection landed identically and at the same point in both the old and new diff modes once the quota-bearing object was the one Argo CD actually applies, not one it creates indirectly.
source: daily-topic
env: kind v0.33.0, node image kindest/node:v1.37.0 · Argo CD v3.6.2 installed from the official core manifest (`manifests/install.yaml`), not the argo-helm chart used in [[argocd-helm-ha-install]] · a throwaway git-daemon pod in the same namespace stood in for a real git host, nothing pushed anywhere external
verified: 2026-11-20
---

## Why this topic

[[topics]] lists GitOps and delivery — Argo CD, Flux, progressive delivery — as in scope, and
[[argocd-helm-ha-install]] is this repository's only Argo CD document. **Argo CD v3.6.0 shipped
2026-11-03, with patch releases v3.6.1 (2026-11-04) and v3.6.2 (2026-11-18)** — two days before this
run — confirmed against the release API rather than a blog post:

```bash
gh release list --repo argoproj/argo-cd --limit 6
```

```
v3.6.2  Latest  v3.6.2  2026-11-18T19:55:54Z
v3.4.14         v3.4.14 2026-11-18T19:58:38Z
v3.5.8          v3.5.8  2026-11-18T19:54:30Z
v3.6.1          v3.6.1  2026-11-04T14:20:31Z
v3.6.0          v3.6.0  2026-11-03T22:29:38Z
v3.3.19         v3.3.19 2026-11-02T20:18:03Z
```

The official [3.5 to 3.6 upgrade notes](https://argo-cd.readthedocs.io/en/stable/operator-manual/upgrading/3.5-3.6/) (fetched 2026-11-20) name the headline behavior change plainly: *"Applications with the `ServerSideApply=true` sync option now use Server-Side Diff by default"*, replacing the old Structured-Merge Diff strategy, with two stated consequences — more kube-apiserver load from dry-run requests "proportional to the number of resources," and *"Validating webhooks now participate in the diff stage"*, meaning a resource a webhook would reject can now show up as a diff error **before** Sync is even clicked, not just at apply time. The escape hatch is a per-Application annotation: `argocd.argoproj.io/compare-options: ServerSideDiff=false`.

This is a default-behavior change on a knob, not a new tool, and it lands squarely on [[argocd-helm-ha-install]]'s own stack. Checking that document directly: it never sets `ServerSideApply=true` anywhere —

```bash
grep -n 'ServerSideApply' 01-install/argocd-helm-ha-install.md
```

— no matches. So the install as written is not affected by this default on upgrade; the risk is for whoever adds that sync option later (a common reason: large CRDs that choke the old client-side three-way merge), which is exactly the kind of case this lab builds.

Other candidates found in the same pass: **Kubernetes 1.37 "Garhwal"** (GA'd 2026-08-26, Metrics API and resilient watchcache both reached GA — [release blog](https://kubernetes.io/blog/2026/08/26/Kubernetes-v1-37-release/)) is real and in scope, but container orchestration already has an open backlog item ([[2026-08-14-inplace-pod-resize-ga]], not yet executed) and nothing in 1.37 touches an existing document the way this does. **Prometheus 3.16.0** (released 2026-11-05, [GitHub release](https://github.com/prometheus/prometheus/releases/tag/v3.16.0)) adds an experimental query-cost feature — interesting, but purely additive and opt-in, with no comparable "this changes a default you already rely on" angle.

## 30-minute lab

### 1. Cluster and a from-scratch Argo CD core install

```bash
kind create cluster --name daily-argocd36 --wait 120s
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.6.2/manifests/install.yaml
```

Observed — this failed, on the first CRD in the file that is actually big:

```
The CustomResourceDefinition "applicationsets.argoproj.io" is invalid: metadata.annotations: Too long: may not be more than 262144 bytes
```

`kubectl apply` without `--server-side` stores the whole applied object in a `last-applied-configuration` annotation for next time's three-way merge, and Argo CD's `ApplicationSet` CRD is now big enough to blow past etcd's 262144-byte annotation ceiling on its own. The fix is server-side apply, which does not use that annotation — but running it straight after the failed attempt above hits a second, different error, because the partial first apply already registered `kubectl-client-side-apply` as a field manager on some objects:

```bash
kubectl apply -n argocd --server-side -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.6.2/manifests/install.yaml
```

```
Apply failed with 1 conflict: conflict with "kubectl-client-side-apply" using apps/v1: .spec.template.spec.containers[name="argocd-applicationset-controller"].env[name="NAMESPACE"].valueFrom.fieldRef
...
```

From a clean namespace, `--server-side --force-conflicts` applies in one pass with no prior manager to fight:

```bash
kubectl delete namespace argocd --wait --timeout=60s
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.6.2/manifests/install.yaml
kubectl -n argocd wait --for=condition=Available deployment --all --timeout=180s
```

Observed: every `deployment.apps/...` line printed `condition met`, and:

```bash
kubectl -n argocd get pods
```

```
NAME                                                READY   STATUS    RESTARTS   AGE
argocd-application-controller-0                     1/1     Running   0          34s
argocd-applicationset-controller-76c9bbbc9f-62jdz   1/1     Running   0          34s
argocd-dex-server-c5c68fc58-9qlq7                   1/1     Running   0          34s
argocd-notifications-controller-67bf66d585-4mdsz    1/1     Running   0          34s
argocd-redis-665bf4467d-4p6d7                       1/1     Running   0          34s
argocd-repo-server-7fb4dfb7fb-fmx6l                 1/1     Running   0          34s
argocd-server-7c54fc4fd9-gvppr                      1/1     Running   0          34s
```

Confirmed version actually running, not assumed from the tag in the URL:

```bash
kubectl -n argocd exec deploy/argocd-server -- argocd-server version
```

```
argocd-server: v3.6.2
BuildDate: 2026-11-18T19:03:00Z
```

### 2. A throwaway git source, with no external repo involved

Argo CD only syncs from a git/Helm/OCI source, so a one-off lab needs *some* repo. Rather than push anywhere, this spins up a disposable `git://` daemon inside the same namespace and tears it down with the cluster:

```bash
kubectl -n argocd run git-server --image=alpine:3.20 --restart=Never --command -- \
  sh -c "apk add --no-cache git-daemon >/dev/null 2>&1 && mkdir -p /srv/git && sleep infinity"
kubectl -n argocd wait --for=condition=Ready pod/git-server --timeout=60s
```

Plain `apk add git` does not include `git-daemon` — Alpine ships it as the separate `git-daemon` package, with the binary at `/usr/libexec/git-core/git-daemon`, not on `PATH`:

```bash
kubectl -n argocd cp /tmp/repo.git git-server:/srv/git/repo.git
kubectl -n argocd exec git-server -- sh -c \
  "nohup /usr/libexec/git-core/git-daemon --base-path=/srv/git --export-all --reuseaddr --listen=0.0.0.0 > /tmp/gitd.log 2>&1 &"
kubectl -n argocd expose pod git-server --port=9418 --target-port=9418 --name=git-server
```

(`/tmp/repo.git` is a bare clone of a local working tree containing one manifest — see step 3.)

### 3. Two Applications, one object, one quota

A `ResourceQuota` on the destination namespace is the admission check under test:

```bash
kubectl create namespace quota-demo
kubectl -n quota-demo apply -f - <<'EOF'
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tiny-budget
spec:
  hard:
    requests.memory: 100Mi
    limits.memory: 100Mi
EOF
```

**First attempt — wrong object.** The manifest in the repo was a `Deployment` requesting `200Mi`. Both the plain and the `ServerSideApply=true` Application reported `successfully synced`, with no error from Argo CD at all:

```bash
kubectl -n argocd exec deploy/argocd-server -- argocd app sync classic-diff --server localhost:8080 --insecure
```

```
...
Phase:          Succeeded
Message:        successfully synced (all tasks run)
```

Checking what actually happened in the namespace told the real story:

```bash
kubectl -n quota-demo get events --sort-by='.lastTimestamp' | tail -5
```

```
Warning  FailedCreate  replicaset/oversized-app-698f7cd776  Error creating: pods "oversized-app-698f7cd776-mjsvl" is forbidden: exceeded quota: tiny-budget, ...
```

A `ResourceQuota` on `requests.memory`/`limits.memory` is enforced on the `Pod`, not the `Deployment`. Argo CD's apply of the `Deployment` object always succeeds; the `ReplicaSet` controller is the one that keeps getting its `Pod` creations rejected, in a loop Argo CD's sync call never sees. Testing "does a new default change what Argo CD's own apply call sees" against a `Deployment` here is a test of the wrong object.

**Second attempt — the object Argo CD actually applies.** Swapped the repo content for a bare `Pod` requesting the same `200Mi`, re-created both Applications against the same two sync-option configurations (`classic-diff`: no sync options; `ssa-diff`: `syncOptions: [ServerSideApply=true]`), and synced both:

```bash
kubectl -n argocd exec deploy/argocd-server -- argocd app sync ssa-diff --server localhost:8080 --insecure
kubectl -n argocd exec deploy/argocd-server -- argocd app sync classic-diff --server localhost:8080 --insecure
```

Observed, for **both** apps, word for word the same message:

```
Phase:    Failed
Message:  one or more objects failed to apply, reason: pods "oversized-pod" is forbidden:
          exceeded quota: tiny-budget, requested: limits.memory=200Mi,requests.memory=200Mi,
          used: limits.memory=0,requests.memory=0, limited: limits.memory=100Mi,requests.memory=100Mi
```

No difference in timing, wording, or which stage caught it, between the `ServerSideApply=true` app and the plain one. See Traps for why.

### Verify

The mechanism the upgrade notes describe — a server-side dry-run genuinely hitting admission — is real and checkable directly with `kubectl`, independent of Argo CD:

```bash
kubectl -n quota-demo apply --server-side --dry-run=server -f /tmp/demo-repo-work/deployment.yaml
```

Observed:

```
Error from server (Forbidden): pods "oversized-pod" is forbidden: exceeded quota: tiny-budget, ...
```

That is the same `Forbidden` a real (non-dry-run) `apply` gets — confirmed by running the same command without `--dry-run=server` and seeing the identical message. A `--dry-run=server` request really does go through quota admission; it is not a client-side simulation.

### Clean up

```bash
kind delete cluster --name daily-argocd36
```

(The git-daemon pod, Service, and both Applications all live inside that one cluster, so the cluster delete is the whole teardown — nothing else to unwind.)

## Traps

**A `ResourceQuota` rejection is not the "diff error before Sync" the upgrade notes describe, because quota rejects the real apply exactly as reliably as the dry-run one.** The notes specifically name *validating webhooks* as the thing that now "participates in the diff stage" — a webhook can approve a dry-run and still be consulted. Built-in `ResourceQuota` admission already rejects both the dry-run and the real call with the same `Forbidden`, in both diff modes, because the object genuinely does not fit the budget either way. The two sync options produced byte-for-byte identical failure messages in this lab. **Not verified in this lab:** whether an actual `ValidatingWebhookConfiguration` surfaces its rejection during the passive background refresh (before anyone clicks Sync) for a `ServerSideApply=true` Application, which is the specific claim the upgrade notes make — building and TLS-wiring a real webhook server was the piece this run ran out of scope for. See Follow-ups.

**Testing an admission default against a `Deployment` tests the wrong layer.** Compute-resource quotas bind to `Pod`, not to the controllers that create Pods. A `Deployment`/`StatefulSet`/`Job` will report a clean Argo CD sync no matter how badly its Pods get rejected downstream — check `kubectl get events` in the destination namespace, not the Application's own sync status, if the object under test is anything but the Pod-equivalent resource itself.

**`kubectl apply -f <big-manifest>` on Argo CD's own install manifest fails before any Argo CD question can even be asked.** The `applicationsets.argoproj.io` CRD is large enough that client-side apply's `last-applied-configuration` annotation exceeds etcd's 262144-byte cap on a fresh v3.6.2 install. `--server-side` is the fix, but only from a clean namespace — retrying `--server-side` after a failed plain `apply` hits `kubectl-client-side-apply` field-manager conflicts and needs `--force-conflicts` on top.

**Alpine's `git` package does not include `git-daemon`.** It is the separate `git-daemon` package, and the binary lands at `/usr/libexec/git-core/git-daemon`, not on `PATH` — `apk add git-daemon && git daemon ...` fails with "'daemon' is not a git command" even though the install succeeded.

## If we applied this here

- [[argocd-helm-ha-install]] does not set `ServerSideApply=true` anywhere today, so its own upgrade to 3.6 changes nothing by default — confirmed by `grep`, not assumed.
- The reduced on-prem values in that same document's section 2.1 are the more likely place this ever matters: a two-node budget with tight CRD/CRD-churn pressure is exactly the situation that makes someone reach for `ServerSideApply=true` later, and whoever does inherits this default the day they turn it on, not the day they upgrade the chart.
- [[2026-08-15-argocd-repo-server-mtls]], this repository's other open Argo CD backlog item, is unrelated to this change (it is about repo-server transport, not sync diff strategy) — no overlap to resolve between the two.

## Follow-ups

- [ ] Stand up one real `ValidatingWebhookConfiguration` against a kind cluster and confirm whether its rejection appears in a `ServerSideApply=true` Application's `status.conditions` during passive refresh, before any Sync is triggered 📅 2026-12-04

## Related

[[argocd-helm-ha-install]] — the Argo CD document this default change lands on; confirmed it does not use `ServerSideApply=true` today.
[[2026-08-15-argocd-repo-server-mtls]] — the other open Argo CD backlog item, unrelated to this one.
[[topics]] — why this topic was selected.
