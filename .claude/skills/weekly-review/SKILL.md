---
name: weekly-review
description: Cross-reads the last 7 days of hands-on documents to surface repeated failures, missing procedures, and stale verification. Use for "weekly review" requests, issues labelled weekly-review, and the Sunday scheduled run.
---

# Weekly Review — reading across the week

Individual documents are each correct. The problem is **what only appears when you lay several of them on top of each other.** This skill creates no new knowledge; it finds patterns among documents that already exist.

Write in English.

## Input

Every `.md` created or modified in the last 7 days, plus the `verified` dates across the whole repository.

## Procedure

### 1. Collect the week

Documents in `00-inbox/` … `05-daily/` whose `date` falls in the last 7 days. If there are none, say so and move to step 2 — acknowledging an empty week is also a review.

### 2. Look for five things

**① Repeats** — the same cause appearing in two or more separate documents is a structural problem, not an isolated incident. Name the documents with their paths.

**② Work handled without a procedure** — something in `03-troubleshoot/` whose response procedure is missing from `02-runbook/`. You will do that work again.

**③ Stale verification** — procedure documents whose `verified` is over 120 days old or empty. Oldest first, at most five.

**④ Dropped follow-ups** — tasks still open (`- [ ]`) with a 📅 date in the past.

**⑤ Isolated documents** — documents with no `[[link]]` attached. A document reachable only by search is effectively absent.

### 3. Write it

`05-daily/YYYY-MM-DD-weekly.md`:

```markdown
---
title: Weekly review <YYYY-MM-DD>
date: <today>
domain: daily
tags: [weekly]
stack: []
summary: <the single most important finding of the week, in one sentence.>
source: weekly-review
---

## What the week left behind
<Document count and category spread. Not only numbers — one paragraph on what kind of week it was.>

## What repeated
<② the same cause twice or more — cite the evidence documents as [[links]].>

## Should become a procedure
<Troubleshooting with no matching runbook. "None" if there is none.>

## Due for re-verification
| Document | Last verified | Age |
|---|---|---|

## Follow-ups that slipped
- [ ] <verbatim, with the document it came from>

## Next week
<Three or fewer. No resolutions without evidence.>
```

### 4. Do not

- **Do not edit documents.** A review observes. Improving procedures is the `standardize` skill's job.
- Do not manufacture a pattern that is not there. With two documents in the week, "no pattern" is the correct answer.
- Do not write praise or encouragement.

## Report at the end

- How many documents you analysed
- How many patterns you found, with the evidence path for each
- **The single most dangerous item due for re-verification** (high risk and old)
