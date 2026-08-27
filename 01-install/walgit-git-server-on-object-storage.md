---
title: walgit — a git server whose disk you can delete, and two bugs between the README and the code
date: 2026-08-27
domain: install
tags: [git, object-storage, rust, self-hosting, containers]
stack: [walgit, rustfs, s3, git, podman, docker-compose]
summary: Building tobi/walgit from its own Containerfile fails on a missing protobuf package, and the README's quick-start config cannot parse. Past those, the central claim holds — a second instance that never saw a push serves the repository from the bucket alone, and wiping an instance's entire cache costs nothing but a restart.
source: handson
env: walgit @ 6d8fa54 (2026-08-27) · Rust 1.97 · rustfs (S3-compatible) · git 2.51.0 client · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-27
verifiability: partial
verifiability-note: Two walgit instances against one rustfs bucket on a single laptop, token auth, TLS off, over the loopback network. The distributed claim is verified in the sense that matters — a second process with an empty cache serves what the first accepted — but not against real S3, real latency, concurrent writers racing the manifest CAS, or the LFS, bundle-URI, OIDC and web-UI paths. Both upstream bugs were reproduced from a clean clone and diagnosed to a specific line; neither has been reported upstream from here.
duration: 60–90 min
risk: low
---

> **Verified 2026-08-27.** Built from a clean clone at `6d8fa54`. Both failures in
> [Where this bit us](#where-this-bit-us) happened on the documented path, and the fix for each was
> found in the project's own source rather than guessed.

Most self-hosted git servers keep repositories on a disk and then work hard to replicate that disk.
[walgit](https://github.com/tobi/walgit) inverts it: **a write-ahead log in an object store is the
repository, and every running instance is a cache you can throw away.** The README puts it plainly —
*"Local disk is a cache. Memory is a cache. The bucket is the repository."*

That is a testable claim, and testing it is most of what this page does.

## An S3 bucket to be the repository

The project ships a compose file for local development — rustfs, an S3-compatible store:

```bash
podman compose up -d rustfs
podman compose run --rm create-bucket
```

```
make_bucket: walgit-test
```

## Building it

```bash
podman build -t walgit:local -f Containerfile .
```

**This fails**, on a clean clone, for the reason in [Where this bit us](#where-this-bit-us). With one
package added to the build stage it succeeds, in three stages: a pnpm build of the React UI, a
`cargo build --release` that compiles 114 crates, and a Debian trixie runtime carrying `git`,
`git-lfs` and the two binaries.

```
Successfully tagged localhost/walgit:local
  localhost/walgit:local 1.01 GB
```

**The runtime image needs a real git.** walgit shells out to `git upload-pack`, `repack`, `bundle`
and `index-pack`, so the base image is chosen for its git version — 2.47+ on the server, 2.46+ on
clients — rather than for size.

## Configuring it

```toml title="lab.toml"
[server]
listen = "0.0.0.0:8080"
public_url = "http://127.0.0.1:8080"
auto_create_on_push = true          # `git push` to a repo that does not exist creates it

[server.tls]
mode = "off"                        # plain HTTP so git needs no cert pinning in the lab

[server.auth]
# "none" is refused on a non-loopback bind — see Where this bit us.
mode = "token"
anonymous_read = false
# `token = ""` is the workaround: serde requires the field even though the
# validator accepts token OR token_env. See Where this bit us.
tokens = [{ principal = "me", token = "", token_env = "WALGIT_TOKEN_ME", write = true }]

[store]
backend = "s3"
bucket = "walgit-test"

[store.s3]
endpoint = "http://rustfs:9000"
region = "us-east-1"
force_path_style = true             # true for most self-hosted S3 implementations

[cache]
dir = "/var/lib/walgit"             # local materialized repos — wiped in the test below
```

```bash
export WALGIT_TOKEN_ME=$(openssl rand -hex 24)

podman run -d --name walgit-a --network walgit_default -p 8080:8080 \
  -e AWS_ACCESS_KEY_ID=walgit-dev -e AWS_SECRET_ACCESS_KEY=walgit-dev-secret \
  -e WALGIT_TOKEN_ME="$WALGIT_TOKEN_ME" \
  -v "$PWD/lab.toml:/etc/walgit/walgit.toml:ro,Z" \
  -v walgit-cache-a:/var/lib/walgit \
  walgit:local serve
```

```
  readyz: 200
  anonymous: 401
```

## A push, and what it leaves in the bucket

```bash
git -c http.extraHeader="Authorization: Bearer $WALGIT_TOKEN_ME" \
    push http://127.0.0.1:8080/acme/app.git main
```

```
remote: * walgit: acme/app — push by me
To http://127.0.0.1:8080/acme/app.git
 * [new branch]      main -> main
```

The repository did not exist a moment earlier; `auto_create_on_push` made it. And the whole of it is
now visible as objects:

```
  repos/acme/app/manifest.pb                          323
  repos/acme/app/log/0000000000000001.pb              274
  repos/acme/app/log/0000000000000002.pb               97
  repos/acme/app/log/0000000000000003.pb              138
  repos/acme/app/wal/dcbf40a4….pack                   652
  repos/acme/app/wal/dcbf40a4….idx                   1296
  repos/acme/app/wal/dcbf40a4….commit-graph          1232
  repos/acme/app/wal/dcbf40a4….bitmap                 256
```

**Read that listing as the architecture.** `manifest.pb` is the single commit point — the object that
compare-and-swap is performed against, standing in for the consensus a database would provide.
`log/0000…N.pb` are the append-only WAL segments. `wal/<sha>.pack` and its siblings are ordinary git
packs, sitting in a bucket instead of on a disk. There is no database anywhere, and no file whose
name encodes which server wrote it.

## Deleting the disk

The claim says local storage is a cache. The test is to remove it.

```bash
podman exec walgit-a sh -c 'rm -rf /var/lib/walgit/*'
```

```
  entries left: 0
```

Cloning immediately after this **fails** — see below; the honest form of the claim is about instance
lifecycle, so restart it:

```
  readyz: 200
  cache entries at start: 0

  commits: 2  head: 944eac1
  identical to the pre-wipe clone: YES
  cache rebuilt to: 140K
```

**Nothing was lost.** The instance came back with an empty disk, served a clone that matched the
pre-wipe one commit for commit, and rebuilt 140K of local cache on demand from the bucket.

## Two instances, one bucket, no coordination

The stronger test is a process that never witnessed the push at all:

```bash
podman run -d --name walgit-b --network walgit_default -p 8081:8080 \
  … -v walgit-cache-b:/var/lib/walgit walgit:local serve
```

```
  instance B readyz: 200  | cache entries: 0
  commits: 2  head: 944eac1  same as A: YES
```

**B shares nothing with A except the bucket** — no gossip, no leader election, no replication stream,
no shared filesystem. Pushing to B and then reading from A closes the loop:

```
  pushed head: fd2aa1b   (to B)
  A now serves: 3 commits, head fd2aa1b
```

**That sequence is the whole architecture in four lines.** Two disposable processes, one durable
bucket, and a repository that belongs to neither of them.

## Verification checklist

- [x] `podman build -f Containerfile .` **fails** on a clean clone, at `walgit-proto`, with a protoc import error
- [x] `protobuf-compiler` alone does not provide `/usr/include/google/protobuf/timestamp.proto`; adding `libprotobuf-dev` does — checked in the base image both ways
- [x] The README's quick-start `tokens = [{ …, token_env = … }]` **fails to parse** with `missing field 'token'`
- [x] `mode = "none"` is **refused** on a `0.0.0.0` bind, naming the reason
- [x] An anonymous fetch returns **401**; the same request with a bearer token does not
- [x] A push to a non-existent repository creates it, and writes a `manifest.pb`, numbered WAL segments and git packs into the bucket
- [x] Deleting the cache **under a running process** breaks the next clone with `fatal: expected 'packfile'`
- [x] Restarting on the emptied cache serves a clone **identical** to the pre-wipe one and rebuilds the cache
- [x] A second instance with its own empty cache serves the same repository from the bucket alone
- [x] A push to instance B is served by instance A, with no coordination between them

## Rollback

```bash
podman rm -f walgit-a walgit-b
podman volume rm walgit-cache-a walgit-cache-b
podman compose down -v          # rustfs and the bucket
podman rmi walgit:local
```

## Where this bit us

**The project's own container build does not work, and the error names the wrong thing.**

```
error: failed to run custom build command for `walgit-proto v0.1.0`
  Error: protoc failed: google/protobuf/timestamp.proto: File not found.
  walgit/v1/wal.proto:5:1: Import "google/protobuf/timestamp.proto" was not found
```

The Containerfile installs `protobuf-compiler`, which reads as sufficient — it is the package that
provides `protoc`. It is not the package that provides the **well-known types** those `.proto` files
import. Checked directly in the same base image rather than inferred:

```
  protoc: libprotoc 3.21.12
  timestamp.proto present: NO
  owned by package:        dpkg-query: no path found matching pattern …
  --- now add libprotobuf-dev ---
  timestamp.proto present: YES
```

One word fixes it:

```dockerfile
RUN apt-get install -y --no-install-recommends \
      protobuf-compiler libprotobuf-dev pkg-config cmake perl python3
```

**A failing build is the good case here** — it stops. The lesson worth keeping is the diagnostic
shape: *"tool X is installed but its data files are not"* is a whole family of Debian packaging
surprises, and `dpkg -S` on the missing path settles it in one command.

**The README's quick-start config cannot be parsed by the code it ships with.** Copying it verbatim:

```toml
tokens = [{ principal = "me", token_env = "WALGIT_TOKEN_ME", write = true }]
```

```
TOML parse error at line 13, column 11
missing field `token`
```

The same form appears in `walgit.example.toml`. And the validator explicitly intends to accept it:

```rust
anyhow::ensure!(
    !t.token.is_empty() || t.token_env.as_deref().is_some_and(|v| !v.is_empty()),
    "server.auth.tokens[] for {:?} needs `token` or `token_env`",
```

But the struct it validates makes the field mandatory before validation ever runs:

```rust
pub struct StaticToken {
    pub principal: String,
    /// Read from env var if set, else literal.
    pub token: String,              // <- no #[serde(default)]
    #[serde(default)]
    pub token_env: Option<String>,
```

**Serde rejects the document before the either/or check can run**, so that branch of the validator is
unreachable from a config file. The upstream fix is one attribute (`#[serde(default)]` on `token`);
the workaround from outside the project is to supply the field empty:

```toml
tokens = [{ principal = "me", token = "", token_env = "WALGIT_TOKEN_ME", write = true }]
```

Worth noting *why* this is worth the trouble rather than just writing the literal token: `token_env`
exists so the secret stays out of the committed file, which is the same argument
[[vault-secrets-rotation]] makes at length. The bug pushes people toward the insecure form.

**walgit refuses to start unauthenticated on a public bind, and says exactly why.**

```
error loading config: server.auth.mode = none is loopback-only (listen is 0.0.0.0:8080);
  use token or oidc for a public bind
```

This is the opposite of a trap and deserves saying: `mode = "none"` in the shipped standalone config
is safe *because the server checks the bind address before honouring it*. A configuration that is
only safe when you read the comment is not safe; this one enforces the comment.

**Deleting the cache under a running process is not the same as a disposable cache.**

```
fatal: expected 'packfile'
```

Removing `/var/lib/walgit/*` while the server was serving broke the very next clone — the process
still held references to pack files that no longer existed. A restart on the same empty directory
worked perfectly. **The claim is about instance lifecycle, not live filesystem surgery**, and it is
worth stating precisely: you can destroy the machine, not the disk underneath a running process. In
practice that is the case that matters — instances are replaced, not disembowelled — but the
distinction is the difference between a claim that holds and one that has been overstated.

## Follow-ups

- [ ] Report both bugs upstream with the diagnosis above — the `libprotobuf-dev` line and the `#[serde(default)]` attribute are each a one-line patch
- [ ] Run two instances against **real S3** rather than rustfs, where request latency and consistency behaviour are not a loopback socket
- [ ] Race two concurrent pushes to the same ref across both instances and watch the manifest CAS reject one — the consensus claim this page takes on trust
- [ ] Exercise bundle-URI clones and confirm a large clone is served from static objects rather than `upload-pack`
- [ ] Push a repository with LFS objects and check where the bytes land in the bucket
- [ ] Try `cache.mode = "budget"` with a repository larger than the budget, which is the remote-reader path the README argues is the whole point
- [ ] Compare the bucket layout after `walgit compact` against the raw WAL above

## Related

[[minio-object-storage-onprem]] — an S3 endpoint of your own, which is what walgit actually needs in anger.
[[s3-object-storage-options]] — choosing the bucket implementation underneath something like this.
[[opensearch-mappings-and-templates]] — another system that treats object storage as durable truth and local disk as replaceable, with the snapshot/restore half made explicit.
[[vault-secrets-rotation]] — why `token_env` exists, and why a bug that pushes you to the literal form matters.
[[gitlab-ci-argocd-fastapi-onprem]] — the git server this would replace, and the CI that would have to reach it.
