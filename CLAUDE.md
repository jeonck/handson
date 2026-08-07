# handson — DevOps hands-on experience repository

Markdown + Git + Claude. The entire state of this repository is `.md` files. No database, no server.

There is one goal — **record what you hit once so the next person can reproduce it exactly.** Not a retrospective; an executable document.

## Language

**Everything in this repository is written in English** — documents, frontmatter, templates, skill instructions, and the site. Field notes may arrive in any language; the document produced from them is English. The site is published for an English-reading audience.

## Folder convention

| Folder | Purpose | When to use |
|---|---|---|
| `00-inbox/` | Unsorted field notes | When classification is unclear, park it here |
| `01-install/` | Install guides | Follow it on an empty environment and it comes up |
| `02-runbook/` | Runbooks | The order that makes repeated work come out the same |
| `03-troubleshoot/` | Troubleshooting guides | Branching from symptom down to cause |
| `04-reference/` | Reference | Tool comparisons, config rationale, topic scope |
| `05-daily/` | Daily | Topic of the day, weekly reviews |
| `06-archive/` | Archive | Retired procedures — moved here, never deleted |
| `07-templates/` | Templates | Starting points for new documents (not published to the site) |

## Document format

Every document starts with frontmatter.

```markdown
---
title: Argo CD HA install with Helm
date: 2026-08-07
domain: install          # inbox | install | runbook | troubleshoot | reference | daily | archive
tags: [gitops, cd]
stack: [kubernetes, argocd, helm]
summary: One-line summary. Appears verbatim on the site card.
source: handson          # handson | daily-topic | weekly-review | standardize
env: Kubernetes 1.31 (EKS) · Helm 3.16
verified: 2026-08-07     # the day this procedure actually ran
duration: 40–60 min
risk: medium             # low | medium | high
---
```

Rules:

- **Filenames are lowercase kebab-case ASCII**, extension `.md`. The filename is both the `[[wikilink]]` target and the URL.
- `summary` is mandatory. The site's card preview uses it.
- `stack` holds lowercase kebab-case tool names. The site's stack axis and search use it.
- **`verified` is only ever a day it actually ran.** Never guess. If that value is false, every freshness number on the site is meaningless. With no basis, leave it empty.
- `risk`: `low` = easy to undo, no production impact / `medium` = can affect service, rollback exists / `high` = includes a step that cannot be undone.
- Dates are always absolute `YYYY-MM-DD`. No relative expressions like "last week".
- Follow-ups go under a `## Follow-ups` heading as `- [ ] text 📅 YYYY-MM-DD` — that heading is what makes the site count them as open work rather than as a verification checklist.
- Links are `[[filename]]` without the extension. Pointing at a document that does not exist yet is fine — it marks the writing queue.

## What a procedure document must contain

`install` and `runbook` documents are incomplete without all three.

1. **Verification checklist** — the definition of "it worked", as checkboxes.
2. **Rollback or abort criteria** — where you go back to when it fails.
3. **Where this bit us** — only traps actually hit. Never imagined.

`troubleshoot` documents keep the symptom → branch → action shape, with a check command attached to each cause.

## Writing commands

- Keep the form actually typed. Smoothing it into something that behaves differently is not allowed.
- Replace environment-specific values (host, account, region, ARN, IP) with `<PLACEHOLDER>` or a variable.
- **Never keep credentials.** Tokens, passwords, and keys become `<REDACTED>`.
- Tag code blocks with a language (`bash`, `yaml`). The site counts lines in `bash` blocks to tell a document you follow from a document you read.

## Skills

`.claude/skills/` is the entire behaviour of this repository. Markdown instructions, not code.

- `handson` — sort a lump of field experience into install / runbook / troubleshooting and document it
- `daily-topic` — on days with no notes, build a 30-minute lab from one current DevOps topic
- `weekly-review` — cross-read the last 7 days (observe only, never edit documents)
- `standardize` — promote scattered records into a standard runbook

## Never

- **Delete** a document. Retired procedures move to `06-archive/`.
- Write into `site/`, `scripts/`, or `.github/` — those are framework, and skills do not touch them.
- Create an `.md` without frontmatter. The build skips it.
- **Present a command you never ran as verified.** If it came from official documentation, say so.
- Invent a "common problem" you never actually hit.

## Build

`node scripts/build.mjs` → static site in `dist/`. GitHub Actions runs it on every push.
The site is <https://handson.metacog.co.kr>.
