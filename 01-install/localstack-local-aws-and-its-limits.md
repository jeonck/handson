---
title: LocalStack — a local AWS that accepts any credentials and ignores your IAM policy
date: 2026-08-28
domain: install
tags: [aws, testing, containers, devsecops, iam]
stack: [localstack, aws-cli, s3, iam, podman, docker-compose]
summary: LocalStack 4.14 Community from a compose file, then asked what it actually emulates. A user with an explicit Deny on s3:* listed the buckets anyway, ENFORCE_IAM=1 was accepted and changed nothing, an empty access key in the credential scope was honoured, and a restart threw the state away.
source: handson
env: LocalStack 4.14.0 (community, license not activated) · amazon/aws-cli latest · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-28
verifiability: partial
verifiability-note: Community edition only, on one host, exercising S3, IAM and STS. Every negative result below — the credential handling, the unenforced IAM, the lost state — is a Community-edition observation and several of those are Pro features; nothing here says the Pro edition behaves the same way. Lambda, API Gateway, CloudFormation and the rest of the surface are unexercised, and no comparison against real AWS was made.
duration: 30–50 min
risk: low
---

> **Verified 2026-08-28.** Every response below came from a running LocalStack. The IAM result is the
> reason this page is worth reading before you decide what LocalStack is for.

LocalStack answers AWS API calls on your laptop, so tests do not need an account and cost nothing.
The useful question is not whether it works — it does — but **which parts of AWS it actually
reproduces**, because the parts it does not are the parts people assume hardest.

## Bringing it up

```yaml title="compose.yml"
services:
  localstack:
    image: docker.io/localstack/localstack:4
    environment:
      # Only the services named here are started. Anything else answers 501.
      SERVICES: "s3,sqs,dynamodb,sts,iam"
      DEBUG: "0"
    volumes:
      - ls-data:/var/lib/localstack
    ports: ["4566:4566"]
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:4566/_localstack/health || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 40
```

**One port for everything.** Real AWS gives each service its own endpoint; LocalStack multiplexes all
of them on `:4566` and routes by the request, which is why every client only needs
`--endpoint-url`.

```bash
curl -s http://127.0.0.1:4566/_localstack/health
```

```
  version: 4.14.0
    dynamodb     available
    dynamodbstreams available
    acm          disabled
    apigateway   disabled
    cloudformation disabled
    ec2          disabled
```

**`SERVICES` is a real switch, not a hint.** Anything not listed reports `disabled` and returns a
`501` when called — which is how [[crossplane-cloud-resources-as-crds]] discovered that the AWS
provider needs STS before it will touch S3.

## Using it

```bash
aws --endpoint-url http://localhost:4566 s3 mb s3://demo-bucket
aws --endpoint-url http://localhost:4566 s3api list-buckets --query 'Buckets[].Name'
```

```
  make_bucket: demo-bucket
  ["demo-bucket"]
```

That is the whole developer experience: point any AWS SDK or CLI at the endpoint and the calls
behave. **What follows is everything that behaves differently, which is what you are here for.**

## Verification checklist

- [x] `/_localstack/health` reports per-service `available` / `disabled`, matching `SERVICES`
- [x] `s3 mb` and `s3api list-buckets` work through `--endpoint-url` with no AWS account
- [x] **Any** credential pair is accepted — `test:test`, a realistic-looking key, and `anything:atall` all succeed
- [x] A request whose `Credential=` scope has an **empty** access key id still returns the bucket list
- [x] A user with an explicit `Deny` on `s3:*` **lists the buckets anyway**
- [x] Setting `ENFORCE_IAM=1` is accepted into the container environment and **changes nothing**
- [x] `/_localstack/info` reports `"edition": "community"` and `"is_license_activated": false`
- [x] Restarting the container leaves `Buckets: []` — the state is gone despite a mounted volume

## Rollback

```bash
podman compose down -v
```

## Where this bit us

**LocalStack accepts any credentials, including none.** Three pairs, all successful:

```
  test:test                   -> OK
  AKIAIOSFODNN7EXAMPLE:secret -> OK
  anything:atall              -> OK
```

and a hand-built request whose credential scope names no key at all:

```bash
curl -H "Authorization: AWS4-HMAC-SHA256 Credential=/20260828/us-east-1/s3/aws4_request, \
  SignedHeaders=host, Signature=abc" http://127.0.0.1:4566/
```

```xml
<ListAllMyBucketsResult …><Buckets><Bucket><Name>demo-bucket</Name>…
```

The signature is not checked and the key is not looked up. **That is fine and it is also the reason
LocalStack cannot tell you whether your application's credential handling works** — every wrong key,
expired token and missing profile passes.

**IAM policies are stored and ignored.** This is the finding that changes what LocalStack is for:

```bash
aws iam put-user-policy --user-name denied-user --policy-name deny-s3 --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"s3:*","Resource":"*"}]}'
```

```
  policy on denied-user: {'Effect': 'Deny', 'Action': 's3:*', 'Resource': '*'}

  list-buckets with the DENIED key:
    ["demo-bucket"]
```

The policy is accepted, stored and retrievable — `get-user-policy` returns it verbatim — and then
the explicitly denied call succeeds. **An IAM policy tested against LocalStack has not been tested.**
Least-privilege work, `Deny` guardrails, permission boundaries and any "does this role have too much
access" review are exactly the things this cannot answer, and they are the things people most want a
safe environment for.

**And the switch that looks like it fixes that does not.** `ENFORCE_IAM=1` is a documented variable;
it reached the container:

```
  ENFORCE_IAM in the container env:  ENFORCE_IAM=1
```

and the denied key still listed the bucket. The reason is the edition:

```json
{"version": "4.14.0", "edition": "community", "is_license_activated": false}
```

**A configuration variable that is silently inert on your edition is worse than one that errors**,
because the setting is in your compose file, in review, and in everyone's mental model of what the
environment enforces. Check `/_localstack/info` before believing any policy-related result.

**Restarting throws the state away, mounted volume or not.**

```
  buckets after restart: []
```

`/var/lib/localstack` was a named volume the whole time. Persistence is a Pro feature, so the
Community edition rebuilds from nothing on every start. **That is good for test isolation and bad for
anyone who set the volume expecting it to mean something** — the volume exists, it is written to, and
it does not bring your buckets back.

**What this excludes about a failure on another page.**
[[crossplane-cloud-resources-as-crds]] left an unresolved `InvalidAccessKeyId` when the Crossplane AWS
provider created a bucket against LocalStack, while `awslocal` succeeded with the same values. The
credential experiments above rule out the obvious explanations: **the values did not matter, an empty
key did not matter, and the signature was not being verified.** So whatever produced that error was
not credential validation in the sense tested here, and the remaining candidates are the upjet
provider's request shape or LocalStack's S3 handling of it. Narrower, still open, and recorded as such
on both pages.

## Follow-ups

- [ ] Repeat the IAM test against LocalStack Pro with a licence and confirm `ENFORCE_IAM` does what its name says — the one experiment that would turn "cannot test policies" into "can, at a price"
- [ ] Capture the exact HTTP request the upjet AWS provider sends and replay it with `curl` against this LocalStack, which is the direct way to finish the Crossplane question
- [ ] Test SQS and DynamoDB semantics that are easy to get wrong — visibility timeouts, conditional writes — and see how faithful they are
- [ ] Compare an S3 lifecycle rule and a bucket policy against real AWS behaviour, since both are accepted here and neither is obviously enforced
- [ ] Point [[packer-aws-ami]]'s build at LocalStack and record which of its AWS calls are and are not emulated

## Related

[[crossplane-cloud-resources-as-crds]] — the page that needed a local AWS, and the failure this one narrows.
[[packer-aws-ami]] — real AWS, real cost, real cleanup, for what LocalStack lets you skip.
[[minio-object-storage-onprem]] — S3 without AWS at all, when object storage is the only part you need.
[[vault-secrets-rotation]] — credential handling that LocalStack, accepting everything, cannot exercise.
