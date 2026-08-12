---
title: Topic of the day — signing an image and attesting its SBOM with cosign v3 and syft
date: 2026-08-12
domain: daily
tags: [daily, ci]
stack: [docker, cosign, syft]
summary: Stand up a local registry, generate an SPDX SBOM with syft, sign the image and attach the SBOM as an attestation with cosign — then verify both with a public key, entirely offline.
source: daily-topic
---

## Why this topic

[[topics]] lists CI in scope and names "supply-chain security (SBOM, signing)" explicitly. No document in this repository has built, scanned, or signed a container image yet — a `grep` for `cosign`, `syft`, or `SBOM` across the repo turns up nothing outside `topics.md` itself. Every install doc here ([[argocd-helm-ha-install]], [[ingress-nginx-onprem]], [[cert-manager-onprem]], [[longhorn-storage-onprem]]) pulls already-published upstream images by tag; none of them touch the tooling for producing or verifying one.

Two dated triggers make this the week to pick it up rather than some other week:

- **cosign v3.1.3 and the backport v2.6.5, both published 2026-08-06**, fix security advisory `GHSA-fx35-mq7g-6g98` — a verification bypass using an unexpected public key in a legacy bundle. ([release list](https://github.com/sigstore/cosign/releases)) That's a signature-verification bug in the exact tool this lab teaches, patched six days before this was written — reason enough to pin the lab to a version newer than the fix rather than "latest" undated.
- **syft v1.51.0 was published 2026-08-10**, two days before this was written. ([releases](https://github.com/anchore/syft/releases))
- Separately, GitHub has been moving artifact attestation generation from opt-in toward default for public repositories through 2025 into 2026, tightening enforcement over the same stretch. ([Tenki Cloud, 2026-02-27](https://tenki.cloud/blog/github-actions-artifact-attestations-slsa)) That's a GitHub-specific mechanism this lab does not reproduce — it needs an actual GitHub Actions run, which is a cloud dependency this repository's labs avoid — but it's the same SBOM-and-signature pair this lab builds by hand with `syft` and `cosign` against a local registry, so the primitives transfer.

## 30-minute lab

> **Not executed in this run.** This is a scheduled run with no user in the loop, and `docker run`, `gh release view`, and similar commands sit behind an approval prompt this sandbox has nobody to answer — only read-only checks like `docker ps` and `which` went through. Every command below is copied from official docs (linked per step) or built from the confirmed flag names and versions above, but nobody has watched the sequence run end to end. Treat it the way [[2026-08-11-prometheus-3-13-lts]] treated its own unexecuted lab: run it and check the box under Follow-ups before trusting the exact output shown here.

### 1. Local registry

Source: [CNCF Distribution — deploy a registry server](https://distribution.github.io/distribution/about/deploying/).

```bash
docker run -d -p 5000:5000 --restart=always --name registry registry:2
```

### 2. Put something in it

No custom image exists in this repo yet, so retag a small public one rather than inventing a Dockerfile.

```bash
docker pull alpine:3.20
docker tag alpine:3.20 localhost:5000/demo:1.0
docker push localhost:5000/demo:1.0
```

### 3. Generate an SBOM

Source: [syft quick start](https://github.com/anchore/syft).

```bash
syft localhost:5000/demo:1.0 -o spdx-json=sbom.spdx.json
```

### 4. Generate a local key pair

Source: [Sigstore — signing containers](https://docs.sigstore.dev/cosign/signing/signing_with_containers/). This is a local key pair, not the keyless/OIDC flow — no external identity provider involved.

```bash
cosign generate-key-pair
```

Prompts interactively for a password to encrypt `cosign.key`. In a non-interactive shell, set `COSIGN_PASSWORD` first or the command blocks waiting on stdin.

### 5. Sign the image

Source: [Sigstore — signing containers](https://docs.sigstore.dev/cosign/signing/signing_with_containers/) and [`cosign_sign` reference](https://github.com/sigstore/cosign/blob/main/doc/cosign_sign.md) for the `--allow-http-registry` flag.

```bash
cosign sign --key cosign.key --allow-http-registry --yes localhost:5000/demo:1.0
```

`localhost:5000` is plain HTTP — `--allow-http-registry` is required or cosign tries HTTPS first and fails.

### 6. Attach the SBOM as an attestation

Source: [`cosign_attest` reference](https://github.com/sigstore/cosign/blob/main/doc/cosign_attest.md). `spdxjson` is the JSON-format predicate type; cosign v3 split this from `spdx` (the tag-value format) — see Traps.

```bash
cosign attest --key cosign.key --predicate sbom.spdx.json --type spdxjson --allow-http-registry --yes localhost:5000/demo:1.0
```

### Verify

Source: [Sigstore — verifying signatures](https://docs.sigstore.dev/cosign/verifying/verify/).

```bash
cosign verify --key cosign.pub --allow-http-registry localhost:5000/demo:1.0
cosign verify-attestation --key cosign.pub --type spdxjson --allow-http-registry localhost:5000/demo:1.0
```

Expected: both exit `0`. `verify` prints a JSON array of signature entries; `verify-attestation` prints the in-toto envelope, whose `payload` field is base64-encoded — decode it (`| jq -r .payload | base64 -d | jq .`) to read the SBOM back out. Signing with the wrong key, or verifying against an image that was re-pushed after signing, is the failure this check exists to catch — both should exit non-zero with an explicit error rather than printing anything. That specific failure path was not exercised in this write-up; confirm it actually happens before relying on it.

### Clean up

```bash
docker rm -f registry
docker rmi alpine:3.20 localhost:5000/demo:1.0
rm -f cosign.key cosign.pub sbom.spdx.json
```

## Traps

**`spdx` and `spdxjson` are not interchangeable in cosign v3.** Cosign v3 split the SBOM predicate type into `spdx` (tag-value format) from `spdxjson` (JSON format) — passing `--type spdx` against the JSON file `syft` produced above is a plausible copy-paste mistake, not a hypothetical one, given how similar the two flag values look. ([pkg.go.dev source](https://pkg.go.dev/github.com/sigstore/cosign/v2/pkg/cosign/attestation)) Not reproduced here — flagged from the docs, not from a failed run.

**A plain HTTP local registry needs `--allow-http-registry` on every cosign subcommand that touches it**, not just the first one — `sign`, `attest`, `verify`, and `verify-attestation` each talk to the registry independently. Forgetting it on `verify` after remembering it on `sign` is an easy split — the error is a registry-connection failure, not "verification failed," which reads like the wrong problem if the message gets truncated.

**`cosign generate-key-pair` is interactive by default.** In a script or CI job with no TTY, it blocks on the password prompt with no obvious timeout — set `COSIGN_PASSWORD` in the environment beforehand instead of finding this out at hour two of a stuck pipeline.

## If we applied this here

Signing has nothing to attach itself to yet: every install doc here ([[argocd-helm-ha-install]], [[ingress-nginx-onprem]], [[cert-manager-onprem]], [[longhorn-storage-onprem]], [[metallb-l2-onprem]]) deploys already-published upstream Helm charts and images, not anything built in this repo. This lab's signing and attestation steps only become load-bearing once something here builds a custom image.

The other half of the value is enforcement, not signing — a signed image nobody checks at admission time is a signature nobody uses. [Sigstore's policy-controller](https://docs.sigstore.dev/policy-controller/sample-policies/) or a Kyverno `imageVerify` policy would need to sit in front of whichever cluster from [[argocd-helm-ha-install]] or [[onprem-3node-kubeadm-ubuntu]] actually runs a custom image — neither policy-controller nor Kyverno is installed anywhere in this repo today, so that's the real next step, not this lab by itself.

## Follow-ups

- [ ] Run the lab above end to end and confirm both `verify` commands actually exit `0` with the output claimed here 📅 2026-08-15
- [ ] Confirm the `spdx` vs `spdxjson` mismatch actually produces the error the Traps section predicts, rather than silently accepting the wrong type
- [ ] Once this repo builds a first custom image for anything, revisit whether policy-controller or Kyverno `imageVerify` belongs in [[argocd-helm-ha-install]]'s cluster

## Related

[[topics]] — why this topic was selected.
[[2026-08-11-prometheus-3-13-lts]] — same sandbox limitation, same "run it and check the box" pattern for the unexecuted lab.
[[argocd-helm-ha-install]] — the cluster this lab's enforcement half would eventually sit in front of.
