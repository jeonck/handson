---
title: Topic of the day — from Ingress to Gateway API, a 30-minute lab on kind
date: 2026-08-07
domain: daily
tags: [daily, networking]
stack: [kubernetes, gateway-api, kind, envoy]
summary: The Ingress API is feature-frozen and Gateway API is the successor. Stand up GatewayClass, Gateway, and HTTPRoute on a kind cluster and see what actually bites when swapping ingress controllers.
source: daily-topic
---

## Why this topic

Kubernetes' `networking.k8s.io/v1 Ingress` is **feature-frozen**. New capability does not land there; SIG-Network has been building Gateway API as the successor. Gateway API ships as its own CRDs and releases independently of Kubernetes core.

The important difference is not features — it is **role separation**. Ingress packs infrastructure settings (TLS, LB class) and application routing (path → service) into one object, so cluster admins and service teams collide on the same resource. Gateway API splits that three ways.

| Resource | Owner | Holds |
|---|---|---|
| `GatewayClass` | infrastructure provider | which controller implementation backs this |
| `Gateway` | cluster admin | listeners, ports, TLS, which namespaces may attach routes |
| `HTTPRoute` | service team | host/path → backend service, weights, header manipulation |

Everything that used to be crammed into vendor annotations — canary weights, header-based routing, redirects — is a typed field here. A typo that nobody warned you about now fails schema validation.

- Reference: [Gateway API docs](https://gateway-api.sigs.k8s.io/) · [how it differs from Ingress](https://gateway-api.sigs.k8s.io/concepts/api-overview/)

## 30-minute lab — kind + NGINX Gateway Fabric

A minimal end-to-end example on a local kind cluster. Do not run this on a production cluster.

### 1. Cluster

```bash
cat <<'EOF' > kind-gw.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080
        hostPort: 8080
        protocol: TCP
EOF
kind create cluster --name gw --config kind-gw.yaml
```

### 2. CRDs

Gateway API is not in core. **Install the CRDs first** or every manifest below fails with `no matches for kind "Gateway"`.

```bash
# standard channel CRDs (GatewayClass, Gateway, HTTPRoute)
kubectl kustomize "https://github.com/kubernetes-sigs/gateway-api/config/crd/standard?ref=v1.2.0" | kubectl apply -f -
kubectl get crd | grep gateway
```

Pin the version in `ref=`. Current tags are on the [releases page](https://github.com/kubernetes-sigs/gateway-api/releases).

### 3. Controller

CRDs alone do nothing — you need an implementation. This lab uses NGINX Gateway Fabric; Envoy Gateway, Istio, Cilium, and Traefik implement the same API.

```bash
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  --create-namespace -n nginx-gateway \
  --set service.type=NodePort \
  --set service.ports[0].port=80 \
  --set service.ports[0].nodePort=30080

kubectl -n nginx-gateway get pods
kubectl get gatewayclass
```

`GatewayClass` showing `ACCEPTED=True` means the controller has claimed its class.

### 4. Gateway and HTTPRoute

```yaml title="gw.yaml"
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shared
  namespace: default
spec:
  gatewayClassName: nginx
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All          # which namespaces may attach routes — the admin's call
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo
  namespace: default
spec:
  parentRefs:
    - name: shared
  hostnames:
    - "demo.local"
  rules:
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: demo
          port: 80
```

```bash
kubectl create deployment demo --image=nginxdemos/hello:plain-text
kubectl expose deployment demo --port=80
kubectl apply -f gw.yaml
```

### 5. Verify

```bash
kubectl get gateway shared -o jsonpath='{.status.conditions[*].type}{"\n"}'
kubectl get httproute demo -o jsonpath='{.status.parents[0].conditions[*].type}{"\n"}'
curl -s -H 'Host: demo.local' http://localhost:8080/ | head -3
```

Expected: Gateway `Accepted`/`Programmed`, HTTPRoute `Accepted`/`ResolvedRefs`, and the nginx demo response from curl.

### 6. Traffic splitting, without annotations

A canary on Ingress meant memorising three vendor-specific annotations. Here it is a field.

```yaml
    - backendRefs:
        - name: demo
          port: 80
          weight: 90
        - name: demo-next
          port: 80
          weight: 10
```

### Clean up

```bash
kind delete cluster --name gw
```

## Traps

**Mixing up CRD channels** — `standard` carries GatewayClass, Gateway, and HTTPRoute; `experimental` adds TCPRoute, TLSRoute, and others. Following a tutorial that uses an `experimental` example against `standard` CRDs ends in an unrecognised kind.

**CRDs without a controller** — the manifests apply cleanly and no traffic moves. An empty `PROGRAMMED` column on `kubectl get gateway` is the tell.

**No namespace boundary** — `allowedRoutes.namespaces.from: All` is a lab setting. In production, without a label `Selector`, any team can attach their hostname to somebody else's gateway.

**Ignoring route status** — an HTTPRoute can exist while `ResolvedRefs: False` because the backend service name is wrong. That information was invisible to `kubectl describe ingress`; here it is explicit in status.

## If we applied this here

- Leave everything currently behind ingress-nginx alone (including [[argocd-helm-ha-install]]) and take **new services only** through Gateway API. The two controllers get separate load balancers, so the DNS cutover needs its own plan.
- The `ingress2gateway` conversion tool exists, but annotation-driven configuration does not convert automatically. A human has to read the diff.
- If canaries run through Argo Rollouts, confirm its Gateway API traffic-routing support first. A mismatch there blocks the whole delivery pipeline.

## Follow-ups

- [ ] Put Gateway API CRDs and one controller on staging and route a single new service through it 📅 2026-08-21
- [ ] Inventory current ingress-nginx annotation usage to size the conversion effort

## Related

[[argocd-helm-ha-install]] — the first thing exposed through an ingress here. Re-check the gRPC path when moving it to a gateway.
[[topics]] — why this topic was selected.
