---
title: cert-manager on-prem — certificates for hosts the internet cannot reach
date: 2026-08-07
domain: install
tags: [on-prem, tls, pki]
stack: [kubernetes, cert-manager, helm, ingress-nginx, kubectl]
summary: Issue and renew TLS certificates automatically on a cluster whose hostnames do not resolve publicly, using either an internal CA or Let's Encrypt over DNS-01. HTTP-01 cannot work here, and that constraint decides the whole design. The internal CA path is verified; the DNS-01 path is not.
source: handson
env: Kubernetes 1.31.6 · cert-manager 1.16.2 · ingress-nginx chart 4.11.3 · MetalLB 0.14.8 · Helm 4.2.3 — Path A run on a three-node kind cluster on one bridge; Path B not run
verified: 2026-08-08
verifiability: partial
verifiability-note: Path A (internal CA) verified. Path B (Let's Encrypt over DNS-01) needs a public zone and a provider token, and has not been run.
duration: 30–50 min
risk: medium
---

> **Verified 2026-08-08 for Path A only.** Sections 1, 2, A and 5–6 were run end to end on a
> three-node kind cluster behind [[ingress-nginx-onprem]], finishing with `curl https://…` from a
> LAN machine with no `-k` and no warning — which is the entire point of the document. One check in
> section 6 was wrong; see [Where this bit us](#where-this-bit-us).
>
> ⚠️ **Path B (Let's Encrypt over DNS-01) has not been run and stays unproven.** It needs a public
> zone and a DNS provider API token, and issuing a real certificate for a real domain is not
> something to do incidentally while testing a document. Treat every command in Path B as drafted
> from upstream documentation. The rate-limit advice in B.1 is the reason to start on staging when
> you do run it.

[[ingress-nginx-onprem]] terminates TLS but serves a self-signed certificate, so every browser warns and every `curl` needs `-k`. That is tolerable for a week and corrosive after that — people start passing `--insecure` reflexively, and then a real certificate error looks like all the others.

cert-manager issues and renews certificates automatically. The on-prem part is the constraint: **HTTP-01 validation requires the ACME server to reach your host over the public internet, and these hosts do not exist out there.** So the choice is not "which cert-manager", it is which of two paths you take.

## Choose the path first

| | Internal CA | Let's Encrypt over DNS-01 |
|---|---|---|
| Trusted by browsers | only after you distribute the root cert | yes, out of the box |
| Needs internet | no | yes, from the cluster |
| Needs a public DNS zone | no | yes, one you can create TXT records in |
| Works for hosts like `demo.apps.internal` | yes | no — the name must be in a zone you own |
| Ongoing work | pushing the root cert to every new laptop | none |
| Failure mode | new device gets warnings | rate limits, DNS API credentials expiring |

**Take the internal CA** when the cluster is genuinely internal and you control the machines that talk to it. **Take DNS-01** when you own a real domain and want certificates that any device trusts without setup — including phones and contractors' laptops, where distributing a root certificate is not realistic.

Both paths install cert-manager identically; only the Issuer differs. Sections 1–2 are shared, then take A or B, then section 5 wires it to the ingress.

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Ingress controller working | `kubectl get ingress -A` | a host answers over HTTP |
| Helm | `helm version --short` | v3.x |
| Clock in sync on all nodes | `timedatectl status` | `System clock synchronized: yes` |
| Outbound HTTPS (path B only) | `kubectl run t --rm -it --image=curlimages/curl --restart=Never -- curl -sI https://acme-v02.api.letsencrypt.org/directory \| head -1` | `HTTP/2 200` |
| DNS API credentials (path B only) | your provider's console | a token scoped to one zone |

Clock skew is not a footnote here. Certificates carry `notBefore`/`notAfter`, and ACME signs timestamped requests — a node minutes out of sync produces validation failures that read like network problems. The kubeadm prerequisites in [[onprem-3node-kubeadm-ubuntu]] already cover this; confirm it rather than assuming.

---

## 1. Install cert-manager

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update jetstack
```

```bash
export CERT_MANAGER_VERSION=v1.16.2
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version "$CERT_MANAGER_VERSION" \
  --set crds.enabled=true \
  --wait --timeout 5m
```

Check the [releases page](https://github.com/cert-manager/cert-manager/releases) for the current version and record it in this document's `env`.

`--set crds.enabled=true` is the current flag. Older guides use `--set installCRDs=true`, which newer charts ignore — Helm accepts unknown values silently, so the install succeeds and then every `Issuer` you apply fails with `no matches for kind`. If that happens, the CRDs were never installed.

```bash
kubectl -n cert-manager get pods
```

Three deployments: `cert-manager`, `cert-manager-webhook`, `cert-manager-cainjector`. All must be `Running`.

```bash
kubectl get crd | grep cert-manager
```

## 2. Wait for the webhook before applying anything

cert-manager validates Issuers and Certificates through an admission webhook. Applying an Issuer before the webhook is serving fails with `failed calling webhook "webhook.cert-manager.io"` — a connection error that reads like a configuration mistake and is only impatience.

```bash
kubectl -n cert-manager rollout status deployment cert-manager-webhook --timeout=180s
```

The official check, if you have the plugin:

```bash
cmctl check api
```

`The cert-manager API is ready` is the green light. Without `cmctl`, applying a throwaway self-signed Issuer and watching it become `Ready` proves the same thing.

---

## Path A — internal CA

Everything stays inside the cluster. cert-manager creates a self-signed root, then issues from it.

### A.1 Root and ClusterIssuer

```yaml title="internal-ca.yaml"
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-root
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-ca
  namespace: cert-manager        # must be here — see the note below
spec:
  isCA: true
  commonName: <ORG> Internal CA
  secretName: internal-ca-key-pair
  duration: 87600h               # 10 years; rotating a root is disruptive, so make it long
  renewBefore: 720h
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned-root
    kind: ClusterIssuer
    group: cert-manager.io
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca
spec:
  ca:
    secretName: internal-ca-key-pair
```

```bash
kubectl apply -f internal-ca.yaml
```

**The CA secret must live in cert-manager's cluster resource namespace**, which is `cert-manager` by default. A `ClusterIssuer` looks for its secret only there — put the Certificate in `default` and the issuer reports `secret not found` while the secret plainly exists.

```bash
kubectl -n cert-manager get certificate internal-ca
kubectl get clusterissuer
```

Both should report `Ready: True`. An issuer that is not ready never issues anything, and the failure downstream looks like a stuck Certificate.

### A.2 Distribute the root certificate

This is the step that gets skipped, and then everyone concludes "cert-manager did not work" when in fact it worked and no client trusts the result.

```bash
kubectl -n cert-manager get secret internal-ca-key-pair \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > internal-ca.crt
```

```bash
openssl x509 -in internal-ca.crt -noout -subject -issuer -dates
```

On an Ubuntu or Debian client:

```bash
sudo cp internal-ca.crt /usr/local/share/ca-certificates/internal-ca.crt
sudo update-ca-certificates
```

On macOS, add it to the login keychain and mark it trusted; on Windows, import into Trusted Root Certification Authorities. Browsers vary — Firefox keeps its own store and needs the certificate added there separately.

> **The private key of this CA can sign a certificate for any name.** It sits in a Kubernetes secret readable by anyone with cluster access. That is an acceptable trade for an internal cluster and an unacceptable one if this CA is ever trusted by machines outside it.

Continue at section 5.

---

## Path B — Let's Encrypt over DNS-01

Real, publicly trusted certificates for hosts that live only on your LAN. It works because DNS-01 proves you control the *domain*, not the *host* — the ACME server never connects to the cluster.

This uses Cloudflare as the concrete example. Route53, Google Cloud DNS, AzureDNS, ACME-DNS, and RFC-2136 all have solvers; the surrounding structure is identical and only the `dns01` block changes.

### B.1 Start on staging

Let's Encrypt enforces rate limits, and the useful one to know is **five duplicate certificates per week.** Debugging a solver against production burns that quota in an afternoon and then locks you out for days.

```yaml title="letsencrypt-staging.yaml"
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: <EMAIL>
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
        selector:
          dnsZones:
            - <DOMAIN>
```

The API token needs **Zone:DNS:Edit on that one zone only**. A global key here is a credential that can move your whole domain, stored in a namespace several people can read.

```bash
kubectl -n cert-manager create secret generic cloudflare-api-token \
  --from-literal=api-token='<REDACTED>'
```

Pass the token through a file or an environment variable rather than typing it inline — a literal on the command line lands in shell history.

```bash
kubectl apply -f letsencrypt-staging.yaml
kubectl get clusterissuer letsencrypt-staging
```

`Ready: True` means the ACME account registered. It says nothing yet about whether the solver can write TXT records — that only shows on the first certificate.

### B.2 Move to production once staging issues cleanly

Copy the file, change the name to `letsencrypt-prod`, and point `server` at `https://acme-v02.api.letsencrypt.org/directory` with its own `privateKeySecretRef`. Do not reuse the staging account key.

Staging certificates are signed by an untrusted root, so browsers still warn — that is expected and is not a reason to switch early. Switch when the Certificate reaches `Ready` without manual intervention.

---

## 5. Wire it to the ingress

One annotation on the Ingress. cert-manager watches for it, requests the certificate, and writes it into the named secret; ingress-nginx picks the secret up and serves it.

```yaml title="demo-ingress.yaml"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo
  annotations:
    cert-manager.io/cluster-issuer: internal-ca      # or letsencrypt-staging / letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - demo.apps.<DOMAIN>
      secretName: demo-tls        # cert-manager creates this; do not create it yourself
  rules:
    - host: demo.apps.<DOMAIN>
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: demo
                port:
                  number: 80
```

```bash
kubectl apply -f demo-ingress.yaml
```

**The secret is created in the Ingress's namespace.** An Ingress in `apps` cannot use a certificate secret in `default`, and cert-manager will not move it there.

Watch the chain of objects. Each one explains the next, and reading them in order is far faster than guessing:

```bash
kubectl get certificate demo-tls
kubectl describe certificate demo-tls | tail -20
```

```bash
kubectl get certificaterequest,order,challenge -A
```

`Certificate` → `CertificateRequest` → `Order` → `Challenge` (ACME paths only). Whichever is not `Ready` holds the reason in its events. A `Challenge` stuck `pending` on DNS-01 means the TXT record was not written or has not propagated — its status names which.

```bash
kubectl -n cert-manager logs deployment/cert-manager --tail=100
```

## 6. Verify from outside

```bash
kubectl get secret demo-tls -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -noout -issuer -dates
```

**The subject comes out empty, and that is correct.** cert-manager's ingress-shim builds the
Certificate from the Ingress's `tls.hosts` and sets no `commonName`, so the hostname lives only in
the SAN extension. Asking for `-subject` prints a blank line, which reads like a broken certificate.
Check the SAN instead — that is the field browsers use anyway:

```bash
kubectl get secret demo-tls -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -noout -text | grep -A1 'Subject Alternative Name'
```

```
X509v3 Subject Alternative Name: critical
    DNS:demo.apps.internal
```

`openssl x509 -ext subjectAltName` is the tidier form and is **not available on macOS**, whose
`openssl` is LibreSSL. The `-text | grep` above works everywhere.

From your workstation, against the real endpoint:

```bash
openssl s_client -connect demo.apps.<DOMAIN>:443 -servername demo.apps.<DOMAIN> </dev/null 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates
```

```bash
# no -k anywhere — that is the whole point
curl -sS https://demo.apps.<DOMAIN>/ | head -3
```

A certificate error at this point on path A means the root is not trusted by this machine — go back to A.2. On path B it means you are still on staging, which is expected until you switch.

### Confirm renewal is scheduled

An automatic certificate that does not actually renew is worse than a manual one, because nobody is watching.

```bash
kubectl get certificate demo-tls -o jsonpath='{.status.renewalTime}{"\n"}'
kubectl get certificate demo-tls -o jsonpath='{.status.notAfter}{"\n"}'
```

cert-manager renews at roughly two-thirds of the lifetime. The gap between those two timestamps should be comfortably wide.

## Verification checklist

- [ ] `kubectl -n cert-manager get pods` — all three deployments `Running`
- [ ] `cmctl check api` reports the API ready (or a throwaway self-signed Issuer goes `Ready`)
- [ ] `kubectl get clusterissuer` — the issuer you chose is `Ready: True`
- [ ] A Certificate reaches `Ready: True` without manual steps
- [ ] `kubectl get challenge -A` is empty after issuance (path B)
- [ ] `openssl s_client` from the LAN shows the expected issuer, not the ingress default self-signed cert
- [ ] The certificate's **SAN** carries the hostname (the subject is legitimately empty)
- [ ] `curl https://…` fails with `unable to get local issuer certificate` **before** the root is trusted
- [ ] `curl https://…` then succeeds **without** `-k`
- [ ] `status.renewalTime` is set and well before `notAfter`
- [ ] Path A only: the root certificate is installed on at least one machine that is not the one that generated it
- [ ] Path B only: the DNS API token is scoped to one zone, and where it expires is written down
- [ ] Deleting and re-creating the Ingress re-issues without hitting a rate limit

## Rollback

Certificates first, then the installation. Removing the CRDs deletes every Certificate object in the cluster, and the TLS secrets they produced are orphaned rather than cleaned up.

```bash
kubectl delete -f demo-ingress.yaml
kubectl delete clusterissuer internal-ca selfsigned-root 2>/dev/null || true
kubectl -n cert-manager delete certificate internal-ca 2>/dev/null || true
```

```bash
kubectl get certificate -A          # nothing left that you still need
```

```bash
helm uninstall cert-manager -n cert-manager
kubectl delete namespace cert-manager
```

```bash
# CRD removal is what actually deletes Certificate objects — irreversible
kubectl get crd | grep cert-manager
kubectl delete crd $(kubectl get crd -o name | grep cert-manager | cut -d/ -f2)
```

Existing TLS secrets survive all of this, so ingress hosts keep serving their current certificate until it expires — and then nothing renews it. If you are removing cert-manager for good, replace those certificates before the expiry, not after.

On path A, the root certificate you distributed to client machines stays trusted until removed there too. Clean it off the clients:

```bash
sudo rm /usr/local/share/ca-certificates/internal-ca.crt
sudo update-ca-certificates --fresh
```

## Where this bit us

Path A ran almost exactly as written. One check was wrong.

**Section 6's `-subject` shows nothing.** A certificate issued through the Ingress annotation carries
no common name — ingress-shim sets `dnsNames` only — so `openssl x509 -noout -subject` prints an
empty line on a perfectly good certificate. Anyone verifying an internal CA for the first time reads
that as a failure and goes looking for a problem that is not there. Section 6 now asks for the SAN.

Worth recording because it is the thing the whole document is for: with the root installed on a LAN
machine, `curl https://demo.apps.internal/` returned the application with **no `-k` and no warning**,
and the same request before installing the root failed with `unable to get local issuer certificate`.
That pair, in that order, is the proof — a single passing `curl` proves nothing if you never saw it
fail.

Everything else held: `crds.enabled=true` installed the CRDs, waiting on the webhook rollout avoided
the admission error, the CA secret in the `cert-manager` namespace was found by the ClusterIssuer,
the `Certificate` → `CertificateRequest` chain completed with no `Challenge` objects (correct for a CA
issuer), `renewalTime` landed at two thirds of a 90-day lifetime, and deleting and re-creating the
Ingress re-issued with a fresh serial. The root itself came out with the full ten-year validity the
`duration: 87600h` asks for.

## Failure points documented upstream

These come from cert-manager's documentation and troubleshooting guide. None were hit on Path A; the
Path B entries are unproven along with the rest of Path B.

**`installCRDs` versus `crds.enabled`** — the flag was renamed. Helm ignores unknown values, so the install looks fine and every Issuer then fails with `no matches for kind`. Section 1. ([Installation with Helm](https://cert-manager.io/docs/installation/helm/))

**Applying an Issuer before the webhook is ready** — `failed calling webhook "webhook.cert-manager.io"`. Not a config error. Section 2.

**ClusterIssuer secret in the wrong namespace** — a `ClusterIssuer` reads secrets only from the cluster resource namespace (`cert-manager` by default), so a CA secret elsewhere is invisible to it. Section A.1.

**TLS secret in the wrong namespace** — the certificate secret must be in the same namespace as the Ingress that references it. Section 5.

**Let's Encrypt rate limits** — five duplicate certificates per week, and failed validations count against separate limits. Debug against staging. Section B.1. ([Rate limits](https://letsencrypt.org/docs/rate-limits/))

**HTTP-01 on an internal host** — the challenge never completes because the ACME server cannot reach the name. This is not a fixable configuration; it is why this document exists.

**Clock skew** — ACME requests and certificate validity both depend on time. A node minutes off produces validation errors that look like network faults. Prerequisites.

**Over-broad DNS credentials** — a global API key instead of a zone-scoped token means a cluster secret that can move the entire domain. Section B.1.

## Follow-ups

- [ ] Run Path B against a real zone on the staging ACME endpoint, correct it, and note in `env` that it has been 📅 2026-09-30
- [ ] Re-run Path A on the real cluster — kind proved the issuance and the trust chain, not the clock-skew failure mode the prerequisites warn about
- [ ] Decide which path is the standard here, and write down why — mixing both leaves nobody sure which hosts are trusted where
- [ ] Path A: get the root certificate into whatever provisions new laptops, not into a wiki page people copy by hand
- [ ] Path B: record where the DNS API token lives and when it expires
- [ ] Move Argo CD onto a real certificate — see [[argocd-helm-ha-install]], which currently assumes one already exists
- [ ] Add an alert for certificates within 14 days of expiry; automatic renewal fails silently otherwise

## Related

[[ingress-nginx-onprem]] — terminates the TLS this document issues. Answers the certificate follow-up left open there.
[[onprem-3node-kubeadm-ubuntu]] — the cluster underneath, and where clock sync was set up.
[[argocd-helm-ha-install]] — its prerequisites table asks for a TLS secret or a ClusterIssuer. This is that.
[[pod-crashloopbackoff]] — if the webhook or cainjector pods will not start.
