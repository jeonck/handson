---
title: Packer without a cloud account — a real image build, and why two identical builds differ
date: 2026-08-21
domain: install
tags: [iac, images, immutable-infrastructure, containers]
stack: [packer, docker, podman, alpine]
summary: A complete Packer template built and its artifact verified on a laptop, using the docker builder against Podman instead of an AWS account. The template ran twice with identical inputs and produced two different image IDs — "golden image" means one artifact promoted through environments, not a build you can reproduce byte for byte.
source: handson
env: Packer 1.15.4 · packer-plugin-docker 1.1.4 · Podman 5.7.1 (docker CLI 29.1.3 against the Podman socket) · Alpine 3.20 · macOS 14.7.5
verified: 2026-08-21
verifiability: partial
verifiability-note: Verified end to end with the docker builder against Podman — a substitute for the cloud builders most Packer work targets. The amazon-ebs builder, its instance lifecycle, AMI sharing and region copies are all unexercised here, and those are where Packer's real cost and failure modes live.
duration: 25–40 min
risk: low
---

> **Verified 2026-08-21.** The build below ran, the resulting image was executed, and the two image
> IDs in [Where this bit us](#where-this-bit-us) are from two consecutive runs of the same template.

Packer builds machine images: start from a base, run provisioners, save the result as an artifact
you deploy repeatedly instead of configuring servers in place. Every tutorial reaches for
`amazon-ebs`, which needs an account and spends money per run.

**The `docker` builder needs neither**, and it exercises the same template structure — sources,
provisioners, post-processors, variables. That is what this page uses, so the whole thing runs on a
laptop.

## Install

```bash
brew install hashicorp/tap/packer
packer version
```

```
Packer v1.15.4
```

**Homebrew now refuses HashiCorp's tap until you trust it explicitly:**

```
Error: Refusing to load formula hashicorp/tap/packer from untrusted tap hashicorp/tap.
Run `brew trust --formula hashicorp/tap/packer` or `brew trust hashicorp/tap` to trust it.
```

```bash
brew trust hashicorp/tap
```

That gate is new enough to surprise people who installed Packer a year ago without it.

## A container runtime, without Docker Desktop

The `docker` builder shells out to the `docker` CLI, and the CLI is happy to talk to Podman:

```bash
export DOCKER_HOST="unix://$(podman machine inspect \
  --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
docker run --rm alpine:3.20 echo ok
```

```
ok
```

Every Packer command below assumes that `DOCKER_HOST` is exported.

## The template

```hcl title="web.pkr.hcl"
packer {
  required_plugins {
    docker = {
      source  = "github.com/hashicorp/docker"
      version = "~> 1"
    }
  }
}

variable "app_version" {
  type        = string
  default     = "0.1.0"
  description = "Baked into the image so a running container can report what it is."
}

source "docker" "alpine" {
  image  = "alpine:3.20"
  commit = true
  changes = [
    "ENV APP_VERSION=${var.app_version}",
    "ENTRYPOINT [\"/usr/local/bin/hello\"]",
  ]
}

build {
  name    = "web"
  sources = ["source.docker.alpine"]

  provisioner "shell" {
    inline = [
      "apk add --no-cache curl",
      "printf '#!/bin/sh\\necho hello from ${var.app_version}\\n' > /usr/local/bin/hello",
      "chmod +x /usr/local/bin/hello",
    ]
  }

  post-processor "docker-tag" {
    repository = "packer-demo/web"
    tags       = [var.app_version, "latest"]
  }
}
```

Four pieces, and they map onto any builder:

- **`source`** — what you start from, plus image metadata. `changes` writes Dockerfile-style
  instructions into the commit; `commit = true` is what makes an image rather than a discarded
  container.
- **`provisioner`** — what runs *inside* the machine. A shell block here; Ansible, Chef and file
  uploads are the same slot.
- **`post-processor`** — what happens to the artifact afterwards. Tagging here, pushing to a
  registry or writing a manifest elsewhere.
- **`variable`** — the values that change per build, which is how one template serves every version.

## The three commands, in order

```bash
packer fmt -check -diff web.pkr.hcl   # exit 0 = already formatted
packer init web.pkr.hcl               # downloads the plugins the template declares
packer validate web.pkr.hcl
```

```
Installed plugin github.com/hashicorp/docker v1.1.4 in "/Users/…/packer/plugins/…"
The configuration is valid.
```

**`validate` earns its place — it fails on a reference that does not exist, and says what does:**

```hcl
sources = ["source.docker.typo"]   # instead of source.docker.alpine
```

```
Known: [docker.alpine]
```

Cheap to run on every save, and it catches the class of mistake that otherwise surfaces after a
cloud builder has already launched an instance.

## Build it

```bash
packer build -var app_version=1.4.0 web.pkr.hcl
```

```
==> web.docker.alpine: (10/10) Installing curl (8.14.1-r2)
==> web.docker.alpine: OK: 15 MiB in 24 packages
==> web.docker.alpine: Committing the container
==> web.docker.alpine: Image ID: d83c19fbe485…
==> web.docker.alpine: Running post-processor:  (type docker-tag)
==> web.docker.alpine (docker-tag): Repository: packer-demo/web:1.4.0
==> web.docker.alpine (docker-tag): Repository: packer-demo/web:latest
Build 'web.docker.alpine' finished after 5 seconds 485 milliseconds.
```

## Verify the artifact, not the build log

A green build says Packer finished, not that the image is right. Three properties, each checked
against the running image:

```bash
docker run --rm packer-demo/web:1.4.0
```

```
hello from 1.4.0
```

```bash
docker run --rm --entrypoint curl packer-demo/web:1.4.0 --version
```

```
curl 8.14.1 (aarch64-alpine-linux-musl) libcurl/8.14.1 OpenSSL/3.3.7 …
```

```bash
docker run --rm --entrypoint printenv packer-demo/web:1.4.0 APP_VERSION
```

```
1.4.0
```

Each one proves a different layer of the template: the `ENTRYPOINT` from `changes`, the package from
the `provisioner`, and the variable that flowed from `-var` through `changes` into the image's
environment. **`hello from 1.4.0` is the strongest of the three** — that string only exists if the
variable reached the provisioner *and* the entrypoint was set *and* the commit kept both.

## Verification checklist

- [x] `packer fmt -check` exits `0` on the committed template
- [x] `packer init` installs the plugin the template declares
- [x] `packer validate` reports valid — and **fails on a typo'd source, listing the known ones**
- [x] `packer build` exits `0` and reports an image ID
- [x] The post-processor produces both the version tag and `latest`
- [x] Running the image prints `hello from 1.4.0` — the variable survived the whole pipeline
- [x] `curl` is present, proving the provisioner ran inside the image
- [x] Two consecutive builds with identical inputs produce **different** image IDs

## Rollback

```bash
podman rmi -f packer-demo/web:1.4.0 packer-demo/web:latest
rm -rf ~/.config/packer/plugins     # only if you want the plugin gone too
```

## Where this bit us

**The same template, the same inputs, twice — two different images.**

```
build 1: d83c19fbe485d59b
build 2: ace62288481bafaa
```

Nothing changed between the runs. Timestamps, package-mirror state and layer metadata all differ, so
the artifact is new every time. **"Golden image" means one artifact built once and promoted through
environments — it does not mean a build you can reproduce byte for byte.** The practical
consequences: never rebuild "the same" image for production because staging's copy is inconvenient
to promote, and never treat a version tag as proof two environments run identical bits. The image ID
or digest is the identity; the tag is a label pointing at it, exactly as
[[gitlab-ci-argocd-fastapi-onprem]] argues for deploys.

**`docker images` fails against Podman while `docker run` works.** Listing images through the
compatibility socket returns:

```
API version 1.41 is not supported by this client: the minimum supported API version is 1.44
```

The client negotiates a version that Podman's Docker-compatible API does not offer on that endpoint.
`docker run`, `commit` and `tag` — everything Packer's builder actually calls — are unaffected, which
is why the build succeeded while a routine `docker images` did not. Use `podman images` to inspect:

```
docker.io/packer-demo/web    1.4.0     d83c19fbe485   15.2 MB
docker.io/packer-demo/web    latest    d83c19fbe485   15.2 MB
```

Worth knowing before concluding the build produced nothing. **A tool that partly works through a
compatibility shim is more confusing than one that does not work at all**, because the failure
arrives on an unrelated command later.

**`brew install packer` alone no longer works.** The tap must be trusted first, and the error names
the fix. Any install script or onboarding doc written before that change now fails at its first
step.

## Follow-ups

- [x] Run the same template shape against `amazon-ebs` — done in [[packer-aws-ami]], including the launch test the docker builder cannot motivate
- [ ] Add the `manifest` post-processor and commit its output, so the image ID for each version is recorded rather than read out of a scrollback
- [ ] Replace the shell provisioner with Ansible and confirm the template structure is unchanged — the claim Packer makes about provisioner portability
- [ ] Build the same artifact twice on two different machines and compare IDs, to see whether anything beyond timestamps diverges
- [ ] Push with `docker-push` into the GitLab registry from [[gitlab-ci-argocd-fastapi-procedure]], so a Packer image joins the same GitOps flow

## Related

[[gitlab-ci-argocd-fastapi-onprem]] — the same argument about tags versus digests, applied to deploys rather than builds.
[[terraform-state-operations]] — the other half of immutable infrastructure: Packer bakes the image, Terraform places it.
[[onprem-3node-kubeadm-ubuntu]] — configuring machines in place, which is what an image build replaces.
[[packer-aws-ami]] — the same template pointed at AWS, where the artifact costs money until it is deleted.
