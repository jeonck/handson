---
title: Diagnosing CrashLoopBackOff — from exit code to cause
date: 2026-08-07
domain: troubleshoot
tags: [incident, debugging, kubernetes]
stack: [kubernetes, kubectl, containerd]
summary: A branch table for pods that keep restarting, keyed on exit code and events. CrashLoopBackOff is not a cause — it is the observation that a container keeps dying.
source: handson
env: Kubernetes 1.28–1.31 · containerd 1.7 · kubectl 1.31
verified: 2026-08-07
duration: 5–30 min
risk: low
---

`CrashLoopBackOff` is not a diagnosis. It means **the container died and kubelet is restarting it on a widening backoff** (10s → 20s → … → 5m). The cause is always underneath it.

## The three things to check in 30 seconds

```bash
NS=<namespace>; POD=<pod>

# 1) exit code and reason
kubectl -n $NS get pod $POD -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.lastState.terminated.exitCode}{"\t"}{.lastState.terminated.reason}{"\t"}{.restartCount}{"\n"}{end}'

# 2) logs from just before it died (--previous is the point — the current container's log is usually empty)
kubectl -n $NS logs $POD --previous --tail=100

# 3) events
kubectl -n $NS describe pod $POD | sed -n '/Events:/,$p'
```

Those three split most cases. Jump to the section matching your exit code.

| Exit code | reason | Usually this |
|---|---|---|
| `0` | Completed | The process exited normally — [A](#a-exit-code-0) |
| `1` / `2` | Error | The application failed on its own — [B](#b-exit-code-1-or-2) |
| `137` | OOMKilled | Memory limit exceeded — [C](#c-exit-code-137) |
| `137` | Error | SIGKILL after a failed liveness probe — [D](#d-137-but-not-oomkilled) |
| `139` | Error | Segfault — suspect an architecture mismatch (arm64/amd64) |
| `143` | Error | Got SIGTERM — something outside told it to stop |
| none | — | The container never started — [E](#e-no-exit-code-at-all) |

---

## A. Exit code 0

The main process finished its work and left. With `restartPolicy: Always` (the Deployment default) Kubernetes restarts that too.

```bash
kubectl -n $NS get pod $POD -o jsonpath='{.spec.containers[*].command} {.spec.containers[*].args}{"\n"}'
```

- Batch work deployed as a Deployment → **make it a Job or CronJob.**
- Entrypoint does not keep the daemon in the foreground → add the foreground flag: `nginx -g 'daemon off;'`, `php-fpm -F`.
- A shell wrapper backgrounds the process and exits → use `exec` so the process replaces the shell.

## B. Exit code 1 or 2

The application killed itself. The answer is in the logs.

```bash
kubectl -n $NS logs $POD --previous --tail=200
kubectl -n $NS logs $POD --previous --all-containers
```

Empty logs mean it **died before configuration was injected**. Check these next.

```bash
# do the referenced ConfigMaps/Secrets actually exist
kubectl -n $NS get pod $POD -o jsonpath='{range .spec.volumes[*]}{.configMap.name}{" "}{.secret.secretName}{"\n"}{end}'
kubectl -n $NS get cm,secret
```

The three usual suspects:

1. **Missing required env var** — a typo in the `envFrom` ConfigMap name. `CreateContainerConfigError` shows up in the events alongside it.
2. **Exits immediately after failing to reach a dependency** — wrong DB/Redis address, or it is not up yet. See below.
3. **Migration failure** — init logic fails and exits 1. The stack trace is usually in the first 20 log lines.

### Checking dependencies

```bash
kubectl -n $NS run netcheck --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'nslookup <SERVICE>.<NS>.svc.cluster.local; nc -zv <SERVICE> <PORT>'
```

If DNS fails, start at CoreDNS.

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

## C. Exit code 137

With `reason: OOMKilled` the kernel did it. The application log shows **nothing at all** — that absence is what distinguishes this from B.

```bash
kubectl -n $NS get pod $POD -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.limits.memory}{"\t"}{.resources.requests.memory}{"\n"}{end}'
kubectl -n $NS top pod $POD --containers
```

In order:

1. **Is the limit below real usage?** Set it to peak plus about 30%. Do not keep doubling it without evidence.
2. **Does the JVM/Node.js heap setting know about the container limit?** This is the real cause more often than the limit itself.
   - JVM: `-XX:MaxRAMPercentage=75.0` (sizes the heap against the container limit)
   - Node.js: `--max-old-space-size=<75% of the limit, in MB>`
3. **Is it an actual leak?** If the interval between restarts shortens steadily, it is a leak. Raising the limit only moves the incident later.

If the whole node is under memory pressure, this is not a per-pod problem.

```bash
kubectl describe node <NODE> | grep -iE "MemoryPressure|Allocated" -A4
```

→ consider adding capacity via [[k8s-node-drain-replace]].

## D. 137 but not OOMKilled

The liveness probe failed and kubelet killed the container. The events always carry `Liveness probe failed`.

```bash
kubectl -n $NS describe pod $POD | grep -iE "liveness|readiness|startup" -A3
```

Nearly always the probe is **shorter than the application's startup time**. The application is fine; the probe will not wait for it.

```yaml
# For slow starters, use startupProbe rather than stretching initialDelaySeconds.
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30        # allows up to 150s to come up
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3
```

Also check:

- Does the liveness endpoint hit the database? If so, a slow DB restarts the entire application in a loop. **Liveness is about the process being alive; readiness is where dependencies belong.**
- Do the port and path match what the process actually listens on?
- `timeoutSeconds` defaults to 1 — will that hold under load?

## E. No exit code at all

The container was blocked before it ran. `Reason` in `describe` names it.

| Reason | Cause | Check |
|---|---|---|
| `ImagePullBackOff` / `ErrImagePull` | image missing, tag typo, credentials | `imagePullSecrets` in `kubectl -n $NS get sa <SA> -o yaml` |
| `CreateContainerConfigError` | ConfigMap/Secret key missing | last lines of `kubectl -n $NS describe pod $POD` |
| `CreateContainerError` | entrypoint file missing or not executable | `docker run` the image locally |
| `Init:CrashLoopBackOff` | an initContainer is dying | `kubectl logs $POD -c <INIT_NAME>` |
| `Pending` (never started) | cannot be scheduled | see below |

When scheduling is the problem:

```bash
kubectl -n $NS describe pod $POD | grep -A10 "Events:"
# "0/5 nodes are available: 3 Insufficient cpu, 2 node(s) had untolerated taint"
```

The message states the cause directly — an oversized request, a taint with no matching toleration, or a node selector pointing at a label nobody has.

## Getting inside a container that keeps dying

You cannot `exec` into a container in CrashLoop. Bring up the same environment with the entrypoint replaced.

```bash
kubectl -n $NS debug $POD -it --image=busybox --target=<CONTAINER> -- sh
```

If `debug` is unavailable, copy the manifest and run a separate pod with a different command. **Do not edit the production Deployment's command to insert a sleep** — forgetting to revert it and shipping that has happened more than once.

## Leave this behind

Once you have the cause, write one entry. You will meet this symptom again in three months.

```markdown
- Symptom: <service> pod in CrashLoopBackOff, exit code 137
- Cause: JVM did not see the container memory limit, sized the heap against node memory
- Fix: added -XX:MaxRAMPercentage=75.0, kept limits.memory at 2Gi
- Prevention: rolled into the shared JAVA_OPTS in the base image
```

## Follow-ups

- [ ] List the services whose liveness probe reaches an external dependency 📅 2026-08-14
- [ ] Add an alert on OOMKilled events (`kube_pod_container_status_last_terminated_reason`)

## Related

[[k8s-node-drain-replace]] — a wave of CrashLoops right after a node swap usually points at the node, not the app.
[[argocd-helm-ha-install]] — with `selfHeal: true`, anything you patch by hand gets reverted. Fix Git first.
