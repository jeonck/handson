---
title: Pin a fixed IP to a LoadBalancer service in a MetalLB environment
date: 2026-08-08
domain: runbook
tags: [networking, metallb, load-balancer]
stack: [kubernetes, metallb, kubectl]
summary: Give a "type: LoadBalancer" service — an ingress controller or any other — a fixed address from a MetalLB pool via annotation, instead of leaving assignment to chance.
source: handson
env: 
verified: 
duration: 
risk: low
---

> **Not yet run.** This procedure was transcribed from a manual supplied as input, not executed
> against a cluster — there is no command output, no observed failure, and no environment to record.
> `env` and `verified` are left empty on purpose; fill them in once someone actually carries this out.
> The annotation itself matches the one already verified in [[ingress-nginx-onprem]] (step 1, pinning
> the ingress controller's own address), which is the closest first-hand confirmation this document has.

By default MetalLB hands a `type: LoadBalancer` service the next free address in its pool. That is fine
for a service nobody points DNS at, but recreating the service — a chart upgrade, a namespace
rebuild — can hand it a different address next time, and every record pointing at the old one goes
stale. Pinning fixes the address to the service definition instead of to chance.

Assumes MetalLB is installed and an `IPAddressPool` already exists — see [[metallb-l2-onprem]].

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| MetalLB installed and assigning addresses | `kubectl -n metallb-system get pods` | controller and speakers `Running` |
| An `IPAddressPool` covering the address you want | `kubectl -n metallb-system get ipaddresspool -o yaml` | the target address falls inside a listed range |
| The target address is not already claimed | `kubectl get svc -A -o jsonpath='{range .items[?(@.status.loadBalancer.ingress)]}{.status.loadBalancer.ingress[0].ip}{"\t"}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'` | the address does not appear in the list |

## 1. Annotate the service

The old `spec.loadBalancerIP` field is deprecated; MetalLB reads the address from an annotation
instead.

```yaml title="service.yaml"
apiVersion: v1
kind: Service
metadata:
  name: <SERVICE_NAME>
  namespace: <NAMESPACE>
  annotations:
    metallb.io/loadBalancerIPs: "<FIXED_IP>"   # must be inside an existing IPAddressPool range
spec:
  type: LoadBalancer
  selector:
    <SELECTOR_KEY>: <SELECTOR_VALUE>
  ports:
    - name: http
      port: 80
      targetPort: http
```

```bash
kubectl apply -f service.yaml
```

For a Helm-managed service (an ingress controller, for example), set the same annotation under its
`service` values block rather than editing the rendered manifest:

```yaml title="values.yaml"
controller:
  service:
    type: LoadBalancer
    annotations:
      metallb.io/loadBalancerIPs: "<FIXED_IP>"
```

An unrecognized annotation key is silently ignored rather than rejected — a typo here does not error,
it just leaves the service on a random address. Check the applied annotation, not only the manifest
you wrote:

```bash
kubectl get svc -n <NAMESPACE> <SERVICE_NAME> -o jsonpath='{.metadata.annotations}' 
```

## 2. Confirm the assignment

```bash
kubectl get svc -n <NAMESPACE> <SERVICE_NAME>
```

`EXTERNAL-IP` must read exactly `<FIXED_IP>`. Two ways this step reads as success without being one:

- **Still `<pending>` after a minute** — the address is outside every `IPAddressPool` range, or it is
  already held by another service. The reason is in the service's events, not in `kubectl get`:

  ```bash
  kubectl describe svc -n <NAMESPACE> <SERVICE_NAME> | tail -20
  ```

  A second service requesting an address already assigned elsewhere produces an `AssignmentError`
  event on the newer request — the pool is not corrupted, the address is just taken.

- **A different address than the one you asked for** — the annotation key was misspelled or landed
  in the wrong block (a second `service:` key in Helm values overwrites the first rather than
  merging). `EXTERNAL-IP` showing *any* address is not the check; it has to be the address you named.

## Rollback

Remove the annotation and re-apply. MetalLB releases the pinned address and assigns the next free one
from the pool — the service does not go back to `<pending>` unless the pool itself is exhausted.

```bash
kubectl annotate svc -n <NAMESPACE> <SERVICE_NAME> metallb.io/loadBalancerIPs-
```

Anything that had the old fixed address recorded (DNS, `/etc/hosts`, firewall rules) now points at a
service with a different one — update those before removing the annotation on anything already in use.

## Verification checklist

- [ ] `kubectl get svc -n <NAMESPACE> <SERVICE_NAME>` shows `EXTERNAL-IP` equal to `<FIXED_IP>` exactly, not merely non-`<pending>`
- [ ] `<FIXED_IP>` falls inside a range listed by `kubectl get ipaddresspool -o yaml`
- [ ] `kubectl describe svc` carries no `AssignmentError` event
- [ ] Re-running `kubectl apply` on the same manifest keeps the same `EXTERNAL-IP` (proves the pin survived a reconcile, not just the first assignment)

## Follow-ups

- [ ] Run this end to end against a real MetalLB pool, record the actual `AssignmentError` message and how long assignment takes, and fill in `env`/`verified`
- [ ] Check whether the same trap noted in [[ingress-nginx-onprem]] — a duplicate `service:` key in Helm values silently overwriting the pinned annotation — reproduces here for a non-ingress service

## Related

[[metallb-l2-onprem]] — installs MetalLB and the `IPAddressPool` this procedure pins into.
[[ingress-nginx-onprem]] — the same annotation, verified, pinning an ingress controller specifically, with the replica/topology considerations that come with it.
