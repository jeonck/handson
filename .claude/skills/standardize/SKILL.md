---
name: standardize
description: Promotes the same work scattered across several documents into one standard runbook, and turns troubleshooting records into reusable procedures. Use for "standardize this" or "make this a runbook" requests, issues labelled standardize, and the monthly scheduled run.
---

# Standardize — scattered experience into a procedure

Something you have hit three times should be a procedure. This skill takes **only existing documents** as input and produces a standard runbook. It invents no new facts.

Write in English.

## Promotion criteria

Not everything gets standardized. One of these must hold.

- The same work appears in **two or more separate documents**
- The same cause has been recorded **twice or more**
- Notes on the same subject have piled up in `00-inbox/`

If nothing meets the bar, **create nothing and report that.** A procedure nobody asked for is a procedure nobody reads.

## Procedure

### 1. Find candidates

```
group documents by overlapping stack values
Grep for commands that repeat across titles and bodies
read everything in 00-inbox/
```

### 2. Pick one

The one that recurred most and is most likely to recur again. **One promotion at a time.**

### 3. Read the sources

Read every source document to the end. Do not work from summaries — with procedures, the substance is usually in the detail.

When two documents do **the same step differently**, that is itself a finding. Do not pick a winner arbitrarily; record both and mark it as needing confirmation.

### 4. Write the standard runbook

`02-runbook/<task>.md`, from `07-templates/runbook.md`.

Anything the sources cannot fill, **leave empty and flag it.**

```markdown
> ⚠️ This runbook was synthesized from <path1> and <path2>.
> Nobody has executed it in this order yet. Fill in `verified` after the first real run.
```

Leave `verified` **empty**. A synthesized procedure is not a verified procedure. Blur that line and every freshness number on the site becomes a lie.

### 5. Tidy the sources

- **Do not delete source documents.** Add a `[[link]]` to the new runbook at the top of each.
- If a note in `00-inbox/` has been fully absorbed, **move** it to `06-archive/` (move, not delete).
- Link back from the new runbook to every source — the provenance has to be traceable.

## Report at the end

- The work you promoted and the new document path
- Every source path used in the synthesis
- **Steps where the sources disagreed** — the user has to decide. Always call these out
- Candidates you passed over for not meeting the bar (one line each, if any)
