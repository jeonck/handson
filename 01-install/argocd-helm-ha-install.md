---
title: Argo CD HA 설치 (Helm) — 인그레스·SSO 없이 첫 배포까지
date: 2026-08-07
domain: install
tags: [gitops, cd, kubernetes]
stack: [kubernetes, argocd, helm, ingress-nginx]
summary: 빈 Kubernetes 클러스터에 Argo CD를 HA 구성으로 올리고, 인그레스로 노출한 뒤 app-of-apps 부트스트랩까지 마치는 절차. 차트 버전 고정과 gRPC 경로가 실패 지점입니다.
source: handson
env: Kubernetes 1.31 (EKS) · Helm 3.16 · ingress-nginx 1.11 · argo-cd chart 7.x
verified: 2026-08-07
duration: 40~60분
risk: medium
---

클러스터에 GitOps 컨트롤 플레인을 처음 세우는 절차입니다. **관리형 클러스터(EKS/GKE/AKS) 기준**이고, ingress-nginx가 이미 떠 있다고 가정합니다. SSO(OIDC)와 Argo CD Image Updater는 이 문서 범위 밖입니다 — 먼저 붙이면 로그인이 안 될 때 원인이 두 배로 늘어납니다.

## 사전 조건

| 항목 | 확인 명령 | 기대값 |
|---|---|---|
| 클러스터 접근 | `kubectl auth can-i create namespace` | `yes` |
| Helm | `helm version --short` | `v3.14` 이상 |
| 인그레스 컨트롤러 | `kubectl get ingressclass` | `nginx` 존재 |
| DNS | `dig +short argocd.example.com` | 인그레스 LB 주소 |
| TLS | `kubectl -n argocd get secret argocd-tls` 또는 cert-manager ClusterIssuer | 둘 중 하나 |

DNS가 아직 안 붙었으면 이 문서를 시작하지 마세요. 인그레스 없이 `port-forward`로 검증한 뒤 나중에 노출하면, 뒤에서 다룰 gRPC 문제를 배포 당일에 처음 만나게 됩니다.

## 1. 네임스페이스와 차트 버전 고정

```bash
kubectl create namespace argocd
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update argo
```

차트 버전을 **반드시 고정**합니다. `helm upgrade --install`을 버전 없이 돌리면 다음 배포 때 다른 Argo CD가 올라옵니다.

```bash
helm search repo argo/argo-cd --versions | head -5
```

출력 첫 줄의 `CHART VERSION`을 아래 변수에 넣습니다. 이 값과 `APP VERSION`(Argo CD 자체 버전)을 문서 프론트매터의 `env`에도 적어 두세요.

```bash
export ARGOCD_CHART_VERSION="<위에서 고른 버전>"
export ARGOCD_HOST="argocd.example.com"
```

## 2. values 파일

```yaml
# argocd-values.yaml
global:
  domain: argocd.example.com

# HA: redis-ha 3 노드 + 각 컴포넌트 다중화.
# 단일 노드 테스트 클러스터에서는 redis-ha가 안티어피니티 때문에 Pending으로 남습니다.
redis-ha:
  enabled: true

controller:
  replicas: 1          # 애플리케이션 컨트롤러는 샤딩 전까지 1로 두는 것이 안전합니다
repoServer:
  replicas: 2
server:
  replicas: 2
  # 인그레스에서 TLS를 끝내므로 서버는 평문으로 받습니다.
  # 이 플래그가 없으면 nginx -> argocd-server 사이에서 무한 리디렉션(ERR_TOO_MANY_REDIRECTS)이 납니다.
  extraArgs:
    - --insecure
  ingress:
    enabled: true
    ingressClassName: nginx
    hostname: argocd.example.com
    annotations:
      nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    tls: true
applicationSet:
  replicas: 2

configs:
  params:
    server.insecure: true
```

`global.domain`, `ingress.hostname`은 실제 도메인으로 바꿉니다. 여기까지가 "웹 UI가 뜨는" 최소 구성입니다.

## 3. 설치

```bash
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --version "$ARGOCD_CHART_VERSION" \
  --values argocd-values.yaml \
  --wait --timeout 10m
```

`--wait`가 10분을 넘겨 실패하면 대부분 `redis-ha`입니다. 노드가 3개 미만이거나 zone이 하나면 안티어피니티를 만족하지 못해 Pod가 Pending으로 남습니다.

```bash
kubectl -n argocd get pods -o wide
kubectl -n argocd get events --sort-by=.lastTimestamp | tail -20
```

단일 노드 환경이면 `redis-ha.enabled: false`로 내리고 다시 돌립니다. 운영에서는 노드를 늘리는 쪽이 맞습니다 — [[pod-crashloopbackoff]]의 스케줄링 절을 함께 보세요.

## 4. 초기 로그인

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d; echo
```

```bash
argocd login "$ARGOCD_HOST" --username admin --grpc-web
```

`--grpc-web`이 핵심입니다. ingress-nginx가 HTTP/2 gRPC를 그대로 넘기지 못하는 구성이 흔해서, 이 플래그 없이 로그인하면 `rpc error: code = Unavailable`로 끊깁니다. 매번 붙이기 싫으면 `argocd login ... --grpc-web` 후 `~/.config/argocd/config`에 저장된 컨텍스트를 그대로 쓰면 됩니다.

비밀번호를 바꾸고 초기 시크릿을 지웁니다.

```bash
argocd account update-password
kubectl -n argocd delete secret argocd-initial-admin-secret
```

## 5. app-of-apps 부트스트랩

Argo CD를 UI로만 쓰면 클릭이 곧 미신고 변경이 됩니다. 루트 Application 하나만 손으로 만들고, 나머지는 Git이 관리하게 둡니다.

```yaml
# bootstrap/root.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/<org>/<gitops-repo>.git
    targetRevision: main
    path: apps            # 이 디렉터리 안의 Application 매니페스트들이 나머지 전부를 만듭니다
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```bash
kubectl apply -f bootstrap/root.yaml
argocd app wait root --health --timeout 300
```

프라이빗 저장소면 먼저 자격증명을 넣습니다.

```bash
argocd repo add https://github.com/<org>/<gitops-repo>.git \
  --username <user> --password <token>
```

## 6. 검증 체크리스트

여기까지 전부 통과해야 "설치 완료"입니다. 하나라도 건너뛰면 실제 장애 때 이 문서를 못 믿게 됩니다.

- [ ] `kubectl -n argocd get pods` — 모든 Pod `Running`, `RESTARTS` 0
- [ ] `https://argocd.example.com` 브라우저 로그인 성공, 인증서 경고 없음
- [ ] `argocd app list` — CLI에서 목록 조회 성공 (gRPC 경로 확인)
- [ ] `argocd app get root` — `Synced` / `Healthy`
- [ ] Git에서 매니페스트 한 줄 고치고 push → 3분 안에 자동 반영 (selfHeal 확인)
- [ ] `kubectl -n argocd delete pod -l app.kubernetes.io/name=argocd-server` 후 UI 재접속 — HA 복구 확인
- [ ] 초기 admin 시크릿 삭제 완료

## 7. 롤백

```bash
helm history argocd -n argocd
helm rollback argocd <REVISION> -n argocd --wait
```

완전 제거는 순서가 있습니다. Application에 finalizer가 걸려 있어서, 차트를 먼저 지우면 네임스페이스가 `Terminating`에서 멈춥니다.

```bash
kubectl -n argocd delete applications --all      # 먼저
helm uninstall argocd -n argocd                  # 그다음
kubectl delete namespace argocd
```

## 걸린 지점

**`ERR_TOO_MANY_REDIRECTS`** — `--insecure` 없이 인그레스 TLS를 붙인 경우입니다. argocd-server가 HTTP를 HTTPS로 리디렉트하는데 인그레스가 다시 평문으로 내려보내면서 루프가 됩니다. values의 `server.extraArgs`와 `configs.params.server.insecure` 둘 다 확인하세요.

**CLI만 안 되고 UI는 됨** — gRPC입니다. `--grpc-web`을 붙이거나, 인그레스에 `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"`를 쓰는 별도 호스트(`grpc.argocd.example.com`)를 하나 더 팝니다. 한 호스트에서 HTTP와 gRPC를 동시에 처리하려는 시도는 대체로 시간 낭비였습니다.

**차트 버전 미고정** — 3주 뒤 무관한 PR의 CI가 `helm upgrade`를 돌리면서 Argo CD 마이너 버전이 올라가 CRD가 바뀐 사례가 있었습니다. `--version` 고정과 renovate/dependabot로 명시적 PR을 받는 쪽이 맞습니다.

## 후속 조치

- [ ] OIDC(SSO) 연동 후 `admin` 계정 비활성화 📅 2026-08-21
- [ ] Argo CD 자체를 root app에 포함시켜 self-managed로 전환
- [ ] 백업: `argocd-cm`, `argocd-rbac-cm`, Application 매니페스트를 Git에 커밋

## 연결

[[pod-crashloopbackoff]] — 설치 직후 Pod가 재시작을 반복할 때 진단 순서.
[[k8s-node-drain-replace]] — Argo CD가 올라간 노드를 교체할 때의 절차. controller가 1 replica라 드레인 순서가 중요합니다.
