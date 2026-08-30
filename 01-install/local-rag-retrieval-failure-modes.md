---
title: Local RAG — two checkbox lines, one answered as a procedure and one as a fact
date: 2026-08-28
domain: install
tags: [rag, llm, embeddings, retrieval, evaluation]
stack: [ollama, bge-m3, chromadb, streamlit, python]
summary: A RAG over this repository's own 64 documents, run entirely on a laptop. Both of its worst answers are a checkbox line lifted out of a document — an unchecked to-do returned as a four-step procedure, and a checked verification line returned as the answer to a different question, the second one surviving the "reply I don't know" instruction that fixes the first.
source: handson
env: Ollama 0.31.1 · bge-m3 (1024-dim) · all-minilm (384-dim) · llama3.2:3b · gemma3:4b · Chroma 1.5.9 (cosine) · Streamlit 1.62 · Python 3.13 · macOS 14.7.5 on M1 Pro / 16 GB
verified: 2026-08-28
verifiability: partial
verifiability-note: Every distance, chunk count and answer below was produced on this machine against this repository as the corpus, so the findings are reproducible but corpus-specific — the numbers will differ on other documents. Generation was measured on two models over three questions, which is enough to show the failures are model-dependent and not enough to rank the models. Reranking, hybrid search and a labelled evaluation set are all absent, and 20 questions is far too few to tune a threshold on.
duration: 90–120 min
risk: low
---

> **Verified 2026-08-28.** The screenshots are the running application. Both failures on this page are
> a Markdown checkbox line pulled out of a document that meant something else by it.

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

## The first checkbox: `- [ ]` answered as a procedure

<img src="/01-install/img/rag-fabricated-from-a-todo.png" width="620" alt="The RAG UI answering a question about Argo CD SSO with Okta on llama3.2: it says the answer is not explicitly stated, then gives four numbered steps, and the retrieved chunk below is the Follow-ups section of the Argo CD document">

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

### That is llama3.2, not RAG

The same question, the same chunk, `gemma3:4b`:

> The context does not provide instructions on how to configure Argo CD SSO with Okta. **It mentions
> that OIDC (SSO) is a follow-up item to be wire up**, but the timeline for this is "📅 2026-08-21"
> and no details are given about the implementation.

**gemma3 read the checkbox as a checkbox.** It found the same line, recognised what it was, said so,
and stopped — without being told it was allowed to. Identical retrieval, opposite outcome, so the
failure above is a property of the generator, not of the corpus or the pipeline.

Across three out-of-corpus questions on the plain prompt:

```
  question                         llama3.2:3b            gemma3:4b
  Argo CD SSO with Okta            fabricated, 841 ch     refused, named the to-do, 242 ch
  Vault AWS auth role TTL          refused, 306 ch        refused, 267 ch
  Prometheus sharding with Thanos  fabricated, 958 ch     hedged then drifted, 998 ch
```

The third row is its own category. gemma3 opens *"Based on the provided context, here's how you can
shard Prometheus with Thanos"*, immediately concedes there is no direct answer, and then lists
exemplar configuration under that promise. **Neither a refusal nor an answer**, and the opening
sentence is what a reader remembers.

**Answer length is the one signal that held.** Every genuine refusal came in under 310 characters and
every fabrication ran past 840. Three questions on two models is not a rule — but it is a better
discriminator than distance was, and it costs nothing to log.

## The escape hatch, and the second checkbox

<img src="/01-install/img/rag-refusal-same-context.png" width="620" alt="The same Argo CD SSO question and the same retrieved chunk at distance 0.4315, with the allow I don't know option enabled, and the answer is simply I don't know">

```python
PROMPT_STRICT = """Answer the question using ONLY the context below.
If the context does not contain the answer, reply exactly: I don't know.
```

**Same question, same retrieval, same chunk at `0.4315`** — the two screenshots show the identical
source and distance. Only the prompt differs, and llama3.2's four-step procedure becomes:

```
I don't know.
```

Retrieval was never the variable. **The model was willing to abstain and had not been told it was
allowed to**, which is cheaper than any amount of threshold tuning and belongs in the default prompt.

It is also not a fix. Six strict runs — three questions on two models — and **five returned exactly
`I don't know`. This is the sixth:**

<img src="/01-install/img/rag-escape-hatch-leaks.png" width="620" alt="The Thanos sharding question on gemma3 with the I don't know option enabled, answered with a statement about Prometheus exemplar counts, retrieved from the Prometheus daily note at distance 0.4465">

> Prometheus stores **0** exemplars without `--enable-feature=exemplar-storage` and **8** with it —
> checked both ways

**That is a verification-checklist line, copied verbatim** from [[grafana-correlate-three-signals]] —
including the trailing "checked both ways", which is that document telling its reader how the item was
proven. Every word of it is true and it was measured. It is also not about Thanos, not about sharding,
and not an answer to the question on screen.

So both failures on this page are the same move on a different box. **An unchecked `- [ ]` became a
procedure; a checked `- [x]` became an answer.** A checklist line is written to be read next to its
heading and its document; pulled into a context window it is a short, confident, well-formed sentence
with no marker saying which question it was the answer to.

The instruction offered two options — answer, or say `I don't know` — and the model took a third:
**answer a question the context does answer.** That is harder to catch than the first failure. There
is no hedge to notice and nothing wrong to verify. **A reader who checks the claim will find it
correct** and carry away that they asked about sharding and got a fact about exemplars, which reads as
their own misunderstanding rather than the system's.

### The refusal detector was wrong in both directions

The first pass at measuring this scanned answers for refusal phrases:

```python
refused = any(s in a.lower() for s in
              ["not provided", "does not", "not mention", "no information",
               "not contain", "don't know"])
```

```
  llama3.2  Argo CD SSO      refused=True   841 ch   <- fabrication, scored as a refusal
  llama3.2  Thanos sharding  refused=False  958 ch   <- fabrication, scored correctly
```

**Two fabrications of the same shape, scored opposite ways** — both open by admitting the context does
not cover the question, and only one happens to phrase it with a word on the list. The detector was
sorting on phrasing and never on whether an answer followed. Same false-pass shape as the
`SYNCED=True` in [[crossplane-cloud-resources-as-crds]].

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
- [x] On the plain prompt, `llama3.2:3b` answers the Argo CD SSO question with a four-step procedure built from an **unchecked `- [ ]` to-do**
- [x] On the same prompt and the same chunk, `gemma3:4b` **identifies that line as a follow-up item** and declines — the failure is model-dependent
- [x] Of six plain-prompt runs, **two fabricated, one hedged then drifted, three refused**; every refusal was under 310 characters and every fabrication over 840
- [x] Adding one line to the prompt returns `I don't know.` for the **same question and the same retrieved chunk at 0.4315**
- [x] That line works in **five of six** strict runs; on the sixth, `gemma3:4b` answers the Thanos question with a **`- [x]` verification line copied verbatim** from another document
- [x] The keyword refusal detector scores **two fabrications of the same shape in opposite directions**
- [x] A Korean question retrieves the correct English document with bge-m3, and pulls in a wrong document at rank 2 with all-minilm
- [x] The 1200-char index ranks first a chunk without the answer; the 300-char index surfaces the answering line at rank 3

## Rollback

```bash
pkill -f "streamlit run app.py"
rm -rf chroma .venv
ollama rm bge-m3 all-minilm      # keep the chat models if you use them elsewhere
```

## Where this bit us

**The first threshold experiment produced the wrong conclusion, and looked rigorous.** Eleven
questions, clean separation, a margin — and it was an artefact of choosing out-of-corpus questions
about tools the corpus never mentions. **A retrieval test set is only as good as its hardest negative**,
and the hardest negatives are questions about the exact tools you documented, asking the one thing you
did not write down. That is also what real users ask.

**This page had to be rewritten after the second model finished downloading.** The first version was
built on `llama3.2:3b` alone and stated as a property of RAG that the model turns to-do items into
procedures, and as a fix that one prompt line stops it. **gemma3:4b disproved the first claim and the
sixth strict run disproved the second** — on the same corpus, the same index, the same chunks. A
single-model result reads exactly like a general one, because nothing in it is marked as
model-specific. Any conclusion here about generation behaviour is a claim about the model that
produced it.

**A checkbox is the most dangerous line in a corpus, in both states.** Every document in this
repository ends in unchecked boxes describing work that was explicitly not done, and contains checked
ones asserting facts about a specific setup. To an embedder both are topical, well-formed, on-subject
prose; in a context window both are short confident sentences stripped of the heading that gave them
their meaning. `- [ ]` says *not done* and `- [x]` says *proven, of this document's question* — and
neither marker survives the trip. Dropping `## Follow-ups` at ingest would have prevented the first
failure and done nothing about the second, because the second line is one the document was right to
write.

**An escape hatch stops the model inventing, not the model drifting.** `reply exactly: I don't know`
gives a model two doors, and its worst output was neither: a correct, sourced fact answering a
question nobody asked. Refusal instructions constrain what an answer may be built from — they say
nothing about whether it addresses the question, and no amount of tightening that sentence would have
caught this one.

**Distances are not comparable across embedding models, and the numbers invite it.** bge-m3's 0.44
and all-minilm's 0.65 above are not on the same scale — different vector spaces. Displaying both as
"distance" in the same UI, as this lab's app does, makes the comparison look meaningful when only the
*ranking within one model* is. A threshold tuned on one embedder is meaningless the moment it changes,
which is a second reason the threshold approach is fragile.

## Follow-ups

- [ ] Score answers for whether they address the question, not whether they refuse — the exemplar leak passes every check on this page except a human reading it
- [ ] Log answer length next to every response and see whether the under-310 / over-840 split holds past three questions, since it is currently the only signal that separated refusals from fabrications
- [ ] Try carrying each chunk's heading path into the context so a `- [x]` arrives labelled as a verification line rather than as a free-standing sentence
- [ ] Exclude `## Follow-ups` at ingest and re-ask the Argo CD SSO question on `llama3.2:3b`, to confirm the first failure is corpus-shaped
- [ ] Add a reranker over the top 20 and see whether it separates the adjacent out-of-corpus questions that distance alone cannot
- [ ] Build a labelled set of 100+ questions with known answers — 20 questions and 3 generation prompts is too few to conclude anything, including the conclusions above
- [ ] Try hybrid retrieval (BM25 + dense) on the exact-string questions like `or vector(0)`, which scored worst of all in-corpus questions at 0.489
- [ ] Measure how often the strict prompt refuses a question the corpus *does* answer — this page never checked the cost of the fix

## Related

[[grafana-correlate-three-signals]] — the document whose verification line became an answer to someone else's question.
[[markitdown-document-to-markdown]] — turning documents into the Markdown this corpus is made of.
[[litellm-streamlit-chat]] — the same Streamlit shape, against a hosted model instead of a local one.
[[pydantic-ai-structured-output]] — forcing a model to answer in a checkable shape, which is the other half of trusting output.
[[crossplane-cloud-resources-as-crds]] — the same false-pass shape: a check that reports success about something that is not true.
