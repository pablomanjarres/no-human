# RAG + indexing over the SICK catalog

**Package:** `packages/rag` (`@no-human/rag`)
**Corpus:** `sick-catalog-dataset/` — 1,776 orderable SKUs, 110 families, 100 % order-number coverage of the SICK 2015/2016 summary catalog.

This is the retrieval layer under the cross-brand equivalence engine. It answers
one question well: _given messy human input, which SICK parts are worth
considering, and where in the catalog can each claim be checked?_

It deliberately does **not** answer "which part is the replacement". That is the
constraint solver's job, and the split is the whole point.

---

## 1. The rule that makes this defensible

> **Retrieval never picks the part.**

Semantic search maps a competitor part number, a plain-language description, a
label photo, or a BOM row onto a _candidate set_. Narrowing that set to a
recommendation is a **deterministic solve over normalized structured specs** —
re-derivable by hand, from a printed table, by a skeptical judge.

Similarity score never enters a correctness decision. That separation is what
lets the system answer

> "under 12 ms **and** PNP **and** IP69K"

which no pure vector search can, and it is why "isn't this just RAG?" has a real
answer rather than a defensive one.

```
                        ┌──────────────────────────┐
 part number            │                          │
 description   ────────▶│  Resolver  (LLM)         │──▶ SpecConstraints
 label photo            │  messy input → constraints│    (the "spec vector")
 BOM row                └──────────────────────────┘
                                    │
                                    ▼
              ┌─────────────────────────────────────────┐
              │  packages/rag                            │
              │                                          │
              │   1. structured PREFILTER  ◀── constraints
              │   2. BM25 lexical lane                   │
              │   3. dense lane (voyage-context-3)       │
              │   4. RRF fusion                          │
              │   5. cross-encoder rerank (rerank-2.5)   │
              │        ──▶ candidates + citations        │
              │                                          │
              │   solve_constraints()  ← DETERMINISTIC   │
              │        ──▶ pass / fail / unknown verdicts│
              └─────────────────────────────────────────┘
                                    │
                                    ▼
                        ┌──────────────────────────┐
                        │  Challenger  (LLM)       │──▶ cited match
                        │  attacks the match       │    or honest refusal
                        └──────────────────────────┘
```

---

## 2. Why contextualized embeddings, specifically

A catalog variant row carries almost no standalone meaning:

```
GTE6-P4212 · 1051781 · PNP · M8 4-pin · ≤ 300 mm
```

Embedded on its own, that is a bag of tokens no engineer's question will ever
land near. Embedded as **chunk 4 of the G6 family document** — whose header card
reads _"G6 — diffuse photoelectric sensor, visible red light, energetic
detection principle, plastic housing"_ — the same row inherits the semantics of
its family and becomes reachable from "photoelectric sensor that sees a box at
30 cm".

That is exactly what Voyage's contextualized endpoint does: it embeds a
document's chunks **together**, so each chunk vector is aware of its neighbours.

So the corpus is shaped to match:

| Unit         | Maps to                                  |
| ------------ | ---------------------------------------- |
| **Document** | one product family (110 of them)         |
| **Chunk 0**  | the family card — shared descriptive text |
| **Chunk 1…n** | one card per SKU (variants + accessories) |

`POST /contextualizedembeddings` takes `inputs: string[][]` — an array of
documents, each an array of its chunks — and returns vectors grouped the same
way. The response ordering is **not** guaranteed, so vectors are re-projected by
`(documentIndex, chunkIndex)` before being zipped back onto chunks. A document
that comes back only partially embedded fails the whole build to lexical-only
rather than producing a vector array with holes: a half-filled dense index
degrades retrieval invisibly, which is worse than not having one.

### The language gap

The catalog is **Spanish**. The queries are **English** ("retroreflective, PNP,
sees a box at 40 cm") or competitor part numbers. Left alone, the lexical lane
scores ~zero and the dense lane degrades.

So every card is rendered **bilingually**: the verbatim Spanish (which is what
`provenance` cites, so it has to survive) plus an English gloss and the
industry-standard synonyms a competitor datasheet would use — `supresión del
fondo` also reads _background suppression (BGS)_, `autocolimación` also reads
_retroreflective_. Numeric specs are rendered in every notation an engineer
might type, so `≤ 300 mm` also reads `30 cm` and `0.3 m` and a query asking for
40 cm can find a 400 mm part.

---

## 3. The five-stage query pipeline

1. **Structured prefilter.** Hard constraints (PNP, IP ≥ 69, response ≤ 12 ms)
   restrict the candidate set _before_ anything is ranked. Ranking cannot repair
   a wrong candidate set, so the filter comes first, never as a post-filter.
2. **Lexical lane** — BM25 (MiniSearch) over chunk text. Tokenized on
   `[^a-z0-9]+` rather than MiniSearch's default whitespace/hyphen split, so
   `GTE6-P4212` yields `gte6` **and** `p4212` as well as the joined form.
   Digit-bearing tokens (`m12`, `ip67`, part numbers) are never stemmed.
3. **Dense lane** — the query is embedded with `input_type: "query"` and cosine-
   searched against the chunk vectors.
4. **RRF fusion** — Reciprocal Rank Fusion (Cormack et al., 2009) over whichever
   lanes actually produced a ranking. RRF needs no score comparability across
   rankers, which is what lets a lane drop out cleanly.
5. **Cross-encoder rerank** — `rerank-2.5` over the fused head.

Each hit reports **honest per-lane signals**: a lane that did not run reports
`null`, never a fabricated rank. The trace panel renders these, and a made-up
number would be a lie on screen.

---

## 4. Fail-open, all the way down

Every network lane returns a degraded-but-valid result instead of throwing:

| Failure                     | Behaviour                                        |
| --------------------------- | ------------------------------------------------ |
| No `VOYAGE_API_KEY`         | Dense + rerank lanes skipped; BM25 + solver only  |
| Voyage 4xx/5xx, timeout     | Same — lane skipped, search still returns         |
| Partial embedding response  | Whole dense lane dropped; index stays lexical     |
| Rerank fails                | Falls back to the identity ranking, so the fused RRF order survives |

**The demo runs with no network and no API key.** The dense and rerank lanes are
a quality lift, never a hard dependency — which is also the honest answer when a
judge asks what happens when the venue wifi dies.

---

## 5. Absent is not failing

The single most damaging defect this system could have is treating an unstated
spec as a constraint failure.

This is the _summary_ catalog (`resumido`). Its selection tables list ordering
options — output, connection, range — but usually omit full electrical specs.
Only 41 of 1,776 SKUs state a supply voltage. So most constraint checks against
most SKUs land on **unknown**, and that is faithful to the source, not a gap.

Therefore every constraint check emits one of three verdicts:

| Verdict   | Meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `pass`    | The catalog states a value and it satisfies the constraint. |
| `fail`    | The catalog states a value and it violates the constraint.  |
| `unknown` | The catalog is **silent**. Not a failure.                   |

`viable === (failed === 0)` — which explicitly does **not** mean "fully
verified". A SKU with five unknowns and zero fails is viable, and any caller
that reports it without surfacing the unknown count is presenting a guess as a
confirmed match. The solver ranks by _fewest unknowns, then most passes_, so the
best-evidenced candidate wins rather than the luckiest one.

This is also where the honest no-match comes from: _"closest is X, but the
catalog never states its response time — you'd be trusting an unverified spec."_

---

## 6. Layout

```
packages/rag/src/
  types.ts                    the shared contract — read this first
  corpus/
    loadCatalog.ts            JSONL + CSV → Catalog (the only snake_case boundary)
    chunker.ts                Catalog → RagChunk[], bilingual, family-grouped
  filter/
    normalize.ts              messy Spanish → NormalizedSpec (conservative)
    constraints.ts            the deterministic solver + verdicts
  embed/
    voyageContextEmbed.ts     /contextualizedembeddings, fail-open
    voyageRerank.ts           /rerank, fail-open to identity
  index/
    bm25Index.ts              lexical lane
    denseIndex.ts             cosine lane
    rrf.ts                    fusion + cosine, fail-soft math
    store.ts                  artifact (base64 Float32) read/write
  buildIndex.ts               corpus → index artifact
  retrieve.ts                 the five-stage pipeline
  tools.ts                    Claude tool definitions
  cli.ts                      sick-rag index | search | get | solve | stats
```

---

## 7. Usage

```bash
# Build the index. Add --no-embed to force lexical-only.
node --experimental-strip-types packages/rag/src/cli.ts index

# Hybrid search with hard constraints
node --experimental-strip-types packages/rag/src/cli.ts search \
  "retroreflective sensor sees a box at 40 cm" --pnp --ip 67 --top 5

# Pure deterministic solve — prints the per-constraint verdict table
node --experimental-strip-types packages/rag/src/cli.ts solve \
  --pnp --ip69k --response-max 12

# One SKU, fully cited
node --experimental-strip-types packages/rag/src/cli.ts get 1051781
```

From the agent side, `createCatalogTools(retriever)` returns the Messages API
tool definitions: `search_catalog`, `get_product`, `solve_constraints`,
`compare_products`, `list_family`, `index_stats`.

The tool descriptions carry the division of labour explicitly — `search_catalog`
states that its ranking is a relevance heuristic and must not be taken as
evidence of technical equivalence, and `solve_constraints` states that an
`unknown` verdict means the catalog is silent. Recent Claude models under-reach
for tools unless the description says _when_ to call them, so those descriptions
are load-bearing prompt surface, not documentation.

## 8. Configuration

All optional. With none of it set, the system runs lexical-only.

| Variable                  | Default                        | Purpose                       |
| ------------------------- | ------------------------------ | ----------------------------- |
| `VOYAGE_API_KEY`          | —                              | Enables dense + rerank lanes  |
| `VOYAGE_CONTEXT_API_KEY`  | falls back to `VOYAGE_API_KEY` | Separate key for embeddings   |
| `VOYAGE_CONTEXT_MODEL`    | `voyage-context-3`             | Contextualized model          |
| `VOYAGE_RERANK_MODEL`     | `rerank-2.5`                   | Cross-encoder reranker        |
| `VOYAGE_CONTEXT_ENDPOINT` | `https://api.voyageai.com/v1`  | Embedding base URL            |
| `SICK_RAG_INDEX`          | `sick-catalog-dataset/rag-index.json` | Artifact path          |
