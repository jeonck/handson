---
title: 프로덕션 노드 드레인 및 교체 절차
date: 2026-08-07
domain: runbook
tags: [maintenance, capacity, kubernetes]
stack: [kubernetes, kubectl, aws-eks, terraform]
summary: 운영 중인 워커 노드를 무중단으로 비우고 새 노드로 교체하는 절차. PDB 사전 점검과 중단 기준(abort criteria)이 절차의 절반입니다.
source: handson
env: Kubernetes 1.31 (EKS) · Managed Node Group · kubectl 1.31
verified: 2026-08-07
duration: 노드당 20~40분
risk: high
---

커널 패치, 인스턴스 타입 변경, AMI 갱신, 좀비 노드 정리에 공통으로 쓰는 절차입니다. **한 번에 노드 하나**가 원칙입니다. 두 개를 동시에 비우다 PDB가 걸려 드레인이 반쯤 멈춘 채로 남는 상황이 가장 수습하기 어렵습니다.

> 이 절차는 되돌릴 수 있는 지점이 3단계까지입니다. 4단계(노드 삭제) 이후는 새 노드를 기다리는 것 말고 방법이 없습니다.

## 사전 점검 (작업 시작 전, 별도 시간에)

### 1. 여유 용량 확인

노드 하나를 빼도 나머지가 그 부하를 받을 수 있는지 봅니다.

```bash
kubectl top nodes
kubectl describe node <NODE> | grep -A5 "Allocated resources"
```

남은 노드의 CPU/메모리 request 합이 90%를 넘길 것 같으면 **먼저 노드를 늘리고** 시작합니다. 드레인 도중에 스케일아웃을 기다리는 것은 장애입니다.

### 2. PodDisruptionBudget 점검 — 가장 중요한 단계

```bash
kubectl get pdb -A
```

`ALLOWED DISRUPTIONS`가 `0`인 PDB가 있으면 드레인은 그 Pod에서 무한정 멈춥니다.

```bash
# 이 노드 위의 Pod 중 PDB에 걸려 있는 것 찾기
kubectl get pods --field-selector spec.nodeName=<NODE> -A \
  -o custom-columns='NS:.metadata.namespace,POD:.metadata.name,OWNER:.metadata.ownerReferences[0].kind'
```

`ALLOWED DISRUPTIONS = 0`의 흔한 원인:

| 원인 | 확인 | 조치 |
|---|---|---|
| replicas=1인데 `minAvailable: 1` | `kubectl get deploy <NAME>` | 작업 전 임시로 replicas를 2로 |
| Pod가 이미 하나 Unhealthy | `kubectl get pods -l <SELECTOR>` | 그 Pod를 먼저 고침 |
| StatefulSet 단일 인스턴스 | `kubectl get sts` | 애플리케이션 팀과 중단 시간 합의 |

### 3. 이 노드에만 있는 것 찾기

```bash
# emptyDir·hostPath를 쓰는 Pod — 드레인하면 데이터가 사라집니다
kubectl get pods --field-selector spec.nodeName=<NODE> -A -o json | \
  jq -r '.items[] | select(.spec.volumes[]?|has("emptyDir") or has("hostPath")) |
         "\(.metadata.namespace)/\(.metadata.name)"'
```

여기 나온 Pod는 소유 팀에 먼저 알립니다. `--delete-emptydir-data` 없이는 드레인이 거부되고, 붙이면 데이터가 날아갑니다. 둘 중 하나를 몰래 고르면 안 됩니다.

### 4. 커뮤니케이션

- 변경 티켓 번호 확보
- 담당 채널에 시작/종료 공지 (예상 소요와 롤백 조건 포함)
- 진행 중 알람 억제(silence)는 **이 노드 관련 알람만**, 만료 시간 필수

## 실행

### 1단계 — cordon (되돌릴 수 있음)

새 Pod가 이 노드로 스케줄되지 않게 막습니다. 기존 Pod는 그대로 돕니다.

```bash
kubectl cordon <NODE>
kubectl get node <NODE>          # STATUS: Ready,SchedulingDisabled
```

롤백: `kubectl uncordon <NODE>`

### 2단계 — drain (되돌릴 수 있음, 되돌리면 재배치가 일어남)

```bash
kubectl drain <NODE> \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120 \
  --timeout=15m \
  --skip-wait-for-delete-timeout=60
```

각 플래그의 이유:

- `--ignore-daemonsets` — DaemonSet Pod는 어차피 다른 노드로 옮길 수 없습니다. 없으면 드레인이 즉시 거부됩니다.
- `--delete-emptydir-data` — 위 사전 점검 3에서 확인·합의한 경우에만 붙입니다.
- `--grace-period=120` — 애플리케이션의 가장 긴 `terminationGracePeriodSeconds`보다 크게. 짧으면 커넥션이 잘립니다.
- `--timeout=15m` — 무한 대기를 막습니다. 걸리면 사람이 판단해야 합니다.

**드레인이 멈춘 것처럼 보일 때** — 다른 터미널에서 관찰합니다. 로그를 노려보고 있지 말고 원인을 봅니다.

```bash
kubectl get pods --field-selector spec.nodeName=<NODE> -A -w
kubectl get events -A --sort-by=.lastTimestamp | grep -i evict | tail
```

`Cannot evict pod as it would violate the pod's disruption budget` → 사전 점검 2로 돌아갑니다.

### 3단계 — 비었는지 확인 (마지막 되돌릴 수 있는 지점)

```bash
kubectl get pods --field-selector spec.nodeName=<NODE> -A \
  --field-selector status.phase!=Succeeded,status.phase!=Failed
```

DaemonSet Pod와 static Pod만 남아 있어야 합니다. 다른 것이 남아 있으면 **다음 단계로 넘어가지 마세요.**

옮겨간 Pod가 실제로 서비스 중인지도 확인합니다. 스케줄만 되고 `Running`이 아닌 경우가 있습니다.

```bash
kubectl get pods -A -o wide | grep -v Running | grep -v Completed
```

이 시점에서 서비스 지표(에러율·p99)를 봅니다. 평소 대비 튀었으면 여기서 멈추고 `uncordon` 후 원인을 찾습니다.

### 4단계 — 노드 제거 (되돌릴 수 없음)

관리형 노드그룹이면 인스턴스를 종료하고 ASG가 새로 띄우게 둡니다.

```bash
# EKS 관리형 노드그룹 — 인스턴스 ID 확인
INSTANCE_ID=$(kubectl get node <NODE> -o jsonpath='{.spec.providerID}' | awk -F/ '{print $NF}')
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
```

IaC로 관리 중이면 콘솔이나 CLI로 직접 지우지 말고 Terraform 쪽에서 처리합니다. 손으로 지운 인스턴스는 다음 `terraform plan`에서 드리프트로 다시 나타납니다.

```bash
terraform plan -target=module.eks.module.eks_managed_node_group
```

### 5단계 — 새 노드 확인

```bash
kubectl get nodes -w        # 새 노드가 Ready 되기까지 대기
kubectl get node <NEW_NODE> -o jsonpath='{.status.nodeInfo.kubeletVersion}{"\n"}'
kubectl get node <NEW_NODE> -o jsonpath='{.metadata.labels}' | jq
```

옛 노드 오브젝트가 `NotReady`로 남아 있으면 정리합니다.

```bash
kubectl delete node <NODE>
```

## 중단 기준 (하나라도 해당하면 즉시 멈추고 uncordon)

- 드레인 15분 초과, 원인 미파악
- 옮겨간 Pod가 다른 노드에서 `Pending` — 용량 부족 신호
- 서비스 에러율이 기준선 대비 눈에 띄게 상승
- 남은 노드의 메모리 압박(`MemoryPressure`) 발생
- 새 노드가 10분 안에 `Ready`가 되지 않음

멈춘 뒤에는 원인을 문서로 남깁니다. 같은 이유로 두 번 멈췄다면 그건 절차 문제이지 그날의 운이 아닙니다.

## 검증 체크리스트

- [ ] 모든 노드 `Ready`, `SchedulingDisabled` 없음
- [ ] `kubectl get pods -A | grep -v Running | grep -v Completed` 비어 있음
- [ ] 새 노드의 kubelet 버전·라벨·테인트가 기존과 동일
- [ ] DaemonSet `DESIRED == READY`
- [ ] 서비스 대시보드 에러율·p99가 작업 전 수준으로 복귀
- [ ] 알람 silence 해제
- [ ] 변경 티켓에 종료 기록

## 후속 조치

- [ ] replicas를 임시로 올린 워크로드 원복 📅 2026-08-08
- [ ] `ALLOWED DISRUPTIONS = 0`이었던 서비스 목록을 팀에 전달

## 연결

[[pod-crashloopbackoff]] — 새 노드에서 Pod가 뜨자마자 죽을 때.
[[argocd-helm-ha-install]] — Argo CD 컨트롤러는 replica 1이라 이 절차 중 잠깐 동기화가 멈춥니다. 드레인 직후 `argocd app list`로 복구를 확인하세요.
