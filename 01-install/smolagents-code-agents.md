---
title: smolagents — the agent writes Python, and one model call does three tool calls
date: 2026-08-21
domain: install
tags: [ai, llm, python, agents, security]
stack: [smolagents, python]
summary: A CodeAgent driven by a scripted stand-in model, so the whole mechanic is visible with no API key and no quota — one model call, three tool invocations, and a float returned rather than a string. A live Gemini run then wrote correct Python and still broke the code-block framing, costing a parse retry. Also the sandbox: import os is refused by default, and the flag that allows it let model-written code list the real filesystem root.
source: handson
env: smolagents 1.26.0 · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-21
verifiability: partial
verifiability-note: The execution mechanic, the call counts and the sandbox were produced by a scripted stand-in model rather than a real LLM, which is deliberate — it makes them reproducible with no key. One live Gemini run was also made: its first step wrote valid Python and then broke the code-block framing, costing a parse retry, and that run had not reached a final answer when this was written. DuckDuckGoSearchTool and a JSON-agent round-trip comparison are unexercised.
duration: 20–30 min
risk: low
---

> **Verified 2026-08-21.** Every number and error below came from a run on this machine. The
> agent's "reasoning" was supplied by a stand-in model on purpose — see
> [Why a fake model proves more here](#why-a-fake-model-proves-more-here).

Most agent frameworks make the model emit JSON — `{"tool": "search", "arguments": {...}}` — which
the framework parses and executes, one round trip per tool call. `smolagents` inverts that: **the
model writes Python, and the framework runs it.** Three tool calls, a list comprehension and an
average become one code block instead of three negotiations.

```bash
pip install smolagents
```

```
smolagents  1.26.0
```

## The easy example

A tool is a plain function with a decorator. The docstring is not decoration — smolagents sends it
to the model, and **it fails at import time without an `Args:` section**:

```python title="agent.py"
from smolagents import CodeAgent, tool

@tool
def context_size(model_name: str) -> int:
    """Return a model's context window in tokens.

    Args:
        model_name: the model to look up
    """
    return {"llama-4": 128000, "mistral-3": 32000, "qwen-3": 64000}[model_name]
```

Asked to average three context sizes, the model produced this — a code block, not JSON:

```py
sizes = [context_size(m) for m in ["llama-4", "mistral-3", "qwen-3"]]
avg = sum(sizes) / len(sizes)
print("sizes:", sizes)
final_answer(avg)
```

and smolagents ran it:

```
─ Executing parsed code: ──────────────────────────────────────────────
  sizes = [context_size(m) for m in ["llama-4", "mistral-3", "qwen-3"]]
  avg = sum(sizes) / len(sizes)
  print("sizes:", sizes)
  final_answer(avg)
──────────────────────────────────────────────────────────────────────
Execution logs:
sizes: [128000, 32000, 64000]

Final answer: 74666.66666666667
```

**`final_answer(avg)` returns a `float`, not a string.** The value came back through Python, so it
never had to be serialised into JSON and parsed out again:

```python
out = agent.run("Average the context sizes of llama-4, mistral-3 and qwen-3.")
type(out)   # <class 'float'>
```

## The measurable difference

Instrumenting both sides — a counter in the tool, a counter in the model:

```
model calls: 1 | tool invocations: 3 | answer: 74666.66666666667 (float)
```

**One model call did three tool calls.** A JSON tool-calling agent cannot do that: each call is a
separate message the model must emit, be handed a result for, and respond to — three round trips
minimum for this task, plus a fourth to compute the average, since arithmetic is not a tool.
The list comprehension is the whole point. Loops, conditionals and arithmetic are free inside a code
block and require a round trip each in a JSON protocol.

That is the mechanism behind the speed claims made for this library. **It is a claim about round
trips, which is what was measured here — not a benchmark of end-to-end latency**, which would depend
on the model, the network and the task.

## Why a fake model proves more here

Every run above used a stand-in model that returns a fixed code block:

```python title="scripted_model.py"
from smolagents import Model, ChatMessage

class ScriptedModel(Model):
    """Stands in for an LLM: returns a fixed code action, so no API call happens."""
    def __init__(self, code):
        super().__init__()
        self.code = code
        self.calls = 0

    def generate(self, messages, stop_sequences=None, **kw):
        self.calls += 1
        return ChatMessage(role="assistant", content=self.code)
```

The code it returns is the literal format smolagents parses:

````text
Thought: I will look each one up and average them.
Code:
```py
sizes = [context_size(m) for m in ["llama-4", "mistral-3", "qwen-3"]]
final_answer(sum(sizes) / len(sizes))
```<end_code>
````

This is not a shortcut — it is what makes the page reproducible. The thing being demonstrated is
**the executor**: that a code block gets parsed, that tools are in scope as ordinary functions, that
`final_answer` ends the run with a typed value, and that imports are policed. None of that depends
on which model wrote the code, and pinning the code makes every number above deterministic instead
of a sample of one model's mood.

What it cannot show is the part that *does* depend on the model: whether a real LLM reliably writes
correct code for a task. That needs a live run, and is left open below.

## What the real model actually did

A live run against Gemini was started to answer the one question the scripted model cannot. It
produced working code on the first try — a different shape from the scripted version, three separate
calls rather than a comprehension:

```py
c_llama = context_size("llama-4")
c_mistral = context_size("mistral-3")
c_qwen = context_size("qwen-3")

print(f"llama-4: {c_llama}")
print(f"mistral-3: {c_mistral}")
print(f"qwen-3: {c_qwen}")

avg = (c_llama + c_mistral + c_qwen) / 3.0
print(f"Average context size: {avg}")
```

**And then it broke the protocol around the code.** Instead of closing the block, it continued
inside it with more prose and an opening tag:

```
  Thought: Now I will return the final average context size using the
  `final_answer` tool.
  <code>
  final_answer(avg)
```

```
Code parsing failed on line 11 due to: SyntaxError: invalid syntax (<unknown>, line 11)
[Step 1: Duration 185.66 seconds | Input tokens: 2,214 | Output tokens: 442]
```

smolagents caught it and started Step 2, which is what the retry loop is for. But the finding is
worth stating plainly against the library's own pitch: **"models are better at code than JSON" did
not mean the framing problem went away.** The Python inside the block was correct on the first
attempt; what failed was the wrapper — a second `Thought:` and a stray `<code>` where the block
should have ended. The failure mode moved from *malformed JSON* to *malformed code-block framing*,
and it still costs a retry.

That step also took **186 seconds** — this run was competing with an exhausted free-tier quota, so
read the duration as a note about rate limits, not about the library.

## The sandbox, and the flag that opens it

Model-written code executing on your machine is the obvious worry, and there is a default allowlist.
`statistics` is on it:

```py
import statistics
final_answer(statistics.mean([128000, 32000, 64000]))
```

```
additional_authorized_imports=[] -> 74666.66666666667
```

`os` is not:

```
Code execution failed at line 'import os' due to: InterpreterError: Import of os is not allowed
```

**The escape hatch is one argument, and it is a real hole:**

```python
CodeAgent(tools=[], model=..., additional_authorized_imports=["os"])
```

```py
import os
final_answer(len(os.listdir("/")))
```

```
additional_authorized_imports=['os'] -> 21
```

**That `21` is the number of entries in this machine's actual filesystem root.** The agent read the
real disk, because the flag said it could. `additional_authorized_imports` is the line between "a
sandbox" and "arbitrary code execution as your user" — adding `os`, `subprocess` or `requests` to it
should be a decision with a reason, not a way to make an error message go away. For anything
untrusted, run the executor somewhere disposable rather than widening the list.

## Verification checklist

- [x] A `@tool` function is callable by name inside the generated code, with no JSON schema anywhere
- [x] `final_answer(...)` returns a `float` to the caller, not a string
- [x] One model call drives three tool invocations — **both counted, not assumed**
- [x] `import os` is refused with `InterpreterError: Import of os is not allowed`
- [x] `additional_authorized_imports=["os"]` lifts that and the code reads the real filesystem
- [x] `import statistics` works without any flag — the default allowlist is not empty
- [x] A real model writes valid Python for this task on the first attempt
- [x] The same reply breaks the code-block framing and costs a parse retry — **observed live**
- [ ] That live run reaching a final answer — it was still retrying when this was written

## Rollback

```bash
rm -rf .venv
```

## Where this bit us

**The example in circulation does not import.** `HfApiModel` was renamed:

```python
from smolagents import CodeAgent, HfApiModel, DuckDuckGoSearchTool
```

```
ImportError: cannot import name 'HfApiModel' from 'smolagents'
```

`InferenceClientModel` is the current name; `DuckDuckGoSearchTool` in the same line is fine. A
rename inside a fast-moving library is unremarkable — the reason to record it is that the snippet is
copied widely enough that the first thing a reader meets is an `ImportError`, and the message does
not suggest the new name.

**Providers are extras, and the error says which one.** `LiteLLMModel` imports fine and then fails
on use:

```
ModuleNotFoundError: Please install 'litellm' extra to use LiteLLMModel:
  `pip install 'smolagents[litellm]'`
```

Worth knowing that the failure lands at *construction*, not at install — a base `pip install
smolagents` looks complete until the first run.

**A `@tool` docstring without `Args:` is a hard error, not a warning.** The decorator parses the
docstring to build the tool's description, and a missing argument section stops the program before
any model is contacted. Annoying once, useful forever: the model's only view of a tool is that text.

## Follow-ups

- [ ] Finish the live run and record the final answer plus how many parse retries it took 📅 2026-08-22
- [ ] Count round trips for the identical task with `ToolCallingAgent` (the JSON path, in the same library) and put the two numbers side by side — that is the honest version of the "40% faster" claim
- [ ] Run the executor in a container rather than in-process, and confirm `additional_authorized_imports=["os"]` can then do no harm
- [ ] Add `DuckDuckGoSearchTool` and see how a real search result — long, messy, untrusted text — survives being pasted into a code block
- [ ] Treat model-written code as untrusted input the way [[fastapi-mvc-layering]] treats a form field, and write down what a hostile prompt could reach

## Related

[[langgraph-control-flow]] — the other end of the spectrum: explicit graphs and approval gates instead of the model writing its own control flow.
[[pydantic-ai-structured-output]] — the JSON-schema approach this library is arguing against, with its own retry loop.
[[litellm-streamlit-chat]] — the provider layer `LiteLLMModel` wraps, and the same Gemini key.
