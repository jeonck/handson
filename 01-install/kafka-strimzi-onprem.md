---
title: Kafka with Strimzi in KRaft mode on the on-prem cluster — sized for two schedulable nodes
date: 2026-08-16
domain: install
tags: [on-prem, messaging, bare-metal, capacity]
stack: [kubernetes, kafka, strimzi, kraft, helm, kubectl, longhorn, metallb]
summary: Strimzi 1.1.0 in KRaft mode on a cluster with two schedulable nodes — two brokers at replication factor 2, not the three every upstream example shows. Longhorn already copies each write to a second machine, so leaving its default replica count on Kafka's volumes sends every produced byte across the LAN three times to buy redundancy Kafka is already providing.
source: handson
env: Strimzi 1.1.0 (Helm chart 1.1.0) · Apache Kafka 4.3.0 · Kubernetes 1.31.14 (kubeadm) · containerd 2.2.1 · Calico 3.28.2 (VXLAN) · Longhorn 1.7.2 · MetalLB 0.14.8 · Ubuntu 24.04.4 LTS — target is the 3-machine cluster from [[onprem-3node-kubeadm-ubuntu]], 2 vCPU / 4 GB per node
verified:
duration: 60–90 min
risk: medium
---

> **Nobody has run this. It was assembled from Strimzi's own documentation and manifests, not from a
> terminal.** `verified` is empty and stays empty until someone follows it end to end.
>
> Versions were checked on **2026-08-16** against:
>
> - [strimzi.io/downloads](https://strimzi.io/downloads/) — current operator **1.1.0**, supported
>   Kafka **4.2.0, 4.2.1, 4.3.0**, tested against Kubernetes **1.30–1.36**. This cluster runs 1.31.14,
>   inside that range.
> - [`kafka-versions.yaml` at tag 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/kafka-versions.yaml)
>   — Kafka **4.3.0** is the default (`metadata: 4.3-IV0`); 4.1.x is present but `supported: false`.
> - [Release 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/releases/tag/1.1.0), published
>   2026-06-26. Only the `v1` CRD API is supported; `v1beta2` and older are gone.
> - `strimzi-kafka-operator` chart **1.1.0** (appVersion 1.1.0, published 2026-06-26) in
>   <https://strimzi.io/charts/>.
>
> **1.2.0-rc1 was published 2026-08-15 — the day before this was written.** It is a release candidate,
> not a release. Pin 1.1.0 and revisit when 1.2.0 ships.
>
> Every YAML below is derived from the upstream examples at tag 1.1.0
> ([`examples/kafka/kafka-persistent.yaml`](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/examples/kafka/kafka-persistent.yaml)),
> with the replica counts, replication factors and storage changed for this cluster — those changes
> are the whole point of the document and are argued for below rather than presented as defaults.
> **No command output is quoted anywhere in this document**, because none was observed.

Kafka on Kubernetes is an operator problem, not a StatefulSet problem — broker identity, per-broker
storage, certificate rotation and rolling restarts in an order that does not lose a quorum are all
things you would otherwise write yourself. Strimzi does that. Since 0.46 it runs Kafka in **KRaft
mode only**: no ZooKeeper, the metadata log lives in Kafka itself, and controllers are just Kafka
nodes with the `controller` role.

What makes this specific cluster interesting is that almost none of the upstream examples apply to
it. Every one of them assumes three places to put a pod. This one has two.

Assumes the cluster from [[onprem-3node-kubeadm-ubuntu]], with [[longhorn-storage-onprem]] providing
the default StorageClass and [[metallb-l2-onprem]] handing out LAN addresses.

Out of scope: authentication and authorization (§6 says plainly what that means), Kafka Connect,
MirrorMaker, Cruise Control, and monitoring. Each is a separate document.

---

## What two schedulable nodes allow

[[schedulable-node-budget]] records the standing decision for this cluster: **the control-plane taint
stays, the budget is 2.** That is the input to every number below. Do not re-open it here — size Kafka
to 2 and, if it cannot work at 2, that is a hardware conversation.

### The trap is that a 3-broker cluster schedules perfectly well

This is worth stating before anything else, because the failure is silent rather than loud.
**Strimzi sets no pod anti-affinity by default.** Reading the 1.1.0 operator source, the only affinity
the operator injects is a *node* affinity when rack awareness is configured
([`ModelUtils.affinityWithRackLabelSelector`](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/model/ModelUtils.java));
there is no anti-affinity anywhere unless you write it into `template.pod.affinity` yourself.

So paste `examples/kafka/kafka-persistent.yaml` onto this cluster and you get three brokers and three
controllers that all come up `Ready`, on two machines, packed two-and-one. `kubectl get kafka` says
`READY: True`. Replication factor 3 is satisfied. And a single node loss takes two of your three
brokers with it, which replication factor 3 was bought specifically to survive.

That is the same shape as the Longhorn failure in [[longhorn-storage-onprem]] — a component reporting
health while the redundancy you are paying for does not exist. The difference is that Longhorn at
least says `degraded`. Kafka has nothing to say, because from Kafka's point of view nothing is wrong.

### Controllers: pick the number once, because you cannot change it

KRaft controllers form a quorum. **Strimzi cannot resize that quorum after the fact.** The deploying
guide is explicit that Strimzi uses static controller quorums for all deployments, including new
installations, and that this prevents:

> "Adding or removing node pools with controller roles; Adding the controller role to an existing
> node pool; Removing the controller role from an existing node pool; Scaling a node pool with the
> controller role"
>
> — [Strimzi 1.1.0, Deploying and Managing — KRaft mode](https://strimzi.io/docs/operators/latest/deploying#assembly-kraft-mode-str)

Brokers scale freely. Controllers do not. Whatever you choose here is frozen until you build a new
Kafka cluster and migrate the data, so choose for the cluster you expect to have, not the one you have
today.

| Controllers | Majority | Survives one node loss? | Survives a rolling restart of the controllers? |
|---|---|---|---|
| 1 | 1 | No | **No** — the single controller is the quorum |
| 2 (e.g. a dual-role pool of 2) | 2 | No | **No** — restarting either leaves 1 of 2 |
| 3, split 2+1 across two nodes | 2 | Only if the node holding **one** controller dies | **Yes** — 2 of 3 remain |
| 3, all on one node | 2 | No | Yes |

The rolling-restart column is the one that decides it. Strimzi rolls controllers one pod at a time,
and it does so on its own schedule — certificate renewal, a config change, a Kafka version bump. With
a quorum of 1 or 2, every one of those events takes the metadata layer down. With 3 it does not, even
though two of them share a machine.

So: **three controllers, in a dedicated pool, with a topology spread constraint that forces the 2+1
split rather than letting all three land together.** Node failure is then survivable exactly half the
time — which is not a fault-tolerance story, and is stated that way rather than dressed up.

### Brokers: two, replication factor 2, `min.insync.replicas` 1

Two schedulable nodes means two brokers, one each, pinned there with a **required** anti-affinity so
that if the budget ever drops to 1 the second broker sits `Pending` and says so, instead of quietly
doubling up. Loud beats silent; see the table in [[schedulable-node-budget]].

Two brokers caps replication factor at 2. That forces the `min.insync.replicas` decision, and there
is no comfortable answer:

| `min.insync.replicas` | Producer with `acks=all` when one broker is down | What you give up |
|---|---|---|
| **2** | Fails — `NotEnoughReplicasException` | Availability. And not only during failures: **every Strimzi rolling restart makes every partition unwritable**, because the broker being restarted leaves the ISR and 1 < 2 |
| **1** (this document) | Succeeds against the single surviving replica | Durability. An acknowledged write held by one broker is lost if that broker's node dies before the follower catches up |

`min.insync.replicas: 1` is chosen here because a two-broker cluster restarts often enough — operator
reconciles, node maintenance, Kafka upgrades — that setting 2 turns routine maintenance into a
producer outage. If the data on this cluster is the kind where a lost acknowledged write is worse than
downtime, set 2 instead and accept that maintenance windows are producer outages. **Set it
deliberately; do not inherit it.**

**Be precise about what replication factor 2 does not give you.** RF 3 with min ISR 2 survives one
broker loss while still requiring two copies of every acknowledged write. RF 2 with min ISR 1 survives
one broker loss by dropping to a single copy. The window between "the follower died" and "the
follower rebuilt" is a window in which one disk failure loses committed data. There is no
configuration on two machines that closes it.

### Summary of the topology this document builds

| | Pool | Replicas | Placement rule | Effect if the rule cannot be met |
|---|---|---|---|---|
| Controllers | `controller` | 3 | `topologySpreadConstraints`, `maxSkew: 1`, `DoNotSchedule` | Third controller `Pending` |
| Brokers | `broker` | 2 | required `podAntiAffinity` on `kubernetes.io/hostname` | Second broker `Pending` |

Cluster-wide Kafka config: `default.replication.factor: 2`, `min.insync.replicas: 1`,
`offsets.topic.replication.factor: 2`, `transaction.state.log.replication.factor: 2`,
`transaction.state.log.min.isr: 1`.

The internal-topic factors matter as much as the user-facing one. Leave
`offsets.topic.replication.factor` at the upstream example's `3` and `__consumer_offsets` cannot be
created on a two-broker cluster — consumer groups then fail in a way that has nothing obviously to do
with a number in the Kafka CR.

---

## Two replication layers over one set of disks

This is the sharpest trade in the document, and it is entirely invisible from `kubectl`.

[[longhorn-storage-onprem]] installs Longhorn with `defaultReplicaCount=2`. Kafka replicates too. If
Kafka's PVCs come from the default `longhorn` StorageClass, both layers are on:

| | Copies of one partition | Where they live |
|---|---|---|
| Kafka RF 2 | 2 | broker-A's volume, broker-B's volume |
| × Longhorn replica 2 | × 2 | each of those volumes copied to both nodes |
| **Total** | **4** | 2 copies per disk, on 2 disks |

Disk cost is the obvious half. **The expensive half is the network.** Longhorn is synchronous block
replication: every write to a volume goes over the LAN to the remote replica before it is
acknowledged. So one produced byte becomes:

1. producer → leader broker (1 crossing, from outside)
2. leader → follower broker, Kafka's own replication (1 crossing)
3. leader's Longhorn volume → its remote replica (1 crossing)
4. follower's Longhorn volume → its remote replica (1 crossing)

Three node-to-node crossings of the same byte, where Kafka's design calls for one. On 2 vCPU machines
sharing a flat LAN with Calico VXLAN encapsulation on top, that is the throughput ceiling of this
cluster, and it is paid on every single write.

### Recommendation: a dedicated StorageClass at one replica, and let Kafka own replication

Kafka is a replication system. Putting it on a replicating block device is paying twice for one
property. Create `longhorn-kafka` with `numberOfReplicas: "1"` and
`dataLocality: "strict-local"`, which Longhorn describes as enforcing that it

> "keep the **only one replica** on the same node as the attached volume, and therefore, it offers
> higher IOPS and lower latency performance."
>
> — [Longhorn 1.7.2 — Data Locality](https://longhorn.io/docs/1.7.2/high-availability/data-locality/)

That removes crossings 3 and 4 entirely: the broker writes to a disk in the machine it is running on.
Total copies drop from 4 to 2, which is exactly the redundancy Kafka was configured for.

**The failure mode of each choice, stated plainly:**

| Choice | What a node loss does | Recovery |
|---|---|---|
| `longhorn-kafka`, 1 replica, strict-local (**recommended**) | That broker's log directory is gone with the machine | The broker comes back on a fresh PVC and re-replicates the whole partition set from the surviving broker. Normal Kafka operation, but it reads the entire dataset across the LAN, and until it completes you are at one copy |
| default `longhorn`, 2 replicas | The volume data survives on the other node | Buys you nothing here, because the required broker anti-affinity will not let the pod restart on the node that already runs the other broker. You pay for a copy you cannot use, on every write |

The second row is the point. On a **two-node** cluster with one broker per node, Longhorn's second
replica cannot be attached to anything without violating the placement rule that makes the Kafka
replication meaningful in the first place. It is pure cost.

This changes with a third node. If a machine is added and brokers go to 3, Longhorn at 2 replicas
starts being able to restart a broker elsewhere with its data intact — worth re-deciding then, not now.

**Two more things about Strimzi storage that are one-way doors:**

- `deleteClaim` defaults to **false** (confirmed in
  [`PersistentClaimStorage.java` at 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/api/src/main/java/io/strimzi/api/kafka/model/kafka/PersistentClaimStorage.java)
  — the field is a plain `boolean` with no initializer). Deleting the Kafka resource leaves every PVC
  and every byte behind. That is the safe default and it is also a way to leak all of your disk.
- The `class` on a volume is fixed at creation. Getting this wrong means rebuilding the cluster, not
  editing a field — which is why the StorageClass comes before the operator in the ordering below.

---

## What an external listener costs from the MetalLB pool

A Strimzi listener of `type: loadbalancer` does not create one Service. It creates **one bootstrap
Service plus one Service per broker**, so that each broker can advertise its own reachable address —
which is how the Kafka protocol works: the client bootstraps, gets back a metadata response naming
every broker, and then connects to them individually.

For this cluster: **2 brokers + 1 bootstrap = 3 LoadBalancer addresses.**

[[metallb-l2-onprem]] uses `192.168.1.240–192.168.1.250` — 11 addresses. [[ingress-nginx-onprem]]
already holds one. Kafka takes 3 of the remaining 10, so **one Kafka cluster consumes 30% of the
pool**, and adding a third broker later takes a fourth. Check the pool before applying the Kafka CR;
if MetalLB cannot assign, the Services sit at `<pending>` and the Kafka resource never becomes ready,
because Strimzi cannot compute the advertised addresses.

Alternatives, if the pool is tight:

| Listener type | Pool addresses used | Cost |
|---|---|---|
| `loadbalancer` (this document) | 3 | 30% of the pool |
| `nodeport` | 0 | Clients need node IPs and a port per broker; node IPs change if machines are replaced |
| `ingress` | 0 (reuses the ingress controller's address) | Requires TLS with SNI routing, which on ingress-nginx means the controller was started with `--enable-ssl-passthrough`. [[ingress-nginx-onprem]] does not set that flag |
| `cluster-ip` | 0 | Not externally reachable on its own; needs your own routing in front |

`loadbalancer` is chosen here because it is the only one that works without changing another
component, and because per-broker addresses make the failure modes legible.

---

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Cluster healthy | `kubectl get nodes` | all `Ready` |
| Schedulable-node budget | `kubectl get nodes -o json \| jq '[.items[] \| select(.spec.taints == null)] \| length'` | `2` — matches [[schedulable-node-budget]] |
| Kubernetes version in Strimzi's tested range | `kubectl version -o json \| jq -r .serverVersion.gitVersion` | within 1.30–1.36 |
| Longhorn healthy | `kubectl -n longhorn-system get nodes.longhorn.io` | every node `Ready` |
| Free disk for Kafka | `df -h /var/lib/longhorn` on each worker | ≥ 30 GB spare per worker for the sizes below |
| MetalLB with free addresses | `kubectl get svc -A --field-selector spec.type=LoadBalancer` | at least 3 addresses left in the pool |
| Helm | `helm version --short` | v3.x |
| Free memory on each worker | see §1 | ≥ 2.3 GB allocatable and uncommitted |

---

## 1. Pre-flight — the three numbers that decide the shape

### 1.1 The schedulable-node budget

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

```bash
kubectl get nodes -o json | jq '[.items[] | select(.spec.taints == null)] | length'
```

Anything other than `2` means the standing decision has changed. Stop and read
[[schedulable-node-budget]] before continuing — every replica count below is derived from that number.

### 1.2 Memory, which is the binding constraint here

The workers in [[onprem-3node-kubeadm-ubuntu]] are 2 vCPU / 4 GB. Five Kafka JVMs plus the entity
operator is not obviously going to fit alongside Longhorn, Calico, MetalLB and ingress-nginx. Do the
arithmetic before applying, not after watching an OOMKill.

```bash
kubectl describe node <WORKER_NODE> | sed -n '/Allocated resources/,/Events/p'
```

```bash
# what is already committed, per node
kubectl get pods -A -o json | jq -r '
  .items[] | select(.spec.nodeName != null) |
  .spec.nodeName as $n | .spec.containers[].resources.requests.memory // "0" |
  [$n, .] | @tsv' | sort | uniq -c
```

What this document asks for, per node, on the busier of the two:

| Workload | Count on the busier node | Memory request each | Subtotal |
|---|---|---|---|
| `controller` pods | 2 | 512Mi | 1024Mi |
| `broker` pod | 1 | 1Gi | 1024Mi |
| entity operator (topic operator) | 1 | 256Mi | 256Mi |
| | | **Total** | **≈ 2.3 GB** |

On a 4 GB machine already carrying roughly 1.2–1.4 GB of Longhorn, Calico, kube-proxy, MetalLB and
ingress-nginx, that leaves a few hundred megabytes of margin. It is tight and it is not comfortable.

**These numbers are unmeasured.** They are a starting point chosen to fit, not values observed under
load. Watch `kubectl top pod -n kafka` and the brokers' GC behaviour on the first real run and correct
them here. If §1.2 shows less headroom than the table needs, do not shave the requests — drop to a
single dual-role pool of 2 (see the controller table above) and accept that every controller rolling
restart takes the metadata layer down.

### 1.3 Addresses

```bash
kubectl get svc -A --field-selector spec.type=LoadBalancer \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,IP:.status.loadBalancer.ingress[0].ip'
```

Count what is left in the pool defined in [[metallb-l2-onprem]]. Three must be free.

---

## 2. A StorageClass for Kafka data

Before the operator, because the class on a volume cannot be changed afterwards.

```yaml title="longhorn-kafka-storageclass.yaml"
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: longhorn-kafka
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
# Required so the volume is bound only once the scheduler has picked a node —
# strict-local needs to know which node the replica must live on.
volumeBindingMode: WaitForFirstConsumer
parameters:
  # Kafka replicates. Longhorn does not need to. See "Two replication layers" above.
  numberOfReplicas: "1"
  # Keep the single replica on the node running the broker: no LAN hop per write.
  dataLocality: "strict-local"
  staleReplicaTimeout: "2880"
  fsType: "ext4"
```

```bash
kubectl apply -f longhorn-kafka-storageclass.yaml
```

```bash
kubectl get storageclass
```

`longhorn-kafka` must appear **without** `(default)` next to it — the default is still `longhorn`, and
this class is opted into explicitly by the node pools. Two defaults make PVC binding
non-deterministic; see [[longhorn-storage-onprem]] §3.

- Source: [Longhorn 1.7.2 — Create Longhorn Volumes](https://longhorn.io/docs/1.7.2/nodes-and-volumes/volumes/create-volumes/)
  for the parameter names, and [Data Locality](https://longhorn.io/docs/1.7.2/high-availability/data-locality/)
  for `strict-local`. Note that `strict-local` is incompatible with `ReadWriteMany` volumes — Kafka
  uses RWO, so this does not apply here, but do not reuse this class for anything that needs RWX.

---

## 3. Install the Cluster Operator

```bash
kubectl create namespace kafka
```

```bash
helm repo add strimzi https://strimzi.io/charts/
helm repo update strimzi
helm search repo strimzi/strimzi-kafka-operator --versions | head -5
```

Confirm 1.1.0 is what the repo offers before pinning to it — and pin it, so a later `helm upgrade`
does not silently move CRD versions underneath a running cluster.

```bash
helm install strimzi-cluster-operator strimzi/strimzi-kafka-operator \
  --namespace kafka \
  --version 1.1.0 \
  --wait --timeout 5m
```

With `watchNamespaces` left at its chart default of `[]`, the operator watches **only its own
namespace** — `kafka`. That is deliberate: a cluster-wide operator (`--set watchAnyNamespace=true`)
needs ClusterRoleBindings and reconciles anything anyone creates anywhere. On a two-node cluster,
scope it down.

```bash
kubectl -n kafka rollout status deployment strimzi-cluster-operator --timeout=300s
```

```bash
kubectl get crd | grep strimzi.io
kubectl -n kafka logs deployment/strimzi-cluster-operator --tail=30
```

The CRDs are cluster-scoped even though the operator is namespaced. That matters in the rollback
section: deleting them deletes every Strimzi resource on the cluster.

- Source: [Strimzi 1.1.0 — Deploying and Managing](https://strimzi.io/docs/operators/latest/deploying)

---

## 4. Node pools and the Kafka cluster

`KafkaNodePool` is mandatory in KRaft mode — the Kafka CR no longer carries replica counts or storage.
Everything about *how many* and *on what disk* lives in the pools; everything about *how Kafka
behaves* lives in the Kafka CR.

```yaml title="kafka-node-pools.yaml"
apiVersion: kafka.strimzi.io/v1
kind: KafkaNodePool
metadata:
  name: controller
  namespace: kafka
  labels:
    strimzi.io/cluster: onprem
spec:
  # Three, on two machines. See "Controllers: pick the number once" — this is frozen
  # after creation and cannot be scaled later.
  replicas: 3
  roles:
    - controller
  storage:
    type: jbod
    volumes:
      - id: 0
        type: persistent-claim
        size: 10Gi
        class: longhorn-kafka
        kraftMetadata: shared
        deleteClaim: false
  resources:
    requests:
      memory: 512Mi
      cpu: 100m
    limits:
      memory: 512Mi
      cpu: 500m
  jvmOptions:
    -Xms: 384m
    -Xmx: 384m
  template:
    pod:
      # Without this, all three controllers may land on one node and a single
      # machine loss takes the whole quorum. maxSkew 1 forces the 2+1 split.
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              strimzi.io/cluster: onprem
              strimzi.io/pool-name: controller
---
apiVersion: kafka.strimzi.io/v1
kind: KafkaNodePool
metadata:
  name: broker
  namespace: kafka
  labels:
    strimzi.io/cluster: onprem
spec:
  # One per schedulable node. Brokers CAN be scaled later; controllers cannot.
  replicas: 2
  roles:
    - broker
  storage:
    type: jbod
    volumes:
      - id: 0
        type: persistent-claim
        size: 20Gi
        class: longhorn-kafka
        deleteClaim: false
  resources:
    requests:
      memory: 1Gi
      cpu: 250m
    limits:
      memory: 1Gi
      cpu: "1"
  jvmOptions:
    -Xms: 640m
    -Xmx: 640m
  template:
    pod:
      affinity:
        podAntiAffinity:
          # requiredDuringScheduling, not preferred. If the budget drops to one node
          # the second broker stays Pending and says so, instead of doubling up and
          # leaving replication factor 2 with both copies on one machine.
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  strimzi.io/cluster: onprem
                  strimzi.io/pool-name: broker
```

The label keys used in both selectors — `strimzi.io/cluster` and `strimzi.io/pool-name` — are the
operator's own, defined in
[`Labels.java` at 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/operator-common/src/main/java/io/strimzi/operator/common/model/Labels.java).
A selector that matches nothing is a placement rule that does nothing, silently, so §5.2 checks the
placement rather than trusting the manifest.

```yaml title="kafka-cluster.yaml"
apiVersion: kafka.strimzi.io/v1
kind: Kafka
metadata:
  name: onprem
  namespace: kafka
spec:
  kafka:
    version: 4.3.0
    # Must match the version above. 4.3.0 -> 4.3-IV0, per kafka-versions.yaml at tag 1.1.0.
    metadataVersion: 4.3-IV0
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: tls
        port: 9093
        type: internal
        tls: true
      # Creates 1 bootstrap Service + 1 Service per broker = 3 MetalLB addresses.
      - name: external
        port: 9094
        type: loadbalancer
        tls: true
        configuration:
          bootstrap:
            annotations:
              # Only needed if the pool has autoAssign: false. Harmless otherwise,
              # and it documents which pool the address is expected to come from.
              metallb.io/address-pool: lan-pool
    config:
      # Every one of these is 2 or 1 because there are 2 brokers. The upstream
      # example ships 3 and 2; leaving those in place means __consumer_offsets
      # can never be created and consumer groups fail for no visible reason.
      default.replication.factor: 2
      min.insync.replicas: 1
      offsets.topic.replication.factor: 2
      transaction.state.log.replication.factor: 2
      transaction.state.log.min.isr: 1
      # The Topic Operator is the source of truth for topics. Auto-creation would
      # produce topics that no KafkaTopic describes and nobody reviews.
      auto.create.topics.enable: false
  entityOperator:
    topicOperator:
      resources:
        requests:
          memory: 256Mi
          cpu: 50m
        limits:
          memory: 256Mi
    # userOperator is omitted deliberately: it manages KafkaUser, and this document
    # configures no authentication. Add it in the same change that adds auth.
```

```bash
kubectl apply -f kafka-node-pools.yaml
kubectl apply -f kafka-cluster.yaml
```

Node pools first. A Kafka resource with no pools has nothing to schedule.

---

## 5. Watch it come up

### 5.1 Readiness

```bash
kubectl -n kafka get kafka onprem -w
```

```bash
kubectl -n kafka wait kafka/onprem --for=condition=Ready --timeout=600s
```

First start pulls the Kafka image on both workers and formats the KRaft metadata log; ten minutes is
a reasonable budget on a 2 vCPU machine. If it does not arrive, the reason is in the resource status
and the operator log, in that order:

```bash
kubectl -n kafka get kafka onprem -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{" "}{.message}{"\n"}{end}'
kubectl -n kafka logs deployment/strimzi-cluster-operator --tail=100
```

```bash
kubectl -n kafka get pods -o wide
```

### 5.2 Placement — the part the manifest only *asks* for

```bash
kubectl -n kafka get pods -o wide \
  -L strimzi.io/pool-name,strimzi.io/broker-role,strimzi.io/controller-role
```

Two things to establish, and neither is visible from a pod count:

- The two `broker` pods are on **different** nodes. If they share one, the anti-affinity selector did
  not match and replication factor 2 is storing both copies on one machine.
- The three `controller` pods are split **2 + 1**, not 3 + 0.

```bash
# distinct nodes per pool — brokers must be 2, controllers must be 2
kubectl -n kafka get pods -o json | jq -r '
  .items[] | select(.metadata.labels["strimzi.io/cluster"]=="onprem") |
  [.metadata.labels["strimzi.io/pool-name"], .spec.nodeName] | @tsv' |
  sort -u | awk '{c[$1]++} END {for (p in c) print p, c[p]}'
```

### 5.3 Node IDs, before you need them

Node IDs are assigned across the whole cluster, not per pool, so the controller pool takes the low
numbers and **the brokers are almost certainly not 0 and 1.** Anything that addresses a specific
broker — per-broker listener overrides, `kafka-topics.sh` output, a pinned LoadBalancer address —
needs the real IDs:

```bash
kubectl -n kafka get kafkanodepool -o custom-columns=\
'POOL:.metadata.name,DESIRED:.spec.replicas,CURRENT:.status.replicas,NODEIDS:.status.nodeIds,ROLES:.status.roles'
```

Write the broker IDs down. §8 uses them.

### 5.4 Storage

```bash
kubectl -n kafka get pvc -o custom-columns=\
'PVC:.metadata.name,SC:.spec.storageClassName,SIZE:.spec.resources.requests.storage,STATUS:.status.phase'
```

Every PVC must show `longhorn-kafka` and `Bound`. One that shows `longhorn` was created before §2 or
without the `class` field, and it cannot be corrected in place — delete the pool's PVC and let the
operator recreate it, or rebuild.

```bash
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns='VOL:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness,REPLICAS:.spec.numberOfReplicas'
```

For the Kafka volumes, `numberOfReplicas` must be `1` and robustness `healthy`. **A one-replica
Longhorn volume is `healthy`, not `degraded`** — that is the intended state here, and it looks
identical to the failure that [[longhorn-storage-onprem]] warns about only if you read the robustness
field without reading the replica count next to it.

---

## 6. External access

> **This listener has TLS and no authentication.** Anyone on the LAN who trusts the cluster CA can
> read every topic and write to every topic. TLS here proves the *server's* identity, not the
> client's. Do not put real data behind it until [[kafka-strimzi-auth-onprem]] exists — see
> Follow-ups.

```bash
kubectl -n kafka get svc -l strimzi.io/cluster=onprem --field-selector spec.type=LoadBalancer \
  -o custom-columns='NAME:.metadata.name,IP:.status.loadBalancer.ingress[0].ip'
```

Three rows, three distinct addresses, none `<pending>`. A `<pending>` here means MetalLB had nothing
left to assign, and the Kafka resource will not reach `Ready` because Strimzi cannot fill in the
advertised addresses.

The addresses Strimzi actually advertises are in the Kafka status, which is the authoritative place —
not the Service list:

```bash
kubectl -n kafka get kafka onprem \
  -o jsonpath='{.status.listeners[?(@.name=="external")].bootstrapServers}{"\n"}'
```

```bash
kubectl -n kafka get kafka onprem -o jsonpath='{.status.listeners}' | jq
```

The cluster CA, for clients:

```bash
kubectl -n kafka get secret onprem-cluster-ca-cert \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt
```

That file is a public certificate, not a credential. The CA **key**, in
`onprem-cluster-ca`, is `<REDACTED>` and never leaves the cluster.

### Testing it from the right machine

**A test from inside the cluster proves nothing about this listener**, and neither does a test from a
cluster node. The internal `plain` listener works whether or not MetalLB does, and kube-proxy programs
the LoadBalancer address on every node so a node curling it answers itself with no ARP request ever
leaving the machine. That false pass is documented in detail in [[metallb-l2-onprem]] — it returned
`200` on a network where L2 announcement is fundamentally incapable of working.

From a **non-cluster machine on the same LAN**:

```bash
# partial check: MetalLB answered, and the cert chains to the cluster CA.
# Says nothing about the Kafka protocol.
openssl s_client -connect <BOOTSTRAP_IP>:9094 -CAfile ca.crt -brief </dev/null
```

```bash
# the check that decides whether L2 works at all
ip neigh show <BOOTSTRAP_IP>
```

An entry in state `REACHABLE`, with a MAC belonging to the announcing node, is the mechanism working.
No entry, or `FAILED`, means nothing answered the ARP request — go to [[metallb-l2-onprem]] rather
than debugging Kafka.

The end-to-end check needs a real Kafka client on that machine, pointed at the bootstrap address from
the status field above, with:

```properties title="client-external.properties"
security.protocol=SSL
ssl.truststore.type=PEM
ssl.truststore.location=/path/to/ca.crt
```

`ssl.truststore.type=PEM` avoids building a JKS. If the client is old enough to require JKS, that is a
`keytool -import` of the same `ca.crt`.

---

## 7. A topic

```yaml title="kafka-topic.yaml"
apiVersion: kafka.strimzi.io/v1
kind: KafkaTopic
metadata:
  name: handson-test
  namespace: kafka
  labels:
    strimzi.io/cluster: onprem
spec:
  partitions: 6
  # 2, not 3. There are two brokers. A KafkaTopic asking for 3 is created as a
  # Kubernetes resource and never as a Kafka topic — see the check below.
  replicas: 2
  config:
    min.insync.replicas: 1
    retention.ms: 604800000
```

```bash
kubectl apply -f kafka-topic.yaml
```

```bash
kubectl -n kafka get kafkatopic handson-test \
  -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{" "}{.reason}{" "}{.message}{"\n"}{end}'
```

**`kubectl get kafkatopic` showing the resource is not the check.** The resource exists the moment the
API server accepts it, whether or not the Topic Operator could create anything in Kafka. `Ready=True`
in the status is the property. A `replicas` value above the broker count fails here, with the reason
in the message.

---

## 8. Produce and consume

Both use the Strimzi Kafka image at the version the operator ships,
`quay.io/strimzi/kafka:1.1.0-kafka-4.3.0`, which contains the standard Kafka CLI under `/opt/kafka`
(the image's working directory, so `bin/…` resolves).

```bash
MARKER="handson-$(date -u +%FT%TZ)-$RANDOM"
echo "$MARKER"
```

```bash
kubectl -n kafka run kafka-producer --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-console-producer.sh \
    --bootstrap-server onprem-kafka-bootstrap:9092 \
    --topic handson-test \
    --producer-property acks=all <<< "$MARKER"
```

`acks=all` is the point of the exercise — with `min.insync.replicas: 1` it succeeds against one
replica, which is exactly the durability trade §"Brokers" describes. Producing with the default acks
would not exercise it at all.

```bash
kubectl -n kafka run kafka-consumer --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-console-consumer.sh \
    --bootstrap-server onprem-kafka-bootstrap:9092 \
    --topic handson-test \
    --from-beginning \
    --timeout-ms 15000 \
  | grep -F "$MARKER"
```

Two things about this that look like failures and are not:

- **`kafka-console-consumer.sh --timeout-ms` exits by throwing a `TimeoutException` on stderr.** That
  is how it terminates when the topic goes idle; it is not an error. The `grep` exit status is the
  result — zero means the exact marker came back, non-zero means it did not.
- The consumer is a **separate pod** from the producer on purpose. Producing and consuming in one
  process passes on a single-broker cluster with replication factor 1, which is precisely the
  configuration this document exists to avoid.

### The check that actually tests replication

Reading a message back proves the topic works. It says nothing about whether the second copy exists.

```bash
kubectl -n kafka run kafka-admin --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-topics.sh --bootstrap-server onprem-kafka-bootstrap:9092 \
    --describe --topic handson-test
```

Every one of the 6 partitions must list **two** entries in `Isr:`, and those two must be the broker
node IDs from §5.3.

```bash
kubectl -n kafka run kafka-admin --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-topics.sh --bootstrap-server onprem-kafka-bootstrap:9092 \
    --describe --under-replicated-partitions
```

**Empty output is the pass here** — an alarming-looking blank that means every partition has its full
ISR.

> **Known false pass:** `--under-replicated-partitions` is also empty on a replication-factor-1
> topic, because one replica in an ISR of one is not under-replicated. It only means "as replicated
> as it was asked to be", not "replicated". Pair it with the `Isr:` count from the previous command,
> which states the number.

### Killing a broker

```bash
kubectl -n kafka get pods -l strimzi.io/pool-name=broker -o wide
kubectl -n kafka delete pod onprem-broker-<ID>
```

Immediately, in another terminal, re-run the consumer from §8 and confirm the same marker still comes
back, and re-run `--describe` to see the leader for those partitions on the surviving broker and the
ISR at 1.

```bash
# during the window: this should now print something. If it stays empty, the
# partitions were never replicated to the deleted broker in the first place.
kubectl -n kafka run kafka-admin --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-topics.sh --bootstrap-server onprem-kafka-bootstrap:9092 \
    --describe --under-replicated-partitions
```

Then confirm it returns to empty once the pod is back and has caught up.

**Be honest about what this tests.** Deleting a pod is not losing a node — the StrimziPodSet recreates
it in seconds on the same machine, with the same PVC. [[metallb-l2-onprem]] found the same shape:
deleting a pod produced a perfect-looking failover that never happened. The test that would mean
something is powering off a worker, which also exercises the strict-local storage decision (the
broker's log directory dies with the machine). See [[k8s-node-drain-replace]] first.

### Clean up the test

```bash
kubectl -n kafka delete kafkatopic handson-test
```

```bash
kubectl -n kafka run kafka-admin --rm -i --restart=Never \
  --image=quay.io/strimzi/kafka:1.1.0-kafka-4.3.0 -- \
  bin/kafka-topics.sh --bootstrap-server onprem-kafka-bootstrap:9092 --list
```

`handson-test` should be gone from Kafka, not merely from Kubernetes.

---

## Verification checklist

Placement — the things that make the replication factors mean anything:

- [ ] `kubectl get nodes` with the taint column shows exactly **2** untainted nodes, matching [[schedulable-node-budget]]
- [ ] The two `broker` pods are on **two distinct nodes**. *(Known false pass: a pod count of 2 is satisfied by both on one node. Check the `NODE` column, not the count.)*
- [ ] The three `controller` pods are split **2 + 1** across the two nodes, not 3 + 0
- [ ] Every Kafka pod is `1/1`, not merely `Running`

Replication — the property, not its proxy:

- [ ] `kubectl -n kafka get kafka onprem` shows `Ready=True` in `.status.conditions`, not just an existing resource
- [ ] Both `KafkaNodePool` resources show `status.replicas` equal to `spec.replicas`
- [ ] `kafka-topics.sh --describe` lists **two** node IDs in `Isr:` for every partition of the test topic, and they are the broker IDs from §5.3
- [ ] `--under-replicated-partitions` returns **empty** with all brokers up. *(Known false pass: also empty at replication factor 1. Only meaningful alongside the `Isr:` count above.)*
- [ ] `--under-replicated-partitions` returns **non-empty** while a broker pod is deleted, and empty again after it catches up. A run that never goes non-empty means nothing was ever replicated
- [ ] The `Kafka` config carries `offsets.topic.replication.factor: 2`, and a consumer group commits offsets successfully (which is what proves `__consumer_offsets` was actually created)

Data path:

- [ ] A message produced with `acks=all` from one pod is read back **byte-identical** by a consumer in a **different** pod. *(The `grep -F "$MARKER"` exit status is the check; the consumer's `TimeoutException` on stderr is normal termination, not a failure.)*
- [ ] The same marker still reads back while one broker pod is deleted

Storage:

- [ ] Every Kafka PVC reports `storageClassName: longhorn-kafka` and `Bound`
- [ ] The corresponding Longhorn volumes report `numberOfReplicas: 1` and `robustness: healthy`. *(One replica reporting `healthy` is correct here, not the degraded state [[longhorn-storage-onprem]] warns about — read the replica count next to the robustness field.)*
- [ ] `kubectl -n kafka exec onprem-broker-<ID> -- df -h` shows the Kafka log directory on a `longhorn` device at the size the pool asked for, not on the node root filesystem. *(Confirm the mount path from `kubectl -n kafka describe pod onprem-broker-<ID>` rather than assuming it — JBOD volume 0 is not mounted at the same path as a non-JBOD volume.)*

External access:

- [ ] Three LoadBalancer Services exist for this cluster, all with an assigned IP, none `<pending>`
- [ ] `.status.listeners[?(@.name=="external")].bootstrapServers` is populated with real addresses
- [ ] A Kafka client on a machine that is **not a cluster node** produces and consumes over 9094 using `ca.crt`. *(Known false pass: any test from inside the cluster or from a cluster node passes regardless of whether MetalLB works — see [[metallb-l2-onprem]].)*
- [ ] `ip neigh show <BOOTSTRAP_IP>` on that machine reports `REACHABLE` at the announcing node's MAC
- [ ] The MetalLB pool still has free addresses after Kafka took its three

Config, checked rather than assumed:

- [ ] `min.insync.replicas` was chosen deliberately (1 or 2) and the consequence in the table above was accepted
- [ ] A `KafkaTopic` with `replicas: 3` reports `Ready=False` — confirming the Topic Operator is validating rather than accepting anything
- [ ] The operator version in this document's `env` matches `helm list -n kafka`

---

## Rollback

Order matters. Removing the operator before the Kafka resources leaves finalizers with nothing to
service them.

```bash
kubectl -n kafka delete kafkatopic --all
```

```bash
kubectl -n kafka delete kafka onprem
kubectl -n kafka delete kafkanodepool broker controller
```

**The PVCs and all Kafka data survive this.** `deleteClaim: false` is the default and this document
sets it explicitly. That is the safe behaviour and it is also how you leak 70 GB:

```bash
kubectl -n kafka get pvc
```

```bash
# only when the data is genuinely finished with — there is no undo
kubectl -n kafka delete pvc -l strimzi.io/cluster=onprem
```

```bash
helm uninstall strimzi-cluster-operator -n kafka
kubectl delete namespace kafka
```

```bash
kubectl delete storageclass longhorn-kafka
```

> **The Strimzi CRDs are cluster-scoped.** `kubectl delete crd -l app=strimzi` removes them and
> **every `Kafka`, `KafkaNodePool`, `KafkaTopic` and `KafkaUser` in every namespace** goes with them.
> On this cluster there is only one Kafka, so it is safe; on any cluster where that is not certain,
> leave the CRDs in place. The chart does not remove them on uninstall, which is why this is a
> separate deliberate step:

```bash
kubectl get crd -l app=strimzi
```

### Abort criteria

- The schedulable-node count is not 2. Stop; the replica counts here are derived from it.
- The Kafka resource has not reached `Ready` after 15 minutes and the operator log shows no progress.
  Do not scale anything to "help" — a controller pool cannot be scaled, and trying leaves the CR
  rejected while the pods it already made keep running.
- MetalLB cannot assign all three addresses. Remove the `external` listener and come back to it, or
  switch to `nodeport`. A partially-assigned listener keeps the whole cluster from becoming ready.
- The two brokers landed on the same node. Delete and rebuild rather than living with it — replication
  factor 2 with both copies on one machine is worse than replication factor 1, because it costs the
  same as redundancy and provides none.

---

## Where this bit us

Nothing yet. This document has not been run.

That is not the same as "no problems" — it means the traps below are the ones Strimzi and Longhorn
document, and the ones this cluster's own history predicts, rather than ones anyone here has hit.
Replace this section with what actually happened on the first run.

## Failure points documented upstream

Each of these is cited. None was observed here.

**A controller quorum that cannot be resized.** Adding or removing controller node pools, adding or
removing the controller role, and scaling a controller pool are all unsupported, because Strimzi uses
static KRaft quorums. Getting the count wrong means building a new Kafka cluster and migrating, not
editing a number.
([Deploying and Managing — KRaft mode](https://strimzi.io/docs/operators/latest/deploying#assembly-kraft-mode-str))

**Internal topic replication factors above the broker count.** The upstream persistent example ships
`offsets.topic.replication.factor: 3` and `transaction.state.log.replication.factor: 3`. On two
brokers `__consumer_offsets` cannot be created and consumer groups fail; the symptom appears in
consumers, not in the Kafka CR.
([`examples/kafka/kafka-persistent.yaml` at 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/examples/kafka/kafka-persistent.yaml)
ships the 3-broker values this document deliberately overrides.)

**PVCs outliving the cluster.** `deleteClaim` is a plain `boolean` field with no initializer, so it
defaults to `false`. Deleting a `Kafka` leaves every PVC and all data. Rollback section.
([`PersistentClaimStorage.java` at 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/api/src/main/java/io/strimzi/api/kafka/model/kafka/PersistentClaimStorage.java))

**No default pod anti-affinity.** The operator injects node affinity only when rack awareness is
configured; nothing prevents brokers stacking on one machine. §"What two schedulable nodes allow".
([`ModelUtils.java` at 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/model/ModelUtils.java))

**`kubectl drain` against a Kafka node.** Strimzi generates a PodDisruptionBudget with
`maxUnavailable` defaulting to 1, which is not by itself enough — Strimzi ships a separate Drain
Cleaner so that broker and controller pods are moved by the operator, in a quorum-safe order, rather
than evicted by Kubernetes. Not installed by this document.
([`PodDisruptionBudgetTemplate.java` at 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/blob/1.1.0/api/src/main/java/io/strimzi/api/kafka/model/common/template/PodDisruptionBudgetTemplate.java)
for the default; [Strimzi Drain Cleaner](https://strimzi.io/docs/operators/latest/deploying#assembly-drain-cleaner-str)
for the component.) On a two-node cluster a drain takes the budget to 1 and the second broker will not
reschedule — see [[k8s-node-drain-replace]].

**Only the `v1` CRD API is supported.** Release 1.1.0 removed `v1beta2`, `v1beta1` and `v1alpha1`.
Manifests copied from a blog post or an older repository will be rejected, or worse, silently accepted
by a stale CRD. Every YAML here uses `kafka.strimzi.io/v1`.
([Release 1.1.0](https://github.com/strimzi/strimzi-kafka-operator/releases/tag/1.1.0))

**Longhorn `strict-local` and RWX.** Data locality `strict-local` is incompatible with
`ReadWriteMany` volumes. Kafka uses RWO so this is fine, but the `longhorn-kafka` StorageClass must
not be reused for anything needing RWX.
([Longhorn 1.7.2 — Data Locality](https://longhorn.io/docs/1.7.2/high-availability/data-locality/))

**A LoadBalancer listener needs every address before the cluster is ready.** Strimzi cannot compute
advertised addresses until all the Services are assigned, so an exhausted MetalLB pool presents as a
Kafka cluster that never becomes ready rather than as an address problem.
([Accessing Kafka using loadbalancers](https://strimzi.io/docs/operators/latest/deploying#proc-accessing-kafka-using-loadbalancers-str))

---

## Follow-ups

- [ ] Add authentication and authorization before anything real is on this cluster — a TLS listener with no auth means any LAN host with `ca.crt` has full read/write. `KafkaUser` with `scram-sha-512` plus a `simple` authorizer, and the `userOperator` that §4 deliberately omits. Draft as [[kafka-strimzi-auth-onprem]] 📅 2026-08-31
- [ ] Measure the resource requests in §1.2 instead of guessing them — `kubectl top pod -n kafka` under a `kafka-producer-perf-test.sh` run, then correct the tables here and the memory line in [[schedulable-node-budget]] step 3 📅 2026-09-15
- [ ] Install the Strimzi Drain Cleaner, or write the manual pre-drain procedure into [[k8s-node-drain-replace]] — on two schedulable nodes a drain leaves a broker unschedulable, and the generated PDB does not prevent that 📅 2026-09-30
- [ ] Re-decide the storage and topology when a fourth machine arrives: at 3 schedulable nodes, replication factor 3 with `min.insync.replicas` 2 becomes possible, Longhorn's second replica starts being usable, and the controller count would need to have been 3 already — which it is, deliberately. Also derive the 20 GB per broker from a throughput and retention estimate rather than from what fits

## Related

[[onprem-3node-kubeadm-ubuntu]] — the cluster this runs on, and the source of the 2 vCPU / 4 GB worker spec that makes §1.2 the binding constraint rather than an afterthought.
[[schedulable-node-budget]] — the standing decision that the budget is 2. Every replica count and replication factor in this document is derived from that number; read it before changing any of them.
[[longhorn-storage-onprem]] — supplies the disks, and its `defaultReplicaCount=2` is exactly the setting this document opts out of for Kafka data. Also the source of the "healthy-looking component with no redundancy" failure this document's placement rules exist to avoid.
[[metallb-l2-onprem]] — supplies the three LoadBalancer addresses, and its false-pass lesson is reused verbatim in §6: any test of the external listener from inside the cluster or from a cluster node passes whether or not the mechanism works.
[[ingress-nginx-onprem]] — already holds one address from the same pool, and would be the route to a zero-address Kafka listener if it were running with `--enable-ssl-passthrough`, which it is not.
[[k8s-node-drain-replace]] — draining a worker here removes a broker, a controller, and that broker's only copy of its log directory at once. Read before any planned maintenance.
[[pod-crashloopbackoff]] — where a broker that will not start, or one stuck `Pending` on the anti-affinity rule, gets diagnosed.
