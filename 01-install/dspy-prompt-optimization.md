---
title: DSPy — the prompt it writes for you, measured before and after compiling
date: 2026-08-21
domain: install
tags: [ai, llm, python, prompt-engineering]
stack: [dspy, gemini, python, python-dotenv]
summary: A signature instead of a prompt string, run against Gemini. The concrete effect is shown by rendering the exact messages DSPy sends — 2 messages and 582 characters before compiling, 10 and 1020 after, with the examples injected as real conversation turns rather than pasted text. The accuracy comparison is written and shipped but not yet run: the Gemini free tier ran out.
source: handson
env: dspy 3.3.1 · litellm 1.97.0 · python-dotenv · Python 3.13.0 on macOS 14.7.5 · Gemini via GEMINI_API_KEY
verified: 2026-08-21
verifiability: partial
verifiability-note: The install, the signature/Predict round trip against Gemini, and the rendered before/after prompts were all verified — the prompt rendering needs no API calls and is fully reproducible. The baseline-versus-compiled accuracy measurement in experiment.py was NOT completed: the Gemini free-tier quota was exhausted partway through and the backoff gave up. Numbers for it are deliberately absent rather than estimated.
duration: 25–40 min
risk: low
---

> **Verified 2026-08-21, except the accuracy table.** The prompt renderings below come from a script
> that makes no API calls, so they reproduce exactly. The one live Gemini result quoted is real. The
> before/after **accuracy** numbers are missing on purpose — see
> [What is not measured here](#what-is-not-measured-here).

A production prompt is usually a long string with hand-picked examples pasted into it, and it breaks
when the model changes. DSPy replaces the string with a **signature** — the fields, their types and
what they mean — and generates the prompt itself:

```python
class Triage(dspy.Signature):
    """Assign a support ticket a priority."""
    ticket: str = dspy.InputField()
    priority: str = dspy.OutputField(desc="one of P1, P2, P3")

predict = dspy.Predict(Triage)
predict(ticket="I was double-charged on my invoice this month.").priority
```

```
P2
```

**That answer is wrong for this company**, which is the point of the whole exercise below.

## Install

```bash
pip install dspy python-dotenv
```

```
dspy       3.3.1
litellm    1.97.0
```

DSPy calls providers through `litellm`, so the model string is the same one
[[litellm-streamlit-chat]] uses, and the key comes from the same `.env`:

```python
from dotenv import load_dotenv
load_dotenv()
import dspy

dspy.configure(lm=dspy.LM("gemini/gemini-3.6-flash", max_tokens=120, cache=False))
```

`cache=False` matters while measuring anything — DSPy caches identical calls, and a cached second
run of an evaluation reports the first run's numbers instantly.

## The task: a rule the model cannot guess

Optimization only shows up on a task where the model's prior is wrong. This support desk has a house
convention that is deliberately *not* the industry default:

| Ticket is about | Priority here |
|---|---|
| billing, refunds, invoices | **P1** — money first |
| crashes, outages, data loss | **P2** |
| feature requests, how-to, praise | **P3** |

Asked cold, Gemini put a double-charged invoice at **P2** — sensible in general, wrong here. No
wording of the signature fixes that, because the rule lives in the company, not in the language.
Examples are the only way to communicate it, and choosing them is exactly what DSPy automates.

## The concrete effect: the prompt it builds

This is the part worth seeing, and it needs **no API calls** — DSPy's adapter can render the exact
messages it would send:

```python title="dspy-prompt-diff.py"
import dspy
from dspy.teleprompt import LabeledFewShot
from dspy.adapters import ChatAdapter

def render(prog, label):
    msgs = ChatAdapter().format(prog.signature, prog.demos, {"ticket": "My card was charged twice."})
    print(f"{label}: {len(msgs)} messages, {sum(len(m['content']) for m in msgs)} chars")
    for m in msgs:
        print(f"--- {m['role']} ---\n{m['content']}")

base = dspy.Predict(Triage)
render(base, "BEFORE compiling")

compiled = LabeledFewShot(k=4).compile(dspy.Predict(Triage), trainset=train)
render(compiled, "AFTER LabeledFewShot")
```

**Before compiling — 2 messages, 582 characters, 0 demos:**

```
--- system ---
Your input fields are:
1. `ticket` (str):
Your output fields are:
1. `priority` (str): one of P1, P2, P3
All interactions will be structured in the following way, with the appropriate values filled in.

[[ ## ticket ## ]]
{ticket}

[[ ## priority ## ]]
{priority}

[[ ## completed ## ]]
In adhering to this structure, your objective is:
        Assign a support ticket a priority.
--- user ---
[[ ## ticket ## ]]
My card was charged twice.

Respond with the corresponding output fields, starting with the field `[[ ## priority ## ]]`,
and then ending with the marker for `[[ ## completed ## ]]`.
```

**That system prompt was never written by hand.** The field list, the `[[ ## marker ## ]]` protocol
and the closing instruction are generated from the signature — which is also how DSPy parses the
reply back into `.priority` without a regex.

**After compiling — 10 messages, 1020 characters, 4 demos:**

```
--- user ---
[[ ## ticket ## ]]
We lost yesterday's uploads after the outage.
--- assistant ---
[[ ## priority ## ]]
P2

[[ ## completed ## ]]

--- user ---
[[ ## ticket ## ]]
Could you add dark mode to the dashboard?
--- assistant ---
[[ ## priority ## ]]
P3

[[ ## completed ## ]]
```

| | messages | characters | demos |
|---|---|---|---|
| before compiling | 2 | 582 | 0 |
| after `LabeledFewShot(k=4)` | 10 | 1020 | 4 |

Both scripts ship beside this page: [`dspy-prompt-diff.py`](/01-install/nb/dspy-prompt-diff.py) needs no key at all.

**The examples are injected as real `user`/`assistant` turns, not pasted into one string.** That is
the mechanical difference from a hand-written few-shot prompt: the model sees a conversation it
appears to have already had, in the same field format it is being asked to produce. Changing model
changes the rendering, not your code.

`LabeledFewShot` simply takes labelled examples — no model calls, which is why the numbers above are
reproducible offline. `BootstrapFewShot` is the one that costs requests: it *runs* the program on
training inputs and keeps only the traces where the metric passed, so the demos are examples the
model itself produced correctly.

```python
from dspy.teleprompt import BootstrapFewShot

metric = lambda gold, pred, trace=None: gold.priority == pred.priority.strip().upper()[:2]
compiled = BootstrapFewShot(metric=metric, max_bootstrapped_demos=3, max_labeled_demos=3).compile(
    dspy.Predict(Triage), trainset=train)
```

## What is not measured here

The obvious question — **does the compiled program actually score better?** — has a script and no
answer. [`dspy-experiment.py`](/01-install/nb/dspy-experiment.py) evaluates a 6-example dev set before and
after compiling and prints both scores; it was written, started, and did not finish, because the Gemini free tier ran out partway
through the baseline sweep and a six-attempt backoff was not enough to get through.

```
RuntimeError: still rate limited after backoff
```

Numbers are left blank rather than filled in from a partial run or from expectation. The run is a
dated follow-up below. What that quota limit is, and why a paced loop hits it, is written up in
[[pydantic-ai-structured-output]] — same key, same 20-request ceiling.

## Verification checklist

- [x] `dspy.Predict` against a signature returns a parsed `.priority` from Gemini
- [x] Cold, the model puts a billing ticket at `P2` — the house rule says `P1`
- [x] `ChatAdapter().format(...)` renders the generated system prompt with no API call
- [x] Compiling with `LabeledFewShot(k=4)` grows the request from 2 messages to 10
- [x] The injected demos appear as `user`/`assistant` turns, not as text inside one message
- [x] `BootstrapFewShot` imports and accepts `metric`, `max_bootstrapped_demos`, `max_labeled_demos`
- [ ] Baseline versus compiled **accuracy** on the dev set — **blocked on quota**, see above

## Rollback

```bash
rm -rf .venv
```

## Where this bit us

**Optimizers multiply request count, and the free tier notices.** `BootstrapFewShot` runs the
program over the training set, and the evaluation runs it over the dev set twice — once before
compiling and once after. A 10-example train and 6-example dev set is a small experiment by any
standard and still needs roughly 20–25 requests, which is the entire free-tier allowance. Pacing
calls seven seconds apart was not enough once the day's budget was gone.

The lesson is not "DSPy is expensive" — it is that **the cost of optimization scales with dataset
size times the number of candidate programs**, and the default optimizers are happy to spend that.
Check the arithmetic before pointing `MIPROv2` at a real dataset.

**`cache=True` is the default and it lies to a benchmark.** DSPy caches by prompt, so re-running an
evaluation after a change that does not alter the prompt returns the first run's numbers
immediately. Set `cache=False` on the LM whenever the thing being measured is the model's behaviour
rather than the pipeline's plumbing — otherwise a "before and after" can be the same numbers twice.

## Follow-ups

- [ ] Run [`dspy-experiment.py`](/01-install/nb/dspy-experiment.py) once the quota resets and fill in the baseline-versus-compiled table 📅 2026-08-22
- [ ] Repeat the comparison with `MIPROv2`, which also rewrites the instruction text rather than only selecting demos
- [ ] Swap the model string for a second provider and re-compile — the claim worth testing is that the *same* signature compiles to a different prompt without code changes
- [ ] Try a signature with a typed output (`Literal["P1","P2","P3"]`) and see whether the parsing beats a plain `str` with a `desc`
- [ ] Feed the triage program a document converted by [[markitdown-document-to-markdown]] rather than a one-line ticket

## Related

[[pydantic-ai-structured-output]] — the other way to constrain an LLM's output, by schema rather than by learned examples, and where the same quota limit is documented.
[[litellm-streamlit-chat]] — the provider layer DSPy calls through, and the same `.env` key.
[[langgraph-control-flow]] — where an optimized module would sit as one node in a larger graph.
