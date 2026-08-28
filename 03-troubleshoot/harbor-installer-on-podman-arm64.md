---
title: Harbor on Apple Silicon — three fixable failures, then one that is not
date: 2026-08-27
domain: troubleshoot
tags: [registry, containers, podman, arm64, harbor]
stack: [harbor, podman, docker-compose, qemu]
summary: Harbor's online installer stops four times on rootless podman under arm64. Three are configuration and have one-line fixes; the fourth is that goharbor publishes amd64-only images and redis-photon segfaults under qemu, leaving harbor-core in a permanent 502. Recorded so the next person spends ten minutes rather than an afternoon.
source: handson
env: Harbor v2.15.2 online installer · Podman 5.7.1 (rootless, podman-machine 6 GB) · docker-compose 5.3.1 · macOS 14.7.5 on Apple Silicon (arm64)
verified: 2026-08-27
verifiability: partial
verifiability-note: Every failure below was reproduced on this machine and diagnosed to a specific cause. The conclusion is negative — Harbor did not come up — so the three fixes are verified only in the sense that each unblocked the next step; they are not verified as sufficient on an amd64 host, where the fourth failure would not occur. Harbor's own features (projects, scanning, replication, quotas) are entirely unexercised.
duration: 30–45 min to reproduce
risk: low
---

> **Verified 2026-08-27.** Nine containers started and the portal answered `200`, and the API never
> did. The stopping point is real and is not a configuration mistake — the evidence is at the end.

This is a **negative result**, written down because the failures are staged: each one has to be fixed
before the next appears, so the fourth is four fixes away from anyone who starts here. If you are on
an amd64 host, the first three are still the ones you will hit.

## Symptom

`./install.sh` from the Harbor online installer fails, repeatedly, at a different place each time.
On the fourth run all nine containers start, `http://<host>:8090/` serves the portal, and every API
call returns `502`.

## Branch 1 — `127.0.0.1 can not be the hostname`

```
Error happened in config validation...
ERROR:root:127.0.0.1 can not be the hostname
```

**Cause.** `harbor.yml.tmpl` says so in a comment, and `prepare` enforces it:

```yaml
# The IP address or hostname to access admin UI and registry service.
# DO NOT use localhost or 127.0.0.1, because Harbor needs to be accessed by external clients.
hostname: reg.mydomain.com
```

The hostname is baked into what the registry returns to clients, so a loopback address would be
meaningless to anyone else. Harbor refuses rather than letting you find out later.

**Fix.** Use a real address of the host:

```bash
ipconfig getifaddr en0        # e.g. 192.168.4.49
```

```yaml
hostname: 192.168.4.49
```

**Check.** `prepare` gets past validation and starts creating containers.

## Branch 2 — `mkdir /var/log/harbor/: permission denied`

```
Error response from daemon: make cli opts(): making volume mountpoint for volume
  /var/log/harbor/: mkdir /var/log/harbor/: permission denied
```

**Cause.** Harbor bind-mounts a host log directory, and its default is a root-owned system path.
**Rootless podman runs as you**, so it cannot create `/var/log/harbor`.

**Fix.** Point it somewhere writable, in `harbor.yml`:

```yaml
log:
  local:
    location: /tmp/harbor-log      # default: /var/log/harbor
```

```bash
mkdir -p /tmp/harbor-log
```

**Check.** `harbor-log` reaches `Created` rather than erroring.

## Branch 3 — `invalid log driver: invalid argument`

```
service:redis:1 Error response from daemon: container create: running container create option:
  invalid log driver: invalid argument
```

**Cause.** `prepare` generates a `docker-compose.yml` in which eight of the ten services log through
the `harbor-log` container:

```yaml
    logging:
      driver: "syslog"
      options:
        syslog-address: "tcp://localhost:1514"
        tag: "registry"
```

**Podman does not implement the `syslog` log driver** (it offers `k8s-file`, `journald`, `passthrough`
and `none`). The message names neither the driver nor the service, which is what makes it slow to
place.

**Fix.** Strip the logging blocks from the generated compose file — after `prepare`, before `up`:

```python
new = re.sub(r"\n    logging:\n      driver: \"syslog\"\n      options:\n"
             r"        syslog-address: \"tcp://localhost:1514\"\n        tag: \"[^\"]*\"", "", s)
```

```
  logging blocks removed: 8
```

**Cost of the fix, stated plainly:** container logs stop being aggregated into `harbor-log` and go to
podman instead, so `harbor-log` becomes an idle container and Harbor's own log-collection story is
gone. For a lab that is fine. It is not a fix for a deployment.

**Check.** All nine containers reach `running`.

## Branch 4 — everything is up and the API is 502

```
  harbor-log     Up (healthy)      registry     Up (healthy)
  harbor-db      Up (healthy)      registryctl  Up (healthy)
  harbor-portal  Up (healthy)      nginx        Up (healthy)
  redis          Up (unhealthy)
  harbor-core    Up (starting)     harbor-jobservice Up (starting)
```

```
  http://192.168.4.49:8090/   -> 200      (the portal)
  /api/v2.0/users/current     -> 502      (everything else)
```

**A healthy-looking stack serving a login page it can never authenticate against.** `harbor-core`
says why:

```
failed to ping redis://redis:6379?idle_timeout_seconds=30, retry after 8.6s :
  dial tcp 10.89.3.6:6379: connect: connection refused
```

and redis says why that is:

```
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
```

**Cause.** goharbor publishes **amd64-only** images:

```
  host arch: arm64
  goharbor/harbor-core:v2.15.2   amd64/linux
  goharbor/harbor-db:v2.15.2     amd64/linux
```

They run under qemu emulation on Apple Silicon, and `redis-photon` segfaults there. Most of the stack
tolerates emulation; redis does not. **This is not a configuration problem and there is no
`harbor.yml` key that addresses it.**

## Where this leaves you

| Host | Branches 1–3 | Branch 4 |
|---|---|---|
| amd64 Linux, rootful docker | not hit (docker supports `syslog`, root can create `/var/log/harbor`) | not hit |
| amd64 Linux, rootless podman | **hit** — all three fixes apply | not hit |
| arm64 macOS, podman | **hit** | **hit — stops here** |

The honest options on Apple Silicon are a remote amd64 host, a Linux VM that is genuinely x86_64, or
a different registry. **[[minio-object-storage-onprem]] plus a plain `registry:2` covers the storage
half**, and `registry:2` is multi-arch; what you lose is everything Harbor exists for — projects,
RBAC, scanning, replication, retention.

## Where this bit us

**Three of the four failures were made harder by their own error messages.** `invalid log driver:
invalid argument` names neither the driver nor which of the ten services carries it. `mkdir
/var/log/harbor/: permission denied` is clear about the path and silent about the fact that it is
configurable. Only the hostname check says what to do — and that one is the check Harbor was
criticised for being too strict about.

**The most expensive part was that the stack looked healthy.** Nine containers `running`, seven of
them `healthy`, and a portal returning `200`. If the check had been "does `docker-compose ps` look
right", this would have been called a successful install. **The check that catches it is an
authenticated API call**, which is the first thing that touches core, redis and the database
together:

```bash
curl -s -o /dev/null -w '%{http_code}' -u "admin:$PW" "http://$HOST:8090/api/v2.0/users/current"
```

**Harbor's own preflight has a shell bug that silently never runs.** In `common.sh`:

```bash
if [! docker compose version] &> /dev/null || [! docker-compose --version] &> /dev/null
```

`[!` is not a command, so both tests error, the output is discarded, the condition is false and the
"you need docker-compose" branch is unreachable. It happens not to matter — the `elif` chain below
does the real detection — but a preflight that cannot fail is not a preflight, which is the same
point [[pod-crashloopbackoff]] makes about checks in general.

## Follow-ups

- [ ] Run the identical installer on an amd64 host and confirm branches 1–3 are the whole story there
- [ ] Try Harbor's Helm chart on an arm64 Kubernetes cluster, where the images are pulled per component and a redis of your own can be substituted
- [ ] Substitute a multi-arch `redis:7` for `redis-photon` in the generated compose and see whether Harbor is otherwise emulation-tolerant — the single change that would settle whether redis is the only blocker
- [ ] Report the `common.sh` preflight bug upstream, as was done for [[walgit-git-server-on-object-storage]]'s two
- [ ] Stand up `registry:2` behind [[ingress-nginx-onprem]] as the fallback this page recommends, and record what is actually lost

## Related

[[gitea-selfhosted-git-server]] — a self-hosted forge that does publish arm64 images, for contrast.
[[minio-object-storage-onprem]] — the storage half of a registry, without Harbor.
[[packer-image-build-local]] — the other place this repo hit an architecture assumption baked into a tool.
[[pod-crashloopbackoff]] — the same lesson about a component that starts and is not working.
