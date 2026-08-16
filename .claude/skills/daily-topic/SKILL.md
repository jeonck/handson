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
3. **It has to finish in the environment this run is actually in** — which is not always the same environment. Probe before choosing a topic (step 0). kind / minikube / docker / local CLI only; never a lab that needs a cloud account or spend.
4. **State versions.** Chart, CRD, and image tags go in as fixed values, alongside how to find the current tag.
5. **Say when you do not know.** Do not fill a blank with a plausible sentence.

## Procedure

### 0. Establish the mode, and check the backlog first

**Both of these happen before you choose a topic**, because both change what you should choose.

**Probe what this run can execute.** An interactive run and a scheduled run are different machines
with different permissions. Do not assume; find out, with the cheapest command of each kind:

```bash
docker ps                 # read-only — often allowed where `docker run` is not
kind get clusters         # the one that matters; this is what a lab actually needs
kubectl version --client
```

- All three work → **`lab` mode.** Build a lab, run it, and write from what you saw.
- Any of them blocked, missing, or waiting on an approval nobody will answer → **`notes` mode.**

`notes` mode is a legitimate output, not a degraded one — but it is a *different* output, and the
rest of this skill branches on it. A scheduled run with no user in the loop is normally `notes`.

**Then count the backlog.** How many documents in `05-daily/` are tagged `not-executed` and still
have an open follow-up asking for someone to run them?

```bash
grep -l 'not-executed' 05-daily/*.md | wc -l
```

- **3 or more, and this run is in `notes` mode → produce nothing.** Stop here and report the
  backlog instead. Six unexecuted labs in a row is not six days of work, it is one capacity problem
  restated six times, and adding a seventh makes the repository less useful rather than more.
- 3 or more, and this run is in `lab` mode → **execute the oldest one in the backlog instead of
  picking a new topic.** Correct that document from what you observe, drop the `not-executed` tag,
  and close its follow-up. Clearing the backlog outranks a new topic every time.
- Fewer than 3 → continue.

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

**In `notes` mode, criterion 2 inverts.** You cannot run anything, so pick a topic whose value
survives not being run: a changed default, a deprecation, a flag that moved, a version skew that
affects a document already in this repository. A topic whose whole point is watching something work
is the wrong choice for a run that cannot watch it — writing it up unrun produces a tutorial nobody
has any more reason to trust than the upstream docs it was copied from.

### 4. Write it

`05-daily/YYYY-MM-DD-<topic-slug>.md`, from `07-templates/daily.md`.

**In `notes` mode, three things are mandatory** — the reader has to know from the card, not from
paragraph four:

- `tags` includes `not-executed`. This is what the backlog check in step 0 counts, and what a weekly
  review can find.
- `summary` says it was not executed, in the summary itself. The summary is the site's card text; a
  disclosure that only appears in the body does not reach anyone scanning.
- The lab section is headed **"Prepared lab — not executed"** rather than "30-minute lab", with a
  banner naming what blocked it and where each command came from.

And one thing is forbidden: **do not write an `### Verify` section with an "Expected:" output you
did not see.** In `notes` mode write the check and leave the expected output blank, or state which
line of the upstream documentation the expectation comes from. A predicted output presented in the
same shape as an observed one is the defect this repository spends most of its effort removing.

In `lab` mode, the Verify step must be one you watched succeed — and, where breaking the thing on
purpose is cheap, one you also watched fail. Paste both.

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

## Follow-ups in `notes` mode

**One follow-up, dated, naming the smallest slice that would settle the topic** — not "run the lab
above end to end". That wording is what accumulated six identical open items between 2026-08-10 and
2026-08-15, each true, none actionable enough to pick up in a spare twenty minutes.

```markdown
- [ ] Run just step 2 on a kind cluster and confirm the `Resize` condition appears 📅 <date>
```

If the previous `not-executed` document already carries an equivalent follow-up, **do not add
another**. The backlog is the `not-executed` tag, counted in step 0. A second copy of the same
sentence tracks nothing.

## Do not

- Choose a lab that costs cloud money
- Write "just do this" for a command you never ran — if it came from official documentation, say so
- Put the topic of the day in a real folder like `01-install/` — it stays in `05-daily/` until a human verifies it
- Repeat a topic within 30 days
- **Publish a `notes`-mode document when three or more are already outstanding.** Step 0 is a stop, not a warning
- **Show an expected output you did not observe.** Blank is honest; predicted-and-formatted-as-observed is not
- Let a `notes`-mode document reach `05-daily/` without the `not-executed` tag and without saying so in `summary`

## Report at the end

- **Which mode this run was in, and the probe output that decided it** — first line, before anything else
- The backlog count from step 0, and whether it stopped production or redirected it
- The topic you chose and **why that one** (one line each for the candidates you dropped)
- Source links with dates
- **Steps you could not run and took from documentation only** — the user verifies those first
