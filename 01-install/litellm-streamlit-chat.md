---
title: A Streamlit chat app on LiteLLM — one call signature, any provider
date: 2026-08-21
domain: install
tags: [ai, llm, python, developer-tools]
stack: [litellm, streamlit, gemini, python, python-dotenv]
summary: Forty lines of Streamlit over LiteLLM's unified completion() call, running against Gemini with a key from .env. The portability claim is tested rather than repeated — the same code was pointed at three providers, and the two without keys fail on credentials, not on syntax. A hardcoded model name was already retired when this was written, and the API said so.
source: handson
env: litellm 1.97.0 · streamlit 1.62.0 · python-dotenv 1.2.3 · Python 3.13.0 on macOS 14.7.5 · Gemini via GEMINI_API_KEY
verified: 2026-08-21
verifiability: partial
verifiability-note: Verified end to end against Gemini only — that is the one provider with a key on this machine. The OpenAI and Anthropic calls were made and returned missing-credential errors, which shows the call signature is accepted but not that a completion succeeds there. Streaming, multi-turn history and the error path were exercised; cost tracking, fallbacks, retries and the LiteLLM proxy server were not.
duration: 20–30 min
risk: low
---

> **Verified 2026-08-21.** Every response in the screenshots below came from a live Gemini call.
> The retired-model error in [Where this bit us](#where-this-bit-us) is what the API actually
> returned, not an illustration.

Swapping LLM providers usually means rewriting the call layer: different client objects, different
payload shapes, different streaming handlers. `litellm` collapses that into one function whose only
provider-specific part is a **string**.

```python
from litellm import completion

response = completion(
    model="gemini/gemini-3.6-flash",                  # ← the only provider-specific line
    messages=[{"role": "user", "content": "Optimize this Python function."}],
)
print(response.choices[0].message.content)
```

The response is OpenAI-shaped no matter who answered, which is what makes the Streamlit app below
provider-agnostic without a single `if provider == ...`.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install streamlit litellm python-dotenv
```

```
litellm         1.97.0
streamlit       1.62.0
python-dotenv   1.2.3
```

## The key lives in `.env`, and `.env` is never committed

```text title=".env"
GEMINI_API_KEY=<REDACTED>
```

```bash
echo ".env" >> .gitignore
git check-ignore -v .env      # prove it, before the first commit
```

```
.gitignore:5:.env	.env
```

**`load_dotenv()` puts the key in the environment and `litellm` picks it up from there** — the key
is never passed as an argument, never lands in `st.session_state`, and never reaches a traceback.
`GEMINI_API_KEY` is the name LiteLLM looks for; each provider has its own
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and adding one is the whole cost of adding a provider.

## The whole app

```python title="app.py"
import os

import streamlit as st
from dotenv import load_dotenv
from litellm import completion

load_dotenv()

# One string is the whole provider choice. Swap it for "openai/gpt-4o" or
# "anthropic/claude-sonnet-4-20250514" and nothing else in this file changes.
MODELS = [
    "gemini/gemini-3.6-flash",
    "gemini/gemini-flash-latest",
]

st.title("LiteLLM chat")

if not os.getenv("GEMINI_API_KEY"):
    st.error("GEMINI_API_KEY is not set. Put it in .env next to this file.")
    st.stop()

model = st.sidebar.selectbox("model", MODELS)
if st.sidebar.button("Clear chat"):
    st.session_state.messages = []

st.session_state.setdefault("messages", [])

for m in st.session_state.messages:
    st.chat_message(m["role"]).write(m["content"])

if prompt := st.chat_input("Ask something"):
    st.session_state.messages.append({"role": "user", "content": prompt})
    st.chat_message("user").write(prompt)

    with st.chat_message("assistant"):
        try:
            stream = completion(
                model=model,
                messages=st.session_state.messages,
                stream=True,
            )
            # LiteLLM normalises every provider's stream into OpenAI-shaped
            # chunks, so st.write_stream needs no provider-specific handling.
            reply = st.write_stream(
                c.choices[0].delta.content or "" for c in stream
            )
        except Exception as e:  # noqa: BLE001 — surface the provider error verbatim
            st.error(f"{type(e).__name__}: {e}")
            st.session_state.messages.pop()  # don't leave a turn with no answer
            st.stop()

    st.session_state.messages.append({"role": "assistant", "content": reply})
```

Three things carry more weight than their line count:

- **`messages=st.session_state.messages`** sends the whole history, which is the only reason the
  model can answer a follow-up. Streamlit re-runs the entire script on every interaction, so
  `session_state` is what survives between turns — a plain local variable would reset each time and
  the app would look stateless.
- **`c.choices[0].delta.content or ""`** — the `or ""` is not defensive padding. Some chunks carry
  `None` as content (role announcements, finish markers), and `st.write_stream` raises on `None`.
- **`st.session_state.messages.pop()` in the error branch** removes the user turn whose request
  failed. Without it, a failed call leaves a question in the history with no answer after it, and
  every later turn resends that dangling pair.

```bash
.venv/bin/streamlit run app.py
```

## What it looks like

<img src="/01-install/img/litellm-chat-empty.png" width="620" alt="The empty chat app: a model selector and Clear chat button in the sidebar, an Ask something input">

Asking a question streams the answer back:

<img src="/01-install/img/litellm-chat-reply.png" width="620" alt="The app after one question, showing a streamed answer from Gemini">

The follow-up is what proves history is being sent — `100` is only answerable from the previous
turn, not from the question alone:

<img src="/01-install/img/litellm-chat-multiturn.png" width="620" alt="A follow-up question answered with 100, which requires the previous turn as context">

## The portability claim, tested

Repeating "it works with 100+ providers" proves nothing. Running the identical call against three
of them does:

```python title="swap_check.py"
msgs = [{"role": "user", "content": "Reply with exactly: ok"}]
for model in ["gemini/gemini-3.6-flash", "openai/gpt-4o-mini", "anthropic/claude-sonnet-4-20250514"]:
    r = completion(model=model, messages=msgs)
```

```
gemini/gemini-3.6-flash             -> 'ok'
openai/gpt-4o-mini                  -> InternalServerError: OpenAIException - Missing credentials
anthropic/claude-sonnet-4-20250514  -> AuthenticationError: Missing Anthropic API Key
```

**Read what those two failures are, and are not.** No `TypeError`, no unexpected keyword, no
"messages must be a list of X" — the signature was accepted and the request was built for each
provider. The only thing missing is a key. That is the strongest honest evidence available on a
machine holding exactly one credential, and it is worth more than a claim that all three answered.

## Verification checklist

- [x] `git check-ignore -v .env` names the ignoring rule — run **before** the first commit
- [x] A non-streaming `completion()` returns content, model name and token usage from Gemini
- [x] A streaming call yields multiple chunks that join into the full answer
- [x] The Streamlit app renders and answers a question end to end in a browser
- [x] A follow-up question is answered correctly from history, not from the question alone
- [x] Pointing the same code at two other providers fails on **credentials**, not on syntax
- [x] A retired model name returns a `NotFoundError` naming its replacement — **hit for real**

## Rollback

```bash
rm -rf .venv
```

`.env` stays; it is the one file worth keeping and the one that must not be committed.

## Where this bit us

**A hardcoded model name was already retired, and the API named its replacement.** The first
version used `gemini/gemini-2.0-flash`, which had been current not long before:

```
litellm.NotFoundError: GeminiException - {
  "error": {
    "code": 404,
    "message": "This model models/gemini-2.0-flash is no longer available.
                Please update your code to use models/gemini-3.6-flash
                for the latest features and improvements.",
    "status": "NOT_FOUND"
  }
}
```

Two things worth taking from it. **A `404` here is good news** — it means the key authenticated and
the request reached the provider; a bad key gives `401`/`AuthenticationError` instead, so the status
code tells you which half of the setup is wrong. And **model names rot faster than code does**: the
`gemini-flash-latest` alias in `MODELS` exists so there is always one entry in the picker that
cannot go stale, at the cost of not knowing exactly which model answered.

**`litellm` has no `__version__`.** `import litellm; litellm.__version__` raises `AttributeError`
rather than returning a string, because the module defines a `__getattr__` that rejects unknown
names. Use `pip list | grep litellm` to record the version — worth knowing before writing it into a
startup banner and getting a crash on line one.

**`load_dotenv()` fails when the script is piped into Python.** Running the smoke test as
`python - <<'PY' ... PY` produced:

```
File ".../dotenv/main.py", line 372, in find_dotenv
    assert frame.f_back is not None
AssertionError
```

`find_dotenv()` walks the call stack to locate the caller's directory, and there is no caller frame
when the code arrives on stdin. Nothing to do with the `.env` file, which was correct the whole
time. Save the script to a file, or pass `load_dotenv("/explicit/path/.env")`.

## Follow-ups

- [ ] Add a second provider key and confirm the swap end to end — today only the *signature* is proven portable, not a completed call
- [ ] Turn on `litellm.success_callback` cost tracking and show the per-turn spend in the sidebar; the response already carries token usage
- [ ] Configure `fallbacks=[...]` so a provider outage rolls to the next model instead of surfacing an error to the user
- [ ] Try the LiteLLM proxy server, so the key lives in one place rather than in every app's `.env`
- [ ] Containerise and deploy through [[gitlab-ci-argocd-fastapi-procedure]] — the key becomes a Kubernetes secret, not a file

## Related

[[fastapi-mvc-layering]] — the other small Python app in this repo, and where `.env`-style config would go if it grew one.
[[gitlab-ci-argocd-fastapi-procedure]] — the pipeline that would deploy this, and how a secret gets into a cluster without landing in Git.
[[bruno-api-client]] — for exercising an LLM endpoint directly, outside the app that wraps it.
