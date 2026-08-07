---
title: Topic scope
date: 2026-08-07
domain: reference
tags: [meta, profile]
stack: [kubernetes, terraform, argocd, prometheus, github-actions]
summary: Defines what the daily-topic skill is allowed to pick each morning. Edit this list and the auto-generated topic of the day changes with it.
source: handson
---

The `daily-topic` skill reads this file every morning. **Anything not listed here never becomes a topic of the day.**

One test decides what belongs: *is there a real chance I touch this in the next quarter?* Interesting but never-touched subjects go unread no matter how good the write-up is.

## topics

- Container orchestration — Kubernetes core, workload APIs, scheduling, upgrades
- GitOps and delivery — Argo CD, Flux, progressive delivery, release strategy
- IaC — Terraform / OpenTofu, module design, state operations, drift
- Observability — Prometheus, OpenTelemetry, Grafana, log pipelines, SLOs
- CI — GitHub Actions, runner operations, build caching, supply-chain security (SBOM, signing)
- Platform networking — ingress, Gateway API, service mesh, DNS
- Incident response — on-call operations, postmortems, runbook automation

## Excluded

- Vendor announcements with no usable release or documentation behind them
- Benchmark leaderboard arguments
- "Tool X is dead" think pieces
- Architecture overviews with no code

## Format requirements

A topic of the day has to be **something you follow, not something you read**. At minimum it carries:

- Why this topic now (source link and date)
- A minimal lab that finishes in 30 minutes — commands that run when pasted
- How to verify — what "it worked" actually looks like
- Traps — what you will definitely hit on the first attempt
- What would block us if we applied it here

## Baseline environment

Unless a document says otherwise, labs assume this environment.

| Component | Version |
|---|---|
| Kubernetes | 1.31 (EKS) |
| Helm | 3.16 |
| Terraform | 1.9 |
| kubectl | 1.31 |
| Local lab | kind 0.24 / Docker Desktop |

## Changing it

Edit this file and commit, or open an issue saying "add X to the topics".
