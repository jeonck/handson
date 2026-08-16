---
title: MinIO on an on-prem cluster — S3-compatible object storage on two schedulable nodes
date: 2026-08-16
domain: install
tags: [on-prem, storage, object-storage, s3]
stack: [kubernetes, minio, helm, longhorn, ingress-nginx, cert-manager, metallb, mc]
summary: Stand up an S3 endpoint on the 3-machine cluster. Two schedulable nodes cannot give MinIO an erasure-coding topology that keeps accepting writes when a node dies — no drive count fixes that — so run it standalone on Longhorn and let one layer own the redundancy instead of paying twice for it. The AGPL line is archived and carries advisories whose only fix ships in a non-AGPL build.
source: handson
env: Kubernetes 1.31.14 (kubeadm) · Calico 3.28.2 · Longhorn 1.7.2 · MinIO chart 5.4.0 (appVersion RELEASE.2024-12-18T13-15-44Z, pinned forward to RELEASE.2025-10-15T17-29-55Z) · ingress-nginx chart 4.11.3 · cert-manager 1.16.2 · MetalLB 0.14.8 · Helm 3 — targets the 3-machine on-prem cluster with 2 schedulable nodes
verified:
duration: 60–90 min
risk: medium
---

> **Read [[s3-object-storage-options]] first.** That page compares this product against Rook/Ceph
> and Garage for this cluster, and recommends against MinIO on the strength of the §0 finding
> below. This document stays as the record of the MinIO investigation and is still accurate;
> it is no longer the default answer.
>
> ⚠️ **Nothing in this document has been run.** It was assembled on 2026-08-16 from MinIO's own
> documentation, the archived `minio/minio` and `minio/operator` repositories, and MinIO's published
> security advisories. Every version, minimum, and default below is quoted from a source with a URL;
> no command output is reproduced, because none was observed. `verified` is empty and stays empty
> until someone runs it.
>
> Versions checked on 2026-08-16: MinIO Helm chart **5.4.0**, appVersion `RELEASE.2024-12-18T13-15-44Z`,
> published 2025-01-02, the highest entry in <https://charts.min.io/index.yaml>. Last AGPL server
> release **`RELEASE.2025-10-15T17-29-55Z`** (2025-10-16). MinIO Operator **v7.1.1** (2025-04-23).
>
> **Read §0 before you install anything.** The project's status changed materially in 2026 and it
> changes what this document is worth.

An on-prem cluster has no S3. Everything downstream assumes one — Velero, database dump targets,
CI artifacts, Loki and Thanos chunks, and eventually [[longhorn-backup-target-onprem]]. MinIO is the
usual answer because it speaks the S3 API and runs on whatever disks you have.

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]] with [[longhorn-storage-onprem]],
[[metallb-l2-onprem]], [[ingress-nginx-onprem]] and [[cert-manager-onprem]] already working.

---

## 0. Project status — a decision, not a footnote

This is first because it is the only part that cannot be undone by `helm uninstall`.

| What | Status as of 2026-08-16 | Source |
|---|---|---|
| `minio/minio` (server, AGPLv3) | archived 2026-04-25, read-only. README: **"THIS REPOSITORY IS NO LONGER MAINTAINED."** | [repo](https://github.com/minio/minio) |
| Last AGPL server release | `RELEASE.2025-10-15T17-29-55Z` | [releases](https://github.com/minio/minio/releases) |
| `minio/operator` | archived 2026-03-20, read-only. Last release v7.1.1 (2025-04-23) | [repo](https://github.com/minio/operator/releases) |
| Helm chart `minio/minio` | 5.4.0, last published 2025-01-02 | [charts.min.io](https://charts.min.io/index.yaml) |
| Documentation | community doc URLs `301` to `docs.min.io/enterprise/aistor-object-store/…` | observed 2026-08-16 |
| Successor | AIStor. **AIStor Free is licensed "solely in standalone mode (single-node deployments without distributed clustering or high availability)"** | [AIStor Free agreement](https://www.min.io/legal/aistor-free-agreement) |

### The part that actually bites

MinIO's advisory list did not stop when the repository did. Two examples, read on 2026-08-16:

- **[GHSA-hv4r-mvr4-25vw](https://github.com/minio/minio/security/advisories/GHSA-hv4r-mvr4-25vw)** —
  "Unauthenticated Object Write via Query-String Credential Signature Bypass", High. Affected:
  `>= RELEASE.2023-05-18T00-05-36Z`. Patched: `>= RELEASE.2026-04-11T03-20-12Z`.
- **[GHSA-xh8f-g2qw-gcm7](https://github.com/minio/minio/security/advisories/GHSA-xh8f-g2qw-gcm7)** —
  "Path Traversal via msgpack Body in ReadMultiple Storage-REST Endpoint". Affected through
  `RELEASE.2025-09-07T16-13-09Z`. Patched: `>= RELEASE.2026-04-14T21-32-45Z`.

Both patch versions postdate the final AGPL release by six months. The second advisory's own
remediation says it plainly: *"Users of the open-source `minio/minio` project should upgrade to MinIO
AIStor `RELEASE.2026-04-14T21-32-45Z` or later."* **There is no AGPL build that carries these fixes.**

So the honest framing of this install: you are deploying a frozen artifact with known, unfixed,
High-severity advisories against it. That is survivable on a LAN-only endpoint with the interim
mitigations the advisories themselves list (§5.4), and it is not survivable on anything
internet-facing. Decide which you are building before §2.

### The alternatives, stated without endorsement

- **AIStor Free** — actively patched, but the licence above restricts it to standalone single-node.
  On this cluster that happens to match what §2 recommends anyway, so it is a live option; it is a
  licence decision, not a technical one, and not mine to make.
- **`pgsty/silo`** — a community fork of the AGPL line, rebranded from MinIO, publishing releases
  through 2026-08 and maintaining its own advisory index with backported fixes
  ([releases](https://github.com/pgsty/minio/releases)). I read its release notes and nothing else.
  I have not run it, audited it, or verified any backport. Treat that line as a lead, not a
  recommendation.
- **Replacing MinIO** — Ceph RGW, SeaweedFS, Garage. Out of scope here; noted so the follow-up exists.

> The chart README carries its own disclaimer, and it predates all of the above:
> *"This Helm chart is community built, maintained, and supported. MinIO does not guarantee support
> for any given bug, feature request, or update referencing this chart."*

### The console is not what older write-ups describe

The web console bundled with community MinIO was cut down in mid-2025: the administrative surface —
user, policy, access-key, and configuration management — was removed, leaving an object browser.
Reported at the time by [Blocks & Files (2025-06-19)](https://www.blocksandfiles.com/ai-ml/2025/06/19/minio-users-complain-after-admin-ui-removed-from-community-edition/1610856)
and argued out in [minio/minio discussion #21326](https://github.com/minio/minio/discussions/21326).
I could not confirm the exact release that did it from the archived docs, because those URLs now
redirect to the AIStor documentation, which describes a different product.

**Consequence for this document:** every administrative step below uses `mc`, not the console. Do not
plan on clicking. If a tutorial tells you to create a user in the console, it is describing a build
older than the one you are installing.

---

## 1. Operator or plain Helm chart

| | MinIO Operator v7.1.1 | Helm chart `minio/minio` 5.4.0 |
|---|---|---|
| What it adds | `Tenant` CRD, pool expansion, per-tenant TLS from its own CA, multi-tenancy | a StatefulSet and two Services |
| Kubernetes floor | **≥ 1.30.0** from v7.1.1 ([README](https://github.com/minio/operator)) — 1.31.14 clears it | none stated |
| StorageClass | expects `volumeBindingMode: WaitForFirstConsumer` | no requirement |
| Status | archived 2026-03-20 | archived with the server repo, 2026-04-25 |
| Failure surface | operator deployment + CRD + webhook, on top of MinIO | MinIO |

**Take the Helm chart.** Everything the Operator is good at — expanding server pools, running many
tenants, issuing per-tenant certificates — is about scale across many nodes. This cluster has two
schedulable nodes and one tenant. The Operator would add a controller, a CRD, and a reconciliation
loop that can itself fail, in exchange for none of its benefits, and it is archived too, so the
CRD is a permanent dependency on an unmaintained schema.

The `WaitForFirstConsumer` requirement is a second, smaller reason. Longhorn's default class may not
be set that way — check rather than assume:

```bash
kubectl get storageclass longhorn -o jsonpath='{.volumeBindingMode}{"\n"}'
```

---

## 2. What erasure coding can actually do on two nodes

The control-plane taint is kept by standing decision, so this cluster has **exactly 2 schedulable
nodes**. See [[schedulable-node-budget]] — that number, not the number of machines, is the input here.

### The documented minimums

From the archived repository, which is the documentation for the build being installed:

- *"MinIO creates erasure-coding sets of 2 to 16 drives per set. The number of drives you provide in
  total must be a multiple of one of those numbers."*
  ([docs/distributed/README.md](https://github.com/minio/minio/blob/master/docs/distributed/README.md))
- *"As the minimum drives required for distributed MinIO is 2 (same as minimum drives required for
  erasure coding), erasure code automatically kicks in as you launch distributed MinIO."* (ibid.)
- *"Choice of erasure set size is automatic based on the number of drives available… based on the
  greatest common divisor (GCD) of acceptable erasure set sizes ranging from 4 to 16."*
  ([docs/distributed/DESIGN.md](https://github.com/minio/minio/blob/master/docs/distributed/DESIGN.md))
- *"Parity blocks can not be higher than data blocks, so STANDARD storage class parity can not be
  higher than N/2."* Default parity: 5 drives or fewer → `EC:2`, 6–7 → `EC:3`, 8 or more → `EC:4`.
  ([docs/erasure/storage-class/README.md](https://github.com/minio/minio/blob/master/docs/erasure/storage-class/README.md))
- A single-node single-drive deployment *"provides no erasure coding or high availability and is
  supported only for non-production testing and evaluation."*
  ([AIStor erasure-coding docs](https://docs.min.io/enterprise/aistor-object-store/operations/core-concepts/erasure-coding/))

Note the two published numbers disagree at the bottom end: the default-parity table asks for `EC:2`
at five drives or fewer, and the `N/2` ceiling forbids `EC:2` on a 2-drive set. The archived docs do
not say which wins at `N=2`. Do not guess — read it off `mc admin info` on a running deployment. It
is one more reason not to build a 2-drive set.

### The quorum arithmetic, and why no drive count rescues two nodes

Quorum is evaluated per erasure set. The AIStor erasure-coding page gives the concrete shape for a
16-drive set: at `EC:4` you need **12 drives for both reads and writes**; at `EC:8` — parity equal to
half the set — you need **8 for reads and 9 for writes**. Parity at exactly `N/2` costs one extra
drive on the write path.

That is the case this cluster is permanently in. With exactly two nodes, **losing one node removes
exactly half the drives in every set**, whatever the drive count:

| Topology on 2 schedulable nodes | Total drives | Erasure set | Parity ceiling (`N/2`) | Drives left after one node dies | Reads | Writes |
|---|---|---|---|---|---|---|
| `mode: standalone`, 1 PVC | 1 | none | — | 0 | ✗ (pod reschedules) | ✗ (pod reschedules) |
| 2 servers × 1 drive | 2 | 2 | `EC:1` | 1 | ✓ | **✗** |
| 2 servers × 2 drives | 4 | 4 | `EC:2` | 2 | ✓ | **✗** |
| 2 servers × 4 drives | 8 | 8 | `EC:4` | 4 | ✓ | **✗** |

Read quorum is `N − parity`, which a half-set exactly meets. Write quorum, when parity is at the
`N/2` ceiling, is one higher, which a half-set never meets. **Adding drives per node does not change
the write column.** On two nodes, distributed MinIO gives you a deployment that goes read-only when a
node dies. It does not give you a deployment that survives a node dying.

MinIO's own guidance assumes a different shape: *"A production AIStor Server deployment consists of
at least 4 hosts."* Four nodes is where a node loss takes a quarter of the drives instead of half,
and where the write path survives. A 4-node example is not adaptable to this cluster; it is a
different cluster.

Be honest about what "durability" then means here. Two nodes buys you: reads through a node failure,
and nothing else. That is a real property and it is worth less than it sounds, because the thing
that most often goes wrong with a 2-node object store is not a node dying — it is the one PVC
underneath it.

### One more thing that dissolves the case for distributed mode

Every "drive" in the table above is a Longhorn PVC, not a spindle. MinIO's within-node parity would
be protecting against the failure of a Longhorn volume — and Longhorn already keeps two block-layer
replicas of every volume. You would be erasure-coding across things that are themselves replicated.

---

## 3. Longhorn underneath MinIO — pick one layer

Longhorn replicates at the block layer (`defaultReplicaCount=2`, per [[longhorn-storage-onprem]]).
MinIO erasure-codes at the application layer. Stacking them costs twice and, worse, makes it
ambiguous which layer is holding the data up.

**Byte amplification.** Longhorn already stores every byte twice, so usable capacity is raw ÷ 2
before MinIO exists. Add distributed MinIO at `EC:2` on 4 drives and the application layer stores a
second copy of everything on top of that. 100 GB of objects becomes ~400 GB of disk on two nodes'
worth of raw capacity.

**The ambiguity is the real cost.** When a node goes, both layers start recovering the same bytes at
once, and they disagree about what happened. Longhorn sees a replica gone and rebuilds it onto the
survivor. MinIO sees drives it can still reach — Longhorn reattached the volumes — and so its healer
has no failure to act on, while its write quorum is broken for a reason invisible from the storage
layer. Reading `mc admin info` and `kubectl get volumes.longhorn.io` at that moment gives you two
health stories that cannot both be acted on. Post-incident, nobody can say which layer saved the data.

### Recommendation for this cluster

**Run MinIO in `mode: standalone` on one Longhorn PVC. Longhorn is the only redundancy.** One layer
owns the data, capacity is 2× and not 4×, and there is exactly one health signal to read.

The failure mode of each option, so this is a choice and not an instruction:

- **Standalone on Longhorn (recommended).** No erasure coding at all — MinIO's docs are explicit that
  single-node single-drive gives none. **You lose bitrot detection**, which lives in the erasure
  layer; Longhorn protects against a replica being lost, not against a block coming back wrong.
  A node loss means the pod reschedules onto the survivor and Longhorn reattaches: an outage of tens
  of seconds to minutes, during which nothing reads or writes. Not zero — but bounded, and it ends by
  itself.
- **Distributed MinIO on Longhorn.** 4× amplification, and per §2 a node loss makes the deployment
  read-only until the node returns. You pay twice and buy a read-only window instead of a short
  outage. This is the worst of the three and it is the one most tutorials will lead you into.
- **Distributed MinIO on local disks** (bypassing Longhorn with a local-path class or hostPath). The
  only combination where MinIO's erasure coding protects real drives, and the only one MinIO's own
  documentation is written for. On two nodes it is still read-only after a node loss, and you have
  taken drive management back from Longhorn. Worth revisiting at four schedulable nodes; not before.

The unavoidable consequence of the recommendation: **this MinIO is a single point of failure with a
restart-shaped outage.** Write that in the service description rather than discovering it.

---

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Schedulable node count | `kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'` | 2 rows with empty `TAINTS` — matches [[schedulable-node-budget]] |
| Default StorageClass | `kubectl get storageclass` | `longhorn (default)`, exactly one default |
| Longhorn healthy | `kubectl -n longhorn-system get nodes.longhorn.io` | every listed node `Ready` and schedulable |
| Free capacity | Longhorn UI, or `kubectl -n longhorn-system get nodes.longhorn.io -o yaml` | ≥ 2× the bucket size you intend, before headroom |
| ingress-nginx | `kubectl -n ingress-nginx get svc` | holds a MetalLB address |
| cert-manager ClusterIssuer | `kubectl get clusterissuer` | the internal CA issuer from [[cert-manager-onprem]], `READY=True` |
| Spare MetalLB address | the pool range in [[metallb-l2-onprem]] | at least one unallocated |
| Helm | `helm version --short` | v3.x |
| `mc` client | `mc --version` | installed on the workstation, not in the cluster |
| Worker memory headroom | `kubectl describe node <WORKER>` | see §4.1 — the chart's default request is 16Gi |

---

## 4. Install

### 4.1 Read the chart's defaults before you use them

Three defaults in chart 5.4.0 will bite on this cluster. From
[`helm/minio/values.yaml`](https://github.com/minio/minio/blob/master/helm/minio/values.yaml) read on
2026-08-16:

| Key | Shipped default | Why it is wrong here |
|---|---|---|
| `image.tag` | `RELEASE.2024-12-18T13-15-44Z` | predates the CVE-2025-62506 fix — see §7 |
| `mode` | `distributed` | §2 and §3 |
| `replicas` | `16` | 16 pods on 2 nodes |
| `persistence.size` | `500Gi` | more than this cluster has |
| `resources.requests.memory` | `16Gi` | the pod sits `Pending` on a worker that does not have it |
| `users` | ships an example account (`console` / `console123`, policy `consoleAdmin`) | a full-admin account with a published password |

That last one is the dangerous one. Render the chart and look at what it would actually create,
**before** installing:

```bash
helm repo add minio https://charts.min.io/
helm repo update minio
helm show values minio/minio --version 5.4.0 | less
```

### 4.2 Credentials, out of band

Put the root credential in a Secret you create yourself. Do not put it in `values.yaml`: Helm stores
rendered values in the release Secret, and `helm get values` will hand the credential to anyone with
read access to the namespace, for as long as the release exists.

```bash
kubectl create namespace minio
```

```bash
kubectl -n minio create secret generic minio-root \
  --from-literal=rootUser='<ROOT_USER>' \
  --from-literal=rootPassword='<REDACTED>'
```

Generate the password with something that is not your memory, and put it in whatever holds the
cluster's secrets:

```bash
openssl rand -base64 36
```

The chart reads two keys from `existingSecret`. Confirm the key names the version you are installing
expects rather than trusting the two above — the chart is unmaintained and this is cheap:

```bash
helm show values minio/minio --version 5.4.0 | grep -n -A6 'existingSecret'
```

### 4.3 Values

```yaml title="values-minio.yaml"
image:
  repository: quay.io/minio/minio
  # Pinned forward past the chart's appVersion: the chart ships
  # RELEASE.2024-12-18T13-15-44Z, which predates the fix for CVE-2025-62506
  # (GHSA-jjjj-jwhf-8rgr) in the exact service-account scoping used in section 6.
  # This is the last AGPL release; see section 0 for what it does not fix.
  tag: RELEASE.2025-10-15T17-29-55Z

mode: standalone            # section 3 — Longhorn owns the redundancy

existingSecret: minio-root  # section 4.2 — never inline the credential

users: []                   # drop the chart's example consoleAdmin account
policies: []
buckets: []                 # created with mc in section 6, not by a post-install job

persistence:
  enabled: true
  storageClass: longhorn
  accessMode: ReadWriteOnce
  size: <SIZE>Gi            # remember Longhorn stores this twice

resources:
  requests:
    memory: 2Gi             # chart default is 16Gi
    cpu: 500m
  limits:
    memory: 4Gi

service:
  type: ClusterIP           # section 5 puts a MetalLB address in front deliberately
  port: "9000"

consoleService:
  type: ClusterIP
  port: "9001"

ingress:
  enabled: false            # S3 API does not go through ingress-nginx — section 5
consoleIngress:
  enabled: false            # created by hand in section 5.2

environment:
  MINIO_BROWSER_REDIRECT_URL: https://<CONSOLE_HOST>
```

`MINIO_DOMAIN` is deliberately absent. §5.1 explains what it is for and what it costs.

### 4.4 Install

```bash
helm install minio minio/minio \
  --namespace minio \
  --version 5.4.0 \
  -f values-minio.yaml \
  --wait --timeout 10m
```

```bash
kubectl -n minio get pods -o wide
kubectl -n minio get pvc
kubectl -n minio get svc
```

Look for a single pod at `1/1` — `Running` on its own is not the check, since MinIO reports
unreadiness through its probe while it is still bringing the drive up. A PVC stuck at `Pending` is a
Longhorn scheduling problem, not a MinIO one; go to [[longhorn-storage-onprem]].

Confirm what is actually running, rather than what you asked for:

```bash
kubectl -n minio get pod -l app=minio -o jsonpath='{.items[*].spec.containers[*].image}{"\n"}'
```

---

## 5. Endpoints — the console and the S3 API want different things

MinIO serves two ports: the **S3 API** on 9000 and the **console** on 9001. They have different
requirements and the difference is not cosmetic.

### 5.1 Why the S3 API does not belong behind the shared ingress

**Addressing style.** S3 clients address a bucket one of two ways: path-style
(`https://minio.<DOMAIN>/<BUCKET>/<KEY>`) or virtual-host-style
(`https://<BUCKET>.minio.<DOMAIN>/<KEY>`). MinIO serves path-style by default; virtual-host-style
requires `MINIO_DOMAIN` to be set on the server, and — per the same documentation — *"Setting
`MINIO_DOMAIN` alone is not sufficient… the surrounding DNS and TLS configuration must also resolve
and secure those subdomains"*
([AIStor core settings](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/core/)).

That is the whole problem in one sentence. Virtual-host-style behind ingress-nginx needs a **wildcard
Ingress host**, a **wildcard DNS record**, and a **wildcard certificate** — every bucket name is a new
hostname. The internal CA in [[cert-manager-onprem]] can issue a wildcard, but you are now putting a
wildcard cert on the shared controller that fronts every other app. Meanwhile newer AWS SDKs default
to virtual-host-style and need an explicit `forcePathStyle` / `--addressing-style path` opt-out, so
"just use path-style" is a per-client instruction you will be repeating for years.

**Body size and buffering.** ingress-nginx's default `proxy-body-size` is `1m`. An object store whose
uploads fail at 1 MiB is not an object store. Fixing it means either raising the limit on the shared
controller — for every app behind it — or a per-Ingress annotation plus `proxy-request-buffering: off`
so that large uploads are not spooled to the controller's disk first.

**Signature integrity.** SigV4 signs headers including `Host`. Every proxy hop is another place a
rewritten or added header turns a valid request into `SignatureDoesNotMatch`, and the error names
nothing useful. Fewer hops is not an aesthetic preference here.

### 5.2 The recommendation

**S3 API on its own pinned MetalLB address, with MinIO terminating TLS itself. Console through
ingress-nginx with an internal-CA certificate.**

The console is an ordinary web UI on one fixed hostname with small requests — exactly what the shared
ingress is for. The S3 API is none of those things.

Pin the address using the procedure in [[metallb-pin-loadbalancer-ip]]:

```yaml title="minio-api-svc.yaml"
apiVersion: v1
kind: Service
metadata:
  name: minio-api
  namespace: minio
  annotations:
    metallb.universe.tf/loadBalancerIPs: "<S3_API_IP>"
spec:
  type: LoadBalancer
  selector:
    app: minio
    release: minio
  ports:
    - name: https
      port: 443
      targetPort: 9000
```

```bash
kubectl -n minio get pod -l app=minio --show-labels
```

Confirm the selector against the labels the chart actually applied before relying on it — a Service
with a selector that matches nothing still gets an address and still answers, by refusing every
connection.

```bash
kubectl apply -f minio-api-svc.yaml
kubectl -n minio get svc minio-api -o wide
```

Console Ingress, on the shared controller:

```yaml title="minio-console-ingress.yaml"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: minio-console
  namespace: minio
  annotations:
    cert-manager.io/cluster-issuer: <INTERNAL_CA_ISSUER>
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
spec:
  ingressClassName: nginx
  tls:
    - hosts: ["<CONSOLE_HOST>"]
      secretName: minio-console-tls
  rules:
    - host: <CONSOLE_HOST>
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: minio-console
                port:
                  number: 9001
```

```bash
kubectl apply -f minio-console-ingress.yaml
kubectl -n minio get certificate minio-console-tls
```

The `Certificate` must reach `READY=True`. It sits at `False` with a `Pending` order when the issuer
name is wrong — a typo there produces an Ingress that serves ingress-nginx's own self-signed default
certificate and looks like it is working.

### 5.3 TLS on the S3 endpoint

MinIO reads its own certificate from a certs directory and requires two exact filenames:
**`public.crt`** and **`private.key`**
([docs/tls/README.md](https://github.com/minio/minio/blob/master/docs/tls/README.md)). TLS turns on
by their presence — there is no enable flag.

Issue the certificate from the internal CA for the name clients will use. Because the S3 endpoint is
an IP-addressed LoadBalancer, the SAN has to cover whatever the client puts in the URL — a hostname
you add to internal DNS, and the IP itself if any client will connect by address:

```yaml title="minio-api-cert.yaml"
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: minio-api-tls
  namespace: minio
spec:
  secretName: minio-api-tls
  issuerRef:
    name: <INTERNAL_CA_ISSUER>
    kind: ClusterIssuer
  commonName: <S3_HOST>
  dnsNames:
    - <S3_HOST>
    # In-cluster clients hit this same TLS listener — MinIO has no plaintext
    # port once the certificate is present — so the Service names belong in the
    # SAN too. Leave them out and every in-cluster S3 read fails certificate
    # validation while `mc` from a workstation works perfectly.
    - minio.<MINIO_NS>.svc.cluster.local
    - minio.<MINIO_NS>.svc
    - minio.<MINIO_NS>
  ipAddresses:
    - <S3_API_IP>
```

**There is no plaintext S3 port after this step.** TLS is on or off for the
whole listener. Anything inside the cluster — [[trino-query-engine-onprem]],
[[spark-on-k8s-onprem]], [[postgresql-cnpg-onprem]], [[airflow-orchestration-onprem]] —
must therefore use `https://` *and* trust the internal CA from
[[cert-manager-onprem]]. How that trust is installed differs per runtime (a JVM
truststore, a connection extra, an operator field) and none of it has been run
here; each of those documents carries it as an open item.

cert-manager writes `tls.crt` and `tls.key` into the Secret; MinIO wants `public.crt` and
`private.key`. Bridge that with the chart's TLS values rather than renaming by hand — check the
version's key names, because this is exactly the kind of thing an unmaintained chart gets wrong:

```bash
helm show values minio/minio --version 5.4.0 | grep -n -B2 -A12 'tls:'
```

If the chart's mapping does not cover it, project the Secret with explicit key paths in a volume so
the two filenames land as MinIO expects. Do not `cp` certificates into a running pod — it works until
the pod restarts, and then it does not, and nobody remembers why.

Add the DNS record for `<S3_HOST>` → `<S3_API_IP>` in the internal zone before testing, or every
result below is measuring the wrong thing.

### 5.4 Interim mitigations from §0

These come from the advisories' own remediation sections, quoted, not invented. Apply them if you are
running the frozen AGPL build:

- **GHSA-hv4r-mvr4-25vw:** *"Block unsigned-trailer requests at the load balancer. Reject any request
  containing `X-Amz-Content-Sha256: STREAMING-UNSIGNED-PAYLOAD-TRAILER`"*, and *"Restrict WRITE
  permissions. Limit `s3:PutObject` grants to trusted principals"* — the advisory notes this reduces
  but does not eliminate exposure for principals that already have write access.
- **GHSA-xh8f-g2qw-gcm7:** *"Rotate the root credential and restrict who holds it"*, *"Do not run the
  MinIO container as UID 0"*, *"Restrict the internode storage-REST port at the network layer"*.

The first one needs a proxy in the path, which §5.2 deliberately removed for the S3 endpoint. That is
a genuine tension between the two recommendations and there is no clean answer: either accept the
proxy hop for the S3 API and its signature/body-size problems, or enforce the header rejection with a
NetworkPolicy-adjacent control you have to build. Whichever you pick, write down which one, because
the mitigation is invisible from the deployment.

---

## 6. A bucket and a scoped access key

All of this is `mc`. The console cannot do it — §0.

```bash
mc alias set <ALIAS> https://<S3_HOST> <ROOT_USER> <REDACTED>
```

If the internal CA is not in your workstation's trust store, `mc` will refuse the connection. Add the
CA properly rather than reaching for `--insecure`; a habit of `--insecure` against the S3 endpoint is
how a real certificate failure gets ignored later.

```bash
mc admin info <ALIAS>
mc mb <ALIAS>/<BUCKET>
mc ls <ALIAS>
```

### 6.1 The policy

Write the smallest policy that lets the workload do its job, and nothing for any other bucket:

```json title="policy-<BUCKET>-rw.json"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::<BUCKET>"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::<BUCKET>/*"]
    }
  ]
}
```

### 6.2 The key

`mc`'s administrative subcommands were reorganised across the AIStor rebrand, so confirm the surface
of the client you have before running the next two commands verbatim:

```bash
mc --version
mc admin user svcacct add --help
```

```bash
mc admin policy create <ALIAS> <POLICY_NAME> policy-<BUCKET>-rw.json
mc admin user add <ALIAS> <WORKLOAD_USER> <REDACTED>
mc admin policy attach <ALIAS> <POLICY_NAME> --user <WORKLOAD_USER>
```

```bash
mc admin user svcacct add <ALIAS> <WORKLOAD_USER> \
  --access-key '<ACCESS_KEY>' \
  --secret-key '<REDACTED>' \
  --policy policy-<BUCKET>-rw.json
```

The service account inherits the parent user's policy, further narrowed by the inline session policy.
That narrowing is the mechanism CVE-2025-62506 bypassed — §7. It is fixed in the release pinned in
§4.3, and §Verification checks that the fix is present rather than assuming it.

Hand `<ACCESS_KEY>` and its secret to the workload through a Kubernetes Secret. They never go in
`values.yaml`, a Git-tracked manifest, or this document.

---

## 7. Failure points documented upstream

Each one has a source. None was observed here.

**The chart's default image predates a privilege-escalation fix in the mechanism §6 uses.**
CVE-2025-62506 / [GHSA-jjjj-jwhf-8rgr](https://github.com/minio/minio/security/advisories/GHSA-jjjj-jwhf-8rgr) —
service accounts and STS credentials with a restricted session policy could bypass that policy when
operating on their own account, notably when creating further service accounts for the same user; the
IAM check relied on `DenyOnly` instead of confirming the session policy allowed the action. Fixed in
`RELEASE.2025-10-15T17-29-55Z`. Chart 5.4.0's default `image.tag` is `RELEASE.2024-12-18T13-15-44Z`,
ten months earlier. §4.3 pins forward.

**High-severity advisories with no AGPL fix.** GHSA-hv4r-mvr4-25vw and GHSA-xh8f-g2qw-gcm7, §0.
Patched only in AIStor builds dated 2026-04.

**The chart ships an example admin account.** `console` / `console123` with the `consoleAdmin` policy
in the `users` list. §4.3 sets `users: []`; §4.1 renders the chart to check.

**Parity cannot exceed half the erasure set**, so a 2-drive set cannot carry the documented default
of `EC:2`, and the archived docs do not say what it does instead
([storage-class README](https://github.com/minio/minio/blob/master/docs/erasure/storage-class/README.md)).

**Single-node single-drive has no erasure coding and no HA**, and upstream calls it supported *"only
for non-production testing and evaluation"*
([AIStor erasure-coding docs](https://docs.min.io/enterprise/aistor-object-store/operations/core-concepts/erasure-coding/)).
§3 recommends it anyway, with the reason and the cost stated. Know that you are outside upstream's
supported shape.

**Virtual-host-style addressing needs more than `MINIO_DOMAIN`** — DNS and TLS for every bucket
subdomain ([AIStor core settings](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/core/)). §5.1.

**The Operator needs `volumeBindingMode: WaitForFirstConsumer`** on the StorageClass backing a
Tenant ([Operator README](https://github.com/minio/operator)). Only relevant if you overrule §1.

**The chart is community-supported and MinIO disclaims support for it** — chart README, quoted in §0.

**Community documentation URLs redirect to the AIStor documentation.** The docs describing the build
you installed are no longer served at their own addresses; the pages you land on describe a different
product with different minimums. Observed 2026-08-16 on
`min.io/docs/minio/kubernetes/upstream/…` → `docs.min.io/enterprise/aistor-object-store/…`.

---

## 8. The circularity problem — before [[longhorn-backup-target-onprem]]

This cluster is scheduled to point Longhorn's backup target at an S3 endpoint. **Do not point it at
this one.**

Longhorn's backups would be written into a bucket, in a MinIO server, whose data lives on a Longhorn
volume, replicated by the same Longhorn installation the backups exist to recover. Three distinct
failures follow:

1. **Shared fate.** A Longhorn-level fault — a bad upgrade, a corrupt replica, the
   `deleting-confirmation-flag` uninstall path in [[longhorn-storage-onprem]] — destroys the volumes
   and the backups of those volumes in the same motion.
2. **Restore ordering.** Restoring a Longhorn volume needs the backup target reachable. The backup
   target is a pod whose PVC is a Longhorn volume. If Longhorn is what broke, that pod cannot start,
   and the backup is unreachable at precisely the moment it is needed. This one is worse than shared
   fate because the data may be perfectly intact and still unrecoverable.
3. **Amplification, again.** Every backup byte is stored twice by Longhorn, on the same disks holding
   the volumes being backed up. Backups compete for capacity with the thing they protect.

What is fine: application-level backups where the restore path does not run through Longhorn —
database dumps, CI artifacts, Velero's object data with its metadata elsewhere, Loki and Thanos
chunks.

What is not fine: Longhorn's own backup target, and anything whose recovery procedure begins with
"first get the cluster's storage layer working". Those go to a MinIO **outside** this cluster, or an
NFS export on a machine that is not one of the three. If this MinIO is used for them at all, it is a
convenience copy and the words "off-cluster copy" must appear next to it in the runbook.

---

## Verification checklist

Each of these fails on a specific realistic fault. Known false passes are named next to the check.

- [ ] `helm template` output — rendered *before* install — contains no plaintext root credential and
      no `console123`. Grepping the live cluster instead is too late.
- [ ] `kubectl -n minio get pods` shows `1/1`, not merely `Running`. MinIO reports an unready drive
      through the probe; `Running` passes while the drive is unusable.
- [ ] `kubectl -n minio get pod -o jsonpath='{..image}'` shows `RELEASE.2025-10-15T17-29-55Z`.
      **False pass:** `helm get values` shows what you asked for, not what is running — a failed image
      pull leaves the old ReplicaSet's pod serving happily.
- [ ] `mc admin info <ALIAS>` reports that same release, and reports the drive/parity layout you
      intended. If it reports an erasure configuration at all under `mode: standalone`, the values
      did not apply.
- [ ] `kubectl -n longhorn-system get volumes.longhorn.io` — MinIO's volume is `attached` / **`healthy`**,
      not `degraded`. `degraded` here means only one replica exists and §3's entire argument is void.
- [ ] From a LAN workstation with the internal CA trusted and **no `-k`**: `curl https://<S3_HOST>/`
      completes the TLS handshake and returns MinIO's S3 XML error for an unauthenticated request.
      The 403 is the pass; a certificate warning is the failure. **False pass:** running this from a
      cluster node, or against the Service ClusterIP, can bypass the certificate path being tested.
- [ ] `<CONSOLE_HOST>` in a browser presents a certificate chaining to the internal CA — check the
      issuer, not the padlock. **False pass:** ingress-nginx serves its own self-signed default
      certificate when the `Certificate` is not ready, and the page still loads.
- [ ] **The scoped key writes to its own bucket.** `mc` aliased to `<ACCESS_KEY>` puts an object into
      `<BUCKET>` successfully.
- [ ] **The scoped key is denied elsewhere — run the denial.** Create a second bucket as root, then
      `mc ls <SCOPED_ALIAS>/<OTHER_BUCKET>` must return `AccessDenied`. A policy that exists is not a
      policy that denies; this is the only item that proves the scoping.
- [ ] **The scoped key cannot create a further service account for itself.** `mc admin user svcacct add`
      run as `<ACCESS_KEY>` must be refused. This is the CVE-2025-62506 regression check; it passes
      trivially on a patched build and is the reason §4.3 pins the image.
- [ ] **An object survives the pod being destroyed.** Put an object, record its checksum, then
      `kubectl -n minio delete pod -l app=minio`, wait for `1/1`, and `mc cp` it back and compare the
      checksum. Compare bytes, not exit codes. **False pass:** reading during the terminating pod's
      grace period can be served by the old pod — confirm the pod's UID changed before reading.
- [ ] **An object survives the pod moving to the other node.** `kubectl cordon` the node it is on,
      delete the pod, confirm it lands on the other schedulable node, and read the same checksum back.
      This is what §3 claims Longhorn buys; it is unproven until watched. Uncordon afterwards.
- [ ] An upload larger than 1 MiB succeeds by the route real clients will use. **False pass:** it
      succeeds over the MetalLB address while the console Ingress path 413s, or vice versa — test the
      route the client uses, not the convenient one.
- [ ] Deleting a test bucket removes it, and the Longhorn volume's used capacity drops. Space that
      never comes back is a lifecycle problem you want to find on a test bucket.

Not on this list, deliberately: anything checking that the MinIO process is up. That is already
covered by `1/1`, and a second liveness-shaped check would only add a step that cannot fail.

---

## Rollback

**`helm uninstall` plus deleting the PVC destroys every object.** There is no undo and no snapshot
unless you made one.

Revoke credentials first — they outlive the deployment in whatever consumed them:

```bash
mc admin user svcacct rm <ALIAS> <ACCESS_KEY>
mc admin user remove <ALIAS> <WORKLOAD_USER>
mc admin policy rm <ALIAS> <POLICY_NAME>
```

Copy anything that matters off the cluster before going further:

```bash
mc mirror <ALIAS>/<BUCKET> <LOCAL_PATH>/
```

```bash
kubectl delete -f minio-console-ingress.yaml
kubectl delete -f minio-api-svc.yaml
kubectl delete -f minio-api-cert.yaml
helm uninstall minio -n minio
```

The PVC survives `helm uninstall`, which is the safe default and also means the data is still there
and still occupying twice its size on Longhorn. Deleting it is the irreversible step:

```bash
kubectl -n minio get pvc
kubectl -n minio delete pvc <PVC_NAME>
kubectl delete namespace minio
```

```bash
kubectl -n longhorn-system get volumes.longhorn.io
```

The Longhorn volume should disappear a few seconds later — the `longhorn` class reclaim policy is
`Delete`. If it lingers, that is a `Retain` class or a stuck finalizer, and it holds disk forever.

**Abort criteria** — stop and do not proceed rather than working around:

- The pod will not reach `1/1` and the PVC is `Bound`. That is MinIO refusing the drive, not a
  scheduling problem; reading `kubectl logs` beats retrying the install.
- The scoped-key denial check in §Verification does not deny. Do not hand out the key. Something
  about the policy or the running image is not what you think it is.
- The Longhorn volume comes up `degraded`. Fix that in [[longhorn-storage-onprem]] first — with §3's
  recommendation, one replica is the entire redundancy story.

---

## Follow-ups

- [ ] Settle the §0 question and record the decision: frozen AGPL build with §5.4 mitigations, AIStor
      Free under its standalone-only licence, a maintained fork, or a different object store. It is a
      licensing and risk decision, not a technical one, and it should not be made implicitly by
      whoever runs the install 📅 2026-09-15
- [ ] Re-read <https://github.com/minio/minio/security/advisories> before the S3 endpoint is reachable
      from anything wider than the LAN, and again each quarter — the advisory list keeps growing
      against a build that no longer receives fixes 📅 2026-09-01
- [ ] Decide where Longhorn's backup target actually lives, per §8, before
      [[longhorn-backup-target-onprem]] is executed. Off-cluster MinIO or an NFS export on a fourth
      machine 📅 2026-09-30
- [ ] Revisit §2 and §3 if [[schedulable-node-budget]] ever reports four schedulable nodes — that is
      the point where distributed MinIO on local disks becomes the right answer instead of the
      expensive one

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this targets. Its kept control-plane taint is the single
constraint that makes §2 come out the way it does.
[[schedulable-node-budget]] — the standing answer of 2 schedulable nodes. §2's whole table is derived
from that number; re-read it before changing the topology.
[[longhorn-storage-onprem]] — supplies the `longhorn` StorageClass and the second block replica that
§3 makes the only layer of redundancy. Its `defaultReplicaCount=2` is what makes stacking cost 4×.
[[metallb-l2-onprem]] — supplies the address the S3 API listens on, and the reason §5 can put the API
somewhere other than the shared ingress.
[[metallb-pin-loadbalancer-ip]] — pinning that address, so the S3 endpoint's DNS record and
certificate SAN do not go stale when the Service is recreated.
[[ingress-nginx-onprem]] — fronts the console. §5.1 is the argument for why the S3 API deliberately
does not go through it.
[[cert-manager-onprem]] — issues both certificates from the internal CA. Path A (internal CA) is the
one used here; no public DNS is involved.
[[longhorn-backup-target-onprem]] — the circularity risk in §8. Read §8 before pointing that document
at this MinIO.
[[k8s-node-drain-replace]] — draining the node holding MinIO's Longhorn replica is a storage
operation, and with one MinIO pod it is also an outage. Plan it there.
