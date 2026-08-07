---
title: CrashLoopBackOff 진단 — 종료 코드에서 원인으로
date: 2026-08-07
domain: troubleshoot
tags: [incident, debugging, kubernetes]
stack: [kubernetes, kubectl, containerd]
summary: Pod가 재시작을 반복할 때 종료 코드와 이벤트를 축으로 원인을 좁히는 분기표. CrashLoopBackOff는 원인이 아니라 "컨테이너가 계속 죽는다"는 관찰일 뿐입니다.
source: handson
env: Kubernetes 1.28~1.31 · containerd 1.7 · kubectl 1.31
verified: 2026-08-07
duration: 5~30분
risk: low
---

`CrashLoopBackOff`는 진단명이 아닙니다. **컨테이너가 죽었고, kubelet이 재시작 간격을 늘려 가며(10s → 20s → … → 5m) 다시 띄우는 중**이라는 상태 표시입니다. 원인은 항상 그 아래에 있습니다.

## 30초 안에 확인할 세 가지

```bash
NS=<namespace>; POD=<pod>

# 1) 종료 코드와 이유
kubectl -n $NS get pod $POD -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.lastState.terminated.exitCode}{"\t"}{.lastState.terminated.reason}{"\t"}{.restartCount}{"\n"}{end}'

# 2) 죽기 직전 로그 (--previous 가 핵심 — 현재 컨테이너 로그는 대체로 비어 있습니다)
kubectl -n $NS logs $POD --previous --tail=100

# 3) 이벤트
kubectl -n $NS describe pod $POD | sed -n '/Events:/,$p'
```

이 세 개로 대부분 갈립니다. 아래 표에서 종료 코드에 해당하는 절로 바로 가세요.

| 종료 코드 | reason | 대체로 이것 |
|---|---|---|
| `0` | Completed | 프로세스가 정상 종료 — [A](#a-종료-코드-0) |
| `1` / `2` | Error | 애플리케이션 자체 실패 — [B](#b-종료-코드-1-2) |
| `137` | OOMKilled | 메모리 한도 초과 — [C](#c-종료-코드-137) |
| `137` | Error | liveness 프로브 실패 후 SIGKILL — [D](#d-137인데-oomkilled가-아님) |
| `139` | Error | 세그폴트 — 아키텍처 불일치(arm64/amd64) 의심 |
| `143` | Error | SIGTERM 수신 — 외부에서 종료시킴 |
| 없음 | — | 컨테이너가 시작조차 못 함 — [E](#e-종료-코드가-없음) |

---

## A. 종료 코드 0

컨테이너의 메인 프로세스가 할 일을 마치고 나갔습니다. Kubernetes는 `restartPolicy: Always`(Deployment 기본값)에서 이것도 재시작합니다.

```bash
kubectl -n $NS get pod $POD -o jsonpath='{.spec.containers[*].command} {.spec.containers[*].args}{"\n"}'
```

- 배치성 작업을 Deployment로 배포함 → **Job/CronJob으로 바꿉니다.**
- 엔트리포인트가 데몬을 포그라운드로 안 띄움 → `nginx -g 'daemon off;'`, `php-fpm -F` 처럼 포그라운드 플래그를 붙입니다.
- 셸 래퍼가 백그라운드로 실행하고 즉시 종료 → `exec` 로 프로세스를 교체합니다.

## B. 종료 코드 1 / 2

애플리케이션이 스스로 죽었습니다. 로그에 답이 있습니다.

```bash
kubectl -n $NS logs $POD --previous --tail=200
kubectl -n $NS logs $POD --previous --all-containers
```

로그가 비어 있다면 순서상 **설정 주입 전에 죽은 것**입니다. 다음을 봅니다.

```bash
# 참조하는 ConfigMap/Secret이 실제로 있는가
kubectl -n $NS get pod $POD -o jsonpath='{range .spec.volumes[*]}{.configMap.name}{" "}{.secret.secretName}{"\n"}{end}'
kubectl -n $NS get cm,secret
```

가장 흔한 세 가지:

1. **필수 환경변수 누락** — `envFrom`의 ConfigMap 이름 오타. 이벤트에 `CreateContainerConfigError`가 함께 뜹니다.
2. **의존 서비스에 연결 실패 후 즉시 exit** — DB/Redis 주소가 틀렸거나 아직 안 떴습니다. 아래 "의존성" 절로.
3. **마이그레이션 실패** — 초기화 로직이 실패하면서 exit(1). 로그 첫 20줄에 보통 스택트레이스가 있습니다.

### 의존성 확인

```bash
kubectl -n $NS run netcheck --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'nslookup <SERVICE>.<NS>.svc.cluster.local; nc -zv <SERVICE> <PORT>'
```

DNS가 안 되면 CoreDNS부터 봅니다.

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

## C. 종료 코드 137

`reason: OOMKilled`이면 커널이 죽인 것입니다. 애플리케이션 로그에는 **아무 흔적도 남지 않습니다** — 이 점이 B와 구분되는 신호입니다.

```bash
kubectl -n $NS get pod $POD -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.limits.memory}{"\t"}{.resources.requests.memory}{"\n"}{end}'
kubectl -n $NS top pod $POD --containers
```

조치 순서:

1. **한도가 실사용보다 낮은가** — 피크 사용량 + 30% 여유로 올립니다. 근거 없이 두 배씩 올리지 마세요.
2. **JVM/Node.js 힙 설정이 컨테이너 한도를 모르는가** — 이게 진짜 원인인 경우가 많습니다.
   - JVM: `-XX:MaxRAMPercentage=75.0` (컨테이너 한도 기준으로 힙을 잡음)
   - Node.js: `--max-old-space-size=<한도의 75%, MB>`
3. **실제 누수인가** — 재시작 주기가 규칙적으로 점점 짧아지면 누수 쪽입니다. 한도만 올리면 장애가 뒤로 미뤄질 뿐입니다.

노드 전체가 메모리 압박이면 개별 Pod 문제가 아닙니다.

```bash
kubectl describe node <NODE> | grep -iE "MemoryPressure|Allocated" -A4
```

→ [[k8s-node-drain-replace]]로 용량을 늘리는 쪽을 검토합니다.

## D. 137인데 OOMKilled가 아님

liveness 프로브가 실패해서 kubelet이 컨테이너를 죽인 것입니다. 이벤트에 `Liveness probe failed`가 반드시 남습니다.

```bash
kubectl -n $NS describe pod $POD | grep -iE "liveness|readiness|startup" -A3
```

거의 항상 **프로브 설정이 애플리케이션 기동 시간보다 짧은 것**이 원인입니다. 애플리케이션은 멀쩡한데 프로브가 못 기다려 줍니다.

```yaml
# 기동이 느린 애플리케이션은 initialDelaySeconds가 아니라 startupProbe로 풉니다.
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30        # 최대 150초까지 기동 허용
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3
```

체크 항목:

- liveness 엔드포인트가 DB를 찌르고 있지 않은가 → DB가 느려지면 애플리케이션이 통째로 재시작 루프에 빠집니다. **liveness는 프로세스 생존만, readiness가 의존성을 봅니다.**
- 포트/경로가 실제 리스닝 포트와 같은가
- `timeoutSeconds`가 기본 1초라 부하 시 넘기지 않는가

## E. 종료 코드가 없음

컨테이너가 실행되기 전에 막혔습니다. `describe`의 `Reason`이 이름을 말해 줍니다.

| Reason | 원인 | 확인 |
|---|---|---|
| `ImagePullBackOff` / `ErrImagePull` | 이미지 없음·태그 오타·자격증명 | `kubectl -n $NS get sa <SA> -o yaml` 의 `imagePullSecrets` |
| `CreateContainerConfigError` | ConfigMap/Secret 키 없음 | `kubectl -n $NS describe pod $POD` 마지막 줄 |
| `CreateContainerError` | 엔트리포인트 파일 없음·권한 | 이미지를 로컬에서 `docker run` 해 봄 |
| `Init:CrashLoopBackOff` | initContainer가 죽음 | `kubectl logs $POD -c <INIT_NAME>` |
| `Pending` (아직 시작 안 함) | 스케줄 불가 | 아래 참조 |

스케줄이 안 되는 경우:

```bash
kubectl -n $NS describe pod $POD | grep -A10 "Events:"
# "0/5 nodes are available: 3 Insufficient cpu, 2 node(s) had untolerated taint"
```

메시지가 원인을 그대로 알려 줍니다 — request가 과한지, 테인트/톨러레이션이 안 맞는지, 노드 셀렉터가 없는 라벨을 가리키는지.

## 임시 조치: 죽는 컨테이너 안을 보고 싶을 때

CrashLoop 중인 컨테이너에는 `exec`가 안 붙습니다. 셸을 덮어써서 같은 환경을 띄웁니다.

```bash
kubectl -n $NS debug $POD -it --image=busybox --target=<CONTAINER> -- sh
```

`debug`가 막혀 있으면 매니페스트를 복사해 command를 바꾼 Pod를 따로 띄웁니다. **운영 Deployment의 command를 직접 고쳐 sleep을 넣는 것은 하지 마세요** — 되돌리는 것을 잊고 그대로 배포되는 사고가 반복적으로 납니다.

## 남길 것

원인을 찾았으면 그 자리에서 한 줄 남깁니다. 같은 증상을 세 달 뒤에 다시 만납니다.

```markdown
- 증상: <서비스명> Pod CrashLoopBackOff, 종료 코드 137
- 원인: JVM이 컨테이너 메모리 한도를 인식 못 해 힙이 노드 메모리 기준으로 잡힘
- 조치: -XX:MaxRAMPercentage=75.0 추가, limits.memory 2Gi 유지
- 재발 방지: 베이스 이미지 공통 JAVA_OPTS에 반영
```

## 후속 조치

- [ ] liveness 프로브가 외부 의존성을 찌르는 서비스 목록화 📅 2026-08-14
- [ ] OOMKilled 이벤트 알람 추가 (`kube_pod_container_status_last_terminated_reason`)

## 연결

[[k8s-node-drain-replace]] — 노드 교체 직후 대량으로 CrashLoop이 나면 노드 쪽 문제일 가능성이 큽니다.
[[argocd-helm-ha-install]] — Argo CD가 `selfHeal: true`면 여기서 손으로 고친 매니페스트가 되돌려집니다. Git을 먼저 고치세요.
