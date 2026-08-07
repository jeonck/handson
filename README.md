# 🧰 handson

**Install guides, runbooks, and incident playbooks.** A repository for recording what you hit once in the field so the next person can reproduce it exactly. No database, no server — the entire state is `.md` files in this repository.

🌐 **<https://handson.metacog.co.kr>**

---

## What this is

Three days after the work, the memory is gone. So two things are bolted on.

1. **A static site** — publishes the repository's markdown as categories, stacks, search, and a re-verification dashboard.
2. **An on-demand agent** — a button on the site opens a GitHub issue; Actions then runs Claude, which writes the document and commits it.

## How it runs

```
Click "Capture" on the site
   ↓  (zero tokens in the browser — it is just an issue link)
GitHub issue created  ·  label: handson
   ↓
Actions: owner check → skill routing → Claude Code runs (the OAuth token lives only in runner secrets)
   ↓
.md committed & pushed  →  result commented on the issue, which auto-closes
   ↓
Pages workflow rebuilds  →  live on the site
```

**Days with no notes do not stay blank.** At 06:00 KST a scheduled workflow inspects the last 26 hours of commits.

- Field notes written by a human → **it does nothing.**
- None → it picks one current DevOps topic within the scope in `04-reference/topics.md` and commits a **30-minute lab** to `05-daily/`.

Documents the agent produced (`source: daily-topic` and friends) do not count as notes. Letting the agent's own writing suppress it the next morning kills the loop.

## Folders

| Folder | Purpose |
|---|---|
| `00-inbox/` | Unsorted field notes |
| `01-install/` | Install guides |
| `02-runbook/` | Runbooks |
| `03-troubleshoot/` | Troubleshooting guides |
| `04-reference/` | Tool comparisons, config rationale, topic scope |
| `05-daily/` | Topic of the day, weekly reviews |
| `06-archive/` | Retired procedures (moved, never deleted) |
| `07-templates/` | Document templates |

## What this treats differently

The difference from a normal wiki is three frontmatter fields.

| Field | Why |
|---|---|
| `env` | Which versions it was verified against. Without it, a procedure is something that "used to work" |
| `verified` | **The day it actually ran.** The dashboard uses it to pick what needs re-verification |
| `risk` | Whether the work can be undone — something you need to know before opening the procedure |

Procedure documents whose `verified` is over 120 days old, or empty, appear on the dashboard's first screen. **A procedure that is wrong is more dangerous than one that does not exist.**

## Skills

| Skill | What it does | Trigger |
|---|---|---|
| `handson` | Sorts tangled field notes into install / runbook / troubleshooting and documents them | issue · local |
| `daily-topic` | One current topic as a 30-minute lab (sources required, local-only, no repeats within 30 days) | issue · 06:00 KST on days with no notes |
| `weekly-review` | Cross-reads the last 7 days for repeated patterns | issue · Sunday 07:00 KST |
| `standardize` | Promotes scattered records into a standard runbook | issue · monthly |

`.claude/skills/` is the whole behaviour — markdown instructions, not code.

## Using it

**From the site** — top-right `🛠 Capture` → pick a request → file the issue. It shows up on the site a few minutes later.

**From Claude Code locally** — open the repository and just say it.

```
write up the argocd install i just did
give me a topic of the day
weekly review
```

**From Obsidian** — open this folder as a vault and the `[[links]]` work as-is.

## Local preview

```bash
npm install
node scripts/build.mjs
npx serve dist
```

## Setup

One-time setup lives in [SETUP.md](SETUP.md) — OAuth token, Pages, custom domain.

## Being honest about it

Material the agent produced is **not a verified procedure.** It was synthesized from official documentation, so it stays in `05-daily/` with `verified` empty. That separation holds until a human runs it and promotes it into `01-install/` or `02-runbook/`. Break that boundary and this becomes just another unverified wiki.

The publishing and trigger layers are adapted from [jeonck/secbrain](https://github.com/jeonck/secbrain), reworked for hands-on documentation.

## License

MIT for the framework. Document contents belong to their author.
