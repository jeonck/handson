---
title: Topic of the day — in-place Pod resize goes GA in Kubernetes 1.35
date: 2026-08-14
domain: daily
tags: [daily, container-orchestration, not-executed]
stack: [kubernetes, kubectl, kind]
summary: Resize a running Pod's CPU and memory without recreating it — GA and on by default since Kubernetes 1.35 — and see exactly which resource needs a restart to apply and which doesn't.
source: daily-topic
---

## Why this topic

[[topics]] lists Container orchestration — Kubernetes core, workload APIs, scheduling — as in scope. In-place Pod resize (KEP-1287) graduated from beta to **stable, enabled by default** in **Kubernetes v1.35**, released 2025-12-17 as "Timbernetes" ([release announcement](https://kubernetes.io/blog/2025/12/17/kubernetes-v1-35-release/)), with a dedicated post two days later confirming the graduation and the mechanics ([In-Place Pod Resize Graduates to Stable, 2025-12-19](https://kubernetes.io/blog/2025/12/19/kubernetes-v1-35-in-place-pod-resize-ga)). The feature itself dates back further — alpha in v1.27, beta in v1.33 — but this is the first release where it needs no feature gate and behaves the same on every cluster.

It connects straight to [[schedulable-node-budget]]: that runbook's standing decision caps this cluster at 2 schedulable nodes and sizes every add-on to fit inside that budget up front, because getting the number wrong today means recreating the workload to fix it. In-place resize changes what "getting it wrong" costs — a Pod that was requested too small can be corrected without a delete/recreate cycle, which matters more, not less, on a tight budget where every reschedule has only one other node to land on.

Command syntax throughout is from the official task doc, [Resize CPU and Memory Resources assigned to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/), fetched 2026-08-14.

## 30-minute lab

> **Not executed in this run.** This is a scheduled run with no user in the loop, and `kind create cluster` sits behind an approval prompt this sandbox cannot answer (`docker ps` — read-only — works; `kind get clusters` does not). Every command below is copied from the official docs task page linked above or built from the confirmed kind node-image digest below. Nobody has watched it run yet — treat it the way [[2026-08-11-prometheus-3-13-lts]] treats its own unexecuted lab: run it and check the Follow-ups box before trusting the output shown here.

### 1. Cluster, pinned to a build where the feature is GA

kind v0.32.0 (published 2026-06-02) ships a pre-built node image for Kubernetes v1.35.5 ([release notes](https://github.com/kubernetes-sigs/kind/releases/tag/v0.32.0)):

```bash
kind create cluster --name resize-demo \
  --image kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95
```

### 2. A Pod with an explicit resize policy per resource

Source: the example on the official task page, trimmed. `cpu` is set to apply without a restart, `memory` is set to require one — the two behave differently in the same Pod on purpose, so one Pod is enough to see both outcomes.

```yaml title="resize-demo.yaml"
apiVersion: v1
kind: Pod
metadata:
  name: resize-demo
spec:
  containers:
  - name: pause
    image: registry.k8s.io/pause:3.8
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired
    - resourceName: memory
      restartPolicy: RestartContainer
    resources:
      requests:
        cpu: 100m
        memory: 50Mi
      limits:
        cpu: 200m
        memory: 100Mi
```

```bash
kubectl apply -f resize-demo.yaml
kubectl wait --for=condition=Ready pod/resize-demo --timeout=60s
kubectl get pod resize-demo -o jsonpath='{.status.containerStatuses[0].restartCount}{"\n"}'
```

Expected: `0` — this is the baseline the two resizes below get compared against.

### 3. Resize CPU — no restart expected

The resize subresource is mandatory here: a plain `kubectl patch` against `spec.containers[*].resources` without `--subresource resize` is rejected, because that field stays immutable outside this specific path (see Traps).

```bash
kubectl patch pod resize-demo --type merge --subresource resize \
  -p '{"spec":{"containers":[{"name":"pause","resources":{"requests":{"cpu":"150m"},"limits":{"cpu":"300m"}}}]}}'
```

### 4. Resize memory — restart expected

```bash
kubectl patch pod resize-demo --type merge --subresource resize \
  -p '{"spec":{"containers":[{"name":"pause","resources":{"requests":{"memory":"80Mi"},"limits":{"memory":"150Mi"}}}]}}'
```

### Verify

```bash
# 1) restart count: should still be 0 after the CPU resize, 1 after the memory resize
kubectl get pod resize-demo -o jsonpath='{.status.containerStatuses[0].restartCount}{"\n"}'

# 2) the value the kubelet actually applied, not just what was requested
kubectl get pod resize-demo -o jsonpath='{.status.containerStatuses[0].resources}{"\n"}'

# 3) generation the kubelet has processed vs. the latest spec generation — they should match once settled
kubectl get pod resize-demo -o jsonpath='{.status.observedGeneration}/{.metadata.generation}{"\n"}'
```

Expected: restart count `0` right after step 3, `1` right after step 4 — same Pod, same command shape, different outcome because of the `resizePolicy` set in step 2. `status.containerStatuses[0].resources` shows the new numbers in both cases; `observedGeneration` equal to `metadata.generation` means the kubelet has fully caught up. If the two generation numbers differ, the resize is still `PodResizeInProgress` — check `kubectl describe pod resize-demo` for the condition's `message` field before assuming step 3 or 4 finished.

### Clean up

```bash
kind delete cluster --name resize-demo
```

## Traps

**A plain `kubectl patch`/`kubectl edit` against a running Pod's `resources` field fails, and the error doesn't say "use the resize subresource."** `spec.containers[*].resources` is immutable through the normal Pod update path; it only became mutable through `--subresource resize`. Whoever tries the obvious `kubectl edit pod` first gets a validation error that reads like resize isn't supported at all, rather than "you're patching the wrong path."

**Memory shrink is best-effort, not guaranteed.** The docs are explicit that decreasing memory has no OOM protection — the kubelet applies the lower limit and the container can be OOM-killed if it's still using more than the new limit allows. That is a real restart, but it is not the `resizePolicy`-driven restart this lab demonstrates; it looks the same in `restartCount` and needs `kubectl describe pod` to tell apart from a clean resize-triggered restart.

**QoS class cannot change under a resize.** A resize that would flip the Pod from `Guaranteed` to `Burstable` (or vice versa) is rejected outright rather than partially applied — worth checking before assuming any request/limit combination is resizable.

## If we applied this here

- [[schedulable-node-budget]]'s standing decision is "size each add-on to 2 schedulable nodes before installing." Today, discovering an add-on was undersized means editing the manifest and letting it reschedule — competing for placement against whatever else is already on the other of the 2 nodes. In-place resize turns some of those corrections into a same-node adjustment instead, which matters specifically because that runbook's budget leaves no spare node to reschedule onto during a drain.
- It does not touch the runbook's other two failure modes. Longhorn's replica count and Argo CD's `redis-ha` anti-affinity are both about *how many Pods* get placed, not the size of one Pod — resize has nothing to offer there.
- Nothing in this repository's on-prem docs sets a `resizePolicy` or uses the kubelet's static CPU/Memory manager policy, so the "incompatible with static policy" limitation in the official docs does not currently block anything here — unconfirmed whether that stays true if [[longhorn-storage-onprem]] or [[argocd-helm-ha-install]] ever pin exclusive CPUs.

## Follow-ups

- [ ] Run the lab above end to end on kind and confirm both restart-count values match what's claimed here 📅 2026-08-21
- [ ] Confirm `kubectl` on the on-prem admin host used for [[onprem-3node-kubeadm-ubuntu]] is v1.32+ before relying on `--subresource resize` there
- [ ] Check whether any workload already running there (Longhorn manager, Argo CD controllers) is chronically undersized in a way this would fix without a reschedule

## Related

[[schedulable-node-budget]] — the node-budget runbook this feature changes the cost model for.
[[2026-08-11-prometheus-3-13-lts]] — same sandbox limitation, same "run it and check the box" pattern for the unexecuted lab.
[[topics]] — why this topic was selected.
