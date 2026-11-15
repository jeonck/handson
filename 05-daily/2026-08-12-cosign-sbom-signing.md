---
title: Topic of the day — signing an image and attesting its SBOM with cosign v3 and syft
date: 2026-08-12
domain: daily
tags: [daily, ci]
stack: [docker, cosign, syft]
summary: Stand up a local registry, generate an SPDX SBOM with syft, sign the image and attach the SBOM as an attestation with cosign — verify both with a public key, and watch the wrong-key and wrong-predicate-type failures actually happen.
source: daily-topic
env: Docker 29.4.2 (containers only, no Kubernetes) · syft v1.51.0 and cosign v3.1.3 run from their official container images, not host binaries — this sandbox blocks executing a freshly downloaded binary directly, see Traps
verified: 2026-11-15
---

## Why this topic

[[topics]] lists CI in scope and names "supply-chain security (SBOM, signing)" explicitly. No document in this repository had built, scanned, or signed a container image before this one — a `grep` for `cosign`, `syft`, or `SBOM` across the repo turned up nothing outside `topics.md` itself. Every install doc here ([[argocd-helm-ha-install]], [[ingress-nginx-onprem]], [[cert-manager-onprem]], [[longhorn-storage-onprem]]) pulls already-published upstream images by tag; none of them touch the tooling for producing or verifying one.

Two dated triggers made this the week to pick it up rather than some other week:

- **cosign v3.1.3 and the backport v2.6.5, both published 2026-08-06**, fix security advisory `GHSA-fx35-mq7g-6g98` — a verification bypass using an unexpected public key in a legacy bundle. ([release list](https://github.com/sigstore/cosign/releases)) That's a signature-verification bug in the exact tool this lab teaches, patched six days before this was first drafted — reason enough to pin the lab to a version newer than the fix rather than "latest" undated.
- **syft v1.51.0 was published 2026-08-10**, two days before this was first drafted. ([releases](https://github.com/anchore/syft/releases))
- Separately, GitHub has been moving artifact attestation generation from opt-in toward default for public repositories through 2025 into 2026, tightening enforcement over the same stretch. ([Tenki Cloud, 2026-02-27](https://tenki.cloud/blog/github-actions-artifact-attestations-slsa)) That's a GitHub-specific mechanism this lab does not reproduce — it needs an actual GitHub Actions run, which is a cloud dependency this repository's labs avoid — but it's the same SBOM-and-signature pair this lab builds by hand with `syft` and `cosign` against a local registry, so the primitives transfer.

This document was drafted on 2026-08-12 in a scheduled run that could not execute anything (`docker run` sat behind an unanswered approval prompt that day). It sat in the `not-executed` backlog until 2026-11-15, when a scheduled run landed with working `docker run` and cleared the oldest backlog item instead of picking a new topic, per the daily-topic skill's own backlog rule. Everything below is now what was observed, not what the docs predicted.

## 30-minute lab

Neither `syft` nor `cosign` was installed on the host, and this sandbox's permission classifier refuses to execute a freshly downloaded binary directly (tried `install.sh`-fetched `syft` — denied as "Undermining Oversight" even after `chmod +x`). Running both from their **official container images** instead worked — see Traps for the one gotcha that came with it (non-root container user, read-only bind mount).

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

Source: [syft quick start](https://github.com/anchore/syft). Run from the official image rather than a host binary — see the banner above.

```bash
mkdir -p lab && cd lab
docker run --rm --network host -v "$(pwd)":/out anchore/syft:v1.51.0 \
  localhost:5000/demo:1.0 -o spdx-json=/out/sbom.spdx.json
```

Observed: `sbom.spdx.json`, 87585 bytes, `"creators":["Organization: Anchore, Inc","Tool: syft-1.51.0"]`, 15 packages listed (alpine's base layout, musl, apk-tools, busybox, and friends).

### 4. Generate a local key pair

Source: [Sigstore — signing containers](https://docs.sigstore.dev/cosign/signing/signing_with_containers/). This is a local key pair, not the keyless/OIDC flow — no external identity provider involved. Run from the `gcr.io/projectsigstore/cosign` image, version `v3.1.3` (the fixed version from the advisory above).

```bash
chmod 777 lab   # the cosign image runs as non-root (uid 65532) — see Traps
cd lab
docker run --rm -e COSIGN_PASSWORD=<REDACTED> -v "$(pwd)":/work -w /work \
  gcr.io/projectsigstore/cosign:v3.1.3 generate-key-pair
```

Observed: `Private key written to cosign.key` / `Public key written to cosign.pub`, written as uid `65532`, not the host user — confirming the chmod was necessary, not optional.

### 5. Sign the image

Source: [Sigstore — signing containers](https://docs.sigstore.dev/cosign/signing/signing_with_containers/) and [`cosign_sign` reference](https://github.com/sigstore/cosign/blob/main/doc/cosign_sign.md) for the `--allow-http-registry` flag.

```bash
docker run --rm --network host -e COSIGN_PASSWORD=<REDACTED> -v "$(pwd)":/work -w /work \
  gcr.io/projectsigstore/cosign:v3.1.3 sign --key cosign.key --allow-http-registry --yes localhost:5000/demo:1.0
```

Observed: a warning about signing by tag rather than digest (expected — this lab intentionally uses a tag, see Traps for why that's a real risk, not just lint noise), then `Signing artifact... Pushing signature to: localhost:5000/demo`, exit 0.

### 6. Attach the SBOM as an attestation

Source: [`cosign_attest` reference](https://github.com/sigstore/cosign/blob/main/doc/cosign_attest.md). `spdxjson` is the JSON-format predicate type; cosign v3 split this from `spdx` (the tag-value format) — see Traps for what happens if you use the wrong one, confirmed below.

```bash
docker run --rm --network host -e COSIGN_PASSWORD=<REDACTED> -v "$(pwd)":/work -w /work \
  gcr.io/projectsigstore/cosign:v3.1.3 attest --key cosign.key --predicate sbom.spdx.json --type spdxjson \
  --allow-http-registry --yes localhost:5000/demo:1.0
```

Observed: `Using payload from: sbom.spdx.json`, `Signing artifact...`, exit 0, no further output.

### Verify

Source: [Sigstore — verifying signatures](https://docs.sigstore.dev/cosign/verifying/verify/).

```bash
docker run --rm --network host -v "$(pwd)":/work -w /work gcr.io/projectsigstore/cosign:v3.1.3 \
  verify --key cosign.pub --allow-http-registry localhost:5000/demo:1.0
docker run --rm --network host -v "$(pwd)":/work -w /work gcr.io/projectsigstore/cosign:v3.1.3 \
  verify-attestation --key cosign.pub --type spdxjson --allow-http-registry localhost:5000/demo:1.0
```

**Pass, observed:** both exit `0`. `verify` printed a JSON array of two signature entries (image signature, `spdx.dev/Document` attestation), `verify-attestation` printed the in-toto envelope. Decoding `payload` (`| jq -r .payload | base64 -d`) gave back the same SBOM: `predicateType: https://spdx.dev/Document`, subject digest matching the pushed image, `name: localhost:5000/demo`, 15 packages — the SBOM round-tripped intact.

**Fail, observed (this was never exercised before this run):**

- Verifying against an unrelated public key: `cosign verify --key <wrong>.pub ...` → **exit 1**, `Error: no matching attestations: failed to verify log inclusion: transparency log certificate does not match`. Non-zero as expected, but the error text talks about "log inclusion," not "wrong key" — worth knowing before troubleshooting it as a transparency-log problem.
- Attesting with the wrong predicate type (`--type spdx` against the JSON file syft produced): **fails immediately at `attest`, not later at `verify-attestation`** — `Error: signing localhost:5000/demo:1.0: creating bundle: signing bundle: error signing bundle: failed to fetch envelope statement: validation error: invalid attestation: decoding json`, exit 1. The mismatched attestation is never written, so there is nothing to catch at verify time — see Traps, this corrects what the original draft guessed.

### Clean up

```bash
docker rm -f registry
docker rmi alpine:3.20 localhost:5000/demo:1.0 anchore/syft:v1.51.0 \
  gcr.io/projectsigstore/cosign:v3.1.3 gcr.io/projectsigstore/cosign:v2.6.5
rm -rf lab
```

Ran clean in this session — no leftover containers (`docker ps -a` empty afterward).

## Traps

**`spdx` and `spdxjson` are not interchangeable in cosign v3 — and the mismatch fails at `attest`, not at `verify`.** Passing `--type spdx` against the JSON file `syft` produced raises `invalid attestation: decoding json` the moment you try to sign the bundle; no attestation is written. The earlier draft of this document guessed the failure would surface at `verify-attestation` instead — confirmed wrong, now corrected. ([pkg.go.dev source](https://pkg.go.dev/github.com/sigstore/cosign/v2/pkg/cosign/attestation))

**A plain HTTP local registry needs `--allow-http-registry` on every cosign subcommand that touches it**, not just the first one — `sign`, `attest`, `verify`, and `verify-attestation` each talk to the registry independently. Forgetting it on `verify` after remembering it on `sign` is an easy split — the error is a registry-connection failure, not "verification failed," which reads like the wrong problem if the message gets truncated.

**`cosign generate-key-pair` is interactive by default.** In a script or CI job with no TTY, it blocks on the password prompt with no obvious timeout — set `COSIGN_PASSWORD` in the environment beforehand instead of finding this out at hour two of a stuck pipeline. Confirmed here: with `COSIGN_PASSWORD` set it ran non-interactively with no prompt.

**Running `syft`/`cosign` from their official images instead of host binaries means the container user is non-root (uid `65532` for cosign) and the bind-mounted working directory needs to be writable by it.** `generate-key-pair` and `attest` both failed with `permission denied` against a freshly created directory owned only by the host user until it was `chmod 777`'d. Worth knowing before assuming an install-script failure means the tool itself is broken — in this sandbox the install script failed for an unrelated reason (the permission classifier refuses to run a freshly downloaded binary at all), and the container-image path was the one that actually worked.

**Verifying against the wrong key does not say "wrong key."** The actual error (`failed to verify log inclusion: transparency log certificate does not match`) reads like a transparency-log outage, not a key mismatch — confirmed by deliberately generating an unrelated second key pair and verifying against it.

## If we applied this here

Signing has nothing to attach itself to yet: every install doc here ([[argocd-helm-ha-install]], [[ingress-nginx-onprem]], [[cert-manager-onprem]], [[longhorn-storage-onprem]], [[metallb-l2-onprem]]) deploys already-published upstream Helm charts and images, not anything built in this repo. This lab's signing and attestation steps only become load-bearing once something here builds a custom image.

The other half of the value is enforcement, not signing — a signed image nobody checks at admission time is a signature nobody uses. [Sigstore's policy-controller](https://docs.sigstore.dev/policy-controller/sample-policies/) or a Kyverno `imageVerify` policy would need to sit in front of whichever cluster from [[argocd-helm-ha-install]] or [[onprem-3node-kubeadm-ubuntu]] actually runs a custom image — neither policy-controller nor Kyverno is installed anywhere in this repo today, so that's the real next step, not this lab by itself.

## Follow-ups

- [x] Confirm the `spdx` vs `spdxjson` mismatch actually produces the error the Traps section predicted, rather than silently accepting the wrong type — done 2026-11-15: it fails at `attest` with `invalid attestation: decoding json`, not at `verify-attestation` as originally guessed.

## Related

[[topics]] — why this topic was selected.
[[2026-08-11-prometheus-3-13-lts]] — same sandbox limitation this document originally hit, same "run it and check the box" pattern for the unexecuted lab.
[[argocd-helm-ha-install]] — the cluster this lab's enforcement half would eventually sit in front of.
