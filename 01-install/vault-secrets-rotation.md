---
title: Vault — rotating a password without redeploying, and the two you rotated away that still work
date: 2026-08-24
domain: install
tags: [security, secrets, devsecops, containers]
stack: [vault, hvac, python, podman, docker-compose]
summary: A real Vault server on file storage — initialised, sealed, unsealed with two of three key shares — serving a credential an application pulls on demand. Three rotations landed with the container at restarts=0, and then the same read-only token read every password that had been rotated away, which is what makes `kv destroy` part of incident response rather than housekeeping.
source: handson
env: Vault 1.20.4 (file storage, TLS disabled) · hvac 2.3.0 · Python 3.13 · Podman 5.7.1 with docker-compose 5.3.1 · macOS 14.7.5
verified: 2026-08-24
verifiability: partial
verifiability-note: A single unreplicated node with TLS disabled on the listener, using token auth. Everything below — seal/unseal thresholds, policy paths, rotation without restart, version destruction, TTL expiry and the audit device — ran against it. What a single node cannot show is HA and standby behaviour, auto-unseal via a cloud KMS, and the auth methods anything real would use instead of hand-issued tokens (AppRole, Kubernetes, OIDC).
duration: 45–70 min
risk: low
---

> **Verified 2026-08-24.** Every token, denial and version below came from a running server. The
> passwords are real values generated for the lab and redacted here; the SHA-256 fingerprints in the
> application log are what actually got printed, and they are how rotation was proven without
> printing a secret.

A `.env` file fails in three ways at once: it gets committed, it cannot be rotated without a
redeploy, and nobody can tell you who read it. Vault answers all three, and **the answer is a change
of direction — the application pulls the credential when it needs it, instead of being handed one at
deploy time.** That inversion is what decouples rotation from releases.

## A server that starts sealed

Most Vault tutorials run `-dev`, which is in-memory, auto-unsealed and gone on restart. It also hides
the single most important operational fact about Vault, so this uses file storage:

```hcl title="config/vault.hcl"
# File storage rather than dev mode: the server starts SEALED and survives a
# restart, which is the operational reality dev mode hides.
storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true          # lab only; a real listener terminates TLS here
}

api_addr      = "http://127.0.0.1:8200"
disable_mlock = true          # required when IPC_LOCK is unavailable
```

```bash
podman compose up -d vault
curl -s http://127.0.0.1:8200/v1/sys/health
```

```json
{ "initialized": false, "sealed": true, "standby": true, "version": "1.20.4" }
```

**A new Vault holds nothing and can do nothing.** The data on disk is encrypted with a key that is
itself encrypted, and the pieces needed to reassemble it do not exist yet.

```bash
vault operator init -key-shares=3 -key-threshold=2
```

```
  shares: 3 | threshold: 2
  root token: <REDACTED, 28 chars>
```

**Shamir's secret sharing is the whole design.** The unseal key is split into three shares, any two
of which reconstruct it — so no single person can unseal the server alone, and losing one share is
survivable. The threshold is not advisory:

```
  supply ONE key:
    Sealed             true
    Unseal Progress    1/2

  supply the SECOND key:
    Sealed          false
```

**Write down what `init` printed, once.** Those shares and that root token are the only copies; Vault
does not keep them, and a lost set on a real cluster means unrecoverable data.

## Audit before secrets

```bash
vault audit enable file file_path=/vault/file/audit.log
```

```
Success! Enabled the file audit device at: file/
```

**Enable this before writing the first secret, not after an incident.** Vault will refuse requests
outright if no enabled audit device can be written to, which is a deliberate design choice: it would
rather stop than act unobservably.

## The engine, and the path that is not the path

```bash
vault secrets enable -path=secret -version=2 kv
vault kv put secret/myapp/db username=appuser password='<REDACTED>'
```

```
  secret/      type=kv version=2
  created_time       2026-08-24T02:45:54Z
  version            1
```

Now a policy for an application that should read this one secret and nothing else. The obvious
version:

```hcl title="naive.hcl"
# The path you read and write with the CLI.
path "secret/myapp/*" {
  capabilities = ["read"]
}
```

```
  Error reading secret/data/myapp/db: Code: 403. Errors:
  	* permission denied
```

The fix is in [Where this bit us](#where-this-bit-us), and the audit log is what supplies it:

```hcl title="myapp.hcl"
# KV v2 puts the payload under data/ and the version history under metadata/.
# The CLI hides both; a policy must name them.
path "secret/data/myapp/*" {
  capabilities = ["read"]
}
```

```bash
vault token create -policy=myapp-read -ttl=15m
```

**Probe the boundaries rather than assuming them** — a policy you have only seen succeed is a policy
you have not tested:

```
  read secret/myapp/db          ->  version: 1 | username: appuser
  write secret/myapp/db         ->  403 permission denied
  read  secret/other/db         ->  403 permission denied
  read  metadata for the secret ->  403 permission denied
```

That last one matters: **`secret/metadata/…` is a separate path from `secret/data/…`**, so a token
granted the payload cannot list the version history. Which turns out not to protect the history at
all — see below.

## Pulling instead of being pushed

```python title="app/consumer.py"
client = hvac.Client(url=os.environ["VAULT_ADDR"], token=os.environ["VAULT_TOKEN"])
last = None

while True:
    r = client.secrets.kv.v2.read_secret_version(
        path="myapp/db", mount_point="secret", raise_on_deleted_version=True)
    d, meta = r["data"]["data"], r["data"]["metadata"]
    # Never print the secret. A fingerprint proves it changed without leaking it.
    fp = hashlib.sha256(d["password"].encode()).hexdigest()[:12]
    if fp != last:
        print(f"v{meta['version']} user={d['username']} sha256:{fp}")
        last = fp
    time.sleep(3)
```

**The polling loop is not the interesting part** — a real application fetches on connection failure
or on a lease renewal, not on a timer. What matters is that the credential arrives from the API and
never from the environment or a file.

Rotating twice, as an operator, while the application is running:

```bash
vault kv put secret/myapp/db username=appuser password='<REDACTED>'   # version 2
vault kv put secret/myapp/db username=appuser password='<REDACTED>'   # version 3
```

```
  v1 user=appuser sha256:ae204465780d (first read)
  v2 user=appuser sha256:603ff57e5736 (ROTATED)
  v3 user=appuser sha256:c8d88423e050 (ROTATED)

  app container started at: 2026-08-24 11:48:14, restarts: 0
```

**`restarts: 0` and an unchanged start time are the check.** Three different passwords reached a
process nobody redeployed, reconfigured or signalled. That is the entire claim, and the fingerprints
prove it without a secret ever appearing in a log.

## Verification checklist

- [x] A fresh server reports `initialized: false, sealed: true` and can do nothing
- [x] `operator init` produces **3 shares** with a threshold of **2**
- [x] One key leaves it `Sealed true, Unseal Progress 1/2`; the second unseals it
- [x] The read-only policy allows the read and **denies** write, a sibling path, and the metadata path — all `403`
- [x] A policy naming `secret/myapp/*` is denied, and the audit log shows the request went to `secret/data/myapp/db`
- [x] Three rotations reach the running application with `restarts: 0` and an unchanged start time
- [x] The same read-only token reads **every superseded version**, including passwords already rotated away
- [x] `kv delete` is reversible with `kv undelete`; `kv destroy` is not
- [x] A `20s` token succeeds immediately and fails after 25 seconds
- [x] The audit log contains **0** occurrences of the real password — values are HMAC'd, including the token
- [x] Restarting the container returns it to `sealed: true`, and the application reports `Vault is sealed`
- [x] After unsealing, the application picks up the next rotation **without being restarted**

## Rollback

```bash
podman compose down -v          # containers, and the encrypted file storage
```

Reseal without destroying anything — useful to rehearse before you need it:

```bash
vault operator seal
```

## Where this bit us

**The path you type is not the path you authorise.** A policy granting `secret/myapp/*` produced a
flat `403` for a token that looked correctly scoped. The audit device answered it in one line:

```
  path: secret/data/myapp/db | op: read | error: 1 error occurred:
	* permission denied
```

**KV v2 stores the payload under `data/` and the history under `metadata/`, and the `kv` CLI hides
both.** `vault kv get secret/myapp/db` issues `GET /v1/secret/data/myapp/db`. Policies are written
against API paths, so the convenience of the CLI is exactly what makes the policy wrong. This is also
the argument for enabling the audit device first: **without it the 403 is unexplained, and with it it
is a one-line diagnosis.**

**Rotation does not revoke anything. The old passwords are still readable, by the same token.** After
rotating twice, asking the *read-only application token* for superseded versions:

```
  -version=1 -> v1 readable  sha256:ae204465780d
  -version=2 -> v2 readable  sha256:603ff57e5736
  -version=3 -> v3 readable  sha256:c8d88423e050
```

**All three.** A single `capabilities = ["read"]` on `secret/data/myapp/*` grants every version that
path ever held. So "we rotated the credential" is not a complete incident response — if the reason
for rotating was that the old value leaked, the old value is still sitting in Vault, readable by
anything that could read the new one. The version has to be removed explicitly, and there are two
verbs that look alike and are not:

```
  kv delete -versions=1     ->  v1 NOT readable
  kv undelete -versions=1   ->  v1 readable again          <- a soft delete is reversible
  kv destroy -versions=1,2  ->  v1 NOT readable, v2 NOT readable
```

```
  v1 destroyed=True
  v2 destroyed=True
  v3 destroyed=False
  current_version: 3 | max_versions: 0
```

`delete` marks a version deleted and `undelete` brings it back; only `destroy` removes the data.
**And `max_versions: 0` is the default, meaning unlimited** — every password a secret has ever held
is retained forever unless you set `max_versions` or a `delete_version_after` on the metadata. The
sequence for a leaked credential is therefore rotate, **destroy the leaked version**, then confirm it
is unreadable, and the middle step is the one that gets skipped.

**A short TTL is a real expiry, not a hint.**

```
  immediately:  appuser
  after 25s:    Error making API request.
```

A 20-second token stops working after 20 seconds, with no grace. That is the property that makes
short-lived tokens worth the trouble — a leaked token is worthless within minutes — and it is also
the reason an application needs a renewal or re-auth path rather than a token pasted into an
environment variable at deploy time. **The `VAULT_TOKEN` env var in this lab's compose file is itself
the antipattern the lab is arguing against**, kept only to isolate one variable at a time; AppRole or
Kubernetes auth is what removes it.

**The audit log records everything and reveals nothing.**

```
  occurrences of the real password: 0
  response.data.data: {"password": "hmac-sha256:b313eae3292f04ff…", "username": "hmac-sha256:e143815d…"}
  client token field: hmac-sha256:f79ef32f5241cc6c362600c7ac95
```

Values are HMAC'd with a per-device key, tokens included. **You can prove that a given secret was
read without the log being a place secrets live** — and because the HMAC is stable, you can still
search the log for a *known* value by hashing it the same way. It is a deliberately narrow capability
and a good one.

**Restarting the container seals it again, and everything stops.**

```
  initialized=True sealed=True progress=0/2
```

```
  ERROR VaultDown: Vault is sealed, on get http://vault:8200/v1/secret/data/myapp/db
```

This is correct behaviour and it is also an outage: **every application depending on Vault fails
until two humans supply key shares.** It is why production clusters use auto-unseal against a cloud
KMS or a transit engine, and why a Vault node is a dependency to be designed around rather than
installed and forgotten. The recovery, once unsealed, needed nothing from the application:

```
  v3 user=appuser sha256:c8d88423e050 (ROTATED)
  ERROR VaultDown: Vault is sealed, …          x6
  v4 user=appuser sha256:cebc9e0aec61 (ROTATED)

  restarts of the app container: 0
```

**One log showing the whole argument** — rotation, an outage, recovery and another rotation, with the
process never restarted.

## Follow-ups

- [ ] Replace the hand-issued token with AppRole, so the application authenticates instead of being handed a credential — the step that removes the `VAULT_TOKEN` antipattern this lab still contains
- [ ] Use the database secrets engine to generate per-connection credentials with a lease, which makes rotation automatic rather than an operator action
- [ ] Enable auto-unseal with the transit engine backed by a second Vault, and confirm a restart recovers without human key shares
- [ ] Set `max_versions` and `delete_version_after` on the metadata and confirm old versions age out without anyone running `destroy`
- [ ] Turn on TLS for the listener and drop `tls_disable`, then check what breaks in the client
- [ ] Add a leaked-credential drill to [[k8s-node-drain-replace]]'s neighbourhood as a runbook: rotate, destroy, confirm, then scan history
- [ ] Point [[gitlab-ci-argocd-fastapi-procedure]] at Vault for `GITOPS_TOKEN` instead of a masked CI variable, which is the same argument applied to the pipeline

## Related

[[gitlab-ci-argocd-fastapi-procedure]] — where a masked CI variable does this job today, and what Vault would replace.
[[opensearch-mappings-and-templates]] — a rejected password echoed into a container log, which is the failure mode a secret store exists to prevent.
[[grafana-correlate-three-signals]] — the same `$__env{}` instinct for keeping a credential out of a committed file, one layer up.
[[slo-error-budget-burn-rate]] — a sealed Vault is an outage that spends error budget, which is how to argue for auto-unseal in numbers.
