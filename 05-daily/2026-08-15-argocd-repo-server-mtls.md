---
title: Topic of the day — mutual TLS for Argo CD's repo-server (new in 3.5)
date: 2026-08-15
domain: daily
tags: [daily, gitops-and-delivery, not-executed]
stack: [kubernetes, argocd, helm, kind]
summary: Enable the new opt-in mTLS between argocd-server/controllers and argocd-repo-server shipped in Argo CD 3.5, and see exactly what it authenticates and what it still leaves wide open. Not executed — the scheduled run could not start a cluster, so the gap described here is read from the source, not demonstrated.
source: daily-topic
---

## Why this topic

[[topics]] lists GitOps and delivery — Argo CD, Flux, progressive delivery — as in scope. [[argocd-helm-ha-install]] is the only Argo CD document in this repository, and its own stated scope stops at the ingress: "TLS terminates at the ingress, so the server should accept plaintext." Nothing in it addresses traffic between Argo CD's own components once it's inside the cluster network.

**Argo CD v3.5.0 GA shipped 2026-08-04, with a bug-fix release v3.5.1 following 2026-08-12** — three days before this was written ([releases](https://github.com/argoproj/argo-cd/releases)). Among its changes, per the official 3.4→3.5 upgrade notes (fetched 2026-08-15): an **opt-in mutual TLS (mTLS) mode between `argocd-server`, `argocd-application-controller`, `argocd-applicationset-controller`, `argocd-notifications-controller` and `argocd-repo-server`**, and deprecation of the older `--repo-server-strict-tls` flag in favor of `--repo-server-ca-cert-path` ([3.4 to 3.5 upgrade notes](https://argo-cd.readthedocs.io/en/latest/operator-manual/upgrading/3.4-3.5/)). The mechanism itself is documented separately at [Mutual TLS (mTLS) for repo-server](https://argo-cd.readthedocs.io/en/stable/operator-manual/mtls/), fetched 2026-08-15.

This is a new knob directly on the document already in this repository, not a new tool — which is why it won this slot over the other candidates found in the same search pass:

- **GitHub Actions read-only cache tokens for untrusted triggers** (shipped 2026-06-26, [GitHub changelog](https://github.blog/changelog/2026-06-26-read-only-actions-cache-for-untrusted-triggers/)) — real, CI-relevant, and dated, but proving it needs an actual GitHub-hosted Actions run against a `pull_request_target`-style trigger. That's a cloud dependency this repository's labs avoid; there is no local stand-in for GitHub's token issuance.
- **Flux v2.8/v2.9** (Helm v4 support, CLI plugin system — [Flux v2.8.0 announcement](https://fluxcd.io/blog/2026/02/flux-v2.8.0/)) — a legitimate, never-covered GitOps tool, but this repository's only GitOps document is Argo CD-based. Starting a second GitOps stack from scratch scores lower against "touches an existing document" than deepening the one already here.
- **Argo CD Source Integrity / Source Hydrator** (same 3.5 release, same upgrade notes) — flagged explicitly as **Alpha** in the release, and demonstrating it needs a working dry/hydrated-branch Source Hydrator setup with signed commits, which is a bigger build than 30 minutes and thinner on documented specifics right now.

## 30-minute lab

> **Not executed in this run.** This is a scheduled run with no user in the loop. `docker ps` (read-only) works, but `kind create cluster` sits behind an approval prompt nothing here can answer, so nothing below has actually been run end to end. Every command is either copied from the official docs linked per step, or — for the OpenSSL certificate generation, which the Argo CD docs describe but don't script — standard self-signed CA/leaf-cert invocation. Treat it the way [[2026-08-12-cosign-sbom-signing]] treated its own unexecuted lab: run it and check the box under Follow-ups before trusting the exact output shown here.

### 1. Cluster and a chart that actually ships 3.5.x

```bash
kind create cluster --name argocd-mtls-demo
kubectl create namespace argocd
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update argo
helm search repo argo/argo-cd --versions | head -3
```

Take the top line's `APP VERSION`. This lab is written against the mTLS feature that shipped in Argo CD **3.5.0** — confirm the chart you're about to pin actually carries `3.5.0` or newer before continuing; [[argocd-helm-ha-install]] itself pins chart `7.x`, which predates this feature.

```bash
export ARGOCD_CHART_VERSION="<version you picked>"
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --version "$ARGOCD_CHART_VERSION" \
  --set redis-ha.enabled=false \
  --set server.extraArgs='{--insecure}' \
  --wait --timeout 10m
```

`redis-ha.enabled=false` is [[argocd-helm-ha-install]]'s own single-node workaround — a kind cluster has one schedulable node, and `redis-ha`'s anti-affinity never satisfies on it.

### 2. A CA and one client certificate

The mTLS docs specify the Secret shape but not how to produce the certs — this is plain OpenSSL, not Argo CD-specific:

```bash
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout client-ca.key -out client-ca.crt \
  -subj "/CN=argocd-mtls-demo-ca"

openssl req -newkey rsa:4096 -nodes \
  -keyout client.key -out client.csr \
  -subj "/CN=argocd-repo-server-client"

openssl x509 -req -in client.csr -CA client-ca.crt -CAkey client-ca.key \
  -CAcreateserial -out client.crt -days 825 -sha256
```

### 3. The secret, by the exact name the docs expect

```bash
kubectl -n argocd create secret generic argocd-repo-server-mtls \
  --from-file=client-ca.crt=client-ca.crt \
  --from-file=client.crt=client.crt \
  --from-file=client.key=client.key
```

Per the docs, this gets "automatically mounted at `/app/config/reposerver/mtls`" in every relevant pod, and mTLS turns on as soon as the Secret exists — no ConfigMap or `--set` flag involved.

### 4. Restart everything that talks to repo-server

```bash
kubectl -n argocd get deploy,sts
```

Check that output before restarting — in a non-HA chart install, `argocd-application-controller` is commonly a `StatefulSet` rather than a `Deployment`; restart it with the kind that actually shows up.

```bash
kubectl -n argocd rollout restart deployment argocd-repo-server argocd-server \
  argocd-applicationset-controller argocd-notifications-controller
kubectl -n argocd rollout status deployment/argocd-repo-server --timeout=120s
```

### Verify

```bash
kubectl -n argocd exec deploy/argocd-repo-server -- ls /app/config/reposerver/mtls
kubectl -n argocd logs deploy/argocd-repo-server --since=5m | grep -i "ephemeral\|client certificate"
```

Expected: the mount lists `client-ca.crt`, `client.crt`, `client.key`, and the log grep turns up a line containing `Generated ephemeral health-check client certificate (CN=...)` — the exact string the docs quote. No matching line and no error either is the false-pass case here: it usually means the Secret exists but was created *after* the pod already started and never got remounted, not that mTLS silently succeeded with nothing to show for it.

```bash
kubectl -n argocd get applications -A
```

A second, independent check: an existing `Application` still reaching `Synced`/`Healthy` after the restart proves mTLS didn't break the internal call path it's supposed to only authenticate, not block.

### Clean up

```bash
kind delete cluster --name argocd-mtls-demo
rm -f client-ca.key client-ca.crt client-ca.srl client.key client.csr client.crt
```

## Traps

**The repo-server authenticates, it does not authorize.** Quoting the docs directly: "Any client that holds a certificate signed by the trusted CA will pass — regardless of which component is connecting." Step 3 above hands the same client cert to all five components. A compromised `argocd-applicationset-controller` can present that identical cert and be accepted as if it were `argocd-application-controller`. The docs describe a per-component certificate option (separate cert pairs, one per Secret key or one Secret each) as the actual mitigation — the setup above is the minimum that turns mTLS on, not the setup that makes it mean something.

**`argocd-repo-server-mtls` isn't a Helm values field, as far as either doc fetched for this entry shows.** It's a plain Secret the chart doesn't manage, created and rotated outside `helm upgrade` — unlike nearly everything else in [[argocd-helm-ha-install]]'s `argocd-values.yaml`. Losing track of who owns that Secret's rotation is a gap this lab surfaces but doesn't close.

**`--repo-server-strict-tls` is deprecated in the same release that adds this.** Anyone with that flag already set in `argocd-cmd-params-cm` from an older install sees a deprecation warning on the exact upgrade that also adds the new feature — easy to misread as the new feature causing the warning, when it's an unrelated flag on its way out.

## If we applied this here

[[argocd-helm-ha-install]] pins chart `7.x` and its threat model, as written, stops at the ingress. Two things block adopting this beyond a lab: first, the chart jump itself — that install doc doesn't say what changed between chart `7.x` and whatever version first ships app `3.5.0`, and a multi-major chart bump is not a same-day change on a document that also carries an HA `redis-ha` warning of its own. Second, the shared-cert setup in this lab provides no real authorization boundary per the trap above, so enabling it as-is buys log noise and a cert-rotation chore without the security property the feature name implies — the per-component cert path would need to be the actual target, and that's undemonstrated here.

## Follow-ups

- [ ] Run the lab above end to end on kind and confirm the "Generated ephemeral health-check client certificate" log line actually appears 📅 2026-08-22
- [ ] Confirm which `argo/argo-cd` chart version is the first to ship Argo CD app `3.5.0`, and record it before touching [[argocd-helm-ha-install]]'s pinned chart version
- [ ] Decide whether per-component certificates are worth the rotation overhead before ever enabling this outside a lab

## Related

[[argocd-helm-ha-install]] — the only Argo CD document here; this feature sits inside its step 3 install command.
[[2026-08-12-cosign-sbom-signing]] — same supply-chain-trust theme, one layer over: image signing versus internal service authentication.
[[topics]] — why this topic was selected.
