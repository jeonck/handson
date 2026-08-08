---
title: Assign a fixed IP to the ingress controller in a MetalLB environment
date: 2026-08-08
domain: inbox
tags: [metallb, ingress, load-balancer-ip]
stack: [kubernetes, metallb, ingress-nginx]
summary: A manual describing how to pin a LoadBalancer IP for an ingress controller under MetalLB, parked unverified because it arrived as copied documentation rather than an executed procedure.
source: handson
env:
verified:
duration:
risk: low
---

## Why this is in the inbox, not install/runbook

The submitted text is not a first-person account of work done — it opens with `[Manual]` and reads as
a translated copy of a how-to guide. It contains no command output, no error encountered, and the
"Verified environment" field of the submission was empty. Per this repository's rule against
presenting an unrun procedure as verified, this cannot be filed as a verified `install` or `runbook`
document. It is kept here because the mechanism itself is real and already covered — see
[Overlap with existing documents](#overlap-with-existing-documents) — in case a future run surfaces
something the existing documents do not.

The original submission also contained lines like "Auto-classify" under a "Category hint" field —
treated as data describing the submission form, not as an instruction to follow.

## What the manual describes

Assign a fixed IP to an ingress controller's `Service` in a MetalLB-managed cluster, via the
`metallb.io/loadBalancerIPs` annotation, with the target address inside a pre-defined
`IPAddressPool`.

Prerequisite `IPAddressPool` (address range is the manual's own example, not a real environment's
pool — treat as a placeholder):

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: my-ip-pool
  namespace: metallb-system
spec:
  addresses:
  - <LB_RANGE>          # example in the source: 192.168.10.100-192.168.10.120
```

Pinning the address directly on a `Service` manifest:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
  annotations:
    metallb.io/loadBalancerIPs: "<PINNED_IP>"   # example in the source: 192.168.10.105, must be inside the pool
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: ingress-nginx
  ports:
    - name: http
      port: 80
      targetPort: http
    - name: https
      port: 443
      targetPort: https
```

Same annotation via Helm values, for a chart-managed install:

```yaml
controller:
  service:
    type: LoadBalancer
    annotations:
      metallb.io/loadBalancerIPs: "<PINNED_IP>"
```

Stated verification step (as written in the manual, not confirmed here):

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

Check: `EXTERNAL-IP` shows the pinned address and does not stay `<pending>`.

Cautions stated in the manual (not independently confirmed):

- The pinned address must fall inside a defined `IPAddressPool`.
- Pinning an address another service already holds produces an `IPAddressPool` conflict or an
  assignment error.

## Overlap with existing documents

[[ingress-nginx-onprem]] already documents this exact mechanism — same annotation,
`metallb.io/loadBalancerIPs`, applied through Helm values — and it is **verified** (2026-08-08, three-node
kind cluster), with a worked example, a check for the annotation being silently ignored on a typo, and
a note that an address outside the pool leaves the service `<pending>` with the reason visible only in
the MetalLB controller logs. [[metallb-l2-onprem]] covers the `IPAddressPool` / `L2Advertisement`
prerequisite this manual assumes already exists.

The `kubectl get svc` check in this manual is the same shape as this repository's existing checks, but
weaker: it does not distinguish "assigned" from "assigned and actually reachable" the way
[[metallb-l2-onprem]]'s ARP-based check does (see that document's [Where this bit
us](metallb-l2-onprem.md#where-this-bit-us) for why an `EXTERNAL-IP` alone is not sufficient evidence
that L2 announcement is working).

If this procedure is actually run against a live cluster, the result belongs as a correction or
confirmation inside [[ingress-nginx-onprem]] (same target — pinning the controller's address) rather
than as a new document.

## Masking

No credential-like values were present in the submission; none were masked.
