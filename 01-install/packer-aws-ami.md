---
title: Packer on AWS — an AMI built, booted, curled, and deleted
date: 2026-08-23
domain: install
tags: [iac, images, aws, immutable-infrastructure]
stack: [packer, aws, amazon-ebs, ec2, amazon-linux]
summary: A real AMI built with amazon-ebs in 5m27s, then launched to prove the registered image boots and serves what was baked into it — a check the in-build smoke test cannot make. Every resource was deleted afterwards, and the cleanup is the part most Packer guides leave out.
source: handson
env: Packer 1.15.4 · packer-plugin-amazon 1.8.2 · Amazon Linux 2023 (looked up, not pinned) · t3.micro in us-east-1 · macOS 14.7.5
verified: 2026-08-23
verifiability: lab
duration: 30–45 min
risk: medium
---

> **Verified 2026-08-23.** One AMI was built, one instance launched from it, `curl` returned the
> baked string, and everything was then deregistered and deleted — confirmed by querying AWS for
> leftovers afterwards.
>
> `risk: medium` is about the bill, not the difficulty. This creates an EC2 instance, an AMI and an
> EBS snapshot. The instance stops costing when it terminates; **the AMI and snapshot bill until you
> delete them**, and Packer does not clean those up for you — they are the artifact.

[[packer-image-build-local]] builds an image with the `docker` builder and no cloud account. This is
the same template shape pointed at `amazon-ebs`, which is where Packer is actually used, and where
the parts that cost money live.

## What amazon-ebs actually does

The log is worth reading once, because the lifecycle explains the failure modes:

```
Prevalidating AMI Name: handson-web-1.2.0-20260823021427
Creating temporary keypair: packer_...
Launching a source AWS instance...
Waiting for instance (i-...) to become ready...
  [provisioners run over SSH here]
Stopping the source instance...
Creating AMI handson-web-1.2.0-... from instance i-...
Terminating the source AWS instance...
Deleting temporary security group...
Deleting temporary keypair...
Build 'aws.amazon-ebs.web' finished after 5 minutes 27 seconds.
```

**Packer launches a real instance, configures it over SSH, stops it, snapshots it, and cleans up
after itself** — the keypair and security group it created are temporary and it deletes them. The
one thing it deliberately leaves behind is the artifact: the AMI and its EBS snapshot.

## The template

```hcl title="ami.pkr.hcl"
packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "app_version" {
  type    = string
  default = "0.1.0"
}

# Never hardcode an AMI ID: they differ per region and are replaced on every
# security update. Look the current one up instead.
data "amazon-ami" "al2023" {
  filters = {
    name                = "al2023-ami-2023.*-x86_64"
    virtualization-type = "hvm"
    root-device-type    = "ebs"
  }
  owners      = ["amazon"]
  most_recent = true
  region      = var.region
}

source "amazon-ebs" "web" {
  region        = var.region
  source_ami    = data.amazon-ami.al2023.id
  instance_type = "t3.micro"
  ssh_username  = "ec2-user"

  ami_name        = "handson-web-${var.app_version}-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  ami_description = "nginx baked at ${var.app_version}"

  tags = {
    Name        = "handson-web"
    app_version = var.app_version
    built_by    = "packer"
    source_ami  = "{{ .SourceAMI }}"
  }

  # Tag the snapshot too, or cost allocation cannot see it.
  snapshot_tags = {
    Name     = "handson-web"
    built_by = "packer"
  }
}

build {
  name    = "aws"
  sources = ["source.amazon-ebs.web"]

  provisioner "shell" {
    inline = [
      "sudo dnf -y install nginx",
      "echo 'handson ${var.app_version}' | sudo tee /usr/share/nginx/html/index.html",
      "sudo systemctl enable nginx",
    ]
  }

  # Prove the image is right while the builder is still up — a failure here
  # aborts the build and no AMI is registered.
  provisioner "shell" {
    inline = [
      "set -e",
      "systemctl is-enabled nginx",
      "test -f /usr/share/nginx/html/index.html",
      "grep -q '${var.app_version}' /usr/share/nginx/html/index.html",
      "echo SMOKE_OK",
    ]
  }

  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
  }
}
```

Four details that are specific to AWS and easy to get wrong:

- **`data "amazon-ami"` instead of a hardcoded `ami-…`.** AMI IDs are per-region and get replaced
  whenever Amazon rebuilds the base image, so a pinned ID is a template that works in one region
  until it silently stops being current. `most_recent = true` with an `owners` filter is the
  idiomatic form — and `owners` is not optional decoration: without it, a name filter can match
  **someone else's** image.
- **`ami_name` must be unique in the region**, which is why it carries a timestamp. Packer
  prevalidates this before launching anything, so a name collision costs you nothing.
- **`snapshot_tags` is separate from `tags`.** Tags on the AMI do not propagate to the EBS snapshot
  underneath it, and the snapshot is the thing that actually consumes storage — an untagged snapshot
  is invisible to cost allocation and to any cleanup script that filters by tag.
- **`{{ .SourceAMI }}`** records what this image was built *from*, which is the only way to answer
  "which base image is this fleet running" months later.

## Build

```bash
packer init ami.pkr.hcl
packer validate ami.pkr.hcl
packer build -var app_version=1.2.0 ami.pkr.hcl
```

```
==> aws.amazon-ebs.web: SMOKE_OK
==> Builds finished. The artifacts of successful builds are:
--> aws.amazon-ebs.web: AMIs were created:
us-east-1: ami-0d8a0e121930a2c96
```

The `manifest` post-processor writes the same thing to a file, which is what a pipeline should
consume rather than scraping stdout:

```json title="manifest.json"
{
  "builds": [
    {
      "name": "web",
      "builder_type": "amazon-ebs",
      "artifact_id": "us-east-1:ami-0d8a0e121930a2c96",
      "packer_run_uuid": "fd417ff8-1b7f-feed-eeea-536b786d1106"
    }
  ]
}
```

## Verify the AMI, then verify it boots

First that the artifact exists as specified:

```bash
aws ec2 describe-images --region us-east-1 --image-ids ami-0d8a0e121930a2c96 \
  --query 'Images[0].{Name:Name,State:State,Snap:BlockDeviceMappings[0].Ebs.SnapshotId,Tags:Tags}'
```

```json
{
  "Name": "handson-web-1.2.0-20260823021427",
  "State": "available",
  "Snap": "snap-06d9ed70098aabf9d",
  "Tags": [
    {"Key": "source_ami",  "Value": "ami-0332d564d76dbd8d6"},
    {"Key": "app_version", "Value": "1.2.0"},
    {"Key": "Name",        "Value": "handson-web"},
    {"Key": "built_by",    "Value": "packer"}
  ]
}
```

**That is still not proof the image works**, and the distinction matters. `SMOKE_OK` was printed by
the *builder instance*, before the AMI existed — it proves the configuration ran, not that the
snapshot taken afterwards produces a bootable machine. The only check that covers that is launching
one:

```bash
IID=$(aws ec2 run-instances --region us-east-1 --image-id ami-0d8a0e121930a2c96 \
  --instance-type t3.micro --security-group-ids "$SG" --count 1 \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-status-ok --region us-east-1 --instance-ids "$IID"
```

```json
{"Instance": "ok", "System": "ok", "State": "running"}
```

```bash
curl -sS "http://$(aws ec2 describe-instances --region us-east-1 --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)/"
```

```
handson 1.2.0
```

**`handson 1.2.0` is the pass condition** — a string that only exists because `-var app_version=1.2.0`
reached a provisioner, was written to disk, survived the snapshot, and is being served by a service
that came up on its own after a cold boot. Nothing short of launching demonstrates that chain.

## Clean up — this is the part that bills

```bash
aws ec2 terminate-instances --region us-east-1 --instance-ids "$IID"
aws ec2 wait instance-terminated --region us-east-1 --instance-ids "$IID"
aws ec2 delete-security-group --region us-east-1 --group-id "$SG"

aws ec2 deregister-image --region us-east-1 --image-id ami-0d8a0e121930a2c96
aws ec2 delete-snapshot  --region us-east-1 --snapshot-id snap-06d9ed70098aabf9d
```

**`deregister-image` does not delete the snapshot.** They are separate resources and separate API
calls; deregistering alone leaves the storage behind, still billing, now with no AMI pointing at it
to make it findable in the console. Then confirm, rather than assume:

```bash
aws ec2 describe-images --region us-east-1 --owners self \
  --query 'Images[?starts_with(Name,`handson-`)].[ImageId,Name]' --output text
aws ec2 describe-snapshots --region us-east-1 --owner-ids self \
  --filters Name=tag:built_by,Values=packer --query 'Snapshots[].[SnapshotId]' --output text
```

Both returned empty. **That query only works because of `snapshot_tags`** — an untagged snapshot
cannot be found this way, which is the practical reason to set them.

## Verification checklist

- [x] `packer init` installs `packer-plugin-amazon`; `packer validate` reports valid
- [x] `data "amazon-ami"` resolves a current base image without any AMI ID in the template
- [x] The in-build smoke provisioner prints `SMOKE_OK`, so a bad image aborts before registration
- [x] The AMI reaches `State: available` with all four tags and a snapshot ID
- [x] `manifest.json` records the artifact ID for a pipeline to read
- [x] An instance launched **from the AMI** reaches `Instance: ok / System: ok`
- [x] `curl` against it returns `handson 1.2.0` — the version baked at build time
- [x] After cleanup, both the AMI query and the tagged-snapshot query return empty

## Rollback

Everything this creates is deleted by the cleanup section above. If a build fails partway, Packer
terminates its own instance and removes its temporary keypair and security group — but check for a
stranded instance if it was killed rather than allowed to fail:

```bash
aws ec2 describe-instances --region us-east-1 \
  --filters Name=tag:Name,Values=Packer* Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text
```

## Where this bit us

**The in-build smoke test and a launch test prove different things, and only one of them is
optional.** The `SMOKE_OK` provisioner runs on the builder instance while it is still running — it
cannot tell you whether the resulting snapshot boots, whether `systemctl enable` survived the
imaging, or whether the service starts without the network conditions the builder had. It is still
worth having, because it fails *before* an AMI is registered and therefore before you have anything
to pay for or clean up. But a green build with a green smoke test is not a working image, and the
only thing that establishes that is `run-instances` plus a request.

**Deregistering an AMI leaves its snapshot behind, billing.** They are two resources, two API calls
and two chances to forget. The snapshot is also the more expensive half over time and the harder one
to notice — once the AMI is deregistered, nothing in the EC2 Images view points at it. Tag snapshots
at build time so a cleanup query can find them later; `snapshot_tags` exists for exactly this and is
easy to skip because `tags` looks like it covers everything.

**`owners` on an AMI lookup is a security control, not a filter.** A `name` filter alone can match a
public image published by anyone, so an unowned lookup is an invitation to build on top of a
stranger's base image. `owners = ["amazon"]` is what makes `al2023-ami-2023.*-x86_64` mean what it
looks like it means.

## Follow-ups

- [ ] Add `ami_regions` and confirm what a multi-region copy costs in time and storage — a single-region build is the cheap case
- [ ] Move the build into [[gitlab-ci-argocd-fastapi-procedure]]'s pipeline and have it publish `manifest.json` as an artifact, so a deploy can consume the AMI ID rather than a human reading it
- [ ] Have [[terraform-state-operations]]'s Terraform read that manifest and launch from it, closing the bake-then-place loop
- [ ] Write the cleanup as a scheduled job that deletes AMIs tagged `built_by=packer` older than N days — every build adds a snapshot, and nothing removes them by default
- [ ] Try `amazon-ebssurrogate` for a build that replaces the root filesystem entirely, which is how custom kernels and non-standard partitioning get done

## Related

[[packer-image-build-local]] — the same template structure with the `docker` builder, free and offline, and where the two-identical-builds-differ finding is recorded.
[[terraform-state-operations]] — Packer bakes the image, Terraform places it; the two halves of immutable infrastructure.
[[gitlab-ci-argocd-fastapi-onprem]] — the tag-versus-digest argument, which is the same problem an AMI ID solves for instances.
[[onprem-3node-kubeadm-ubuntu]] — configuring machines in place, which is what baking an image replaces.
