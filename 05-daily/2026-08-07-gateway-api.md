---
title: 오늘의 주제 — Ingress에서 Gateway API로, kind에서 30분 실습
date: 2026-08-07
domain: daily
tags: [daily, networking]
stack: [kubernetes, gateway-api, kind, envoy]
summary: Ingress API는 기능이 동결됐고 후속은 Gateway API입니다. kind 클러스터에서 GatewayClass·Gateway·HTTPRoute를 직접 올려 보고, 인그레스 컨트롤러 교체 시 실제로 걸리는 지점을 정리했습니다.
source: daily-topic
---

## 왜 이 주제인가

Kubernetes의 `networking.k8s.io/v1 Ingress`는 **기능 동결(feature-frozen)** 상태입니다. 새 기능은 Ingress에 추가되지 않고, SIG-Network는 후속 API로 Gateway API를 개발해 왔습니다. Gateway API는 별도 CRD로 배포되며 Kubernetes 코어와 독립된 릴리스 주기를 갖습니다.

핵심 차이는 기능이 아니라 **역할 분리**입니다. Ingress는 한 리소스에 인프라 설정(TLS, LB 클래스)과 애플리케이션 라우팅(경로 → 서비스)이 섞여 있어, 클러스터 관리자와 서비스 팀이 같은 오브젝트를 두고 부딪힙니다. Gateway API는 이걸 셋으로 나눕니다.

| 리소스 | 소유자 | 담는 것 |
|---|---|---|
| `GatewayClass` | 인프라 제공자 | 어떤 컨트롤러 구현을 쓰는가 |
| `Gateway` | 클러스터 관리자 | 리스너, 포트, TLS, 어떤 네임스페이스의 Route를 붙일지 |
| `HTTPRoute` | 서비스 팀 | 호스트·경로 → 백엔드 서비스, 가중치, 헤더 조작 |

Ingress에서 벤더 어노테이션으로 우겨넣던 것(카나리 가중치, 헤더 기반 라우팅, 리다이렉트)이 여기서는 API 필드입니다. 어노테이션 문자열에 오타를 내도 아무도 안 알려 주던 문제가 스키마 검증으로 잡힙니다.

- 참고: [Gateway API 공식 문서](https://gateway-api.sigs.k8s.io/) · [Ingress 대비 차이](https://gateway-api.sigs.k8s.io/concepts/api-overview/)

## 30분 실습 — kind + NGINX Gateway Fabric

로컬 kind 클러스터에서 끝까지 돌아가는 최소 예제입니다. 운영 클러스터에서 하지 마세요.

### 1. 클러스터

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

### 2. CRD 설치

Gateway API는 코어에 없습니다. **CRD를 먼저 깔지 않으면** 아래 매니페스트가 전부 `no matches for kind "Gateway"`로 실패합니다.

```bash
# 표준 채널 CRD (GatewayClass, Gateway, HTTPRoute)
kubectl kustomize "https://github.com/kubernetes-sigs/gateway-api/config/crd/standard?ref=v1.2.0" | kubectl apply -f -
kubectl get crd | grep gateway
```

버전은 `ref=` 부분에서 고정합니다. 최신 태그는 [릴리스 목록](https://github.com/kubernetes-sigs/gateway-api/releases)에서 확인하세요.

### 3. 컨트롤러

CRD만으로는 아무 일도 일어나지 않습니다. 구현체가 필요합니다 — 여기서는 NGINX Gateway Fabric을 씁니다. Envoy Gateway, Istio, Cilium, Traefik 모두 같은 API를 구현합니다.

```bash
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  --create-namespace -n nginx-gateway \
  --set service.type=NodePort \
  --set service.ports[0].port=80 \
  --set service.ports[0].nodePort=30080

kubectl -n nginx-gateway get pods
kubectl get gatewayclass
```

`GatewayClass`가 `ACCEPTED=True`로 보이면 컨트롤러가 자기 클래스를 인식한 것입니다.

### 4. Gateway와 HTTPRoute

```yaml
# gw.yaml
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
          from: All          # 어느 네임스페이스의 Route를 붙일지 — 관리자의 결정
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

### 5. 검증

```bash
kubectl get gateway shared -o jsonpath='{.status.conditions[*].type}{"\n"}'
kubectl get httproute demo -o jsonpath='{.status.parents[0].conditions[*].type}{"\n"}'
curl -s -H 'Host: demo.local' http://localhost:8080/ | head -3
```

기대값: Gateway `Accepted`/`Programmed`, HTTPRoute `Accepted`/`ResolvedRefs`, curl에서 nginx demo 응답.

### 6. 트래픽 분할 — 어노테이션 없이

Ingress에서 카나리를 하려면 벤더별 어노테이션 세 개를 외워야 했습니다. 여기서는 필드입니다.

```yaml
    - backendRefs:
        - name: demo
          port: 80
          weight: 90
        - name: demo-next
          port: 80
          weight: 10
```

### 정리

```bash
kind delete cluster --name gw
```

## 함정

**CRD 채널을 헷갈림** — `standard`에는 GatewayClass·Gateway·HTTPRoute가, `experimental`에는 TCPRoute·TLSRoute 등이 들어 있습니다. 실습 문서를 보고 `experimental` 예제를 `standard` CRD 위에서 돌리면 kind 인식 실패로 끝납니다.

**컨트롤러 없이 CRD만 설치** — 매니페스트는 정상 생성되는데 아무 트래픽도 안 흐릅니다. `kubectl get gateway`의 `PROGRAMMED` 컬럼이 비어 있으면 이 경우입니다.

**네임스페이스 경계를 안 정함** — `allowedRoutes.namespaces.from: All`은 실습용입니다. 운영에서는 `Selector`로 라벨을 지정하지 않으면, 아무 팀이나 남의 게이트웨이에 자기 호스트를 붙일 수 있습니다.

**Route 상태를 안 봄** — HTTPRoute가 생성돼도 `ResolvedRefs: False`면 백엔드 서비스 이름이 틀린 것입니다. Ingress 시절 `kubectl describe ingress`로는 안 보이던 정보가 여기서는 status에 명시적으로 나옵니다.

## 우리 환경에 적용한다면

- 지금 ingress-nginx로 노출 중인 것들([[argocd-helm-ha-install]] 포함)은 그대로 두고, **새 서비스부터** Gateway API로 받는 병행 운영이 현실적입니다. 두 컨트롤러가 서로 다른 LB를 갖게 되므로 DNS 전환 계획이 따로 필요합니다.
- `ingress2gateway` 변환 도구가 있지만 어노테이션 기반 설정은 자동 변환되지 않습니다. 변환 결과를 그대로 믿지 말고 diff를 사람이 봐야 합니다.
- 카나리를 Argo Rollouts로 하고 있다면 Gateway API 트래픽 라우팅 지원 여부를 먼저 확인해야 합니다. 이게 안 맞으면 배포 파이프라인 전체가 걸립니다.

## 후속 조치

- [ ] 스테이징에 Gateway API CRD + 컨트롤러 하나 올려 두고 신규 서비스 한 개를 태워 보기 📅 2026-08-21
- [ ] 현재 ingress-nginx 어노테이션 사용 현황 조사 — 변환 난이도 판단용

## 연결

[[argocd-helm-ha-install]] — 인그레스로 노출한 첫 사례. 게이트웨이로 옮길 때 gRPC 경로를 다시 확인해야 합니다.
[[topics]] — 이 주제가 선택된 근거.
