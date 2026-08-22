---
title: LangGraph — loops, branches, an approval gate, and a workflow that survives the process
date: 2026-08-21
domain: install
tags: [ai, llm, python, workflow, architecture]
stack: [langgraph, python, sqlite]
summary: The four control structures a linear chain cannot express, each run and each failure watched — a self-correcting loop, a conditional branch, a human approval gate proven by testing the rejection, and a SQLite checkpoint that let a second process resume a paused workflow it never started.
source: handson
env: langgraph 1.2.11 · langgraph-checkpoint 4.2.0 · langgraph-checkpoint-sqlite · langchain-core 1.6.0 · Python 3.13.0 on macOS 14.7.5
verified: 2026-08-21
verifiability: lab
duration: 30–45 min
risk: low
---

> **Verified 2026-08-21.** Every output below was printed by a run on this machine. The approval
> gate was tested by answering **no** as well as yes, and the cross-process resume really was two
> separate `python` invocations.

A chain runs `input → step → step → answer`. Business processes do not: they retry when something is
wrong, take different paths for different cases, stop and wait for a person before doing anything
irreversible, and survive a restart in the middle. **LangGraph is those four things** — nodes are
actions, edges are decisions, and the state is a `TypedDict` that every node updates.

```bash
pip install langgraph langgraph-checkpoint-sqlite
```

```
langgraph              1.2.11
langgraph-checkpoint   4.2.0
langchain-core         1.6.0
```

**No model is called anywhere in this document.** Every node here is a plain Python function, which
is deliberate: the control flow is the subject, and a deterministic node makes each claim below
reproducible rather than dependent on what a model felt like returning.

## 1. A self-correcting loop

The pattern: do the work, check it, and send it *back* rather than failing — until it is clean or
the budget runs out.

```python title="loop.py"
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

class AgentState(TypedDict):
    code: str
    errors: list[str]
    iterations: int

def compile_code(state: AgentState):
    if "syntax_error" in state["code"]:
        return {"errors": ["Syntax Error on line 3"], "iterations": state["iterations"] + 1}
    return {"errors": [], "iterations": state["iterations"] + 1}

def fix_code(state: AgentState):
    # a repair that only succeeds on the third try, so the loop has to actually loop
    if state["iterations"] >= 3:
        return {"code": state["code"].replace("syntax_error", "ok")}
    return {"code": state["code"]}

def should_continue(state: AgentState):
    if not state["errors"] or state["iterations"] > 3:
        return END
    return "fix_code"

b = StateGraph(AgentState)
b.add_node("compile", compile_code)
b.add_node("fix_code", fix_code)
b.add_edge(START, "compile")
b.add_conditional_edges("compile", should_continue)
b.add_edge("fix_code", "compile")
graph = b.compile()

print(graph.invoke({"code": "print(syntax_error)", "errors": [], "iterations": 0}))
```

```
{'code': 'print(ok)', 'errors': [], 'iterations': 4}
```

**Pass condition: `iterations` is 4, not 1.** A loop that never loops returns the same shape as one
that does, so the deliberately stubborn `fix_code` — refusing to repair anything until the third
attempt — is what makes this check able to fail. `iterations: 1` would mean the conditional edge
went straight to `END`.

`should_continue` carries **two** exits, and only one is about success: `not state["errors"]` is the
happy path, `state["iterations"] > 3` is the budget. Drop the second and the graph will still work
on inputs it can fix — see [Where this bit us](#where-this-bit-us) for what it does on one it cannot.

## 2. Conditional branching

```python title="branch.py"
from typing import TypedDict, Literal
from langgraph.graph import StateGraph, START, END

class Ticket(TypedDict):
    text: str
    kind: str
    action: str

def classify(s: Ticket):
    return {"kind": "defect" if "crash" in s["text"].lower() else "general"}

def route(s: Ticket) -> Literal["debug", "answer"]:
    return "debug" if s["kind"] == "defect" else "answer"

def debug(s):  return {"action": "opened a bug + attached stack trace"}
def answer(s): return {"action": "drafted a reply from the FAQ"}

b = StateGraph(Ticket)
for n, f in [("classify", classify), ("debug", debug), ("answer", answer)]:
    b.add_node(n, f)
b.add_edge(START, "classify")
b.add_conditional_edges("classify", route, {"debug": "debug", "answer": "answer"})
b.add_edge("debug", END)
b.add_edge("answer", END)
graph = b.compile()
```

```
The app crashes on export            -> kind=defect   action=opened a bug + attached stack trace
How do I change my password?         -> kind=general  action=drafted a reply from the FAQ
```

**Pass condition: two different inputs reach two different nodes.** One input proves nothing — a
router hardwired to `"answer"` passes a single-case test. The routing function returns a *node name*,
not a value; the third argument maps those names to nodes and is what makes the graph readable
(and, in `langgraph` 1.2.11, is optional — the loop above omits it and works).

## 3. Human-in-the-loop: an approval gate

`interrupt()` stops the graph mid-node and hands control back to the caller. **This requires a
checkpointer** — there is nowhere to park a paused workflow otherwise.

```python title="graph_app.py"
from langgraph.types import interrupt

def draft(s):
    return {"body": f"Dear {s['recipient']}, your invoice is overdue.", "log": s["log"] + ["drafted"]}

def approve(s):
    decision = interrupt({"question": "Send this email?", "preview": s["body"]})
    return {"log": s["log"] + [f"human said {decision}"]}

def send(s):
    return {"sent": True, "log": s["log"] + ["SENT"]}

def after_approval(s):
    return "send" if s["log"][-1].endswith("yes") else END
```

```python
graph = build().compile(checkpointer=InMemorySaver())
cfg = {"configurable": {"thread_id": "invoice-1"}}

res = graph.invoke({"recipient": "ACME", "body": "", "sent": False, "log": []}, cfg)
```

```
paused? __interrupt__ present: True
asked: {'question': 'Send this email?', 'preview': 'Dear ACME, your invoice is overdue.'}
state before approval: sent = False
```

`invoke` **returns** rather than blocks. The pause surfaces as an `__interrupt__` key carrying
whatever the node passed to `interrupt()` — the question and a preview, which is what a UI would
render. Resuming is a second `invoke` with a `Command`:

```python
out = graph.invoke(Command(resume="yes"), cfg)
```

```
after approval: sent = True | log = ['drafted', 'human said yes', 'SENT']
```

**The gate was tested by refusing, which is the case that matters:**

```
answered 'no' -> sent=False log=['drafted', 'human said no']
```

An approval step that has only ever been tested with *yes* is not an approval step — it is a delay.
`sent=False` on rejection is the property worth pinning, because the whole reason this node exists
is the run where a human says no.

And if nobody answers at all, nothing happens — no timeout, no default:

```
thread parked at: ('approve',) | sent: False | waits indefinitely
```

That is the right default for sending money or deleting data, and a queue of forgotten threads for
anything else. Whoever owns the workflow owns chasing them.

## 4. State persistence — resuming in a different process

Swap the in-memory saver for SQLite and the pause outlives the process:

```python title="start_run.py"
from langgraph.checkpoint.sqlite import SqliteSaver
from graph_app import build

with SqliteSaver.from_conn_string("state.db") as cp:
    g = build().compile(checkpointer=cp)
    cfg = {"configurable": {"thread_id": "invoice-42"}}
    r = g.invoke({"recipient": "ACME", "body": "", "sent": False, "log": []}, cfg)
    print("paused at:", r["__interrupt__"][0].value["question"])
```

```python title="resume_run.py"
with SqliteSaver.from_conn_string("state.db") as cp:
    g = build().compile(checkpointer=cp)
    cfg = {"configurable": {"thread_id": "invoice-42"}}
    print("next node:", g.get_state(cfg).next)
    out = g.invoke(Command(resume=sys.argv[1]), cfg)
```

Two separate interpreter runs, the first fully exited before the second started:

```bash
python start_run.py
python resume_run.py yes
```

```
PROCESS 1 — paused at: Send this email?
PROCESS 1 — sent so far: False
--- separate process, after the first exited ---
PROCESS 2 — resumed a thread it never started; next node: ('approve',)
PROCESS 2 — answered 'yes' -> sent=True log=['drafted', 'human said yes', 'SENT']
```

**Pass condition: the second process knows the graph is parked at `approve` without being told.**
It rebuilt the same graph, opened the same `state.db`, and asked for `thread_id` `invoice-42` — the
`next: ('approve',)` came out of the checkpoint. `state.db` was 28,672 bytes at that point; a crashed
server, a redeployed container and a week-long wait are all the same situation to this design.

The `thread_id` is the whole addressing scheme. Reuse one across unrelated conversations and they
share history; generate a fresh one per run and nothing can ever be resumed.

## Verification checklist

- [x] The loop reports `iterations: 4`, not `1` — `fix_code` is deliberately stubborn so a non-looping graph fails this
- [x] Two different ticket texts reach two different terminal nodes
- [x] `invoke` returns an `__interrupt__` payload instead of blocking, with `sent` still `False`
- [x] `Command(resume="yes")` completes the send
- [x] `Command(resume="no")` leaves `sent=False` — **the rejection path was actually run**
- [x] An unanswered thread reports `next=('approve',)` and waits, with no timeout
- [x] A second process resumes a thread started by a first that had already exited
- [x] A graph with no `START` edge fails to compile, with a message naming the cause
- [x] A loop with no exit condition raises `GraphRecursionError` rather than running forever

## Rollback

```bash
rm -rf .venv state.db
```

## Where this bit us

**The example graph does not compile as written, because it never declares an entry point.** The
snippet in circulation adds a node and a conditional edge and stops:

```python
builder.add_node("compile", compile_code)
builder.add_conditional_edges("compile", should_continue)
builder.compile()
```

```
ValueError: Graph must have an entrypoint: add at least one edge from START to another node
```

`add_edge(START, "compile")` is the missing line. The error says exactly that, which makes this a
one-minute problem — but only if you read it instead of assuming the graph library is unhappy about
the conditional edge.

**A loop with no exit condition does not hang — it dies, eventually, at 10,007 steps.**

```python
b2.add_conditional_edges("bump", lambda s: "bump")   # no way out
```

```
GraphRecursionError: Recursion limit of 10007 reached without hitting a stop condition.
You can increase the limit by setting the `recursion_limit` config key.
```

Better than an infinite loop, and still worth knowing the shape of: a runaway self-correction loop
burns ten thousand node executions before it stops, and if those nodes call a model, that is ten
thousand billable requests before anyone sees an error. **The `iterations > 3` budget in
`should_continue` is the real protection**; the recursion limit is the backstop, not the design.

**An approval gate is only as good as its rejection path.** Writing the `yes` case first is natural
and it passes immediately, which is exactly the problem — `send` is wired to run after `approve`
either way unless the conditional edge says otherwise. The `no` run is what proves the edge exists,
and it is one line of test for a node whose entire purpose is preventing an irreversible action.

## Follow-ups

- [ ] Put a real model behind `fix_code` and confirm the loop still terminates — a model that keeps producing broken output is exactly the case the `iterations` budget exists for
- [ ] Surface the `__interrupt__` payload in the Streamlit app from [[litellm-streamlit-chat]] so approval happens in a UI rather than a second `invoke`
- [ ] Swap `SqliteSaver` for the Postgres checkpointer against [[postgresql-cnpg-onprem]], so paused threads survive more than one machine
- [ ] Add a timeout sweep over parked threads — nothing here ages out, and a forgotten approval is invisible
- [ ] Try `graph.get_state_history()` and a rollback to an earlier checkpoint, which this document never exercises

## Related

[[pydantic-ai-structured-output]] — the other agent framework here, where the retry loop is built in rather than drawn as a graph.
[[litellm-streamlit-chat]] — where a human would actually answer the approval question.
[[markitdown-document-to-markdown]] — the kind of step that belongs in a node, and whose silent empty output a validation node would catch.
[[dspy-prompt-optimization]] — for the nodes that call a model, replacing the hand-written prompt inside them with a compiled one.
