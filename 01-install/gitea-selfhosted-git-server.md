---
title: Gitea — where the repository actually lives, and what a deleted database row costs
date: 2026-08-27
domain: install
tags: [git, self-hosting, postgresql, backup, containers]
stack: [gitea, postgresql, git, podman, docker-compose]
summary: Gitea with PostgreSQL, from an empty volume to a pushed repository, then taken apart. Deleting one database row left an intact bare repo on disk that no client could clone — and adopting it back produced repository id 2, with a watch row still pointing at the id that no longer exists.
source: handson
env: Gitea 1.24.7 · PostgreSQL 17 (alpine) · git 2.51.0 client · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-27
verifiability: partial
verifiability-note: A single Gitea container against one PostgreSQL container over HTTP on loopback, with token auth. Push, clone, on-disk layout, the dump format, database/disk divergence and the adopt recovery path all ran. SSH access, Gitea Actions, LFS, federation, mirroring, HA behind a proxy and a restore from `gitea dump` into a fresh instance are unexercised — the dump was taken and inspected but not replayed.
duration: 45–70 min
risk: low
---

> **Verified 2026-08-27.** Every id, count and error below came from a running pair of containers.
> The database row was deleted on purpose, and the repository that disappeared is the point of the
> page.

[[walgit-git-server-on-object-storage]] puts the repository in a bucket and calls the disk a cache.
Gitea is the conventional design it is arguing against: **bare git repositories on a filesystem, and
a relational database that says which of them exist.** Both are reasonable; they fail differently,
and the difference only becomes concrete when you break one on purpose.

## Two containers

```yaml title="compose.yml"
services:
  db:
    image: docker.io/library/postgres:17-alpine
    environment:
      POSTGRES_USER: gitea
      POSTGRES_DB: gitea
      POSTGRES_PASSWORD: ${GITEA_DB_PASSWORD:?set it before compose up}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gitea -d gitea"]
      interval: 5s
      timeout: 3s
      retries: 20

  gitea:
    image: docker.io/gitea/gitea:1.24
    environment:
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: db:5432
      GITEA__database__PASSWD: ${GITEA_DB_PASSWORD:?set it before compose up}
      GITEA__server__ROOT_URL: http://127.0.0.1:3000/
      # Without this the first visitor gets the install wizard and becomes admin.
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__service__DISABLE_REGISTRATION: "true"
    volumes:
      - gitea-data:/data
    ports: ["3000:3000"]
    depends_on:
      db: {condition: service_healthy}
```

**`GITEA__section__KEY` writes straight into `app.ini`**, which is what makes Gitea configurable from
compose without templating a config file. The double underscore is the section separator.

**`INSTALL_LOCK` is the one that matters before anything is exposed.** Without it Gitea serves the
setup wizard to whoever arrives first, and completing it creates the administrator — so an instance
reachable for the few minutes between `up -d` and your own first visit is an instance someone else
can own. Setting it means the wizard never runs, which is why the admin has to be made another way:

```bash
gitea admin user create --username labadmin --password '<REDACTED>' \
  --email labadmin@example.com --admin --must-change-password=false
```

```
New user 'labadmin' has been successfully created!
```

```
  healthz: 200
  {"version":"1.24.7"}
```

## A repository, and where its parts go

```bash
curl -X POST -H "Authorization: token $TOKEN" \
  -d '{"name":"app","private":false,"auto_init":false}' \
  http://127.0.0.1:3000/api/v1/user/repos

git -c http.extraHeader="Authorization: token $TOKEN" \
    push http://127.0.0.1:3000/labadmin/app.git main
```

```
  created: labadmin/app | clone: http://127.0.0.1:3000/labadmin/app.git
  remote: . Processing 1 references
  remote: Processed 1 references in total
```

On disk it is exactly what it looks like:

```
/data/git/repositories/labadmin/app.git/
  HEAD  config  description  hooks/  info/  objects/  refs/  logs/
  git-daemon-export-ok
```

```
  commits: 2
  be50ae7 second commit
  589071e first commit
  refs:
    refs/heads/main be50ae7
```

**No custom format anywhere** — `git log` inside the container works because it is an ordinary bare
repository. Run it as the `git` user, not root, or git refuses it as dubious ownership.

And in PostgreSQL:

```
  tables: 112

   id | owner_name | name | is_private | num_stars | num_forks
  ----+------------+------+------------+-----------+-----------
    1 | labadmin   | app  | f          |         0 |         0
```

**Those two things together are the repository.** One hundred and twelve tables describe users,
permissions, issues, pull requests, webhooks and the row that says `labadmin/app` exists at all.

## What a backup has to be

```bash
gitea dump -c /data/gitea/conf/app.ini --type tar.gz
```

```
  Finish dumping in file /tmp/gitea-dump-1787843274.tar.gz
  size: 33.1K
```

```
  app.ini
  data/…
  gitea-db.sql
  repos/…
```

Four things, and **a backup that captures fewer than four is not a backup**: the bare repositories,
a SQL export of the database, the data directory (avatars, archives, action logs) and the config.
That is the honest cost of the design — and the contrast with
[[walgit-git-server-on-object-storage]], where the bucket is the whole of it, is the clearest way to
see what a database buys and what it charges.

## Breaking it on purpose

The disk and the database can disagree. Making them disagree, by deleting one row and touching
nothing else:

```sql
delete from repository where owner_name='labadmin' and name='app';
```

```
  DELETE 1
```

```
  before — API sees:  labadmin/app
  before — on disk:   2 commits

  after  — API sees:  The target couldn't be found.
  after  — on disk:    2 commits, head be50ae7
```

```
remote: Repository not found
fatal: repository 'http://127.0.0.1:3000/labadmin/app.git/' not found
```

**Every byte of git history is still on the disk, and there is no repository.** The row is the
existence; the directory is only the contents. This is the exact inverse of the walgit result, where
deleting the entire local cache cost a restart and nothing else.

## Adopting it back

Gitea knows the directory is there:

```bash
curl -H "Authorization: token $ADMIN_TOKEN" \
  http://127.0.0.1:3000/api/v1/admin/unadopted
```

```json
["labadmin/app"]
```

```bash
curl -X POST -H "Authorization: token $ADMIN_TOKEN" \
  http://127.0.0.1:3000/api/v1/admin/unadopted/labadmin/app
```

```
  POST -> 204
  API sees:  labadmin/app
  cloned: 2 commits, head be50ae7
```

**The git data comes back intact.** What comes back with it is the question, and the answer is in
[Where this bit us](#where-this-bit-us).

## Verification checklist

- [x] `GITEA__section__KEY` environment variables configure the instance with no `app.ini` authored by hand
- [x] With `INSTALL_LOCK=true` the root page serves a sign-in, not the setup wizard
- [x] An admin created by `gitea admin user create` authenticates against the API as `is_admin: true`
- [x] A push produces an **ordinary bare repository** — `git log` inside the container reads it, as the `git` user
- [x] The database holds **112 tables** and a `repository` row with `id=1`
- [x] `gitea dump` contains four parts: `repos/`, `gitea-db.sql`, `data/` and `app.ini`
- [x] Deleting **one row** makes the repository 404 in the API and `Repository not found` to git, while every commit stays on disk
- [x] `/api/v1/admin/unadopted` lists the orphaned directory
- [x] Adopting it restores a cloneable repository at the **same head** (`be50ae7`)
- [x] The adopted repository is a **new record, `id=2`** — and a `watch` row still points at `repo_id=1`
- [x] A token without `write:admin` is refused the admin endpoints, naming the required scope

## Rollback

```bash
podman compose down -v          # containers, the database volume and /data
```

## Where this bit us

**Adopting recovers the git data and not the repository.** The row that came back is not the row that
went away:

```
   id | owner_name | name | num_issues | num_stars | created_unix
  ----+------------+------+------------+-----------+--------------
    2 | labadmin   | app  |          0 |         0 |   1787843429
```

`id=2`. Everything in those 112 tables that referenced `repo_id=1` is now pointing at a repository
that does not exist:

```
  issue            rows still referencing repo_id=1: 0
  star             rows still referencing repo_id=1: 0
  watch            rows still referencing repo_id=1: 1
  collaboration    rows still referencing repo_id=1: 0
  release          rows still referencing repo_id=1: 0
```

This lab had almost nothing attached, and it still left an orphaned `watch`. On a real instance those
counts are issues, pull requests, reviews, releases, stars and collaborators — **none of which adopt
brings back, because none of them were ever on the disk.** So `unadopted` is a genuinely useful
recovery path and it is worth being precise about what it recovers: the commits, under a new
identity. **It is not a substitute for restoring the database**, and reaching for it after losing the
database will quietly cost every issue and pull request the instance ever had.

**The install wizard is an ownership race.** `INSTALL_LOCK` defaults to false, and the first person to
complete the wizard becomes the administrator of the instance. That is fine on a laptop and a real
exposure for anything reachable, including for the couple of minutes between starting the container
and getting to it yourself. **It belongs in the compose file, not in a post-install checklist** —
which also forces the admin to be created by CLI, so there is no window at all.

**Running git as root inside the container fails on an ordinary repository.**

```
fatal: detected dubious ownership in repository at '/data/git/repositories/labadmin/app.git'
```

`podman exec` lands as root; the repositories are owned by `git`. The message suggests
`safe.directory`, which is the wrong fix here — **taking the suggestion would train you to disable a
protection rather than to stop inspecting a service's data as the wrong user.** `podman exec -u git`
is the fix, and the same reflex applies to any container whose payload is owned by a service account.

**Token scopes are enforced, and the error says which one is missing.**

```
token does not have at least one of required scope(s), required=[read:admin],
  token scope=write:repository,write:user
```

A token minted for pushing cannot list unadopted repositories. That is correct behaviour and worth
noticing while things are calm, because the moment you need `/admin/unadopted` is a moment when
discovering that your token is the wrong one is expensive. **Mint the admin-scoped token before the
incident, and store it where [[vault-secrets-rotation]] argues it should live.**

## Follow-ups

- [ ] Restore `gitea dump` into an empty instance and confirm issues and pull requests come back — this page took the dump and read it, but never replayed it, which is the half that matters
- [ ] Repeat the row-deletion test with issues and pull requests attached, and count exactly what adopt loses
- [ ] Put the repositories on one volume and PostgreSQL on another, then snapshot them at different moments and see what an inconsistent pair does on start-up
- [ ] Enable Gitea Actions and run a workflow, which is the piece that would replace [[gitlab-ci-argocd-fastapi-procedure]]'s runner
- [ ] Serve SSH as well as HTTP and compare what the container needs for each
- [ ] Mirror a repository from this Gitea into [[walgit-git-server-on-object-storage]] and time a clone of each

## Related

[[walgit-git-server-on-object-storage]] — the same job with the opposite storage argument, and the same wipe-it-and-see test with the opposite result.
[[gitlab-ci-argocd-fastapi-onprem]] — the heavier forge this would replace, and the pipeline that would have to point at it.
[[postgresql-cnpg-onprem]] — running the database half properly, rather than as a container beside the app.
[[vault-secrets-rotation]] — where the admin token and the database password should come from.
