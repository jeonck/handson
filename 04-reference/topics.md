---
title: 다루는 주제 선언
date: 2026-08-07
domain: reference
tags: [meta, profile]
stack: [kubernetes, terraform, argocd, prometheus, github-actions]
summary: daily-topic 스킬이 매일 아침 무엇을 고를지 정의하는 파일. 이 목록을 고치면 자동 생성되는 오늘의 주제가 바뀝니다.
source: handson
---

`daily-topic` 스킬이 매일 아침 이 파일을 읽습니다. **여기 없는 영역은 오늘의 주제로 뽑히지 않습니다.**

기준은 하나입니다 — *내가 다음 분기에 실제로 손댈 가능성이 있는가.* 흥미롭지만 손댈 일이 없는 것은 뽑아 봐야 읽지 않습니다.

## topics

- 컨테이너 오케스트레이션 — Kubernetes 코어, 워크로드 API, 스케줄링, 업그레이드
- GitOps / 배포 — Argo CD, Flux, 프로그레시브 딜리버리, 릴리스 전략
- IaC — Terraform / OpenTofu, 모듈 설계, state 운영, 드리프트
- 관측성 — Prometheus, OpenTelemetry, Grafana, 로그 파이프라인, SLO
- CI — GitHub Actions, 러너 운영, 빌드 캐시, 공급망 보안(SBOM·서명)
- 플랫폼 네트워킹 — 인그레스, Gateway API, 서비스 메시, DNS
- 사고 대응 — 온콜 운영, 포스트모템, 런북 자동화

## 제외

- 벤더 마케팅성 발표 (실제 사용 가능한 릴리스·문서가 없는 것)
- 벤치마크 순위 다툼
- "이 도구가 죽었다" 류의 논쟁 글
- 코드 예시가 없는 아키텍처 개론

## 형식 요구

오늘의 주제는 **읽는 글이 아니라 따라 하는 자료**여야 합니다. 최소한 다음을 포함합니다.

- 왜 지금 이 주제인지 (출처 링크와 날짜)
- 30분 안에 끝나는 최소 실습 — 붙여 넣으면 도는 명령
- 검증 방법 — "됐다"를 어떻게 확인하는가
- 함정 — 처음 하면 반드시 밟는 것
- 우리 환경에 적용한다면 무엇이 걸리는가

## 환경 기준선

실습 자료는 별도 명시가 없으면 이 환경을 가정합니다.

| 구성 | 버전 |
|---|---|
| Kubernetes | 1.31 (EKS) |
| Helm | 3.16 |
| Terraform | 1.9 |
| kubectl | 1.31 |
| 로컬 실습 | kind 0.24 / Docker Desktop |

## 손보는 법

이 파일을 직접 고쳐 커밋하거나, 이슈에 "주제에 X 추가해줘"라고 적으면 됩니다.
