---
title: Shrinking a container image 123× — and the two endpoints that stopped working
date: 2026-09-09
domain: install
tags: [containers, dockerfile, supply-chain, images]
stack: [podman, docker, golang, distroless]
summary: The same Go service built five ways, from a 1.03 GB single-stage image down to 8.37 MB on scratch. The small one passes its health check and cannot make an HTTPS call or read a timezone, both silently. Making it actually work costs under two megabytes, and the number that governs pull time turns out to be the 351 MB compressed transfer rather than the gigabyte on disk.
source: handson
env: Podman 5.7.1 (arm64, macOS 26.6.2) · golang:1.24 · gcr.io/distroless/static-debian12:nonroot · alpine 3.20 · registry:2
verified: 2026-09-09
verifiability: partial
verifiability-note: One Go service on one arm64 machine. The pull-time claim is measured as compressed transfer bytes read from a registry manifest rather than as wall-clock pull time, because a local registry has no network latency and the layer cache made a timed pull meaningless — so the ratio is exact and the seconds are not measured here. Nothing exercises a real cluster, an image scanner, or a language whose runtime cannot be statically linked.
duration: 60–90 min
risk: low
---

> **Verified 2026-09-09.** Every size and response below came from building and running the five
> images described. The numbers are this service's, not a quoted benchmark.

The advice is well known and correct: a single-stage build ships the compiler, and a multi-stage build
does not. **The part that is usually left out is what the small image can no longer do**, and it does
not announce it — the service starts, answers its health check, and fails at the first outbound call.

The service here is the one the advice is usually told about: a thing that answers whether a request
is logged in.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Podman | `podman --version` | 5.x |
| Base images | `podman manifest inspect docker.io/library/golang:1.24` | includes your architecture |

## 1. A service with more than one job

A health endpoint alone cannot show the problem, because the health endpoint is the thing that keeps
working.

```go title="main.go"
// The realistic part of "is this user logged in": ask the identity provider.
http.HandleFunc("/verify", func(w http.ResponseWriter, r *http.Request) {
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get("https://www.google.com/generate_204")
	...
})

// Session expiry is written in a business timezone, not in UTC.
http.HandleFunc("/expires", func(w http.ResponseWriter, r *http.Request) {
	loc, err := time.LoadLocation("Asia/Seoul")
	...
})

http.HandleFunc("/whoami", func(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "uid=%d gid=%d\n", os.Getuid(), os.Getgid())
})
```

**Four endpoints, because the interesting result is that they do not all survive the same change.**

## 2. The two Dockerfiles

```dockerfile title="Dockerfile.naive"
FROM docker.io/library/golang:1.24
WORKDIR /app
COPY . .
RUN go build -o server .
CMD ["./server"]
```

```dockerfile title="Dockerfile.scratch"
FROM docker.io/library/golang:1.24 AS build
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o server .

FROM scratch
COPY --from=build /app/server /server
CMD ["/server"]
```

`CGO_ENABLED=0` is not decoration. Without it the binary links against glibc, and `scratch` has no
glibc — the image builds and the container exits immediately.

```
  build naive   38s      1.03 GB
  build scratch 12s      8.37 MB
```

**123 times smaller, and the second build is three times faster** because it does not carry the base
layer into the final image.

## 3. What the small image cannot do

Run both and ask all four endpoints:

```
  variant     /healthz  /whoami       /expires                          /verify
  naive       ok        uid=0 gid=0   expires: 2026-09-10T08:14:32+09:00  upstream ok: 204
  scratch     ok        uid=0 gid=0   tz error: unknown time zone …       upstream error: tls: failed
                                                                          to verify certificate
```

**The health check passes on the broken image.** That is the whole problem in one line: the check most
teams wire into their readiness probe is the one endpoint that has no dependencies, so it reports
healthy on a container that cannot reach anything.

Two things `scratch` does not have, and neither failure appears at build time:

- **No CA bundle.** `/etc/ssl/certs/ca-certificates.crt` does not exist, so every outbound HTTPS call
  fails certificate verification. A service that only receives requests will never notice; one that
  validates a token against an identity provider fails on its first real request.
- **No timezone database.** `time.LoadLocation` can only read `/usr/share/zoneinfo`, which is absent.
  UTC keeps working, which is exactly why this survives testing.

And one thing that did not change:

```
  naive    uid=0 gid=0
  scratch  uid=0 gid=0
```

**Both run as root.** The claim that a smaller image gives an attacker less is true about tools and
false about privilege — `scratch` removes the shell and keeps the root user. Being unable to exploit a
shell that was never shipped is worth having; it is not the same as dropping privileges, and the two
are easy to conflate.

## 4. What working costs

```dockerfile title="Dockerfile.fixed"
FROM scratch
# The three things scratch does not have and a network service needs.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=build /etc/passwd /etc/passwd
USER 65534:65534
COPY --from=build /app/server /server
CMD ["/server"]
```

There is a smaller variant for the timezone half — `import _ "time/tzdata"` embeds the database in the
binary instead of the image — and a ready-made base that arrives with all of it:

```dockerfile title="Dockerfile.distroless"
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /app/server /server
CMD ["/server"]
```

```
  variant      size      /healthz  /expires  /verify   uid
  naive        1.03 GB   ok        ok        204       0
  scratch      8.37 MB   ok        FAIL      FAIL      0
  tzembed      9.05 MB   ok        ok        204       0
  fixed        9.62 MB   ok        ok        204       65534
  distroless   11.6 MB   ok        ok        204       65532
```

**Working costs between 0.7 and 3.2 MB.** The famous eight-megabyte number is the size of an image
that cannot make an HTTPS call; the honest range for a service that can is nine to twelve, which is
still about a hundred times smaller than where it started.

**`distroless:nonroot` was the only variant that dropped privileges without being told to** — there is
no `USER` line in its Dockerfile above. Three megabytes over hand-assembled `scratch` buys the CA
bundle, the timezone data, a non-root user and `/etc/passwd`, maintained by someone else.

## 5. The number that decides pull time is not the one everyone quotes

The argument for small images is that a new pod starts serving sooner. That is governed by bytes
transferred, and `podman images` does not report bytes transferred — it reports the uncompressed size
on disk. Pushing each variant to a local registry and reading the manifest gives the real figure:

```
  variant      on disk    layers   compressed transfer
  naive        1.03 GB         9              351.09 MB
  scratch      8.37 MB         1                4.79 MB
  fixed        9.62 MB         4                5.11 MB
  distroless   11.6 MB        13                5.54 MB
```

**A gigabyte on disk is 351 MB on the wire.** The improvement is real and it is 69×, not the 123× the
disk figures suggest — quoting the disk number to argue about pull time overstates the case by a
factor of about two, on the side that makes the argument look better.

Layer count is not a proxy either: `distroless` has thirteen layers and transfers less than `fixed`,
which has four.

The push times are consistent with this, on an empty local registry:

```
  push naive 23s · scratch 0s · fixed 1s · distroless 0s
```

**These seconds are a floor, not a prediction.** A local registry has no network between it and the
client; a real node pulls over a network from a registry that may be rate-limiting it. The transfer
bytes above are the part that carries over.

## Verification checklist

- [x] `golang:1.24` single-stage builds to **1.03 GB**; the multi-stage `scratch` build to **8.37 MB**
- [x] The scratch build finishes in **12s against 38s**
- [x] Both images answer `/healthz` with `ok` — the health check does not distinguish them
- [x] The scratch image fails `/verify` with **`tls: failed to verify certificate`** and `/expires` with **`unknown time zone Asia/Seoul`**
- [x] Neither failure appears at build time or at container start
- [x] `naive` and `scratch` both report **`uid=0 gid=0`**; smaller did not mean less privileged
- [x] Copying the CA bundle, `zoneinfo` and `/etc/passwd` restores both endpoints at **9.62 MB**
- [x] `import _ "time/tzdata"` restores the timezone half at **9.05 MB** without shipping `/usr/share/zoneinfo`
- [x] `distroless/static-debian12:nonroot` works at **11.6 MB** and runs as **65532 with no `USER` line**
- [x] Compressed transfer is **351.09 MB against 5.11 MB** — a 69× ratio, not the 123× the disk sizes imply
- [x] Layer count does not track transfer size: 13 layers at 5.54 MB against 4 layers at 5.11 MB

## Rollback

```bash
podman rm -f reg
podman rmi -f authcheck:naive authcheck:scratch authcheck:fixed authcheck:distroless authcheck:tzembed
```

## Where this bit us

**The first pull-time measurement said a gigabyte downloaded in zero seconds.** `podman rmi` removes
the tag and leaves the layer blobs in the local store, so the next `pull` reuses them and reports
success instantly. The number was absurd enough to disbelieve — the push of the same image had taken
23 seconds — and `--root` for an isolated store turns out not to exist on the macOS client, which is
what pushed the measurement to compressed transfer bytes instead. **That is the better metric anyway**,
because it does not depend on what happens to be cached on the machine doing the measuring.

**A registry that never started looked like a registry rejecting requests.** `curl http://127.0.0.1:5000/v2/`
returned `403 Forbidden`, which reads as an authentication problem. The container was stuck in
`Created` because the port was already bound:

```
  lsof -nP -iTCP:5000 -sTCP:LISTEN  ->  ControlCe (pid 1269)
  Server: AirTunes/960.13.1
```

**macOS AirPlay Receiver holds port 5000 and answers HTTP.** On a Mac, a registry, a Flask default and
an MLflow server all collide with it, and all three get an answer that is not from them.

**The Dockerfile as it usually arrives does not build.** Copied out of an article or a chat, the line
breaks are lost and it becomes `WORKDIR /appCOPY . .` and `FROM scratchCOPY --from=build …`:

```
  Error: FROM requires either one argument, or three: FROM <source> [AS <name>]
```

Worth knowing because the error names `FROM`, several lines away from the `WORKDIR` that actually
swallowed its neighbour.

## Follow-ups

- [ ] Measure a real pull over a network from a remote registry, which is the number this page reasons about and does not have
- [ ] Repeat with a runtime that cannot be statically linked — a JVM or Python service — where `scratch` is not an option and the interesting comparison is `distroless` against `alpine`
- [ ] Run an image scanner across all five variants and record the CVE count, since "less to attack" is asserted here and not measured
- [ ] Check whether the readiness probe can be made to catch the broken image — an endpoint that touches TLS and the clock would have failed where `/healthz` passed
- [ ] Measure how much of the 351 MB is the layer cache actually re-downloading on a redeploy, since unchanged base layers are not transferred twice

## Related

[[harbor-installer-on-podman-arm64]] — the registry this would be pushed to, and where it stopped.
[[nexus-repository-hosted-proxy-docker]] — the other registry, hosting and proxying the same images.
[[gitlab-ci-argocd-fastapi-onprem]] — where an image size becomes a deploy time in a pipeline.
[[cka-workloads-scheduling-drills]] — the `ImagePullBackOff` this page's failure mode does *not* produce, since a broken-but-small image pulls fine.
