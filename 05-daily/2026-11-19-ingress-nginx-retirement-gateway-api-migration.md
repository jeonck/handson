---
title: Topic of the day — ingress-nginx is now actually retired, migrating one real route to Envoy Gateway
date: 2026-11-19
domain: daily
tags: [daily, networking]
stack: [kubernetes, ingress-nginx, gateway-api, envoy-gateway, kind]
summary: kubernetes/ingress-nginx is confirmed archived with no releases since 2026-03-19 — not "announced", actually done. Took the exact demo-ingress.yaml route from this repo's own install doc and moved it to Envoy Gateway, where the wrong-host check still passes but a body-size default that happens to match nginx's is enforced by a completely different mechanism.
source: daily-topic
env: kind v0.33.0, node image kindest/node:v1.37.0 · Envoy Gateway v1.10.0 (Helm chart oci://docker.io/envoyproxy/gateway-helm) · Gateway API CRDs installed by that same chart
verified: 2026-11-19
---

## Why this topic

[[ingress-nginx-onprem]] — this repository's own install guide for ingress-nginx — already carries a banner: *"The ingress-nginx maintainers have announced an end to maintenance... see the project repository for where that stands today."* Written 2026-08-07, that banner is now four months stale and understates the situation: "announced" reads like it might still be pending.

It is not pending. Checked directly against the GitHub API in this run, not a blog post:

```bash
curl -s https://api.github.com/repos/kubernetes/ingress-nginx | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('archived:', d['archived']); print('pushed_at:', d['pushed_at'])"
```

Observed:

```
archived: True
pushed_at: 2026-03-23T16:16:29Z
```

```bash
curl -s https://api.github.com/repos/kubernetes/ingress-nginx/releases | python3 -c "
import json,sys
for r in json.load(sys.stdin)[:3]: print(r['tag_name'], r['published_at'])"
```

```
helm-chart-4.15.1 2026-03-19T21:16:16Z
helm-chart-4.14.5 2026-03-19T21:11:07Z
controller-v1.15.1 2026-03-19T21:17:55Z
```

The repo is archived (read-only) and the last releases are dated 2026-03-19, eight months before this run. The retirement itself was announced 2025-11-11 and confirmed by the Kubernetes Steering and Security Response Committees on 2026-01-29 ([statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)), with the committees naming the replacement direction explicitly: *"the responsible choice is to wind it down and refocus efforts on modern alternatives like Gateway API... None of the available alternatives are direct drop-in replacements."* That last sentence is why this lab migrates one real route rather than just confirming the archive date.

[[2026-08-07-gateway-api]], the earlier daily doc on this repository's stack, left two follow-ups open: *"Put Gateway API CRDs and one controller on staging and route a single new service through it"* and *"Inventory current ingress-nginx annotation usage to size the conversion effort."* It used NGINX Gateway Fabric as the controller. This lab uses a second implementation — **Envoy Gateway v1.10.0**, [current release](https://github.com/envoyproxy/gateway/releases) per its own release page — specifically so a reader comparing the two sees what is controller-specific versus what Gateway API itself guarantees.

## 30-minute lab

### 1. Cluster and Gateway API controller

```bash
kind create cluster --name ingress-migrate
```

Envoy Gateway's own [quickstart](https://gateway.envoyproxy.io/docs/tasks/quickstart/) installs the Gateway API CRDs as part of the same Helm chart — no separate `kubectl apply` of CRDs needed, unlike the NGINX Gateway Fabric lab:

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.10.0 \
  -n envoy-gateway-system --create-namespace
kubectl wait --timeout=5m -n envoy-gateway-system deployment/envoy-gateway --for=condition=Available
```

### 2. The exact route from [[ingress-nginx-onprem]], as Gateway API

[[ingress-nginx-onprem]]'s `demo-ingress.yaml` is a `networking.k8s.io/v1 Ingress` routing `demo.apps.<DOMAIN>` to a `ClusterIP` service on port 80. Same backend, same host-routing intent, as `GatewayClass` + `Gateway` + `HTTPRoute`:

```bash
kubectl create deployment demo --image=nginxdemos/hello:plain-text --replicas=2
kubectl expose deployment demo --port=80
```

```yaml title="gw.yaml"
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: eg
  namespace: default
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo
  namespace: default
spec:
  parentRefs:
    - name: eg
  hostnames:
    - "demo.apps.example.com"
  rules:
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: demo
          port: 80
```

```bash
kubectl apply -f gw.yaml
```

### 3. Verify

```bash
kubectl get gatewayclass
kubectl get gateway eg
kubectl get httproute demo -o jsonpath='{.status.parents[0].conditions[*].type}{" "}{.status.parents[0].conditions[*].status}{"\n"}'
```

Observed:

```
NAME   CONTROLLER                                      ACCEPTED   AGE
eg     gateway.envoyproxy.io/gatewayclass-controller   True       12s

NAME   CLASS   ADDRESS   PROGRAMMED   AGE
eg     eg                False        13s

Accepted ResolvedRefs True True
```

**`PROGRAMMED: False` on the Gateway looks like a failure and is not one here** — kind has no `LoadBalancer` implementation, so the address never fills in, exactly the same gap [[metallb-l2-onprem]] exists to close for ingress-nginx. The `HTTPRoute`'s own status — `Accepted: True`, `ResolvedRefs: True` — is the condition that actually says the route is wired up; `PROGRAMMED` on the `Gateway` is reporting the address, a separate fact. Route traffic through it without an external address with `kubectl port-forward`, the same escape hatch the official quickstart documents for exactly this case:

```bash
kubectl -n envoy-gateway-system port-forward service/envoy-default-eg-e41e7b31 8888:80 &
curl -s -H 'Host: demo.apps.example.com' http://localhost:8888/
```

Observed: `HTTP/1.1 200 OK`, body from `nginxdemos/hello:plain-text` with `Server name: demo-5fc87ff9cd-n4svw` — routing works end to end. (The exact service name `envoy-default-eg-e41e7b31` is generated per-Gateway; find it with `kubectl get svc -n envoy-gateway-system --selector=gateway.envoyproxy.io/owning-gateway-namespace=default,gateway.envoyproxy.io/owning-gateway-name=eg -o jsonpath='{.items[0].metadata.name}'` rather than hardcoding it.)

The wrong-host check [[ingress-nginx-onprem]] uses to prove the controller is answering at all still applies, with a different body:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H 'Host: wrong.example.com' http://localhost:8888/
```

Observed: `404`, empty body — Envoy's generic 404, not nginx's styled one, but the same signal: the proxy answered and no rule matched.

### Clean up

```bash
kubectl delete -f gw.yaml
helm uninstall eg -n envoy-gateway-system
kind delete cluster --name ingress-migrate
```

## Traps

**The body-size default moved to a different mechanism, and it happens to land on the same number.** [[ingress-nginx-onprem]] names `proxy-body-size` (nginx default `1m` = 1,048,576 bytes) as a trap that breaks uploads silently. Posting bodies of increasing size to the Envoy Gateway route above and watching the status code:

```bash
for sz in 900000 1048576 1100000; do
  head -c $sz /dev/zero > /tmp/b.bin
  curl -s -o /dev/null -w "$sz bytes -> %{http_code}\n" -H 'Host: demo.apps.example.com' --data-binary @/tmp/b.bin http://localhost:8888/
done
```

Observed:

```
900000 bytes -> 200
1048576 bytes -> 200
1100000 bytes -> 413
```

The cutoff sits at exactly 1 MiB — the same number as nginx's default, by coincidence, not by design: this is Envoy's connection buffer behavior, not a `proxy-body-size`-equivalent setting anyone configured. **The oversized request also kills the `port-forward` tunnel** (`write: connection reset by peer`) — a failed large upload takes the whole local test session down with it, not just the one request; restart the port-forward before the next check. Per the [Envoy Gateway API reference](https://gateway.envoyproxy.io/docs/api/extension_types/#clienttrafficpolicyspec), raising this limit is `BackendTrafficPolicy.spec.requestBuffer`, documented as: "A request whose buffered body exceeds the configured limit is rejected with HTTP 413 Content Too Large." **Not verified in this lab** — the observed 413 at 1 MiB confirms the default and the error code the docs describe, but applying `requestBuffer` and re-testing was not run here.

**`PROGRAMMED: False` is the expected state on kind, not a sign anything is broken** — see the Verify section. Reading only the `Gateway`'s own status and not the `HTTPRoute`'s makes a working migration look stuck.

**No CRD-install step, unlike the NGINX Gateway Fabric lab.** [[2026-08-07-gateway-api]] installs the Gateway API CRDs with a separate `kubectl kustomize ... | kubectl apply -f -` before the controller. Envoy Gateway's Helm chart installs both together — running the separate CRD step from that other lab against this one is harmless (same CRDs, same version channel) but is dead weight, and skipping it entirely when following a tutorial built around a different controller is the more likely direction of confusion.

**The gRPC path [[ingress-nginx-onprem]] flags for [[argocd-helm-ha-install]]** — `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"` — has a Gateway API equivalent (`GRPCRoute`, a separate CRD from `HTTPRoute`) that this lab did not exercise. Named here rather than left implicit, per the open follow-up below.

## If we applied this here

- [[ingress-nginx-onprem]]'s banner should be rewritten from "announced an end to maintenance" to "retired, archived 2026-03-23, no patches since controller v1.15.1" — the current wording undersells how settled this already is. That edit belongs to a `handson` pass on that document, not to this one; this daily doc only names it.
- [[argocd-helm-ha-install]], [[cert-manager-onprem]], [[garage-object-storage-onprem]], [[minio-object-storage-onprem]], [[trino-query-engine-onprem]], and [[postgresql-cnpg-onprem]] all list `ingress-nginx` in `stack`. None of them need to change today — an archived image with no CVE fixes pending still runs, as the GitHub API check above shows (frozen, not broken) — but every new document pointing at ingress-nginx from here is pointing at a controller with zero future patches.
- `externalTrafficPolicy: Local` and the ~40-second failover flap [[ingress-nginx-onprem]] measured for ingress-nginx were not re-measured against Envoy Gateway's `LoadBalancer` service in this lab — kind has no real `LoadBalancer` to fail over in the first place. That comparison needs the same on-prem MetalLB setup [[metallb-l2-onprem]] used, not kind.

## Follow-ups

- [ ] Apply a `BackendTrafficPolicy` with `requestBuffer` set above 1 MiB against the route above and confirm the upload that gets a 413 today succeeds 📅 2026-12-03
- [ ] Route the gRPC path from [[argocd-helm-ha-install]] through a `GRPCRoute` on this same Envoy Gateway instance and confirm it survives the migration 📅 2026-12-10

## Related

[[ingress-nginx-onprem]] — the document whose own banner this lab goes and checks against the primary source.
[[2026-08-07-gateway-api]] — the first Gateway API lab in this repository, using NGINX Gateway Fabric instead of Envoy Gateway; its two follow-ups are what this lab acts on.
[[metallb-l2-onprem]] — supplies the real `LoadBalancer` address that would make `PROGRAMMED` actually fill in outside kind.
[[argocd-helm-ha-install]] — the gRPC backend named in Traps, and in [[ingress-nginx-onprem]]'s own trap list before it.
[[topics]] — why this topic was selected.
