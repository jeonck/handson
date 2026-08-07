---
name: daily-topic
description: Picks one current DevOps topic inside the declared scope and builds hands-on material that can be followed in 30 minutes. Use for "topic of the day" requests, issues labelled daily-topic, and the scheduled run on days with no field notes.
---

# Daily Topic — one topic a day

This skill exists so that a day with no notes does not stay blank. **It does not run on days when the user recorded something themselves** — the scheduled workflow checks the day's commits first.

What you produce is **hands-on material, not a news summary.** A piece that ends when you finish reading it has failed.

Write everything in English. This repository publishes an English site.

## Rules (not negotiable)

1. **Cite why the topic was chosen.** "It's trending" is not a reason. Link release notes, official docs, or SIG discussion, with a date.
2. **Only commands that actually run.** Do not invent them. Use procedures confirmed in official documentation, and mark any step you could not confirm as such.
3. **It has to finish locally.** kind / minikube / docker / local CLI. Never choose a lab that needs a cloud account or spend.
4. **State versions.** Chart, CRD, and image tags go in as fixed values, alongside how to find the current tag.
5. **Say when you do not know.** Do not fill a blank with a plausible sentence.

## Procedure

### 1. Read the scope

`04-reference/topics.md` — `topics`, `Excluded`, `Baseline environment`. If the file is missing, infer from the `stack` values of recent documents in `01-install/`, `02-runbook/`, and `03-troubleshoot/`, and say at the bottom of the material that the scope file was absent and the scope was inferred.

### 2. Rule out what is already covered

```
titles and stack of the last 30 files in 05-daily/
stack across 01-install/ · 02-runbook/ · 03-troubleshoot/
```

**Do not pick a topic covered within the last 30 days.** The same tool from a genuinely different angle (install → upgrade → incident response) is allowed, but say in the body what is different.

### 3. Find candidates

One or two WebSearch calls per topic area. Look at recent releases, official blogs, and project documentation changes. Shortlist three to five and **confirm the primary source with WebFetch**. Do not write from search snippets — their dates are frequently wrong.

Selection criteria, in priority order:

1. Does it **touch the user's existing documents** (same stack, or a replacement for one)?
2. Can it be verified in a 30-minute lab?
3. Will knowing it now matter next quarter?

### 4. Write it

`05-daily/YYYY-MM-DD-<topic-slug>.md`, from `07-templates/daily.md`.

```markdown
---
title: Topic of the day — <what it does>
date: <today>
domain: daily
tags: [daily, <area>]
stack: [<tools covered>]
summary: <one sentence: what you practise and what bites.>
source: daily-topic
---

## Why this topic
<Concept, plus source links with dates. Use a table where a comparison fits.>

## 30-minute lab
<Commands that run when pasted. Half a line per step on why that step exists.>

### Verify
<The command that confirms "it worked", and the expected output.>

### Clean up
<How to tear the lab down. Without this, nobody does it a second time.>

## Traps
<What you will definitely hit on the first attempt. One paragraph each.>

## If we applied this here
<Link existing documents with [[wikilinks]] and name what would actually block us.>

## Follow-ups
- [ ] ...
```

### 5. Link

Attach `[[wikilinks]]` to existing documents sharing a `stack`. Material that does not connect back to the repository is just a scraped tutorial.

## Do not

- Choose a lab that costs cloud money
- Write "just do this" for a command you never ran — if it came from official documentation, say so
- Put the topic of the day in a real folder like `01-install/` — it stays in `05-daily/` until a human verifies it
- Repeat a topic within 30 days

## Report at the end

- The topic you chose and **why that one** (one line each for the candidates you dropped)
- Source links with dates
- **Steps you could not run and took from documentation only** — the user verifies those first
