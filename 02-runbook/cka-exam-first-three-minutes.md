---
title: The first three minutes of a CKA attempt — shell setup and generated YAML
date: 2026-08-31
domain: runbook
tags: [kubernetes, cka, certification, productivity]
stack: [kubernetes, kubectl, bash]
summary: The fixed opening sequence for a performance-based Kubernetes exam — aliases, completion, a pinned namespace — plus what kubectl will write for you. A generated Deployment is 22 lines; the same object read back from the cluster is 64, and six of its metadata fields cannot be re-applied.
source: handson
env: Kubernetes 1.36.1 on kind 0.32.0 · kubectl 1.36.4 · bash 5 · macOS 14.7.5
verified: 2026-08-31
verifiability: partial
verifiability-note: Every command and count below was run against a live cluster, but nothing here was timed under exam conditions and the exam terminal is not this one — its shell, kubectl version and whether your rc file survives a session are all outside what a lab can settle. Treat the sequence as a checklist to rehearse, not as a measured time saving.
duration: 20–30 min to rehearse
risk: low
---

The exam gives you a browser terminal, a fixed number of tasks and a clock. **Anything you type more
than twice should be typed once**, and everything below is settled before reading task one.

This is the opening sequence, not a tutorial. The drills it feeds are in
[[cka-workloads-scheduling-drills]] and [[cka-services-ingress-storage-drills]].

## Before you read task one

### 1. Aliases and completion

```bash
alias k=kubectl
complete -o default -F __start_kubectl k
export do='--dry-run=client -o yaml'
export now='--force --grace-period=0'
```

```
  kubectl completion bash : ok
```

`$do` and `$now` are the two that pay for themselves. `k create deploy web --image=nginx $do` expands
to the full flag pair, and `k delete pod x $now` skips the 30-second graceful shutdown you will
otherwise wait through several times.

### 2. Pin the namespace, every task

```bash
kubectl config set-context --current --namespace=<ns>
```

```
  pinned namespace, 'kubectl get pods' now reads: drills
```

**Most lost marks are not wrong YAML, they are the right object in the wrong namespace.** Pinning
turns every subsequent command into the short form and removes the `-n` you will otherwise forget on
exactly one command. Do it as the first action of each task, not once at the start.

The same applies to the cluster: a multi-cluster exam expects `kubectl config use-context <name>`,
and the task statement gives you the name.

### 3. Know what you are looking at

```bash
kubectl config current-context
kubectl config view --minify -o jsonpath='{..namespace}'
```

An empty answer to the second is `default`, not "no namespace" — worth knowing before you conclude a
resource is missing.

## What kubectl will write for you

`kubectl create` covers seventeen resource types directly:

```
  clusterrole clusterrolebinding configmap cronjob deployment ingress job namespace
  poddisruptionbudget priorityclass quota role rolebinding secret service serviceaccount token
```

Plus `kubectl run` for a pod and `kubectl expose` for a Service from an existing workload. All four
were confirmed to produce valid manifests with `$do`:

```
  kubectl run           : ok
  kubectl create job    : ok
  kubectl create cronjob: ok
  kubectl expose deploy : ok
```

**Generate, then edit.** A Deployment written from scratch is where indentation mistakes come from:

```bash
kubectl create deployment web --image=nginx:alpine --replicas=3 $do > web.yaml
```

```
  22 lines
```

Anything the generator cannot express — volumes, probes, tolerations, security contexts — is added by
editing those 22 lines, and `kubectl explain` gives you the field names without leaving the terminal:

```bash
kubectl explain pod.spec.tolerations --recursive
```

```
  FIELD: tolerations <[]Toleration>
  DESCRIPTION:
      If specified, the pod's tolerations.
```

## The trap in reading a live object back

The reflex when you need a manifest for an existing object is `kubectl get <obj> -o yaml`. Compare:

```
  kubectl create ... --dry-run=client -o yaml : 22 lines
  kubectl get deploy web -o yaml              : 64 lines
```

The extra 42 lines are not content. **Six metadata fields exist only in the live copy and none of them
can be re-applied:**

```
  annotations  creationTimestamp  generation  namespace  resourceVersion  uid
```

`resourceVersion` and `uid` belong to that specific object instance; feeding them back creates a
conflict rather than a new object. So when a task says "create a copy of this Deployment in another
namespace", `get -o yaml` is the start of the work, not the answer — strip those fields, or regenerate
from `kubectl create` and re-add only what you actually need.

> One version-specific note: this kubectl already omits `managedFields` from `get -o yaml`, which
> older versions include and which is the largest block people used to strip by hand. **Check before
> assuming you need to remove it** — on this cluster the count was zero.

## Verification checklist

- [x] `kubectl completion bash` produces a completion script, and `complete -F __start_kubectl k` binds it to the alias
- [x] `kubectl config set-context --current --namespace=drills` makes bare `kubectl get pods` read that namespace
- [x] `kubectl config view --minify -o jsonpath='{..namespace}'` returns **empty for `default`**, not the word `default`
- [x] `kubectl create` lists **17** resource types; `run`, `create job`, `create cronjob` and `expose` all produce manifests with `--dry-run=client -o yaml`
- [x] A generated three-replica Deployment is **22 lines**; the same object read back is **64**
- [x] The live copy adds `annotations`, `creationTimestamp`, `generation`, `namespace`, `resourceVersion` and `uid` under `metadata`
- [x] `managedFields` is **absent** from `get -o yaml` on kubectl 1.36 — count it before planning to strip it
- [x] `kubectl explain pod.spec.tolerations --recursive` returns the field type and description with no browser

## Rollback

Nothing here changes a cluster except the pinned namespace:

```bash
kubectl config set-context --current --namespace=default
```

## Where this bit us

**The `managedFields` advice everyone repeats was already stale on this version.** The plan for this
page assumed a long block to strip; the count came back zero. Advice about a tool ages with the tool,
and the cheap habit is to run the count instead of quoting the guidance — one `grep -c` settles it.

**An empty namespace in `config view` reads as a bug and is not one.** It means `default`. This is the
alarming-but-correct output the repository's own rules ask to be flagged at the point it appears,
because the natural next move is to go looking for a broken kubeconfig.

## Follow-ups

- [ ] Time a full task end to end with and without this setup, on a fresh terminal, to find out whether the saving is real rather than assumed
- [ ] Rehearse the sequence on a shell where the rc file does *not* persist between sessions, which is the condition that actually matters
- [ ] Check which of these aliases survive in the exam's own terminal, since `complete -F` needs bash completion already loaded
- [ ] Add the `kubectl create` forms for the resources it does not cover, so the gap is known rather than discovered mid-task

## Related

[[cka-practice-cluster-and-checks-that-lie]] — the deep tasks: etcd restore, RBAC, NetworkPolicy, a dead node, a kubeadm upgrade.
[[cka-workloads-scheduling-drills]] — the workload half, where generated YAML is edited rather than written.
[[cka-services-ingress-storage-drills]] — Services, Ingress and volumes, with the checks that pass on a wrong answer.
