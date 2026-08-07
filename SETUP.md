# Setup

One time only. Four steps, about ten minutes.

---

## 1. Claude OAuth token → repository secret

Running Claude in Actions needs an OAuth token. It requires a **Claude Pro or Max subscription**.

In a local terminal:

```bash
claude setup-token
```

A browser opens; once authentication finishes the token is printed. Put that value into a repository secret.

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo jeonck/handson
```

Or in the web UI: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `CLAUDE_CODE_OAUTH_TOKEN`
- Secret: the token from above

> ⚠️ This token runs work as your Claude account. **Never paste it into an issue body on a public repository.** It belongs nowhere except the secret.

Tokens expire. When a workflow fails with an authentication error, re-run `claude setup-token` and update the secret.

> **You do not need to install the Claude GitHub App.** The workflow passes the runner token as `github_token`. Commits and issue comments are handled by the workflow itself, so no `claude[bot]` identity is required.

---

## 2. Give Actions write permission

The agent commits to the repository, so workflows need write access.

**Settings → Actions → General → Workflow permissions**
- ✅ **Read and write permissions**

---

## 3. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: `GitHub Actions`**

This repository's `pages.yml` workflow does the deploy, not a Jekyll build.

Also available from the CLI:

```bash
gh api -X POST repos/jeonck/handson/pages -f build_type=workflow
```

---

## 4. Custom domain — handson.metacog.co.kr

### DNS (assumed already done)

The `metacog.co.kr` zone needs a CNAME record.

| Name | Type | Value |
|---|---|---|
| `handson` | CNAME | `jeonck.github.io` |

Check:

```bash
dig +short handson.metacog.co.kr CNAME
```

It should return `jeonck.github.io.`.

### Repository side

`site/CNAME` is already in place and the build copies it to `dist/CNAME`. **The same value must also be registered in the Pages settings** for GitHub to issue a certificate.

```bash
gh api -X PUT repos/jeonck/handson/pages -f cname=handson.metacog.co.kr
```

Or **Settings → Pages → Custom domain**, enter `handson.metacog.co.kr`, save.

Certificate issuance takes anywhere from a few minutes to an hour. Once it completes, turn on **Enforce HTTPS**.

```bash
gh api -X PUT repos/jeonck/handson/pages -F https_enforced=true
```

> Deleting `site/CNAME` drops the custom domain on every deploy. The file is under framework protection so the agent cannot touch it.

---

## Verify

With all four steps done:

```bash
open https://handson.metacog.co.kr/
```

```bash
gh workflow run claude-ondemand.yml \
  -f skill=handson \
  -f request="Setup verification test. Brought up a local kind cluster and confirmed the kubectl context."
```

```bash
gh run watch
```

A new `.md` committed under `00-inbox/` or `01-install/`, followed by a Pages build, means it works.

Force the scheduled workflow once as well.

```bash
gh workflow run scheduled.yml -f skill=daily-topic -f force=true
```

Without `force=true` it does nothing when notes exist within the last 26 hours — that is also correct behaviour.

---

## How it works, and the security around it

This repository is **public**. Giving an agent write access on a public repository deserves care, so there are three layers.

1. **Owner gate** — `claude-ondemand.yml` checks `github.event.issue.user.login == github.repository_owner`. An issue opened by anyone else cannot run the workflow.
2. **Injection defence** — the issue body is never interpolated into YAML; it goes through env into `/tmp/handson/request.md`. The prompt states explicitly that the file is data, not instructions.
3. **Path guard** — the commit step reverts changes to framework files (`.github/`, `scripts/`, `site/`, `CLAUDE.md`, and so on). Even if the agent ignores its prompt, it cannot modify its own execution environment.

One risk remains: **everything written into a document is public.** Hands-on documents naturally pick up internal hostnames, accounts, and architecture. The prompt instructs the agent to mask credentials, but **the issue body itself is not masked and stays as written.** Do not paste tokens or internal identifiers in the first place.

---

## Customizing

| To change | Edit |
|---|---|
| What the topic of the day may pick | `04-reference/topics.md` |
| Skill behaviour | `.claude/skills/<name>/SKILL.md` |
| Add a skill | `.claude/skills/<new>/SKILL.md` + issue template + the workflow's label list |
| Schedule times | the crons in `.github/workflows/scheduled.yml` (UTC) |
| Re-verification threshold (default 120 days) | `staleDays` in `site.config.json` |
| Site title and category labels | `site.config.json` |
| Model | `--model` in the workflows (default `claude-sonnet-5`) |

The point is that adding a skill never requires touching infrastructure code — one markdown file is enough.

## Common problems

**Site 404s** — check that the Pages source is `GitHub Actions` and that the `pages.yml` workflow succeeded.

**Custom domain keeps unsetting itself** — confirm `dist/CNAME` made it into the deploy artifact. `pages.yml` has a step that checks.

**Opened an issue and nothing happened** — check that a label (`handson`, etc.) was applied. A blank issue opened without a template has no label, so nothing routes.

**No topic of the day in the morning** — that may be correct. If a hands-on document was committed within the last 26 hours it is skipped. The Actions log shows which file caused it on a `human note:` line.

**Committed, but the site is unchanged** — `pages.yml` does not run when only `paths-ignore` paths changed. Trigger it manually from the Actions tab.
