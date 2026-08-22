---
title: Pydantic AI with Gemini — typed output, and the retry that enforces meaning
date: 2026-08-21
domain: install
tags: [ai, llm, python, validation]
stack: [pydantic-ai, pydantic, gemini, python, python-dotenv]
summary: An agent whose return value is a validated Pydantic model rather than a string, run against Gemini with a key from .env. Every line of the widely-copied example has drifted — result_type, result.data, usage() and the model prefix all changed names — and the schema guarantee turns out to be weaker than it sounds: asked for a query under 12 characters, the model complied with SELECT 1 rather than retrying.
source: handson
env: pydantic-ai 2.33.0 · pydantic 2.13.4 · google-genai 2.19.0 · python-dotenv 1.2.3 · Python 3.13.0 on macOS 14.7.5 · Gemini via GEMINI_API_KEY
verified: 2026-08-21
verifiability: partial
verifiability-note: Verified against Gemini only, the one provider with a key on this machine — the model-string form for other providers is unexercised. Validator-driven retries and retry exhaustion were both observed live, as were the notebook's run_sync failure and its top-level-await fix. The shipped notebook has NOT been run top to bottom in one pass and ships with empty output cells: the Gemini free-tier quota ran out during verification. A retry triggered by Pydantic schema validation itself was never reproduced either. Tools, dependencies, streaming and multi-agent graphs are untouched.
duration: 25–35 min
risk: low
---

> **Verified 2026-08-21.** Every output below came from a live Gemini call. The attempt counts in
> [The retry, watched](#the-retry-watched) are what a validator actually recorded, not an
> illustration.

An LLM returns a string. Every application then needs that string to be *something* — a query, a
record, a decision — and the parsing layer in between is where these projects rot. `pydantic-ai`
moves the shape into a Pydantic model and hands back a validated instance:

```python
class DatabaseQuery(BaseModel):
    sql_query: str = Field(description="Valid PostgreSQL query")
    explanation: str = Field(description="Brief breakdown of what the query does")

agent = Agent("google:gemini-3.6-flash", output_type=DatabaseQuery)
result = agent.run_sync("Find the top 5 users by total spend in 2026")
result.output.sql_query      # a str, on an object your type checker knows
```

The `Field(description=...)` text is not a comment — it is sent to the model as part of the schema,
so it is prompt and documentation at once.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install pydantic-ai python-dotenv
```

```
pydantic-ai      2.33.0
pydantic         2.13.4
google-genai     2.19.0
python-dotenv    1.2.3
```

The Gemini provider comes in without extras here — `pydantic-ai` pulled `google-genai` itself.

## The key, from `.env` and nowhere else

```text title=".env"
GEMINI_API_KEY=<REDACTED>
```

```bash
echo ".env" >> .gitignore
git check-ignore -v .env
```

```
.gitignore:5:.env	.env
```

**`load_dotenv()` has to run before `pydantic_ai` is imported**, or rather before the agent is
constructed — the provider reads `GEMINI_API_KEY` out of the environment at that point. Putting the
import first and the `load_dotenv()` second is the version that fails with an authentication error
while the file sits there correctly filled in:

```python
from dotenv import load_dotenv

load_dotenv()  # first

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry
```

## The agent

```python title="agent_app.py"
from dotenv import load_dotenv

load_dotenv()  # GEMINI_API_KEY, before pydantic_ai reads the environment

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry


class DatabaseQuery(BaseModel):
    sql_query: str = Field(description="Valid PostgreSQL query")
    explanation: str = Field(description="Brief breakdown of what the query does")


agent = Agent(
    "google:gemini-3.6-flash",
    output_type=DatabaseQuery,
    instructions="You write PostgreSQL. Return the query and a one-line explanation.",
    retries=3,
)


@agent.output_validator
def must_be_capped(out: DatabaseQuery) -> DatabaseQuery:
    """The schema cannot express 'has a LIMIT'. This can, and a failure re-prompts the model."""
    if "limit" not in out.sql_query.lower():
        raise ModelRetry("The query must include an explicit LIMIT clause. Add one.")
    return out


if __name__ == "__main__":
    result = agent.run_sync("Show every user's total spend in 2026, ordered by spend.")
    print(result.output.sql_query)
    print("---")
    print(result.output.explanation)
    print("tokens:", result.usage)
```

```bash
.venv/bin/python agent_app.py
```

```sql
SELECT
    u.id AS user_id,
    u.name,
    COALESCE(SUM(o.total_amount), 0) AS total_spend
FROM users u
LEFT JOIN orders o
    ON u.id = o.user_id
    AND o.created_at >= '2026-01-01'
    AND o.created_at < '2027-01-01'
GROUP BY u.id, u.name
ORDER BY total_spend DESC
LIMIT 100;
```

```
tokens: RunUsage(cost=Decimal('0.00620925'), ..., requests=2)
```

**`requests=2` is the retry, visible in the bill.** One prompt produced two round trips, because the
first answer had no `LIMIT`. Usage is the cheapest place to notice a validator that is firing more
often than you think.

## The retry, watched

The claim "guaranteed to match the schema or it auto-retries" is worth watching rather than
trusting. Recording every value the validator sees:

```python
attempts = []

@agent.output_validator
def must_be_capped(out: DatabaseQuery) -> DatabaseQuery:
    attempts.append(out.sql_query)
    if "limit" not in out.sql_query.lower():
        raise ModelRetry("The query must include an explicit LIMIT clause. Add one.")
    return out
```

```
validator saw 2 attempt(s)
  attempt 1: NO LIMIT | SELECT u.id AS user_id, u.name, COALESCE(SUM(o.total_amou…
  attempt 2: LIMIT    | SELECT u.id AS user_id, u.name, COALESCE(SUM(o.total_amou…
messages exchanged: 5
```

<img src="/01-install/img/pydantic-ai-retry-flow.png" width="620" alt="Diagram: prompt produces attempt 1 without a LIMIT, the validator raises ModelRetry, attempt 2 comes back with LIMIT 100 and passes, costing two requests">

*This agent is a script with no interface, so the figure above is a diagram of the run, not a screen
capture — the values in it are the ones printed by the commands on this page.*

**Pass condition: two attempts, the first without a `LIMIT` and the second with one.** The
`ModelRetry` message is fed back to the model as a new turn — which is why the message count is 5
rather than 2, and why the retry text should read as an instruction to the model, not as a log line
for a human.

### When the retries run out

```python
agent = Agent("google:gemini-3.6-flash", output_type=Q, retries=1)

@agent.output_validator
def never_happy(out: Q) -> Q:
    raise ModelRetry("Not acceptable. Try again.")
```

```
attempts made: 2
raised: UnexpectedModelBehavior
message: Exceeded maximum output retries (1)
```

Two things to take from a deliberately impossible validator. **`retries=1` produced two calls** —
the parameter counts retries, not total attempts, so a budget of `n` bills up to `n + 1` requests.
And the failure is an exception, not a `None` or a partially-filled model: `UnexpectedModelBehavior`
is what a caller must be ready to catch, because a validator this application cannot satisfy is
indistinguishable at runtime from a model having a bad day.

## In a notebook: `run_sync()` is the one thing that breaks

The script above runs unchanged in a `.py` file. Pasted into a Jupyter cell, its very first call
fails:

```python
agent.run_sync("Select all users.")
```

```
RuntimeError: This event loop is already running
```

**`run_sync` is a convenience wrapper that starts an event loop**, and a notebook kernel is already
running one. Nothing is wrong with the agent, the key, or the model — the synchronous entry point
simply cannot be used from inside a running loop.

The fix is to use the coroutine `run_sync` was wrapping, with IPython's top-level `await`:

```python
result = await agent.run("Find the top 5 users by total spend in 2026")
print(result.output.sql_query)
```

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
```

**That is not the query that was asked for, and it is the real output.** With no schema and no tool,
the model answered a question about users and spend with a query that inspects
`information_schema` — it went looking for the tables first. Typed output guarantees the shape of
the reply, and this is the same lesson as `SELECT 1` below, arriving from the other direction: a
perfectly-formed `DatabaseQuery` can still contain the wrong query. The notebook shipped below adds
an `instructions=` line naming the tables, which is the cheapest fix.

Ending a cell with the result renders the model itself, which is a better argument for typed output
than any prose — the notebook prints a `DatabaseQuery`, not a blob of text to be parsed:

```python
result.output
```

```
DatabaseQuery(sql_query="SELECT table_name, column_name, data_type \nFROM information_schema.columns
              \nWHERE table_schema = 'public' \nORDER BY table_name, ordinal_position;",
              explanation='I will inspect the database schema first to formulate the SQL query.')
```

The `explanation` field is the model saying out loud that it is stalling for a schema — which a
string return value would have buried in prose, and a typed field puts in its own slot.

**The runnable notebook is [`pydantic-ai-gemini.ipynb`](/01-install/nb/pydantic-ai-gemini.ipynb)** —
same agent, the failing `run_sync` cell kept in deliberately so the error is met once on purpose
rather than in the middle of real work, plus an `instructions=` line so the model answers the
question instead of asking for the schema. It needs a `.env` beside it.

> ⚠️ **The notebook ships with empty output cells.** Its individual behaviours were verified in a
> real kernel — the two blocks above are that kernel's output — but the notebook as a single
> top-to-bottom run was not completed: the Gemini free tier ran out first. See
> [Where this bit us](#where-this-bit-us) for what that limit actually is.

## Verification checklist

- [x] `git check-ignore -v .env` names the ignoring rule, before anything is committed
- [x] `agent.run_sync(...)` returns an `AgentRunResult` whose `.output` is a `DatabaseQuery` instance
- [x] A validator rejection produces exactly two attempts — first without `LIMIT`, then with — **watched, not assumed**
- [x] The retry shows up as `requests=2` in the run's usage
- [x] An unsatisfiable validator raises `UnexpectedModelBehavior: Exceeded maximum output retries`
- [x] `retries=1` costs two requests, confirming the parameter is retries and not attempts
- [ ] A retry driven by Pydantic schema validation alone — **never reproduced**, see below
- [x] `run_sync()` in a Jupyter kernel raises `RuntimeError: This event loop is already running`
- [x] `await agent.run(...)` works in the same kernel and returns a `DatabaseQuery`
- [ ] The shipped notebook executed top to bottom in one run — **blocked on the free-tier quota**, see below

## Rollback

```bash
rm -rf .venv
```

## Where this bit us

**Every line of the example in circulation has drifted.** The widely-copied snippet does not run on
2.33.0, and each break was found by running it:

| The snippet says | 2.33.0 wants | How it fails |
|---|---|---|
| `Agent('openai:gpt-4o', ...)` | `Agent('google:gemini-3.6-flash', ...)` for Gemini | — |
| `result_type=DatabaseQuery` | `output_type=DatabaseQuery` | `TypeError` on unexpected keyword |
| `result.data.sql_query` | `result.output.sql_query` | `.data` does not exist |
| `result.usage()` | `result.usage` | `TypeError: 'RunUsage' object is not callable` |

The model prefix has its own trap: `google-gla:gemini-3.6-flash` — the form in older material — is
rejected, but **the error names the fix**, which is the nicest kind of breakage:

```
UserError: Unknown model: google-gla:gemini-3.6-flash.
Did you mean 'google:gemini-3.6-flash'?
```

**Schema conformance is not correctness, and the difference is easy to miss.** Trying to force a
retry from Pydantic validation itself, `sql_query` was given `Field(max_length=12)` — a limit no
real query can meet. The model did not retry. It returned:

```
schema-level retries: 0
final sql: 'SELECT 1' (8 chars)
```

`SELECT 1` is eight characters, passes validation, and answers nothing. **A constraint the model can
satisfy by degrading the answer will be satisfied that way**, and the result arrives with the full
appearance of a validated success. The schema guarantees the *shape* of the reply; it cannot
guarantee the reply is any good, and a narrowing constraint quietly invites a worse answer rather
than a better attempt. That is exactly the gap `output_validator` exists to cover — it is the only
layer in this stack that can express *meaning*.

Recorded as an unreproduced case rather than a success: a schema-level retry may well be reachable
with a constraint that cannot be met by degrading, but nothing here demonstrated one.

**The Gemini free tier is 20 requests, and a retrying agent spends them two at a time.** Verifying
this page exhausted it:

```
ModelHTTPError: status_code: 429, model_name: gemini-3.6-flash
  Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
  limit: 20, model: gemini-3.6-flash
  quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier
  Please retry in 32.449791768s
```

**The message is self-contradictory and worth reading closely.** The quota id says
`...RequestsPerDay...` with a value of `20`, which reads as a hard daily ceiling — but `RetryInfo`
offers 32 seconds, and calls did succeed again about a minute later. Both cannot describe the same
limit. Whichever is authoritative, the practical shape is the same: **a burst gets refused and a
paced run does not**, so a notebook that fires several cells in a row is more likely to hit this
than the same calls typed by hand.

Two follow-on observations from the same window. Switching to `gemini-flash-latest` to dodge the
limit returned `503 UNAVAILABLE — This model is currently experiencing high demand` instead, so the
alias is not a reliable escape hatch. And every validator retry is a billable request, which makes
`retries=3` a quota multiplier as much as a correctness setting — the `requests=2` counter is the
number to watch.

## Follow-ups

- [ ] Execute `nb/pydantic-ai-gemini.ipynb` end to end once the free-tier quota resets, and commit it with its outputs 📅 2026-08-22
- [ ] Reproduce a retry triggered by Pydantic validation alone, with a constraint the model cannot satisfy by giving a worse answer — the one checklist item still open
- [ ] Give the agent a tool (`@agent.tool`) that inspects a real schema, so `explanation` stops guessing at table names — the current output invents `users` and `orders`
- [ ] Run the same agent against a second provider and confirm only the model string changes, as [[litellm-streamlit-chat]] does for plain completions
- [ ] Try `output_type` as a union of models, so the agent can answer "this question cannot be turned into SQL" without an exception
- [ ] Put a real PostgreSQL behind it via [[postgresql-cnpg-onprem]] and `EXPLAIN` the generated query before trusting it

## Related

[[litellm-streamlit-chat]] — the same Gemini key, one layer down: unified completions with no schema, where the reply is still a string.
[[fastapi-mvc-layering]] — Pydantic doing the same validation job for HTTP input rather than model output.
[[bruno-api-client]] — checking an API contract from outside the code that implements it.
