---
title: MarkItDown — documents to Markdown, and the two failures that arrive silently
date: 2026-08-21
domain: install
tags: [ai, llm, python, documents, data-quality]
stack: [markitdown, python, openpyxl, python-pptx, pdfminer]
summary: One call converts xlsx, docx, pptx and pdf to Markdown, verified on files built for the purpose. Two results deserve a guard rather than trust — a PDF with no text layer returns an empty string with no error and exit code 0, and a PowerPoint's private speaker notes are included in the output by default.
source: handson
env: markitdown 0.1.7 with the [all] extra · openpyxl 3.1.5 · python-pptx 1.0.2 · pdfminer.six 20260107 · pandas 3.0.5 · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-21
verifiability: lab
duration: 20–30 min
risk: low
---

> **Verified 2026-08-21.** Every block of Markdown below is what `markitdown` actually returned for
> a file built specifically to test that format. The empty result in
> [Where this bit us](#where-this-bit-us) is a real conversion, not a contrived one.

Feeding documents to a model means getting text out of them first, and that usually becomes a pile
of per-format extraction scripts. `markitdown` replaces the pile with one call that returns
Markdown — headings, tables and lists preserved, so the structure survives into the prompt:

```python
from markitdown import MarkItDown

md = MarkItDown()
result = md.convert("quarterly_report.xlsx")
print(result.text_content)
```

`result.markdown` is the same string as `result.text_content` — the two attributes are
interchangeable, and `result.title` was `None` for every file tried here.

## Install — the one-liner does not work on a bare install

```bash
pip install markitdown        # ← not enough
```

**A plain install converts none of the formats the example shows.** All five test files failed:

```
FileConversionException: File conversion failed after 1 attempts:
 - XlsxConverter threw MissingDependencyException with message: XlsxConverter recognized the
   input as a potential .xlsx file, but the dependencies needed to read .xlsx files have not
   been installed. To resolve this error, include the optional dependency [xlsx] or [all]...
```

That is a good error — it names the file type, the missing extra, and the exact command. Install
what you actually need:

```bash
pip install 'markitdown[all]'          # everything
pip install 'markitdown[xlsx,pdf]'     # or just the formats you handle
```

`[all]` pulls the real workhorses: `openpyxl`, `python-pptx`, `pdfminer.six`, and `pandas`.

## What each format turns into

### XLSX — one heading per sheet

```python
md.convert("docs/quarterly_report.xlsx").text_content
```

```markdown
## Q1
| region | units | revenue | Unnamed: 3 | total |
| --- | --- | --- | --- | --- |
| EMEA | 120 | 24000 | NaN | NaN |
| APAC | 95 | 19500 | NaN | NaN |
| AMER | 210 | 42000 | NaN | NaN |

## Notes
| APAC excludes returns. |
| --- |
```

Every sheet becomes an `##` heading and a table, which is exactly the shape a model reads well.
**Two artifacts in that output are worth seeing before you trust it.** The source sheet had a
`total` column holding `=SUM(C2:C4)`; the formula is gone and its cell reads `NaN` — **formulas are
not evaluated**, so a spreadsheet whose numbers live in formulas converts to a table of blanks. And
the empty spacer column arrived as `Unnamed: 3` with `NaN` cells, a `pandas` default leaking into
the Markdown.

### DOCX — headings and lists survive, the table header does not

```markdown
# Quarterly Review

Revenue rose 12% against plan.

## By region

|  |  |
| --- | --- |
| region | revenue |
| EMEA | 24000 |
| APAC | 19500 |
```

Heading levels and bullets come through cleanly. **The table's header row is emitted empty** — `|  |  |`
— and the real headers drop into the body as an ordinary row. A model reading this sees a
column-less table whose first row happens to contain labels, which is fine for a human and lossy
for anything doing lookups by column name.

### PPTX — slides, and the speaker notes with them

```markdown
<!-- Slide number: 1 -->
# Q1 Results
Revenue +12%
APAC flat

### Notes:
Do not share externally.
```

Slide numbers arrive as HTML comments and the title becomes an `#` heading. **The speaker notes are
included** — and the notes on that slide say `Do not share externally.` See
[Where this bit us](#where-this-bit-us); this is the finding to act on before pointing this at a
shared drive.

### PDF — text only, layout flattened

```markdown
Quarterly Review

Revenue rose 12% against plan.

EMEA 24000    APAC 19500    AMER 42000
```

The text layer comes out intact. Column positions do not survive as structure — the three regions
were laid out as spatially separated cells and arrive as one run of spaced text. Fine for prose,
lossy for a PDF whose meaning is in its table grid.

## The CLI

```bash
markitdown docs/q1_deck.pptx
markitdown docs/q1_deck.pptx > deck.md
```

Same converter, writing to stdout — which is what makes the empty-output case below dangerous in a
shell pipeline.

## Verification checklist

- [x] A bare `pip install markitdown` fails on **all** of xlsx/docx/pptx/pdf, naming the extra to add
- [x] With `[all]`, each of the four formats converts and returns non-empty Markdown
- [x] XLSX sheets become `##` headings; a `=SUM(...)` formula does **not** appear in the output
- [x] DOCX preserves heading levels and bullets, and emits an **empty** table header row
- [x] PPTX output contains the slide's private speaker notes
- [x] A PDF with no text layer returns `''` — **built a text-free PDF on purpose to confirm**
- [x] The CLI exits `0` on that same PDF, writing one byte and nothing to stderr

## Rollback

```bash
rm -rf .venv docs
```

## Where this bit us

**A PDF with no text layer converts "successfully" to nothing.** A scanned page — or, as here, a PDF
built from drawn lines with no text objects — produces no error at all:

```python
r = md.convert("docs/report_scanned.pdf")
repr(r.text_content)   # ''
len(r.text_content)    # 0
```

The CLI is worse, because a pipeline reads its exit code:

```bash
markitdown docs/report_scanned.pdf > out.md; echo "exit=$?"
```

```
exit=0  bytes=1  stderr=0
```

**Exit `0`, empty file, silence.** A batch job over a directory of mixed documents will report
complete success while quietly feeding a model nothing for every scanned page in the set. `[all]`
does not fix this — OCR is a separate concern, not an extra. The guard is one line, and it belongs
in any loop that touches PDFs:

```python
text = md.convert(path).text_content
if not text.strip():
    raise ValueError(f"{path}: converted to zero characters — scanned or image-only?")
```

**Speaker notes leave the deck.** `Do not share externally.` was written into the slide's notes
field, exactly where people put the things not meant for the audience, and it appears in the
converted Markdown under `### Notes:`. Nothing here is a bug — notes are content, and including
them is defensible — but **a pipeline that converts a shared drive and posts the result to an LLM is
exfiltrating the one part of each deck the author deliberately kept off the slide.** Strip the
`### Notes:` sections, or accept that decision knowingly.

**Formula-driven spreadsheets convert to blanks.** `NaN` where `=SUM(C2:C4)` used to be is the
visible symptom; the invisible one is a financial model whose every derived figure is a formula
converting to a table of empty cells with correct-looking headers. Check a converted spreadsheet for
`NaN` before assuming the numbers came across.

## Follow-ups

- [ ] Pair this with OCR for image-only PDFs — the empty-string case above is a hole, not a quirk, and the guard only detects it
- [ ] Strip `### Notes:` sections in the pptx path by default, and make including them the explicit choice
- [ ] Try `MarkItDown(llm_client=..., llm_model=...)`, which uses a model to describe embedded images — a second use for the Gemini key in [[litellm-streamlit-chat]]
- [ ] Run it over a directory of real documents and count how many convert to under, say, 50 characters — that number is the actual quality of the corpus
- [ ] Feed the converted Markdown to the agent in [[pydantic-ai-structured-output]], so the extraction and the typed output are one pipeline

## Related

[[pydantic-ai-structured-output]] — the natural next stage: typed extraction from the Markdown this produces.
[[litellm-streamlit-chat]] — where converted documents would be pasted as context, and the key that could drive MarkItDown's image descriptions.
[[dbt-duckdb-local]] — the same lesson from the data side: a step that reports success while publishing wrong or empty output is the expensive kind.
