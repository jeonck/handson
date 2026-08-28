---
title: Nexus Repository — three repository types, and a login that lies about your password
date: 2026-08-28
domain: install
tags: [artifacts, registry, proxy, containers, devsecops]
stack: [nexus, npm, docker, podman, docker-compose]
summary: Nexus 3.87 Community with a hosted raw repository, an npm proxy and a Docker registry. Blocking the proxy's upstream proved the cache — the fetched package still returned 200 and an unfetched one 404 — and `podman login` reported "invalid username/password" for credentials that worked over curl, because an auth realm was switched off.
source: handson
env: Nexus Repository OSS 3.87.1 (Community) · podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-28
verifiability: partial
verifiability-note: One node, HTTP only, on loopback, with the built-in admin user. Hosted upload, proxy caching with the upstream deliberately blocked, and a Docker push through the connector all ran. Cleanup policies, blob store sizing and compaction, group repositories, LDAP and content selectors are unexercised — and the Community edition's EULA gate, described below, was accepted deliberately for this lab.
duration: 45–70 min
risk: low
---

> **Verified 2026-08-28.** Every status code below came from a running instance. The proxy cache was
> proven by taking the upstream away rather than by observing a second fetch being quick.

An artifact repository does three different jobs, and Nexus names them as three repository types:
**hosted** stores what you build, **proxy** caches what you consume, and a **group** presents several
as one. Getting each to actually do its job took a different obstacle out of the way.

## Bringing it up

```yaml title="compose.yml"
services:
  nexus:
    image: docker.io/sonatype/nexus3:3.87.1
    environment:
      # Nexus is a JVM app; the default heap is larger than a laptop wants.
      INSTALL4J_ADD_VM_PARAMS: "-Xms1g -Xmx1g -XX:MaxDirectMemorySize=2g"
    volumes:
      - nexus-data:/nexus-data
    ports:
      - "8081:8081"     # UI and the repository API
      - "8082:8082"     # a docker registry connector, configured below
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8081/service/rest/v1/status || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 40
      start_period: 60s
```

```
  status: 200 after 40s
```

**The initial password is generated, not defaulted.** It is written into the data volume on first
boot and the account is flagged to change it:

```bash
podman exec nexus-lab-nexus-1 cat /nexus-data/admin.password
```

```
  generated password: <REDACTED, 36 chars>

  user anonymous  status=active           roles=['nx-anonymous']
  user admin      status=changepassword   roles=['nx-admin']
```

```bash
curl -u "admin:$GENERATED" -X PUT -H 'Content-Type: text/plain' --data "$NEW" \
  http://127.0.0.1:8081/service/rest/v1/security/users/admin/change-password
```

```
  change-password: 204
  admin status now: active
```

**Before the repositories will do anything, the Community edition wants its licence accepted** — see
[Where this bit us](#where-this-bit-us). It is one call and it is a legal agreement, so it is a
decision rather than a step:

```bash
curl -u "admin:$PW" -X POST -H 'Content-Type: application/json' \
  -d '{"accepted": true, "disclaimer": "<the text the GET returns>"}' \
  http://127.0.0.1:8081/service/rest/v1/system/eula
```

## Hosted — where your own builds go

```bash
curl -u "admin:$PW" -X POST -H 'Content-Type: application/json' -d '{
  "name":"raw-hosted","online":true,
  "storage":{"blobStoreName":"default","strictContentTypeValidation":true,"writePolicy":"ALLOW"},
  "raw":{"contentDisposition":"ATTACHMENT"}}' \
  http://127.0.0.1:8081/service/rest/v1/repositories/raw/hosted
```

```bash
curl -u "admin:$PW" --upload-file artifact.txt \
  http://127.0.0.1:8081/repository/raw-hosted/team/app/1.0.0/artifact.txt
```

```
  PUT -> 201
  GET: build output 2026-08-28T15:59:58Z (200)
```

**The path in the URL is the path in the repository.** A `raw` repository imposes no layout, which
makes it the right choice for build outputs that are not a package format and the wrong choice when
a real format exists — `maven2`, `npm` and the rest enforce coordinates and metadata that `raw`
cannot.

## Proxy — where everyone else's builds come from

```bash
curl -u "admin:$PW" -X POST -H 'Content-Type: application/json' -d '{
  "name":"npm-proxy","online":true,
  "storage":{"blobStoreName":"default","strictContentTypeValidation":true},
  "proxy":{"remoteUrl":"https://registry.npmjs.org","contentMaxAge":1440,"metadataMaxAge":1440},
  "negativeCache":{"enabled":true,"timeToLive":1440},
  "httpClient":{"blocked":false,"autoBlock":true}}' \
  http://127.0.0.1:8081/service/rest/v1/repositories/npm/proxy
```

A proxy starts empty and fills on demand:

```
  components before: 0
  fetch left-pad -> 200
  components after:  1
    cached: /left-pad/-/left-pad-1.3.0.tgz
```

**A second fetch being fast proves nothing** — it could be the upstream being fast. Take the upstream
away instead:

```bash
# httpClient.blocked = true
```

```
  already-cached package:  200
  never-fetched package:   404
```

**That is the check worth keeping.** With no route to npm at all, the package Nexus had already seen
still serves and one it has not is a miss. This is the property the whole repository exists for —
your builds keep working when the registry outside does not — and it is the one nobody tests until
the day it matters.

## Docker — a registry on its own port

Docker repositories in Nexus need a **connector**, a second HTTP port that speaks the registry API:

```json
"docker": {"v1Enabled": false, "forceBasicAuth": false, "httpPort": 8082}
```

```
  connector on 8082: 401
  with credentials:  200
```

That looks finished and is not — `podman login` fails against it until an auth realm is switched on,
for the reason in [Where this bit us](#where-this-bit-us). Once it is:

```bash
podman push --tls-verify=false 127.0.0.1:8082/team/alpine:1.0.0
```

```
  {"repositories":["team/alpine"]}
  {"name":"team/alpine","tags":["1.0.0"]}
  team/alpine:1.0.0  (1 assets)
```

**The same artifact is visible through two different APIs** — the Docker registry API on 8082 and
Nexus's own component API on 8081. That is the point of putting images in the same system as
everything else: one place to search, one place to apply retention, one place to back up.

## Verification checklist

- [x] The first-boot password is a **generated 36-character file** in the data volume, and admin is flagged `changepassword`
- [x] An unauthenticated caller gets `200` and an **empty list** from `/service/rest/v1/repositories` while admin sees 10
- [x] An unauthenticated repository fetch is refused `401`
- [x] With the EULA unaccepted, repositories **create successfully** and every operation on them returns `403`
- [x] After accepting, a raw upload returns `201` and the download returns the exact bytes
- [x] A proxy repository holds **0 components** until something is fetched through it, then 1
- [x] With the upstream **blocked**, the cached package returns `200` and an unfetched one `404`
- [x] `podman login` fails with `invalid username/password` for credentials that curl accepts, until `DockerToken` is an active realm
- [x] After enabling it, `Login Succeeded!` and a push is visible through both the `/v2/` API and Nexus's component API

## Rollback

```bash
podman compose down -v
```

## Where this bit us

**Nexus Community accepts your configuration and then refuses to serve it.** Creating three
repositories over the API all returned `201`. Using any of them:

```
403 You must accept the End User License Agreement (EULA) through the onboarding
    wizard or REST API before proceeding.
```

**The gate is on the data path, not the control plane**, so an automated setup can appear to succeed
completely — repositories created, users made, everything green — and produce an instance that
cannot store or serve a single artifact. The message is clear once you see it, and you only see it
when something tries to use the thing. Anyone scripting a Nexus install should call
`/service/rest/v1/system/eula` first and treat it as a prerequisite rather than a step, because it is
a licence decision that belongs to a person.

**`podman login` reported the wrong problem.**

```
Error: logging into "127.0.0.1:8082": invalid username/password
```

The credentials were correct — the same pair had just returned `200` from `curl -u` against
`/v2/` on the same port. What was missing is the realm:

```
  active realms: ['NexusAuthenticatingRealm']
```

Docker clients authenticate with a **bearer token flow**, which Nexus implements in a separate,
**off-by-default** realm. Turning it on changes nothing about the password and everything about the
result:

```bash
curl -u "admin:$PW" -X PUT -H 'Content-Type: application/json' \
  -d '["NexusAuthenticatingRealm","DockerToken"]' \
  http://127.0.0.1:8081/service/rest/v1/security/realms/active
```

```
  Login Succeeded!
```

**An authentication error that names the credentials when the credentials are fine is the worst
possible message**, because it sends you to rotate a password that was never the problem. The tell is
that `curl -u` works while the Docker client does not — different auth mechanisms, one of them
disabled. (`forceBasicAuth: true` on the repository is the other way out, and it makes the registry
speak basic auth instead.)

**An unauthenticated caller is told there are no repositories, rather than being refused.**

```
  anonymous sees: 0 repositories
  admin sees:     10 repositories
```

The REST list endpoint returns `200` with an empty array to a caller with no permissions — it does
not `401`. Fetching from a repository does `401`, so the API is inconsistent between listing and
reading. **A provisioning script that verifies its work against an unauthenticated endpoint will
conclude nothing was created**, and re-create it, and still see nothing. The same shape as
[[opensearch-mappings-and-templates]]'s protected system indices: an empty success is
indistinguishable from a refusal until you compare it against an authenticated call.

**Nexus 3.87 ships default repositories, and they arrive late.** `maven-central`, `maven-public`,
`nuget.org-proxy` and four others exist without being asked for. They appear after the status
endpoint already reports `200`, so a script that lists repositories immediately after start-up sees a
different set than one that waits — worth knowing before writing an assertion about how many there
should be.

## Follow-ups

- [ ] Add a `group` repository over the hosted and proxy npm repositories, which is the third type this page names and does not build
- [ ] Set a cleanup policy on the proxy and confirm unused cached components are actually removed, rather than trusting that they will be
- [ ] Point [[gitlab-ci-argocd-fastapi-procedure]]'s pipeline at the Docker repository here instead of the GitLab registry
- [ ] Serve it over TLS and drop `--tls-verify=false`, since a registry reached over plain HTTP is a credential on the wire
- [ ] Compare the blob store's size against the sum of components after a few hundred artifacts, to see what compaction is for
- [ ] Take a Nexus backup and restore it into an empty instance, the way [[gitea-selfhosted-git-server]] did — the blob store and the database are separate here too

## Related

[[harbor-installer-on-podman-arm64]] — the registry this could not be on Apple Silicon, and why.
[[gitea-selfhosted-git-server]] — the same disk-plus-database shape, and what a backup of it has to contain.
[[gitlab-ci-argocd-fastapi-procedure]] — the pipeline that would push here.
[[opensearch-mappings-and-templates]] — the other page where an empty `200` meant "not allowed" rather than "nothing there".
