---
title: DSPy — the prompt it writes for you, measured before and after compiling
date: 2026-08-21
domain: install
tags: [ai, llm, python, prompt-engineering]
stack: [dspy, gemini, python, python-dotenv]
summary: A signature instead of a prompt string, run against Gemini. The effect is shown twice over — the exact messages DSPy sends grow from 2 to 10 with examples injected as real conversation turns, and a compiled program scores 3/3 against a 2/3 baseline, fixing precisely the ticket the house rule is about. The dev set is 3 examples because the free tier allows 20 requests a day, so the direction is measured and the magnitude is not.
source: handson
env: dspy 3.3.1 · litellm 1.97.0 · python-dotenv · Python 3.13.0 on macOS 14.7.5 · Gemini via GEMINI_API_KEY
verified: 2026-08-21
verifiability: partial
verifiability-note: The install, the prompt rendering (no API calls, fully reproducible) and the max_tokens truncation finding were verified against gemini-3.6-flash. The baseline-versus-compiled measurement ran on gemini-flash-lite-latest instead, because 3.6-flash's daily quota was exhausted — so the accuracy numbers and the rest of the page are not from the same model. The dev set is 3 examples, sized by the quota rather than by statistics: the direction of the result is measured, its magnitude is not.
duration: 25–40 min
risk: low
---

> **Verified 2026-08-21, accuracy added 2026-08-22.** The prompt renderings come from a script that
> makes no API calls, so they reproduce exactly. The accuracy numbers are from a real run — on a
> different model than the rest of the page, for the reason in
> [Where this bit us](#where-this-bit-us).

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

dspy.configure(lm=dspy.LM("gemini/gemini-3.6-flash", max_tokens=2048, cache=False))
```

`cache=False` matters while measuring anything — DSPy caches identical calls, and a cached second
run of an evaluation reports the first run's numbers instantly.

**`max_tokens=2048` is not generosity, it is the minimum that works with this model.** At `120`
the answer comes back empty — see [Where this bit us](#where-this-bit-us).

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

## Does compiling actually score better?

Yes, on this task — measured, with the caveats stated plainly afterwards.

```bash
python dspy-experiment.py
```

```
BASELINE (no examples): 2/3
   MISS want=P1 got=P2  | My card was charged twice for one order.
   ok   want=P2 got=P2  | Dashboard freezes when I open the reports tab.
   ok   want=P3 got=P3  | Is there a mobile app planned?

compiled demos: 2

COMPILED (demos chosen by DSPy): 3/3
   ok   want=P1 got=P1  | My card was charged twice for one order.
   ok   want=P2 got=P2  | Dashboard freezes when I open the reports tab.
   ok   want=P3 got=P3  | Is there a mobile app planned?

RESULT  baseline 2/3  ->  compiled 3/3
```

**The one example that changed is the one the house rule is about.** Zero-shot, the billing ticket
went to `P2` — the sensible general answer. After compiling, `P1`. The two cases the model already
agreed with were right both times, which is what you want: the examples taught the exception without
disturbing the rest.

**Now the caveats, because a 3-example dev set is a demonstration and not a benchmark.**

- `n = 3`. One example moved. That is enough to show the mechanism works and nowhere near enough to
  quantify how much it helps — a single flipped answer is the entire difference between these scores.
- The dev set is small **because of the quota**, not because it is the right size. See
  [Where this bit us](#where-this-bit-us).
- **The demos DSPy selected contain no `P1` example at all:**

  ```
  {'ticket': 'The export button crashes the app every time.', 'priority': 'P2'}
  {'ticket': 'Could you add dark mode to the dashboard?',     'priority': 'P3'}
  ```

  The billing case was fixed by examples that are not about billing. `BootstrapFewShot` keeps traces
  where its metric passed, and the zero-shot program passes on `P2` and `P3` — the cases it already
  agrees with — so those are the traces available to keep. Why seeing "crash → P2" is enough to move
  billing to `P1` is not something this run establishes; it is recorded as observed, not explained.

This is the honest shape of the result: **the direction is real and measured, the magnitude is not.**

## Verification checklist

- [x] `dspy.Predict` against a signature returns a parsed `.priority` from Gemini
- [x] Cold, the model puts a billing ticket at `P2` — the house rule says `P1`
- [x] `ChatAdapter().format(...)` renders the generated system prompt with no API call
- [x] Compiling with `LabeledFewShot(k=4)` grows the request from 2 messages to 10
- [x] The injected demos appear as `user`/`assistant` turns, not as text inside one message
- [x] `BootstrapFewShot` imports and accepts `metric`, `max_bootstrapped_demos`, `max_labeled_demos`
- [x] `max_tokens=120` yields an empty `priority`; `2048` returns `P2` — **both run back to back**
- [x] Baseline scores 2/3 and the compiled program 3/3, with the billing case the one that flips
- [x] The improvement came from demos containing **no** `P1` example — recorded as observed

## Rollback

```bash
rm -rf .venv
```

## Where this bit us

**Optimizers multiply request count, and the free tier notices.** `BootstrapFewShot` runs the
program over the training set, and the evaluation runs it over the dev set twice — once before
compiling and once after. The first version of this experiment used a 10-example train and 6-example
dev set: a small experiment by any standard, and still roughly 20–25 requests, which is the entire
free-tier allowance of `20` per day. It never completed. The version that ran uses **6 train, 3 dev
and `max_bootstrapped_demos=2`** — about 12 requests — and the dev set is that small for the quota's
sake, not for the statistics'.

**The quota is per model, and that is the way out.** The limit is
`GenerateRequestsPerDayPerProjectPerModel-FreeTier` — note `PerModel`. With `gemini-3.6-flash`
exhausted, three other models answered on the same key immediately:

```
gemini/gemini-flash-latest           OK
gemini/gemini-flash-lite-latest      OK
gemini/gemini-2.5-flash              OK
```

**The measured result above therefore comes from `gemini-flash-lite-latest`, not the model used
everywhere else on this page.** That is a real difference in the setup and is called out rather than
smoothed over — a different model could plausibly produce a different baseline. Switching models to
dodge a quota is fine for a demonstration and is exactly the kind of thing that invalidates a
comparison if it goes unrecorded.

**A `retryDelay` of 3 seconds does not mean the wait is 3 seconds.** The exhausted-quota error
advises `Please retry in 3.148507058s` while naming a *per-day* quota. Backing off six times at 30
seconds still failed. Read the `quotaId`, not the delay.

The lesson is not "DSPy is expensive" — it is that **the cost of optimization scales with dataset
size times the number of candidate programs**, and the default optimizers are happy to spend that.
Check the arithmetic before pointing `MIPROv2` at a real dataset.

**A reasoning model spends the token budget before it answers, and DSPy reports it as a parse
failure.** The first version set `max_tokens=120` — ample for the three characters `P1` — and the
evaluation died on:

```
Expected to find output fields in the LM response: [priority]
Actual output fields parsed from the LM response: []
```

Nothing about that message points at the token budget. The cause is that `gemini-3.6-flash` emits
**reasoning tokens before its visible answer** — a single earlier call on this key reported
`output_reasoning_tokens: 1024` — so a 120-token ceiling is consumed by thinking and truncates the
response before the `[[ ## priority ## ]]` field is ever written. Both budgets, same prompt, back to
back:

```
max_tokens=  120 -> priority=''
max_tokens= 2048 -> priority='P2'
```

DSPy does warn — `LM response was truncated due to exceeding max_tokens=120` — but the warning
scrolls past above a traceback that talks about output fields, and **the same setting failed two
different ways across runs**: once raising `AdapterParseError: The LM returned an empty or null
response`, once returning an empty string. A budget that looks generous for the *answer* can be far
too small for the *model*.

**`cache=True` is the default and it lies to a benchmark.** DSPy caches by prompt, so re-running an
evaluation after a change that does not alter the prompt returns the first run's numbers
immediately. Set `cache=False` on the LM whenever the thing being measured is the model's behaviour
rather than the pipeline's plumbing — otherwise a "before and after" can be the same numbers twice.

## Follow-ups

- [x] Fill in the baseline-versus-compiled table — done at 3 dev examples on `gemini-flash-lite-latest`
- [ ] Re-run on a dev set of 30+ with a paid key, so the size of the gain can be quantified rather than only its direction 📅 2026-09-05
- [ ] Re-run the same 3-example experiment on `gemini-3.6-flash` for a like-for-like comparison with the rest of this page
- [x] Find out why the first attempt returned no output fields — it was `max_tokens`, now `2048` in the shipped script
- [ ] Repeat the comparison with `MIPROv2`, which also rewrites the instruction text rather than only selecting demos
- [ ] Swap the model string for a second provider and re-compile — the claim worth testing is that the *same* signature compiles to a different prompt without code changes
- [ ] Try a signature with a typed output (`Literal["P1","P2","P3"]`) and see whether the parsing beats a plain `str` with a `desc`
- [ ] Feed the triage program a document converted by [[markitdown-document-to-markdown]] rather than a one-line ticket

## Related

[[pydantic-ai-structured-output]] — the other way to constrain an LLM's output, by schema rather than by learned examples, and where the same quota limit is documented.
[[litellm-streamlit-chat]] — the provider layer DSPy calls through, and the same `.env` key.
[[langgraph-control-flow]] — where an optimized module would sit as one node in a larger graph.
