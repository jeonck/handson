---
title: Local RAG — the answer it built out of an unchecked to-do
date: 2026-08-28
domain: install
tags: [rag, llm, embeddings, retrieval, evaluation]
stack: [ollama, bge-m3, chromadb, streamlit, python]
summary: A RAG over this repository's own 64 documents, run entirely on a laptop. Asked something the corpus does not answer, it retrieved a Follow-ups section — an unchecked to-do — and returned it as a four-step procedure, at a distance closer than real questions score. The same retrieval with one extra prompt line answers "I don't know".
source: handson
env: Ollama 0.31.1 · bge-m3 (1024-dim) · all-minilm (384-dim) · llama3.2:3b · Chroma 1.5.9 (cosine) · Streamlit 1.62 · Python 3.13 · macOS 14.7.5 on M1 Pro / 16 GB
verified: 2026-08-28
verifiability: partial
verifiability-note: Every distance, chunk count and answer below was produced on this machine against this repository as the corpus, so the retrieval findings are reproducible but corpus-specific — the exact numbers will differ on other documents. Generation was verified with llama3.2:3b; gemma3:4b was the intended chat model and its download did not finish in the session, so the generation half is unverified on that model. Reranking, hybrid search and a labelled evaluation set are all absent, and the sample of 20 questions is far too small to tune a threshold on.
duration: 60–90 min
risk: low
---

> **Verified 2026-08-28.** The screenshots are the running application, not mock-ups. The answer in
> the first one is built from a line of this repository that says the work was never done.

RAG is usually presented as a way to ground a model in your documents. **The interesting question is
what it does when your documents do not contain the answer**, because the retriever will return
something regardless — `top_k` is a count, not a judgement.

The corpus here is this repository: 64 hands-on documents, 1.1M characters. Using it means the ground
truth is known, which is the only way the results below can be checked.

## The pipeline

```python title="rag.py"
def embed(texts, model="bge-m3"):
    """One call per batch. Ollama returns embeddings in the order given."""
    return _post("/api/embed", {"model": model, "input": texts})["embeddings"]


def chunk(text, size=1200, overlap=150):
    """Fixed-size character chunks. Crude on purpose — the point of the page
    is what chunk size does to retrieval, not to hide it behind a splitter."""
```

```
  embedding dims: 1024
  corpus docs: 64
  total chars: 1102439

  c1200:        1078 chunks in 183s
  c300:         4271 chunks in 334s
  c1200_minilm: 1078 chunks in  18s
```

**Three indexes, because one index cannot show you a trade-off.** The last line is the first
measurement worth having: the same 1078 chunks took **183 seconds** with bge-m3 and **18 seconds**
with all-minilm — a tenfold difference in indexing cost for the quality compared below.

## Distance does not tell you whether the answer is there

Twelve questions the corpus answers, eight it does not, ranked by the distance of their best hit:

```
  0.323  [IN ]  Why does podman exec fail on a Talos node?
  0.326  [IN ]  What happens when you delete the repository row in Gitea?
  0.360  [IN ]  Why did the Harbor installer fail on arm64?
  0.375  [IN ]  Which package is missing from the walgit Containerfile?
  0.385  [IN ]  What burn rate exhausts a 28-day error budget in two days?
  0.386  [IN ]  How many S3 CRDs does the AWS provider register?
  0.404  [IN ]  How long did Crossplane take to recreate the deleted ConfigMap?
  0.410  [IN ]  What is the LocalStack edition reported by the info endpoint?
  0.426  [IN ]  What is the default ISM job interval in OpenSearch?
  0.432  [OUT]  How do I configure Argo CD SSO with Okta?
  0.447  [OUT]  How do I set Vault's AWS auth method role TTL?
  0.452  [OUT]  How do I shard Prometheus with Thanos receive?
  0.459  [IN ]  What does gitea dump contain?
  0.460  [IN ]  What is the unseal threshold for Vault in the lab?
  0.473  [OUT]  How do I set up Istio ambient mode?
  0.473  [OUT]  How do I enable Cloudflare Workers KV?
  0.481  [OUT]  What is the syntax for an Ansible playbook loop?
  0.489  [IN ]  What does or vector(0) fix in a Prometheus ratio?
  0.498  [OUT]  What is the Gitea webhook payload schema?
  0.504  [OUT]  How do I configure Consul service mesh federation?

  IN  (12): 0.323 ~ 0.489
  OUT  (8): 0.432 ~ 0.504
```

**The ranges overlap, and they overlap in the worst place.** Three questions the corpus cannot answer
score *closer* than three it can. Any cutoff that rejects "Argo CD SSO with Okta" (0.432) also
rejects "what does `gitea dump` contain" (0.459), which is answered in detail on its page.

This is worth dwelling on because **the first version of this experiment said the opposite.** With
eleven questions and only obviously-foreign out-of-corpus examples — Consul, Mongolia — the ranges
separated cleanly with a margin of 0.013, and a threshold looked viable. Adding out-of-corpus
questions that name tools the corpus *does* cover destroyed the separation. **The questions that
break a similarity threshold are the plausible ones**, and a test set without them will tell you your
threshold works.

## What it does with a question it cannot answer

<img src="/01-install/img/rag-fabricated-from-a-todo.png" width="620" alt="The RAG UI answering a question about Argo CD SSO with Okta: it says the answer is not explicitly stated, then gives four numbered steps, and the retrieved chunk below is the Follow-ups section of the Argo CD document">

Read the answer and then read the chunk it came from.

> The answer is not explicitly stated in the provided context. **However, based on the related topics
> and documents, it can be inferred that** configuring Argo CD SSO with Okta involves several steps:
> 1. Setting up OIDC (OpenID Connect) for SSO. 2. Disabling the local `admin` account. 3. Enabling
> mutual TLS (mTLS) between `argocd-server`, `argocd-application-controller`, …

And the retrieved chunk, distance `0.4315`, from [[argocd-helm-ha-install]]:

```
## Follow-ups

- [ ] Wire up OIDC (SSO), then disable the local `admin` account 📅 2026-08-21
```

**Steps 1 and 2 are an unchecked to-do box.** The document says this work was never done; the model
read it as a procedure and numbered it. Step 3 is genuine content from a different page about
repo-server mTLS, welded on because it was in the same window. The component names are real, which is
what makes the whole thing read as authoritative.

**This is worse than a plain hallucination.** The answer opens by admitting the context does not cover
the question — and then answers anyway. The hedge is what makes it dangerous: it looks like a model
being careful, and a reader who skims one sentence to reach the numbered list gets a fabricated
runbook with real component names in it.

### It also defeated the check I wrote to catch it

The first pass at measuring this scanned answers for refusal phrases:

```python
refused = any(s in a.lower() for s in
              ["not provided", "does not", "not mention", "no information",
               "not contain", "don't know"])
```

```
  Q: How do I configure Argo CD SSO with Okta?
  refused: True
  answer: The answer is not explicitly stated in the provided context. However, …
```

**`refused: True`, for the answer above.** The detector matched the hedge and never looked at what
followed it. A refusal check that greps for apologetic language measures politeness, not abstention —
which is the same shape of false pass as the `SYNCED=True` in [[crossplane-cloud-resources-as-crds]].

## The fix is one line of prompt, and it works

<img src="/01-install/img/rag-refusal-same-context.png" width="620" alt="The same question and the same retrieved chunk at distance 0.4315, with the allow I don't know option enabled, and the answer is simply I don't know">

```python
PROMPT_STRICT = """Answer the question using ONLY the context below.
If the context does not contain the answer, reply exactly: I don't know.
```

**Same question, same retrieval, same chunk at `0.4315`** — the screenshots show the identical
source and distance. Only the prompt differs, and the answer becomes:

```
I don't know.
```

Retrieval was never the variable. **The model was willing to abstain and had not been told it was
allowed to**, which is a cheaper fix than any amount of threshold tuning and should be the default
rather than an option.

## Two more measurable differences

**Cross-lingual retrieval is where bge-m3 earns its ten-times indexing cost.** A Korean question
against an English corpus — *"Vault 봉인 해제에 필요한 키 개수는?"*:

```
  bge-m3:
    0.439  01-install/vault-secrets-rotation.md
    0.446  01-install/vault-secrets-rotation.md
    0.453  01-install/vault-secrets-rotation.md
  all-minilm:
    0.655  01-install/vault-secrets-rotation.md
    0.674  01-install/walgit-git-server-on-object-storage.md      <- wrong document
    0.681  01-install/vault-secrets-rotation.md
```

Worth being precise, because the usual claim is too strong: **all-minilm did not fail** — its top hit
is the correct document. What degrades is everything after: distances rise by ~0.2 and an unrelated
page enters the top three. With `k=3` and a model that trusts its context, that wrong page is in the
prompt.

**Chunk size decides whether the answering sentence is even in the window.** The same question against
1200- and 300-character indexes:

```
  c1200:  0.426  opensearch-…  | alog to remind you.  **The security plugin blocks the whol…
  c300:   0.485  opensearch-…  | m:  ```   plugins.index_state_management.job_interval
```

Both retrieve the right document. **The 1200-character index ranks first a chunk that does not
contain the answer**, while the 300-character index surfaces the literal
`plugins.index_state_management.job_interval` text — at rank 3, with a *worse* distance. Ranking and
usefulness are not the same axis, and nothing in the scores tells you which chunk holds the fact.

## Verification checklist

- [x] bge-m3 returns **1024-dimensional** embeddings; all-minilm returns 384
- [x] The corpus is **64 documents / 1,102,439 characters**, indexed as 1078 chunks at size 1200 and 4271 at size 300
- [x] Indexing the same 1078 chunks takes **183s** with bge-m3 and **18s** with all-minilm
- [x] Across 20 questions the in-corpus and out-of-corpus distance ranges **overlap** — 0.323–0.489 against 0.432–0.504
- [x] Three out-of-corpus questions score closer than three in-corpus ones, so **no cutoff separates them**
- [x] An out-of-corpus question produces a four-step procedure built from an **unchecked `- [ ]` to-do**
- [x] A keyword-based refusal detector marks that fabricated answer as `refused: True`
- [x] Adding one line to the prompt returns `I don't know.` for the **same question and the same retrieved chunk at 0.4315**
- [x] A Korean question retrieves the correct English document with bge-m3, and pulls in a wrong document at rank 2 with all-minilm
- [x] The 1200-char index ranks first a chunk without the answer; the 300-char index surfaces the answering line at rank 3

## Rollback

```bash
pkill -f "streamlit run app.py"
rm -rf chroma .venv
ollama rm bge-m3 all-minilm      # keep the chat model if you use it elsewhere
```

## Where this bit us

**The first threshold experiment produced the wrong conclusion, and looked rigorous.** Eleven
questions, clean separation, a margin — and it was an artefact of choosing out-of-corpus questions
about tools the corpus never mentions. **A retrieval test set is only as good as its hardest negative**,
and the hardest negatives are questions about the exact tools you documented, asking the one thing you
did not write down. That is also what real users ask.

**Follow-ups and to-do lists are the most dangerous text in a corpus.** Every document in this
repository ends with unchecked boxes describing work that was explicitly *not* done. To an embedder
they are topical, well-formed, on-subject prose about the thing you asked; to a generator they are
instructions. **The corpus is full of confident sentences about things that never happened**, and
nothing in the chunk marks them as aspirational. Excluding `## Follow-ups` sections at ingest time
would have prevented the headline failure on this page — which is a corpus-specific fix, and the
general lesson is to look at what your documents contain that is *shaped* like an answer without
being one.

**Distances are not comparable across embedding models, and the numbers invite it.** bge-m3's 0.44
and all-minilm's 0.65 in the cross-lingual test above are not on the same scale — they come from
different vector spaces. Displaying both as "distance" in the same UI, as this lab's app does, makes
the comparison look meaningful when only the *ranking within one model* is. Any threshold tuned on one
model is meaningless the moment the model changes, which is a second reason the threshold approach is
fragile.

## Follow-ups

- [ ] Re-run the generation half on `gemma3:4b` — it was the intended chat model and its 3.3 GB pull did not finish here, so every generated answer on this page is `llama3.2:3b`
- [ ] Exclude `## Follow-ups` and other unchecked-box sections at ingest and re-ask the Argo CD SSO question, to confirm the headline failure is corpus-shaped rather than model-shaped
- [ ] Add a reranker over the top 20 and see whether it separates the adjacent out-of-corpus questions that distance alone cannot
- [ ] Build a labelled set of 100+ questions with known answers, since 20 is far too few to conclude anything about a threshold — including the conclusions above
- [ ] Try hybrid retrieval (BM25 + dense) on the exact-string questions like `or vector(0)`, which scored worst of all in-corpus questions at 0.489
- [ ] Measure how often the strict prompt refuses a question the corpus *does* answer — this page never checked the cost of the fix

## Related

[[markitdown-document-to-markdown]] — turning documents into the Markdown this corpus is made of.
[[litellm-streamlit-chat]] — the same Streamlit shape, against a hosted model instead of a local one.
[[pydantic-ai-structured-output]] — forcing a model to answer in a checkable shape, which is the other half of trusting output.
[[crossplane-cloud-resources-as-crds]] — the same false-pass shape: a check that reports success about something that is not true.
