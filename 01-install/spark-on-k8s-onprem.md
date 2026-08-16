---
title: Apache Spark on Kubernetes — batch jobs on two schedulable nodes
date: 2026-08-16
domain: install
tags: [on-prem, batch, data-processing]
stack: [kubernetes, spark, spark-operator, helm, kubectl, minio, s3a]
summary: The Spark Operator turns a batch job into an object you can kubectl get, and that is the whole appeal — but on two 4 GB workers the driver plus executors is the entire memory budget, overhead makes every request larger than the number you typed, and a request nothing can satisfy produces a Pending pod that reads as a hung job rather than a failed one.
source: handson
env: Kubernetes 1.31.14 (kubeadm, 1 control plane + 2 workers, ≈2 vCPU / 4 GB each) · containerd 2.2.1 · Calico 3.28.2 · Longhorn 1.7.2 · Kubeflow Spark Operator chart 2.5.2 · Apache Spark 4.0.4 · Helm 3.x
verified:
duration: 60–90 min
risk: medium
---

> **Not executed. Assembled from upstream documentation and source on 2026-08-16.** Every version,
> field name and default below was read out of an upstream artifact on that date — Kubeflow Spark
> Operator chart **2.5.2** (`appVersion` 2.5.2, published 2026-07-31), Apache **Spark 4.0.4**, the
> operator's own `examples/spark-pi.yaml` at tag `v2.5.2`, and the Spark 4.0.4 documentation set.
> Nothing here has been run against the cluster. `verified` stays empty until it has been. Where a
> claim is upstream's rather than ours, the source is linked at the point it is made; where a number
> is arithmetic rather than measurement, it says so.

Batch Spark on Kubernetes means one thing at runtime: a **driver pod** that asks the API server to
create **executor pods**, runs the job across them, and exits. Everything else — the operator, the
CRD, the service account — exists to make that submission repeatable and to give you something to
`kubectl get` afterwards.

This document stands up the Kubeflow Spark Operator on the cluster from
[[onprem-3node-kubeadm-ubuntu]], gives the driver the RBAC it needs, points Spark at the in-cluster
MinIO for input and output, submits a job, and then answers the question that catches everyone once:
where the logs and the Spark UI are after the driver pod has exited.

Out of scope: Spark Connect, streaming, dynamic allocation with an external shuffle service, GPUs,
Volcano/YuniKorn gang scheduling, and multi-tenant queueing. All are supported by this operator; none
of them fit on two 2-vCPU workers.

---

## Decide first: operator or plain `spark-submit`

Both routes end in the same driver pod. They differ in what you own.

| | Spark Operator (`SparkApplication` CRD) | `spark-submit --deploy-mode cluster` |
|---|---|---|
| What you submit | A YAML object, applied like anything else | A CLI invocation from a machine with a Spark distribution and a kubeconfig |
| Where the job definition lives | In the cluster, in Git, diffable | In whatever shell history or CI script ran it |
| Retries | `restartPolicy` on the CR, `onFailureRetries` | Yours to build |
| Scheduled runs | `ScheduledSparkApplication` | cron, somewhere else |
| Status | `kubectl get sparkapplication` | `kubectl get pod` and read the driver's exit code |
| Extra moving parts | A controller and a mutating webhook that must stay up | None |
| Failure surface it adds | The webhook's `failurePolicy` is `Fail`, so a down webhook blocks driver pod creation; a namespace missing from `spark.jobNamespaces` is silently never reconciled | — |

The operator is worth it as soon as jobs are recurring, reviewed, or owned by more than one person.
`spark-submit` is worth keeping working anyway, because when the operator misbehaves it is the only
way to establish whether the problem is Spark or the controller. Section 7 keeps it alive as a
diagnostic.

The chart's own values file is candid about the controller's cost, and it matters on a 4 GB worker:

> "each job submission will spawn a JVM within the controller pods using
> `/usr/local/openjdk-11/bin/java -Xmx128m`. Kubernetes may kill these Java processes at will to
> enforce resource limits."
> — [`values.yaml`, chart 2.5.2](https://github.com/kubeflow/spark-operator/blob/v2.5.2/charts/spark-operator-chart/values.yaml)

---

## Memory budget — do this before installing anything

Spark is the component on this cluster that competes hardest for memory. Longhorn wants disk, ingress
wants a node, Spark wants *all the RAM you have, briefly*. Work this out first.

### The three multipliers nobody expects

**1. There are two schedulable nodes, not three.** The control-plane taint is kept by standing
decision — [[schedulable-node-budget]] records that, and the reason is that the control plane is the
4 GB machine where an evicted etcd takes the cluster down rather than an app. Driver and executor
pods carry no control-plane toleration, so **every Spark pod lands on one of the two workers.**

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

**2. The pod asks for more memory than you wrote.** `spec.driver.memory: 512m` does not produce a
pod requesting 512 MiB. Spark adds an overhead on top, and the *minimum* dominates at these sizes:

| Setting | Default | Source |
|---|---|---|
| `spark.executor.memoryOverheadFactor` | `0.10` (JVM), `0.40` for non-JVM jobs on Kubernetes | [Spark 4.0.4 configuration](https://spark.apache.org/docs/4.0.4/configuration.html) |
| `spark.executor.minMemoryOverhead` | `384m` | same |
| `spark.driver.minMemoryOverhead` | `384m` | same |

So overhead = `max(memory × factor, 384m)`, and the container gets `memory + overhead`:

| You write | Overhead applied | Pod actually requests |
|---|---|---|
| driver `512m` | 384 MiB (the minimum wins; 10% of 512 is 51) | ≈ **896 MiB** |
| executor `1g` (JVM/Scala) | 384 MiB (the minimum wins again) | ≈ **1408 MiB** |
| executor `2g` (JVM/Scala) | 384 MiB (10% of 2048 is 205, minimum still wins) | ≈ **2432 MiB** |
| executor `1g` (**PySpark**) | ≈ 410 MiB (factor 0.40, not 0.10) | ≈ **1434 MiB** |

Below roughly 3.8 GB of executor memory the 384 MiB floor is doing all the work, which means **small
executors are proportionally expensive**: a 512m executor costs 896 MiB, so you pay 75% overhead.
Two 1g executors cost less total RAM than four 512m ones and give the same heap.

**3. Something is already on those workers.** Longhorn's manager and instance-manager, Calico,
kube-proxy, ingress-nginx, Argo CD if you installed it. Measure, do not assume:

```bash
kubectl describe node <WORKER> | sed -n '/Allocated resources/,/Events/p'
kubectl get node <WORKER> -o jsonpath='{.status.allocatable.memory}{"\n"}{.status.allocatable.cpu}{"\n"}'
```

`allocatable` on a 4 GB Ubuntu node is already below 4 GiB — kubelet subtracts its eviction
threshold. Subtract the `Requests` column from `allocatable`; what remains is Spark's ceiling on that
node.

### What actually fits

Arithmetic, not measurement — recompute it against your own `allocatable`:

- **A safe first shape: driver `512m` + 2 executors at `1g`, one executor per worker.**
  That is ≈896 MiB for the driver and ≈1408 MiB per executor, so ≈2.3 GiB on the worker holding the
  driver and ≈1.4 GiB on the other. On workers with ~2.5 GiB free each, it fits with room to be wrong.
- **Three executors at `1g` does not fit** unless the workers are otherwise nearly empty: two of them
  would have to share a node with the driver, ≈3.7 GiB on one worker.
- **Do not go past 2 executors without checking.** The number of executors that fit here is 2, and
  the second one is already sharing a node with the driver's neighbours.

CPU is the tighter constraint on 2-vCPU workers, and it bites differently. `spec.driver.cores: 1`
maps to `spark.driver.cores`, which becomes the pod's CPU request unless you override it.
`spark.kubernetes.{driver,executor}.request.cores` "takes precedence over `spark.driver.cores` for
specifying the driver pod cpu request"
([Spark 4.0.4, Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html)),
and the operator exposes it as `coreRequest`. Use it: keep `cores: 1` so Spark schedules one task
slot, but request `500m` so a driver and an executor can coexist on a 2-vCPU node next to Calico and
kube-proxy.

### When it does not fit, the job looks hung, not failed

This is the failure mode to internalise, because nothing about it says "too big":

- `kubectl get sparkapplication` shows the app in a live-looking state.
- `kubectl get pods` shows `<app>-driver` at **`Pending`**, indefinitely.
- No error, no restart, no event on the `SparkApplication` object saying "does not fit".
- The only place the truth is written is the pod's events:

```bash
kubectl describe pod <APP>-driver -n <NS> | sed -n '/Events/,$p'
```

A `FailedScheduling` event naming `Insufficient memory` or `Insufficient cpu` is the answer. Nothing
retries it into existence — the pod waits for a node that will never appear, and a job you expected
to take four minutes is still "running" an hour later. **Check `Pending` before you check anything
else.** The same shape appears when a `nodeSelector` or toleration is wrong, so read the event rather
than assuming it is size.

---

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster healthy | `kubectl get nodes` | all `Ready` |
| Schedulable node count | `kubectl get nodes -o custom-columns='N:.metadata.name,T:.spec.taints[*].key'` | 2 rows with empty taints |
| Free memory per worker | `kubectl describe node <WORKER>` | `allocatable` minus `Requests` ≥ what section "What actually fits" plans |
| Helm | `helm version --short` | v3.x |
| Kubernetes version | `kubectl version -o json \| jq -r .serverVersion.gitVersion` | v1.31.x |
| Object storage reachable | `kubectl -n minio get svc` | a ClusterIP service on 9000 — see [[minio-object-storage-onprem]] |
| A bucket to write to | `mc ls <ALIAS>/` | the target bucket exists |
| Egress to Maven Central *or* a pre-built image | `curl -sSI https://repo1.maven.org/maven2/` | see section 4 — one of the two is required for S3A |

---

## 1. Install the Spark Operator

### 1.1 The chart moved — old instructions point at a 404

The project was **GoogleCloudPlatform/spark-on-k8s-operator** and is now
[**kubeflow/spark-operator**](https://github.com/kubeflow/spark-operator). The GitHub repository
redirects, so old `git clone` lines still work and hide the move. The **Helm repository does not
redirect**: `https://googlecloudplatform.github.io/spark-on-k8s-operator/index.yaml` returned **404**
when checked on 2026-08-16. Any guide still using it fails at `helm repo add`, or worse, at
`helm repo update` months after it worked.

The current one:

```bash
helm repo add spark-operator https://kubeflow.github.io/spark-operator
helm repo update spark-operator
```

```bash
helm search repo spark-operator/spark-operator --versions | head -5
```

Chart versions published as of 2026-08-16, read from
[the repo index](https://kubeflow.github.io/spark-operator/index.yaml):

| Chart | appVersion | Published |
|---|---|---|
| **2.5.2** | 2.5.2 | 2026-07-31 |
| 2.5.1 | 2.5.1 | 2026-06-15 |
| 2.5.0 | 2.5.0 | 2026-03-19 |
| 2.4.0 | 2.4.0 | 2025-11-17 |

Note that the chart on the repository's `master` branch reads `version: 2.5.0-rc.0` — the version
bump happens on the release branch, so **`master` is not the version to quote.** Take the number from
the released tag or the index, as above.

The API group is unchanged by the move: objects are still `sparkoperator.k8s.io/v1beta2`.

### 1.2 Install

```bash
kubectl create namespace spark-jobs
```

Create the job namespace **first**. The chart's `spark.jobNamespaces` values comment says: "Make sure
the namespaces have already existed." The chart renders the driver's Role and ServiceAccount into
each listed namespace at install time; a namespace that does not exist yet gets neither.

```bash
helm install spark-operator spark-operator/spark-operator \
  --namespace spark-operator \
  --create-namespace \
  --version 2.5.2 \
  --set 'spark.jobNamespaces={spark-jobs}' \
  --set controller.resources.requests.cpu=100m \
  --set controller.resources.requests.memory=300Mi \
  --set controller.resources.limits.memory=500Mi \
  --set webhook.resources.requests.cpu=50m \
  --set webhook.resources.requests.memory=100Mi \
  --wait --timeout 5m
```

Why these, rather than the defaults:

- `spark.jobNamespaces` — the chart default is `["default"]`. A `SparkApplication` created anywhere
  else is **not reconciled and produces no events**; the object simply sits there. Setting it to the
  namespace you will actually use turns that into an impossibility rather than a mystery.
- `controller.resources` — the chart ships `resources: {}`, i.e. no requests and no limits. On a
  cluster with 8 GB of worker RAM total, an unbounded controller is a bad neighbour. The limit is set
  above the `-Xmx128m` submission JVM the values file warns about, deliberately: too tight a limit
  reproduces upstream's documented `signal: killed`.
- The webhook stays enabled (chart default). It is what applies pod-level fields such as volumes and
  tolerations to driver and executor pods.

```bash
kubectl -n spark-operator get pods
kubectl -n spark-operator rollout status deploy/spark-operator-controller --timeout=180s
kubectl -n spark-operator rollout status deploy/spark-operator-webhook --timeout=180s
```

Two Deployments — controller and webhook — each 1 replica by default. Both must be `1/1`; a webhook
that is `0/1` with a `Fail` failure policy means the next driver pod cannot be created at all.

```bash
kubectl get crd | grep sparkoperator
```

`sparkapplications.sparkoperator.k8s.io` and `scheduledsparkapplications.sparkoperator.k8s.io`.

---

## 2. The service account the driver needs

The driver is a Kubernetes client. Upstream states the requirement plainly:

> "The Spark driver pod uses a Kubernetes service account to access the Kubernetes API server to
> create and watch executor pods. The service account used by the driver pod must have the
> appropriate permission for the driver to be able to do its work. Specifically, at minimum, the
> service account must be granted a `Role` or `ClusterRole` that allows driver pods to create pods
> and services."
> — [Spark 4.0.4, Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html)

With `spark.rbac.create=true` and `spark.serviceAccount.create=true` (both chart defaults), the chart
has already created this in `spark-jobs`. The default name is **`spark-operator-spark`** — the
operator's own examples use it verbatim.

```bash
kubectl -n spark-jobs get sa,role,rolebinding
```

The Role the chart renders grants, on `pods`, `configmaps`, `persistentvolumeclaims` and `services`:
`get, list, watch, create, update, patch, delete, deletecollection`
([`templates/spark/rbac.yaml`, v2.5.2](https://github.com/kubeflow/spark-operator/blob/v2.5.2/charts/spark-operator-chart/templates/spark/rbac.yaml)).
Namespaced, not cluster-wide — which is the right shape and the reason the job namespace has to be
declared at install time.

Prove it, positively and negatively:

```bash
kubectl auth can-i create pods \
  --as=system:serviceaccount:spark-jobs:spark-operator-spark -n spark-jobs
```

```bash
kubectl auth can-i create pods \
  --as=system:serviceaccount:spark-jobs:default -n spark-jobs
```

The first must be `yes`; the second must be `no`. The second is what you get when the
`SparkApplication` omits `spec.driver.serviceAccount`, because "the driver pod is automatically
assigned the `default` service account in the namespace" (same source). The driver then starts
normally, connects to the API server, and **fails when it tries to create its first executor** — a
403 in the driver log, several seconds in, long after the pod looked healthy.

---

## 3. Shuffle and scratch — not on Longhorn, and not silently on `/`

Spark spills shuffle data, sorted runs and broadcast blocks to local disk. On Kubernetes:

> "If no volume is set as local storage, Spark uses temporary scratch space to spill data to disk
> during shuffles and other operations. When using Kubernetes as the resource manager the pods will
> be created with an `emptyDir` volume mounted for each directory listed in `spark.local.dir` or the
> environment variable `SPARK_LOCAL_DIRS`. If no directories are explicitly specified then a default
> directory is created and configured appropriately."
> — [Spark 4.0.4, Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html)

That default is fine in shape and dangerous in placement on this cluster. Three options, in order of
how well they fit here:

**Do not put shuffle on Longhorn.** Spark supports it — you can attach an `OnDemand` PVC per
executor with `spark.kubernetes.executor.volumes.persistentVolumeClaim.spark-local-dir-1.*`, and the
default StorageClass here is `longhorn` with `defaultReplicaCount=2` ([[longhorn-storage-onprem]]).
It is close to the worst possible pairing. Shuffle data is large, lives for minutes, and is
**already recomputable** — losing it costs a stage re-run, not data. Longhorn would replicate every
shuffle byte synchronously to a second node over the same LAN the executors are using to exchange
that shuffle, doubling the write traffic to protect something Spark can regenerate for free, and
adding volume attach latency to every executor start. Replication is for data you cannot rebuild.

**Do not leave it on the root filesystem by accident, either.** An unconfigured `emptyDir` lives
under kubelet's directory on the node's root disk. A shuffle that outgrows it does not fail the pod
cleanly — it fills `/`, and kubelet reports `DiskPressure` on the node and starts evicting. On these
workers that means evicting Longhorn's instance-manager and whatever else is resident, so a Spark
sizing mistake presents as a storage and networking incident on an unrelated node.

**What to do instead:** declare the `emptyDir` explicitly with a `sizeLimit`, so the pod that
overruns is the thing that dies. Spark keys off the volume *name*:

> "To use a volume as local storage, the volume's name should starts with `spark-local-dir-`"
> — same source

```yaml
  volumes:
    - name: spark-local-dir-1
      emptyDir:
        sizeLimit: 4Gi
```

mounted into both driver and executor at a path such as `/data/spark-scratch`. The operator's own
[`examples/spark-pi-emptydir.yaml`](https://github.com/kubeflow/spark-operator/blob/v2.5.2/examples/spark-pi-emptydir.yaml)
uses exactly this volume name. Size the limit against real free space on the worker's root disk, not
against the job — and if these nodes get a second disk, mounting kubelet's directory on it is the
change that makes shuffle safe rather than merely bounded.

**Not `tmpfs` here.** `spark.kubernetes.local.dirs.tmpfs=true` makes the `emptyDir` RAM-backed, and
upstream warns what follows: "Spark's local storage usage will count towards your pods memory usage
therefore you may wish to increase your memory requests by increasing the value of
`spark.{driver,executor}.memoryOverheadFactor`". On 4 GB workers, shuffling into RAM you already do
not have converts a slow job into an OOMKill.

The real fix for shuffle pressure on a cluster this size is upstream of storage: fewer, larger
partitions, and not shuffling more than the workers can hold.

---

## 4. S3A against MinIO — the jars are not in the image

### 4.1 Why a plain image cannot read `s3a://`

`apache/spark:4.0.4` is built from the `spark-4.0.4-bin-hadoop3.tgz` release tarball
([spark-docker Dockerfile](https://github.com/apache/spark-docker/blob/master/4.0.4/scala2.13-java21-ubuntu/Dockerfile)),
and that tarball is produced without the `hadoop-cloud` Maven profile — the release script builds the
`hadoop3` package with `-Phadoop-3` plus the Hive profiles only, while `-Phadoop-cloud` appears solely
in `PUBLISH_PROFILES` for the Maven artifacts
([`dev/create-release/release-build.sh`, v4.0.4](https://github.com/apache/spark/blob/v4.0.4/dev/create-release/release-build.sh)).
So `hadoop-aws` and the AWS SDK are **not** on the classpath, and the first `s3a://` path throws
`ClassNotFoundException: Class org.apache.hadoop.fs.s3a.S3AFileSystem not found`.

Upstream's instruction is to add the cloud module at the same version as Spark:

> "To add the relevant libraries to an application's classpath, include the `hadoop-cloud` module and
> its dependencies." — [Spark 4.0.4, Integration with Cloud Infrastructures](https://spark.apache.org/docs/4.0.4/cloud-integration.html)

Two ways to do that, and the choice is about network, not correctness.

**(a) Resolve at submit time.** The CRD carries `spec.deps.packages`, which becomes `--packages`:

```yaml
  deps:
    packages:
      - org.apache.spark:spark-hadoop-cloud_2.13:4.0.4
```

Simple, and it drags in a consistent dependency set. It also means **every driver and executor pod
resolves from Maven Central at start-up** — a hard dependency on egress from the cluster, a slower
start on every run, and a job that fails the day the proxy changes. Fine for a first run, wrong as a
standing arrangement on-prem.

**(b) Bake the jars into an image.** The versions to pin come from Spark 4.0.4's own
[`pom.xml`](https://github.com/apache/spark/blob/v4.0.4/pom.xml): `hadoop.version` is **3.4.1** and
`aws.java.sdk.v2.version` is **2.25.53**. Use that pair — `hadoop-aws` and the AWS SDK bundle
mismatched against each other is the classic S3A failure, and it surfaces as `NoSuchMethodError` or
`NoClassDefFoundError` deep in a stack trace rather than as anything resembling "wrong version".

```dockerfile title="Dockerfile.spark-s3"
FROM docker.io/apache/spark:4.0.4
USER root
ARG HADOOP_VERSION=3.4.1
ARG AWS_SDK_VERSION=2.25.53
ARG M2=https://repo1.maven.org/maven2
RUN set -eux; \
    curl -fsSL -o /opt/spark/jars/hadoop-aws-${HADOOP_VERSION}.jar \
      ${M2}/org/apache/hadoop/hadoop-aws/${HADOOP_VERSION}/hadoop-aws-${HADOOP_VERSION}.jar; \
    curl -fsSL -o /opt/spark/jars/bundle-${AWS_SDK_VERSION}.jar \
      ${M2}/software/amazon/awssdk/bundle/${AWS_SDK_VERSION}/bundle-${AWS_SDK_VERSION}.jar
USER 185
```

Build it, push it to whatever registry the cluster pulls from, and use that image in `spec.image`.
Verify the classpath before trusting it — a missing jar is cheaper to find here than inside a job:

```bash
docker run --rm --entrypoint ls <REGISTRY>/spark-s3:4.0.4 /opt/spark/jars | grep -E 'hadoop-aws|bundle'
```

### 4.2 Credentials — in a Secret, never in the CR

```bash
kubectl -n spark-jobs create secret generic minio-credentials \
  --from-literal=AWS_ACCESS_KEY_ID='<REDACTED>' \
  --from-literal=AWS_SECRET_ACCESS_KEY='<REDACTED>'
```

`spark.hadoop.fs.s3a.access.key` in `sparkConf` would work and would also write the key into an
object that gets committed to Git and printed by `kubectl get sparkapplication -o yaml`. Put it in
the environment of both pods instead, and let S3A's environment credential provider find it. The CRD
supports `envFrom` on driver and executor
([`sparkapplication_types.go`, v2.5.2](https://github.com/kubeflow/spark-operator/blob/v2.5.2/api/v1beta2/sparkapplication_types.go)).

### 4.3 The S3A settings MinIO needs

**Use the in-cluster ClusterIP service, not the LAN address.** [[minio-object-storage-onprem]] pins a
MetalLB address on a separate `minio-api` Service for clients outside the cluster; pointing Spark at
that sends every shuffle-adjacent byte out of the node to the LAN and back through the ingress path
for no reason. Confirm which Service carries port 9000 as a ClusterIP before writing the endpoint:

```bash
kubectl -n minio get svc -o wide
```

```yaml
  sparkConf:
    spark.hadoop.fs.s3a.endpoint: "https://minio.minio.svc.cluster.local:9000"
    spark.hadoop.fs.s3a.path.style.access: "true"
    spark.hadoop.fs.s3a.connection.ssl.enabled: "true"
    spark.hadoop.fs.s3a.aws.credentials.provider: "org.apache.hadoop.fs.s3a.auth.EnvironmentVariableCredentialsProvider"
```

`path.style.access` is the one that is not optional: without it S3A builds virtual-host URLs like
`http://<BUCKET>.minio.minio.svc.cluster.local:9000`, which does not resolve in cluster DNS, and the
failure reads as a network problem rather than a configuration one. Drop
`connection.ssl.enabled` is `"true"` above because [[minio-object-storage-onprem]] terminates TLS on
the S3 port and offers no plaintext one. That CA is private, so **it has to be in the image's Java
truststore or every read fails `PKIX path building failed`** — the executor image built in the
follow-ups is where that belongs. Nothing here has been run, and this is the step most likely to be
wrong on the first attempt.

For writes, upstream recommends the S3A committers over the default rename-based one:

> "In versions of Spark built with Hadoop 3.1 or later, the hadoop-aws JAR contains committers safe
> to use for S3 storage accessed via the s3a connector."
> — [Spark 4.0.4, Integration with Cloud Infrastructures](https://spark.apache.org/docs/4.0.4/cloud-integration.html)

```yaml
    spark.hadoop.fs.s3a.committer.name: "directory"
    spark.sql.sources.commitProtocolClass: "org.apache.spark.internal.io.cloud.PathOutputCommitProtocol"
    spark.sql.parquet.output.committer.class: "org.apache.spark.internal.io.cloud.BindingParquetOutputCommitter"
```

And the caveat that applies to any object store, MinIO included:

> "it is not always safe to use an object store as a direct destination of queries, or as an
> intermediate store in a chain of queries. Consult the documentation of the object store and its
> connector to determine which uses are considered safe." — same source

---

## 5. Submit the smoke test

Do the trivial job first. It proves the operator, the RBAC, the scheduler and the image without
involving S3A, so that when the real job fails you know which half to look at.

```yaml title="spark-pi.yaml"
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: spark-pi
  namespace: spark-jobs
spec:
  type: Scala
  mode: cluster
  image: docker.io/apache/spark:4.0.4
  imagePullPolicy: IfNotPresent
  mainClass: org.apache.spark.examples.SparkPi
  mainApplicationFile: local:///opt/spark/examples/jars/spark-examples.jar
  arguments:
    - "200"
  sparkVersion: 4.0.4
  restartPolicy:
    type: Never
  volumes:
    - name: spark-local-dir-1
      emptyDir:
        sizeLimit: 2Gi
  driver:
    cores: 1
    coreRequest: "500m"
    memory: 512m
    serviceAccount: spark-operator-spark
    volumeMounts:
      - name: spark-local-dir-1
        mountPath: /data/spark-scratch
  executor:
    instances: 2
    cores: 1
    coreRequest: "500m"
    memory: 1g
    volumeMounts:
      - name: spark-local-dir-1
        mountPath: /data/spark-scratch
```

Shape and field names follow the operator's
[`examples/spark-pi.yaml` at v2.5.2](https://github.com/kubeflow/spark-operator/blob/v2.5.2/examples/spark-pi.yaml);
the sizing is this cluster's, from the budget section. `restartPolicy: Never` is deliberate for a
first run — an `OnFailure` policy on a job that cannot fit resubmits a pod that cannot fit.

```bash
kubectl apply -f spark-pi.yaml
```

```bash
kubectl -n spark-jobs get sparkapplication spark-pi -w
```

**Do not stop here.** The CR reaching a running-looking state means the controller accepted it and
ran `spark-submit`; it says nothing about whether a pod was placed. Watch the pods, which is where
the truth is:

```bash
kubectl -n spark-jobs get pods -o wide -w
```

You are looking for `spark-pi-driver` leaving `Pending` within seconds, then executor pods appearing
and reaching `Running` — on **both** workers, given two executors and the anti-crowding effect of the
CPU requests. A driver stuck at `Pending` sends you back to the budget section.

```bash
kubectl -n spark-jobs logs -f spark-pi-driver
```

---

## 6. The job that matters — read and write MinIO

A job that touches object storage is the only one that proves S3A. Keeping the script in a ConfigMap
avoids building an application image for the first run; the operator supports mounting one, and its
[`examples/spark-pi-configmap.yaml`](https://github.com/kubeflow/spark-operator/blob/v2.5.2/examples/spark-pi-configmap.yaml)
shows the pattern.

```python title="etl.py"
import sys
from pyspark.sql import SparkSession

src, dst = sys.argv[1], sys.argv[2]

spark = SparkSession.builder.appName("s3a-smoke").getOrCreate()
df = spark.read.parquet(src)
n_in = df.count()
out = df.repartition(2)
out.write.mode("overwrite").parquet(dst)

# read back through a fresh plan so the count is not served from the write side
n_out = spark.read.parquet(dst).count()
print(f"ROWCOUNT_IN={n_in} ROWCOUNT_OUT={n_out}", flush=True)
spark.stop()
```

```bash
kubectl -n spark-jobs create configmap etl-script --from-file=etl.py
```

```yaml title="s3a-smoke.yaml"
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: s3a-smoke
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: <REGISTRY>/spark-s3:4.0.4        # the image from 4.1(b); or apache/spark:4.0.4 + deps.packages
  imagePullPolicy: IfNotPresent
  mainApplicationFile: local:///opt/spark/job/etl.py
  arguments:
    - "s3a://<BUCKET>/input/"
    - "s3a://<BUCKET>/output/run-<RUN_ID>/"
  sparkVersion: 4.0.4
  restartPolicy:
    type: Never
  sparkConf:
    spark.hadoop.fs.s3a.endpoint: "https://minio.minio.svc.cluster.local:9000"
    spark.hadoop.fs.s3a.path.style.access: "true"
    spark.hadoop.fs.s3a.connection.ssl.enabled: "true"
    spark.hadoop.fs.s3a.aws.credentials.provider: "org.apache.hadoop.fs.s3a.auth.EnvironmentVariableCredentialsProvider"
    spark.hadoop.fs.s3a.committer.name: "directory"
    spark.sql.sources.commitProtocolClass: "org.apache.spark.internal.io.cloud.PathOutputCommitProtocol"
    spark.sql.parquet.output.committer.class: "org.apache.spark.internal.io.cloud.BindingParquetOutputCommitter"
    spark.eventLog.enabled: "true"
    spark.eventLog.dir: "s3a://<BUCKET>/spark-events/"
    spark.sql.shuffle.partitions: "8"
  volumes:
    - name: spark-local-dir-1
      emptyDir:
        sizeLimit: 4Gi
  driver:
    cores: 1
    coreRequest: "500m"
    memory: 512m
    serviceAccount: spark-operator-spark
    envFrom:
      - secretRef:
          name: minio-credentials
    configMaps:
      - name: etl-script
        path: /opt/spark/job
    volumeMounts:
      - name: spark-local-dir-1
        mountPath: /data/spark-scratch
  executor:
    instances: 2
    cores: 1
    coreRequest: "500m"
    memory: 1g
    envFrom:
      - secretRef:
          name: minio-credentials
    volumeMounts:
      - name: spark-local-dir-1
        mountPath: /data/spark-scratch
```

Two sizing notes specific to this being **PySpark**: the memory overhead factor defaults to **0.40**
rather than 0.10 for non-JVM jobs, so a `1g` executor asks the scheduler for roughly 1434 MiB, not
1408. And `spark.sql.shuffle.partitions` defaults to 200 — on two executors with one core each, that
is 200 tiny tasks and 200 shuffle files for no benefit. Set it down to something near your executor
core count.

```bash
kubectl apply -f s3a-smoke.yaml
kubectl -n spark-jobs get pods -o wide -w
```

---

## 7. The same job without the operator

Worth doing once, because it isolates Spark from the controller. `spark-submit` needs a local Spark
distribution and a kubeconfig; the master URL "must be a URL with the format
`k8s://<api_server_host>:<k8s-apiserver-port>`. The port must always be specified, even if it's the
HTTPS port 443"
([Spark 4.0.4, Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html)).

```bash
kubectl cluster-info | head -1        # take the control-plane URL from here
```

```bash
./bin/spark-submit \
  --master k8s://https://<APISERVER_HOST>:6443 \
  --deploy-mode cluster \
  --name spark-pi-submit \
  --class org.apache.spark.examples.SparkPi \
  --conf spark.kubernetes.namespace=spark-jobs \
  --conf spark.kubernetes.authenticate.driver.serviceAccountName=spark-operator-spark \
  --conf spark.kubernetes.container.image=docker.io/apache/spark:4.0.4 \
  --conf spark.executor.instances=2 \
  --conf spark.driver.memory=512m \
  --conf spark.executor.memory=1g \
  --conf spark.kubernetes.driver.request.cores=500m \
  --conf spark.kubernetes.executor.request.cores=500m \
  local:///opt/spark/examples/jars/spark-examples.jar 200
```

Every constraint from the earlier sections still applies — same overheads, same two nodes, same
service account. What you lose is the CR: no `kubectl get sparkapplication`, no declared retry
policy, and a driver pod named by Spark rather than by you. If this succeeds and the equivalent
`SparkApplication` does not, the problem is the controller or the webhook, not Spark.

---

## 8. Where the logs and the UI go when the driver exits

This is the part that surprises people, and it is worth understanding before the first failed job
rather than during it.

### While the driver is alive

The operator names the driver pod `<app>-driver` and creates a Service named `<app>-ui-svc`
([`pkg/util/sparkapplication.go`, v2.5.2](https://github.com/kubeflow/spark-operator/blob/v2.5.2/pkg/util/sparkapplication.go)).

```bash
kubectl -n spark-jobs logs -f s3a-smoke-driver
```

```bash
kubectl -n spark-jobs port-forward svc/s3a-smoke-ui-svc 4040:4040
```

Upstream documents the pod-level equivalent — "The UI associated with any application can be accessed
locally using `kubectl port-forward` … `kubectl port-forward <driver-pod-name> 4040:4040`". For a
permanent address, `spec.sparkUIOptions` can set the Service type and render an Ingress, which is
where [[ingress-nginx-onprem]] and [[metallb-l2-onprem]] come in. The Spark UI has no
authentication — treat it exactly as [[longhorn-storage-onprem]] treats the Longhorn UI.

### The moment the driver exits, three things change

**The UI stops existing.** Not "shows a finished job" — stops. The UI is served by the driver JVM on
port 4040; when the JVM exits there is nothing behind the Service, and `<app>-ui-svc` remains as an
object with no endpoints. A port-forward gets a connection refused, which reads like a broken cluster
rather than a completed job. Upstream, in one sentence: "this information is only available for the
duration of the application by default"
([Spark 4.0.4, Monitoring](https://spark.apache.org/docs/4.0.4/monitoring.html)).

**Executor logs are already gone.** `spark.kubernetes.executor.deleteOnTermination` defaults to
`true` — executor pods "should be deleted in case of failure or normal termination"
([Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html)). By the
time you notice a job behaved oddly, the pods holding the per-task detail have been reaped. Setting
it to `false` while debugging keeps them around; leaving it `false` fills the cluster with dead pods.

**Driver logs are on borrowed time.** The driver pod stays in a completed state and `kubectl logs`
keeps working — *until the pod object is deleted*. That happens when you delete the
`SparkApplication`, when `spec.timeToLiveSeconds` expires, when the restart policy resubmits, or when
kubelet's terminated-pod garbage collection gets there. `kubectl logs` is a convenience, not a log
store. If these jobs matter, ship stdout somewhere off-cluster; that is a separate build.

### What to set up so history survives

Event logs. They are what the History Server replays, and they are the only artefact of a run that
outlives every pod involved:

```yaml
    spark.eventLog.enabled: "true"
    spark.eventLog.dir: "s3a://<BUCKET>/spark-events/"
```

> "The spark jobs themselves must be configured to log events, and to log them to the same shared,
> writable directory." — [Spark 4.0.4, Monitoring](https://spark.apache.org/docs/4.0.4/monitoring.html)

Then a History Server reading the same prefix. It is the same Spark image, so it needs the same S3A
jars and the same credentials as the jobs:

```yaml title="spark-history-server.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spark-history-server
  namespace: spark-jobs
spec:
  replicas: 1
  selector:
    matchLabels: { app: spark-history-server }
  template:
    metadata:
      labels: { app: spark-history-server }
    spec:
      containers:
        - name: history
          image: <REGISTRY>/spark-s3:4.0.4
          command: ["/opt/spark/bin/spark-class"]
          args: ["org.apache.spark.deploy.history.HistoryServer"]
          ports:
            - containerPort: 18080
          envFrom:
            - secretRef:
                name: minio-credentials
          env:
            - name: SPARK_HISTORY_OPTS
              value: >-
                -Dspark.history.fs.logDirectory=s3a://<BUCKET>/spark-events/
                -Dspark.hadoop.fs.s3a.endpoint=https://minio.minio.svc.cluster.local:9000
                -Dspark.hadoop.fs.s3a.path.style.access=true
                -Dspark.hadoop.fs.s3a.connection.ssl.enabled=true
                -Dspark.hadoop.fs.s3a.aws.credentials.provider=org.apache.hadoop.fs.s3a.auth.EnvironmentVariableCredentialsProvider
          resources:
            requests: { cpu: 100m, memory: 512Mi }
            limits: { memory: 1Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: spark-history-server
  namespace: spark-jobs
spec:
  selector: { app: spark-history-server }
  ports:
    - port: 18080
      targetPort: 18080
```

`spark.history.fs.logDirectory` is the documented setting and the server listens on 18080 by default
([Monitoring](https://spark.apache.org/docs/4.0.4/monitoring.html)). Budget for it: this is a
permanently resident ~512 MiB JVM on a cluster with two 4 GB workers, so it comes out of the same
pool as the executors. On this cluster it is a reasonable trade — without it, every finished job is
unexaminable — but it is a real cost, and running the history server and two 1g executors at the same
time is close to the ceiling.

---

## Verification checklist

Each of these has a realistic failure it would catch. Where a check has a known false pass, it is
named underneath.

**The operator itself**

- [ ] `kubectl -n spark-operator get deploy` — controller and webhook both `1/1`, not `0/1`
- [ ] `kubectl auth can-i create pods --as=system:serviceaccount:spark-jobs:spark-operator-spark -n spark-jobs` returns `yes`, **and** the same command with `:default` returns `no` — the second half is what catches an omitted `serviceAccount` field
- [ ] A `SparkApplication` created in a namespace *not* in `spark.jobNamespaces` produces no driver pod and no events within 60s — do this once on purpose, so the silence is recognisable later

**The run actually ran**

- [ ] `kubectl -n spark-jobs get pod <APP>-driver -o jsonpath='{.status.phase}'` is `Running` within ~30s of apply — **`kubectl get sparkapplication` showing a live state is the classic false pass here**: the controller accepted the CR and ran `spark-submit`, while the driver pod sits `Pending` forever
- [ ] `kubectl -n spark-jobs get pods -l spark-role=executor` shows the requested number of executors `Running` **during** the run, on two distinct nodes (`-o wide`) — executors that never appear mean the driver's RBAC or the node budget, not a slow job
- [ ] `kubectl -n spark-jobs describe pod <APP>-driver` contains no `FailedScheduling` event
- [ ] `kubectl -n spark-jobs get pod <APP>-driver -o jsonpath='{.spec.containers[0].resources.requests.memory}'` equals the memory you set **plus** the overhead from the budget table — if it equals what you typed, your mental model of the budget is wrong by 384 MiB per pod

**The job did the work**

- [ ] The output object exists in the bucket at the exact target prefix — `mc ls <ALIAS>/<BUCKET>/output/run-<RUN_ID>/` lists parquet parts **and** a `_SUCCESS` marker. A driver pod reaching a completed state is not this check; a job can succeed having written nothing
- [ ] The row count read back from the output equals the input count — the `ROWCOUNT_IN` / `ROWCOUNT_OUT` line in the driver log, with the two numbers equal and non-zero. A zero-row output is a *successful* job
- [ ] Read the output from a separate process (`mc cat`, or a second short job) rather than from the writing session, so the count is not being served by the plan that produced it
- [ ] Break it on purpose once: submit with a deliberately wrong `AWS_SECRET_ACCESS_KEY` and confirm the driver fails with a 403 from S3A rather than succeeding. A check that has only ever passed has not been tested

**The budget behaves as documented**

- [ ] Submit one job with `executor.memory: 3g` and confirm the pod stays `Pending` with `Insufficient memory` — this is the "looks hung, is unschedulable" case, and it is worth having seen once, deliberately, at a moment of your choosing
- [ ] During a real run, `kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.conditions[?(@.type=="DiskPressure")].status}{"\n"}{end}'` stays `False` on both workers — shuffle filling the root disk shows up here first
- [ ] `kubectl -n spark-jobs get pod <EXECUTOR> -o jsonpath='{.spec.volumes[*].name}'` shows `spark-local-dir-1` as an `emptyDir` and **no** `persistentVolumeClaim` — confirms shuffle is not on Longhorn

**History outlives the pods**

- [ ] After the run, `mc ls <ALIAS>/<BUCKET>/spark-events/` contains an entry for the application ID
- [ ] Delete the `SparkApplication`, then load the History Server on 18080 and find the completed run — deleting first is the point of the check: it proves the record survived the pod rather than being read out of it
- [ ] Port-forward `<APP>-ui-svc` *after* the driver has exited and confirm it refuses the connection — so that a refused Spark UI is recognised as "the job finished" and not as an outage

---

## Rollback

Removing a Spark job is not the same as removing Spark.

Kill one run — this deletes the driver pod and its logs with it:

```bash
kubectl -n spark-jobs delete sparkapplication <APP>
```

```bash
kubectl -n spark-jobs get pods
```

Any executor pods should disappear along with the driver. Executors left `Running` after the driver
is gone are orphans consuming exactly the memory you were trying to reclaim:

```bash
kubectl -n spark-jobs delete pods -l spark-role=executor
```

Remove the operator. Jobs already running are not stopped by this, but nothing will reconcile them:

```bash
helm uninstall spark-operator -n spark-operator
```

```bash
kubectl get crd | grep sparkoperator
```

Helm does not remove CRDs on uninstall, and removing them **deletes every `SparkApplication` object
in the cluster**, running or not. That is the one irreversible step here, so it is separate and
deliberate:

```bash
kubectl delete crd sparkapplications.sparkoperator.k8s.io
kubectl delete crd scheduledsparkapplications.sparkoperator.k8s.io
```

```bash
kubectl delete namespace spark-operator
```

The job namespace, the credentials Secret and the event logs in MinIO survive all of the above.
Data written to the bucket is untouched by any of it — which is the intended asymmetry: compute is
disposable, the object store is not.

**Abort criteria.** Stop and go back to the budget section rather than pushing forward if: the driver
pod is `Pending` for more than a minute with a `FailedScheduling` event; a worker reports
`DiskPressure` during a run; or the webhook is not `1/1`, since driver pods will fail to be created
with an error that names the webhook and not the cause.

---

## Failure points documented upstream

Nothing here was hit on a run — none has happened yet. Each is a documented failure with a source.

**Old Helm repository URL** — `https://googlecloudplatform.github.io/spark-on-k8s-operator/index.yaml`
returns 404 (checked 2026-08-16), while the GitHub repo redirects to
[kubeflow/spark-operator](https://github.com/kubeflow/spark-operator), so half of an old guide appears
to work. Section 1.1.

**`spark.jobNamespaces` defaults to `["default"]`** — a `SparkApplication` in any other namespace is
never reconciled: no driver pod, no events, no error. The chart also requires the namespace to exist
at install time, "Make sure the namespaces have already existed". Section 1.2.
([`values.yaml`, v2.5.2](https://github.com/kubeflow/spark-operator/blob/v2.5.2/charts/spark-operator-chart/values.yaml))

**Controller OOM-killed during submission** — each submission forks a JVM inside the controller pod,
and upstream names the exact string it produces: "`failed to run spark-submit for SparkApplication
[...]: signal: killed`". Section 1.2 sets a limit above `-Xmx128m` for this reason. (same source)

**Driver without a service account** — the driver defaults to the namespace's `default` service
account and then cannot create executors. "the service account must be granted a `Role` or
`ClusterRole` that allows driver pods to create pods and services". Section 2.
([Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html))

**`s3a://` with no connector on the classpath** — the release tarball the official image is built from
is produced without `-Phadoop-cloud`, so `hadoop-aws` is absent; upstream's instruction is to add the
`hadoop-cloud` module at the matching Spark version. Section 4.1.
([Cloud integration](https://spark.apache.org/docs/4.0.4/cloud-integration.html),
[release-build.sh v4.0.4](https://github.com/apache/spark/blob/v4.0.4/dev/create-release/release-build.sh))

**Object store as a direct destination** — "it is not always safe to use an object store as a direct
destination of queries, or as an intermediate store in a chain of queries." Section 4.3.
([Cloud integration](https://spark.apache.org/docs/4.0.4/cloud-integration.html))

**`tmpfs` local dirs eating the memory budget** — "Spark's local storage usage will count towards
your pods memory usage therefore you may wish to increase your memory requests by increasing the
value of `spark.{driver,executor}.memoryOverheadFactor`". Section 3.
([Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html))

**Overhead minimum of 384 MiB, and 0.40 for PySpark** — `spark.{driver,executor}.minMemoryOverhead`
is `384m`, and the overhead factor "defaults to 0.10 except for Kubernetes non-JVM jobs, which
defaults to 0.40". Both make the scheduled request larger than the configured memory. Budget section.
([Configuration](https://spark.apache.org/docs/4.0.4/configuration.html))

**The UI is gone the moment the job is** — "this information is only available for the duration of
the application by default". Section 8.
([Monitoring](https://spark.apache.org/docs/4.0.4/monitoring.html))

**Executor pods deleted on termination** — `spark.kubernetes.executor.deleteOnTermination` defaults
to `true`, so executor logs are unavailable by the time you go looking. Section 8.
([Running on Kubernetes](https://spark.apache.org/docs/4.0.4/running-on-kubernetes.html))

---

## Follow-ups

- [ ] Reconcile the endpoint with [[minio-object-storage-onprem]] — that document terminates the S3 API with TLS from an internal CA, and section 4.3 here talks plaintext to the ClusterIP. Decide which, and if TLS, get the CA into the Spark image's truststore 📅 2026-08-23
- [ ] Build and push an internal Spark image with `hadoop-aws` 3.4.1 and AWS SDK bundle 2.25.53 baked in, so jobs stop resolving from Maven Central at pod start 📅 2026-08-30
- [ ] Measure real free memory on both workers with Longhorn, ingress-nginx and Argo CD resident, and record the number in [[schedulable-node-budget]] — the executor sizing above is arithmetic against `allocatable`, not a measurement against this cluster 📅 2026-08-23
- [ ] Decide a retention rule for `s3a://<BUCKET>/spark-events/` before the History Server has a year of runs in it — nothing prunes event logs, and the server reads the whole prefix 📅 2026-09-13

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on, and the document where the control-plane taint that halves the Spark budget is decided.
[[schedulable-node-budget]] — Spark is the add-on that consumes the budget rather than merely respecting it; check the count there before choosing an executor count here.
[[longhorn-storage-onprem]] — the default StorageClass, and the one place shuffle data must not be sent. Section 3 explains why replication is exactly wrong for it.
[[minio-object-storage-onprem]] — the object store this reads and writes, including the event logs; it is also where the bucket, the credentials and the TLS decision that section 4 depends on are made.
[[ingress-nginx-onprem]] — needed if the Spark UI or the History Server should have an address that is not a port-forward, and neither has authentication of its own.
[[k8s-node-drain-replace]] — draining a worker mid-job kills executors on it; Spark will re-run the lost tasks on the remaining node, which on two nodes means the job gets half as wide.
