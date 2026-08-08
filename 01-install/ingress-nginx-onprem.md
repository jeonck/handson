---
title: ingress-nginx on one LAN address — HTTP routing for an on-prem cluster
date: 2026-08-07
domain: install
tags: [on-prem, networking, ingress]
stack: [kubernetes, ingress-nginx, helm, metallb, kubectl]
summary: Put one LoadBalancer address in front of every HTTP service instead of burning an address per service, with TLS terminated in one place. Preserving the real client IP is what makes this harder than the quickstart suggests.
source: handson
env: Target — Kubernetes 1.31 (kubeadm, on-prem) · ingress-nginx chart 4.11 · MetalLB 0.14 · Ubuntu 24.04 LTS
verified:
duration: 25–40 min
risk: medium
---

> ⚠️ **This procedure has not been executed in this environment yet.** It is assembled from upstream
> ingress-nginx and MetalLB documentation, so `verified` is empty and the site lists it as needing
> verification. Run it once on the real cluster, then fill in `verified` and correct whatever was wrong.

With [[metallb-l2-onprem]] in place, every `type: LoadBalancer` service takes an address from a pool that has maybe ten of them. Ten services and you are out, and each one needs its own DNS record and its own certificate. An ingress controller collapses that: **one address, one certificate story, host and path routing behind it.**

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]] with MetalLB working.

> **Check the project's status before standardising on it.** The ingress-nginx maintainers have
> announced an end to maintenance, with Gateway API implementations as the direction the ecosystem is
> moving — see [[2026-08-07-gateway-api]] and the [project repository](https://github.com/kubernetes/ingress-nginx)
> for where that stands today. It remains the most widely deployed controller and everything below
> still applies, but if this cluster is being built to last, read that note before committing.

## What you get, and what you give up

| | Per-service LoadBalancer | Behind an ingress |
|---|---|---|
| LAN addresses used | one per service | one, total |
| DNS records | one per service | one wildcard, or one per host |
| TLS | terminated per service | terminated once, at the controller |
| Non-HTTP protocols | any | HTTP/HTTPS only (TCP/UDP needs extra config) |
| Failure blast radius | one service | every HTTP service at once |

That last row is the real trade. The ingress controller becomes a single point of failure for all HTTP traffic, which is why the controller runs with more than one replica below.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| MetalLB assigning addresses | `kubectl get svc -A --field-selector spec.type=LoadBalancer` | earlier test got an `EXTERNAL-IP` |
| A free address in the pool | your reservation notes | one address set aside for ingress |
| Helm | `helm version --short` | v3.x |
| DNS you can point at it | see below | a wildcard record, or `/etc/hosts` for testing |

### Decide the hostname scheme now

Ingress routes on the `Host` header, so names have to resolve to the ingress address before anything works. Pick one of these and set it up before installing:

- **Wildcard DNS** — `*.apps.<DOMAIN>` → `<INGRESS_IP>`. One record covers every future service. This is the one to want.
- **Per-host records** — fine at small numbers, tedious past a handful.
- **`/etc/hosts` on your workstation** — testing only. It proves the routing works and nothing else, since nobody else on the LAN can reach it.

This document uses `<INGRESS_IP>` = `192.168.1.240` and hostnames under `apps.<DOMAIN>`.

## 1. Pin the ingress address

Let MetalLB assign randomly and the address changes the next time the service is recreated — after which every DNS record points at nothing. Pin it.

The old `spec.loadBalancerIP` field is deprecated in Kubernetes; MetalLB reads an annotation instead:

```yaml
# values-ingress.yaml
controller:
  service:
    type: LoadBalancer
    annotations:
      metallb.io/loadBalancerIPs: 192.168.1.240      # <INGRESS_IP>, inside the MetalLB pool
    # Keeps the real client IP. See section 4 — this interacts with MetalLB L2.
    # Everything about the service goes in this one block; a second `service:`
    # key silently overwrites the first, and the pinned address disappears with it.
    externalTrafficPolicy: Local

  # Two replicas so a node reboot does not take all HTTP traffic with it,
  # spread across nodes rather than doubled up on one.
  replicaCount: 2
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
          app.kubernetes.io/component: controller

  ingressClassResource:
    name: nginx
    enabled: true
    default: true          # Ingress objects without ingressClassName land here

  # Sane defaults for real applications rather than a demo.
  config:
    proxy-body-size: "50m"          # default is 1m; file uploads fail at 413 without this
    proxy-read-timeout: "60"
    proxy-send-timeout: "60"
    use-forwarded-headers: "false"  # only true if something trusted sits in front

  metrics:
    enabled: true          # Prometheus can scrape it later; costs nothing now
```

The address must be **inside** the MetalLB pool defined in [[metallb-l2-onprem]]. An address outside it is ignored and the service stays `<pending>`, with the reason only visible in the MetalLB controller logs.

## 2. Install

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update ingress-nginx
```

```bash
helm search repo ingress-nginx/ingress-nginx --versions | head -5
```

Pin the chart version and record it in this document's `env`, for the same reason as every other chart in this repository — an unpinned upgrade months later arrives on its own schedule.

```bash
export INGRESS_CHART_VERSION=4.11.3
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --version "$INGRESS_CHART_VERSION" \
  --values values-ingress.yaml \
  --wait --timeout 5m
```

```bash
kubectl -n ingress-nginx get pods -o wide
kubectl -n ingress-nginx get svc ingress-nginx-controller
```

`EXTERNAL-IP` must show exactly the address you pinned. If it shows a different one, the annotation did not apply — check spelling, since an unknown annotation is silently ignored rather than rejected.

```bash
kubectl get ingressclass
```

`nginx (default)` should appear. **Only one IngressClass may be default.** With two, Ingress objects that omit `ingressClassName` are handled unpredictably:

```bash
kubectl get ingressclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class}{"\n"}{end}'
```

## 3. Route a real service

```bash
kubectl create deployment demo --image=nginxdemos/hello:plain-text --replicas=2
kubectl expose deployment demo --port=80
```

Note the service is **ClusterIP** — that is the point. It never takes a LAN address of its own.

```yaml
# demo-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo
spec:
  ingressClassName: nginx        # explicit, even though nginx is the default
  rules:
    - host: demo.apps.<DOMAIN>
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: demo
                port:
                  number: 80
```

```bash
kubectl apply -f demo-ingress.yaml
kubectl get ingress demo
```

The `ADDRESS` column fills in with `<INGRESS_IP>` once the controller has picked up the object. Empty after a minute means the controller is not watching this Ingress — almost always a class mismatch:

```bash
kubectl describe ingress demo | tail -20
kubectl -n ingress-nginx logs deployment/ingress-nginx-controller --tail=50
```

Test from the LAN, not from a pod:

```bash
# without DNS yet — prove routing works first
curl -s -H 'Host: demo.apps.<DOMAIN>' http://192.168.1.240/ | head -5
```

```bash
# with DNS or /etc/hosts in place
curl -s http://demo.apps.<DOMAIN>/ | head -5
```

A `404 Not Found` from nginx means the controller answered but no rule matched the `Host` header — the host in the request and the host in the Ingress are not the same string. A connection refused or a timeout is a MetalLB or firewall problem, not an ingress one.

## 4. externalTrafficPolicy and the client IP

This is where the on-prem case diverges from the tutorials, and it is worth understanding rather than copying.

With `externalTrafficPolicy: Cluster` (the default), any node can receive the traffic and forward it on, but the source IP is rewritten — applications behind the ingress see the node address, so rate limiting, audit logs, and IP allow-lists all break quietly.

With `Local`, the client IP survives. The cost: traffic is only served by controller pods **on the node holding the address**. MetalLB understands this and only announces the address from nodes that have a ready endpoint, so it works — but if the controller has one replica and it is not on the announcing node, nothing answers.

Which is why `replicaCount: 2` with a spread constraint is in the values above. Verify both facts:

```bash
kubectl -n ingress-nginx get pods -o wide      # replicas on different nodes
```

```bash
curl -s -H 'Host: demo.apps.<DOMAIN>' http://192.168.1.240/ | grep -i 'client address\|server address'
```

The demo image prints the client address it sees. It should be your workstation's LAN address, not a node's.

On a three-node cluster, running the controller as a DaemonSet is also reasonable — every node can then serve, and the announcing node always has a local endpoint. That trades a little memory on each node for one less failure mode.

## 5. TLS

Out of the box the controller serves a self-signed certificate, so browsers warn on every host. Two paths from here:

**A cluster-wide default certificate** — one wildcard cert for `*.apps.<DOMAIN>`, loaded once:

```bash
kubectl -n ingress-nginx create secret tls wildcard-apps \
  --cert=<PATH_TO_FULLCHAIN> --key=<PATH_TO_KEY>
```

```bash
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --version "$INGRESS_CHART_VERSION" \
  --values values-ingress.yaml \
  --set controller.extraArgs.default-ssl-certificate=ingress-nginx/wildcard-apps \
  --wait
```

**Per-ingress certificates** — a `tls` block on each Ingress referencing a secret in that namespace:

```yaml
spec:
  tls:
    - hosts: [demo.apps.<DOMAIN>]
      secretName: demo-tls
```

Getting the certificates themselves is the real work on-prem, where hosts are not publicly resolvable so HTTP-01 validation cannot reach them. That means cert-manager with either a DNS-01 solver or an internal CA — a separate document, left as a follow-up rather than half-covered here.

## Verification checklist

- [ ] `kubectl -n ingress-nginx get pods -o wide` — 2 replicas, `Running`, on different nodes
- [ ] `kubectl -n ingress-nginx get svc ingress-nginx-controller` — `EXTERNAL-IP` is exactly the pinned address
- [ ] `kubectl get ingressclass` — `nginx (default)`, and it is the only default
- [ ] An Ingress object gets `<INGRESS_IP>` in its `ADDRESS` column
- [ ] `curl` with the right `Host` header returns the application from the LAN
- [ ] The application sees the **client's** IP, not a node's
- [ ] A wrong `Host` returns nginx's 404, not a connection failure (proves the controller is answering)
- [ ] Delete one controller pod — traffic continues through the other replica
- [ ] Reboot the node holding the address — the address moves and traffic recovers
- [ ] The backing service is still `ClusterIP`, holding no LAN address of its own

## Rollback

```bash
kubectl delete -f demo-ingress.yaml
kubectl delete service demo
kubectl delete deployment demo
```

```bash
helm uninstall ingress-nginx -n ingress-nginx
kubectl delete namespace ingress-nginx
```

The LAN address returns to the MetalLB pool. **Ingress objects elsewhere in the cluster survive the uninstall** and simply stop being served — they show an empty `ADDRESS` and every host stops resolving to anything useful. Check what would break before removing the controller:

```bash
kubectl get ingress -A
```

If the IngressClass was default and another controller is expected to take over, note that existing Ingress objects with an explicit `ingressClassName: nginx` will not move on their own.

## Failure points documented upstream

**This is not "where this bit us" — nobody has run this here yet.** These come from the ingress-nginx and MetalLB documentation. Replace them with what actually happened on your first run.

**Two default IngressClasses** — Ingress objects without an explicit class are handled by whichever controller reacts, which changes between restarts. Section 2.

**`kubernetes.io/ingress.class` annotation** — the old annotation is removed in current controller versions. Copy an Ingress from an old blog post and it is simply never picked up, with no error anywhere. Use `spec.ingressClassName`.

**413 on upload** — `proxy-body-size` defaults to 1m. The failure surfaces as a broken upload button in an application nobody suspects. Set in the values above. ([ingress-nginx ConfigMap reference](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/))

**`externalTrafficPolicy: Local` with a single replica** — the address lands on a node with no controller pod and nothing answers, intermittently, depending on which node MetalLB elected. Section 4.

**Snippet annotations rejected** — `nginx.ingress.kubernetes.io/configuration-snippet` is disabled by default in recent versions after a set of CVEs. Enabling it re-opens that class of risk; prefer a supported annotation or a ConfigMap setting. ([Annotations reference](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/))

**gRPC backends** — plain HTTP proxying breaks gRPC. The service needs `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"`, which is the same problem hit in [[argocd-helm-ha-install]] and worth reading before exposing Argo CD through this controller.

**Ingress in a different namespace from its service** — an Ingress can only reference a service in its own namespace, and a TLS secret must live there too. A cross-namespace reference fails silently.

## Follow-ups

- [ ] Run this on the real cluster, correct it, and set `verified`
- [ ] Set up cert-manager with a DNS-01 solver or an internal CA — on-prem hosts cannot be validated over HTTP-01
- [ ] Create the wildcard DNS record so hostnames work for everyone, not just workstations with an edited hosts file
- [ ] Move Argo CD from its own LoadBalancer address to a host behind this controller, gRPC path included
- [ ] Decide whether the controller should be a DaemonSet on a three-node cluster
- [ ] Read the ingress-nginx maintenance status and decide whether new services should target Gateway API instead

## Related

[[metallb-l2-onprem]] — supplies the address this controller holds. This document answers the "one address for an ingress instead of one per service" follow-up left open there.
[[onprem-3node-kubeadm-ubuntu]] — the cluster underneath.
[[argocd-helm-ha-install]] — the first real candidate to move behind this, and the source of the gRPC trap above.
[[2026-08-07-gateway-api]] — where this layer is heading, and worth reading before standardising on ingress-nginx.
[[pod-crashloopbackoff]] — if the controller pods will not start.
