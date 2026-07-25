/**
 * The hybrid retrieval engine — the object the agent's tools actually call.
 *
 * One {@link SerializedIndex} in, one {@link Retriever} out. Building the BM25
 * and dense lanes is the expensive part (MiniSearch tokenizes ~1,900 cards, and
 * every vector is base64-decoded), so it happens exactly once at construction
 * and every subsequent query is a scan over prebuilt structures.
 *
 * ## The pipeline, and why the order is not negotiable
 *
 * 1. **Structured prefilter.** When the caller supplies {@link SpecConstraints},
 *    the allowed SKU set is computed *first*, and the ranking lanes are shown
 *    nothing else. Ranking cannot repair a wrong candidate set: if you rank the
 *    whole catalog and then throw away the non-conforming hits, a query like
 *    "PNP and IP69K and under 12 ms" returns whatever handful of conforming SKUs
 *    happened to survive the top-60 cut — usually none, occasionally the wrong
 *    ones. Filtering first means the top-60 is a top-60 *of the conforming set*.
 * 2. **Lexical lane (BM25).** Carries part numbers and exact Spanish spec
 *    strings. Works offline, always.
 * 3. **Dense lane (Voyage contextualized embeddings).** Carries vocabulary — the
 *    gap between "sees a black rubber part on a shiny conveyor" and *supresión
 *    del fondo*. Skipped silently when there is no key, no network, or no
 *    vectors in the artifact. A skipped lane is a quality loss, never an error.
 * 4. **RRF fusion** over whichever lanes produced a ranking.
 * 5. **Cross-encoder rerank** of the fused head. Fails open to the fused order.
 * 6. **Top-K**, each hit carrying its resolved product, a full citation, and
 *    per-lane signals that are `null` wherever a lane did not run or did not
 *    return that chunk.
 *
 * ## Retrieval never picks the part
 *
 * Everything above produces *candidates*. The decision — does this SKU satisfy
 * the requirement — is {@link Retriever.solveConstraints}, a deterministic solve
 * over normalized structured specs with no similarity term anywhere in it. The
 * intended two-step is `search()` to narrow, `solveConstraints()` to decide.
 * Never let a rank or a score leak into a correctness claim.
 *
 * ## Honesty in the signals
 *
 * `RetrievalSignals` is rendered in the trace panel a human uses to audit an
 * answer. A fabricated rank there is a lie on screen, so this module reports
 * `null` for every lane that was skipped, failed, or simply never saw the chunk
 * — including the case where the reranker *appeared* to answer but was actually
 * its own fail-open identity fallback (see {@link isIdentityFallback}).
 *
 * The only I/O this module performs is the two optional Voyage calls, both of
 * which return a usable value on every failure path. It reads no env vars, no
 * files, and no clock.
 */

import { voyageContextEmbedQuery } from "./embed/voyageContextEmbed.js";
import { voyageRerank, type RerankResult } from "./embed/voyageRerank.js";
import { prefilter, solve } from "./filter/constraints.js";
import { buildBm25Index } from "./index/bm25Index.js";
import { buildDenseIndex } from "./index/denseIndex.js";
import { rrfFuse, rrfScores } from "./index/rrf.js";
import { decodeVectors } from "./index/store.js";
import {
  DEFAULT_RRF_K,
  type Citation,
  type IndexProvenance,
  type NormalizedSpec,
  type RagChunk,
  type RetrievalResult,
  type RetrievalSignals,
  type SearchOptions,
  type SerializedIndex,
  type SickProduct,
  type SolveResult,
  type SpecConstraints,
} from "./types.js";

/** Hits returned to the caller when `topK` is not stated. */
const DEFAULT_TOP_K = 10;

/** Candidates each lane contributes to fusion when `candidateK` is not stated. */
const DEFAULT_CANDIDATE_K = 60;

/**
 * How deep into the fused list the cross-encoder is allowed to look.
 *
 * A cross-encoder call costs one HTTP round trip whose latency scales with the
 * candidate count, so this is a budget, not a correctness knob: the fused order
 * is already good, and reranking exists to fix the top slice. 50 is deep enough
 * that a chunk both lanes ranked mid-pack can still be promoted into the top 10,
 * and shallow enough to stay a single request.
 *
 * Exported because it is the honest boundary of the `rerankRank` signal: a hit
 * below this depth has `rerankRank: null` because the reranker never saw it, not
 * because it lost. A trace panel that does not say so invites the reader to
 * conclude the cross-encoder rejected it.
 */
export const RERANK_WINDOW = 50;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Injection points for the two network lanes.
 *
 * Declared locally rather than in `types.ts` because it is a wiring detail of
 * this module, not part of the package contract. It exists so tests can prove
 * the *skipped-lane* and *reranked* paths produce different, honest signals
 * without ever opening a socket — the default implementations are the real
 * Voyage clients, and both of them already fail open, so production never needs
 * to pass this argument.
 */
export interface RetrieverDeps {
  /** Embeds the query for the dense lane. Must return `[]` to mean "no lane". */
  embedQuery?: (query: string, opts: { signal?: AbortSignal }) => Promise<number[]>;
  /** Reorders the fused head. Must fail open to the input order, never throw. */
  rerank?: (
    query: string,
    documents: string[],
    opts: { signal?: AbortSignal },
  ) => Promise<RerankResult[]>;
}

/** Restriction options for {@link Retriever.solveConstraints}. */
export interface SolveOptions {
  /**
   * Order numbers to restrict the solve to — normally
   * `(await search(...)).map((r) => r.citation.orderNumber)`.
   *
   * An explicitly empty array means "the prior step found nothing" and yields no
   * results. It deliberately does NOT fall back to solving the whole catalog:
   * silently widening a caller's empty candidate set to 1,776 SKUs would turn a
   * failed search into a confident recommendation drawn from parts the search
   * never surfaced.
   */
  candidates?: string[];
  /** Truncate the ranked solve output. Omit to get every candidate. */
  topK?: number;
}

/**
 * The retrieval surface the agent's tools bind to.
 *
 * Every method is synchronous except {@link Retriever.search}, which is the only
 * one that can touch the network — and even that one completes successfully with
 * no network at all.
 */
export interface Retriever {
  /**
   * Hybrid search: prefilter → BM25 → dense → RRF → rerank → top-K.
   *
   * Returns `[]` for a blank query, for a query no lane matched, and for a
   * constraint set nothing survives. A constraint-only question (no words at
   * all) belongs in {@link Retriever.solveConstraints}, not here — there is
   * nothing for a similarity lane to rank, and inventing an order over the
   * survivors would be exactly the score-leaks-into-correctness failure this
   * package is built to avoid.
   */
  search(query: string, opts?: SearchOptions): Promise<RetrievalResult[]>;

  /**
   * Resolve a 7-digit order number to its catalog row and normalized spec.
   *
   * `undefined` means the order number is not in this index — an honest "I do
   * not have this part", not "this part does not exist". When the row exists but
   * normalization produced nothing, an empty spec is returned rather than
   * `undefined`, so every constraint against it resolves to `unknown` instead of
   * the SKU vanishing.
   */
  getProduct(orderNumber: string): { product: SickProduct; spec: NormalizedSpec } | undefined;

  /**
   * Every SKU in a product family, in catalog order, matched
   * case-insensitively (`"iq standard"` finds `IQ Standard`).
   *
   * Includes accessories: a cross-reference answer that omits the bracket and
   * the M8 cordset is not a deliverable solution.
   */
  getFamily(family: string): SickProduct[];

  /**
   * The deterministic path: evaluate constraints against normalized specs with
   * **no semantic component whatsoever**.
   *
   * This is the function whose output a skeptical engineer re-derives by hand
   * from the cited spec table. Ranking is by evidence (fewest `unknown`, most
   * `passed`), never by retrieval rank. Non-viable candidates are ranked last
   * rather than dropped, so the caller can show "rejected because…".
   */
  solveConstraints(constraints: SpecConstraints, opts?: SolveOptions): SolveResult[];

  /**
   * How this index was built, plus whether a dense lane is even possible.
   *
   * `denseAvailable` reports that the artifact carries usable vectors — not that
   * a query can be embedded right now. With vectors present but no API key the
   * dense lane still silently skips, and the per-hit `denseRank: null` is where
   * that shows up. Surfaced so the agent can state its own limits instead of
   * implying full-catalog semantic coverage it does not have.
   */
  stats(): IndexProvenance & { denseAvailable: boolean };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Coerce a caller-supplied count, treating junk (0, -1, NaN) as "use default". */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** Composite key for the `families.csv` rollup lookup; ` ` cannot occur in
 *  a section letter or a family name, so it cannot collide. */
function familyKey(section: string, family: string): string {
  return `${section} ${family}`;
}

/**
 * True when a rerank result is {@link voyageRerank}'s own fail-open fallback
 * rather than a real cross-encoder answer.
 *
 * `voyageRerank` deliberately never reports failure — it returns the input order
 * with synthetic `(total - i) / total` scores so callers have exactly one code
 * path. That is right for *ordering* and wrong for *reporting*: publishing those
 * placeholders as `rerankScore` would tell the trace panel a cross-encoder ran
 * when the machine was offline. So we detect the fallback by its exact shape —
 * every index in input order AND every score equal to the synthetic formula —
 * and report `null` signals instead. A genuine rerank that reproduced the input
 * order would still have to hit those exact float scores to be misread, which is
 * not a thing that happens.
 */
function isIdentityFallback(results: readonly RerankResult[], total: number): boolean {
  if (total === 0 || results.length !== total) return false;
  for (let i = 0; i < results.length; i += 1) {
    const entry = results[i]!;
    if (entry.index !== i) return false;
    if (entry.score !== (total - i) / total) return false;
  }
  return true;
}

/** Per-lane rank + score for one chunk position. */
interface LaneHit {
  rank: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a retriever over a loaded index artifact.
 *
 * Throws only when the artifact itself is unusable — {@link decodeVectors}
 * rejects a vector whose width disagrees with `provenance.embeddingDimension`,
 * because that means the file mixes two embedding runs and every similarity it
 * produces is meaningless. Everything else about this function is fail-open: an
 * artifact with no vectors, with a spec missing for some SKU, or with a family
 * the rollup never covered all yield a working retriever with a smaller lane or
 * a thinner citation, never an exception at query time.
 *
 * @param index - a validated artifact, normally from `readIndex` / `readIndexSync`
 * @param deps - test seams for the two Voyage calls; omit in production
 */
export function createRetriever(index: SerializedIndex, deps: RetrieverDeps = {}): Retriever {
  const chunks: readonly RagChunk[] = index.chunks;
  const bm25 = buildBm25Index(chunks);
  const dense = buildDenseIndex(decodeVectors(index));

  const embedQuery = deps.embedQuery ?? ((q, o) => voyageContextEmbedQuery(q, o));
  const rerank = deps.rerank ?? ((q, d, o) => voyageRerank(q, d, o));

  const productsByOrder = new Map<string, SickProduct>();
  for (const product of index.products) {
    if (!productsByOrder.has(product.orderNumber)) productsByOrder.set(product.orderNumber, product);
  }

  const specsByOrder = new Map<string, NormalizedSpec>();
  for (const spec of index.specs) {
    if (!specsByOrder.has(spec.orderNumber)) specsByOrder.set(spec.orderNumber, spec);
  }

  const productsByFamily = new Map<string, SickProduct[]>();
  for (const product of index.products) {
    if (product.family === undefined) continue;
    const key = product.family.trim().toLowerCase();
    const bucket = productsByFamily.get(key);
    if (bucket) bucket.push(product);
    else productsByFamily.set(key, [product]);
  }

  // `families.csv` is the only place a family-level `product_url` is printed, so
  // family chunks would otherwise cite a page with no link to follow.
  const familyUrls = new Map<string, string>();
  for (const family of index.families) {
    if (family.productUrl === undefined) continue;
    familyUrls.set(familyKey(family.section, family.family), family.productUrl);
  }

  // documentId → positions of that document's SKU chunks. Used to decide whether
  // a family card survives the prefilter: a family answers "what is this series"
  // rather than "which SKU", so it stays retrievable as long as at least one of
  // its variants does.
  const documentSkus = new Map<string, number[]>();
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    if (chunk.kind !== "sku") continue;
    const bucket = documentSkus.get(chunk.documentId);
    if (bucket) bucket.push(i);
    else documentSkus.set(chunk.documentId, [i]);
  }

  /**
   * Mark which chunk positions the ranking lanes are allowed to see.
   *
   * A SKU chunk survives when the deterministic prefilter kept its product —
   * i.e. no constraint is *verified to fail*. Constraints the catalog is silent
   * about never drop anything; see `filter/constraints.ts`.
   *
   * Two fail-open cases are deliberate. A SKU chunk whose order number resolves
   * to no product row cannot be proven to violate anything, so it stays. A family
   * chunk whose document contains no SKU chunks at all likewise stays: there is
   * no evidence against it, and "absent is not failing" applies to structure as
   * much as to specs.
   */
  const allowedPositions = (constraints: SpecConstraints): Uint8Array => {
    const survivors = prefilter(index.products, index.specs, constraints);
    const allowedOrders = new Set(survivors.map((p) => p.orderNumber));

    const allowed = new Uint8Array(chunks.length);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      if (chunk.kind !== "sku") continue;
      const orderNumber = chunk.orderNumber;
      if (orderNumber === undefined || allowedOrders.has(orderNumber)) allowed[i] = 1;
    }
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      if (chunk.kind === "sku") continue;
      const skus = documentSkus.get(chunk.documentId);
      if (skus === undefined || skus.some((position) => allowed[position] === 1)) allowed[i] = 1;
    }
    return allowed;
  };

  /**
   * Walk a lane's full ranking and keep the first `limit` survivors.
   *
   * The lane is scored over the whole corpus and *then* narrowed, which is
   * arithmetically identical to scoring only the survivors — BM25 and cosine
   * both score each document independently of which others are in the candidate
   * set — while costing one index instead of one per query. What it is NOT is a
   * post-filter: the `limit` cut happens after the restriction, so the lane
   * always contributes a full `candidateK` of conforming chunks when that many
   * exist.
   */
  const takeAllowed = (
    hits: readonly { index: number; score: number }[],
    allowed: Uint8Array | null,
    limit: number,
  ): Map<number, LaneHit> => {
    const kept = new Map<number, LaneHit>();
    for (const hit of hits) {
      if (kept.size >= limit) break;
      if (allowed !== null && allowed[hit.index] !== 1) continue;
      if (kept.has(hit.index)) continue;
      kept.set(hit.index, { rank: kept.size, score: hit.score });
    }
    return kept;
  };

  const citationFor = (chunk: RagChunk, product: SickProduct | undefined): Citation => {
    const family = product?.family ?? chunk.family;
    const url =
      product?.productUrl ??
      (family !== undefined ? familyUrls.get(familyKey(chunk.section, family)) : undefined);
    return {
      ...(chunk.orderNumber !== undefined ? { orderNumber: chunk.orderNumber } : {}),
      ...(product?.typeCode !== undefined ? { typeCode: product.typeCode } : {}),
      ...(family !== undefined ? { family } : {}),
      sourcePage: chunk.sourcePage,
      pdfPage: chunk.pdfPage,
      ...(url !== undefined ? { productUrl: url } : {}),
    };
  };

  return {
    async search(query: string, opts: SearchOptions = {}): Promise<RetrievalResult[]> {
      const topK = positiveInt(opts.topK, DEFAULT_TOP_K);
      const candidateK = positiveInt(opts.candidateK, DEFAULT_CANDIDATE_K);
      const rrfK = opts.rrfK ?? DEFAULT_RRF_K;
      const signalOpts = opts.signal !== undefined ? { signal: opts.signal } : {};
      const trimmed = typeof query === "string" ? query.trim() : "";

      // 1. STRUCTURED PREFILTER — before either lane ranks anything.
      const allowed = opts.constraints !== undefined ? allowedPositions(opts.constraints) : null;

      // 2. LEXICAL LANE. `chunks.length` as the lane's own top-K asks MiniSearch
      //    for every chunk that matched at least one term; the candidateK cut is
      //    applied afterwards, to the survivors.
      const lexical =
        trimmed === ""
          ? new Map<number, LaneHit>()
          : takeAllowed(bm25.search(query, chunks.length), allowed, candidateK);

      // 3. DENSE LANE. Skipped — not failed — when disabled, when the artifact
      //    carries no vectors (nothing to compare against, so embedding the
      //    query would be a paid no-op), or when the embedding call comes back
      //    empty because there is no key / no network / an API error.
      let denseHits = new Map<number, LaneHit>();
      if (opts.noDense !== true && dense.embeddedCount > 0 && trimmed !== "") {
        const queryVector = await embedQuery(query, signalOpts);
        if (queryVector.length > 0) {
          denseHits = takeAllowed(dense.search(queryVector, chunks.length), allowed, candidateK);
        }
      }

      // 4. FUSE whichever lanes produced a ranking. A lane that returned nothing
      //    contributes no ranking at all rather than an empty one, so RRF never
      //    sees a phantom lane.
      const rankings: number[][] = [];
      if (lexical.size > 0) rankings.push([...lexical.keys()]);
      if (denseHits.size > 0) rankings.push([...denseHits.keys()]);
      if (rankings.length === 0) return [];

      const fused = rrfFuse(rankings, { k: rrfK });
      const fusedScores = rrfScores(rankings, { k: rrfK });

      // 5. RERANK the fused head. `voyageRerank` fails open to the fused order,
      //    so the only thing a failure costs is precision at the top.
      let order = fused;
      const rerankHits = new Map<number, LaneHit>();
      const windowSize = Math.min(fused.length, Math.max(topK, RERANK_WINDOW));
      if (opts.noRerank !== true && windowSize > 1) {
        const windowPositions = fused.slice(0, windowSize);
        const documents = windowPositions.map((position) => chunks[position]!.text);
        const reranked = await rerank(query, documents, signalOpts);
        if (!isIdentityFallback(reranked, documents.length)) {
          const reordered: number[] = [];
          for (const entry of reranked) {
            const position = windowPositions[entry.index];
            if (position === undefined || rerankHits.has(position)) continue;
            rerankHits.set(position, { rank: reordered.length, score: entry.score });
            reordered.push(position);
          }
          // Window members the reranker declined to return keep their fused
          // order behind the ones it did — dropping them would let a truncated
          // rerank response silently delete candidates.
          const untouched = windowPositions.filter((position) => !rerankHits.has(position));
          order = [...reordered, ...untouched, ...fused.slice(windowSize)];
        }
      }

      // 6. Materialize the top-K. Family and SKU chunks may both appear — they
      //    answer different questions ("what is the W4-3 series" vs "which
      //    variant") — but a given chunk id appears at most once.
      const results: RetrievalResult[] = [];
      const seen = new Set<string>();
      for (const position of order) {
        if (results.length >= topK) break;
        const chunk = chunks[position];
        if (chunk === undefined || seen.has(chunk.id)) continue;
        seen.add(chunk.id);

        const product =
          chunk.orderNumber !== undefined ? productsByOrder.get(chunk.orderNumber) : undefined;
        const bm25Hit = lexical.get(position);
        const denseHit = denseHits.get(position);
        const rerankHit = rerankHits.get(position);

        const signals: RetrievalSignals = {
          bm25Rank: bm25Hit?.rank ?? null,
          bm25Score: bm25Hit?.score ?? null,
          denseRank: denseHit?.rank ?? null,
          denseScore: denseHit?.score ?? null,
          rerankRank: rerankHit?.rank ?? null,
          rerankScore: rerankHit?.score ?? null,
          rrfScore: fusedScores.get(position) ?? 0,
        };

        results.push({
          chunk,
          ...(product !== undefined ? { product } : {}),
          signals,
          citation: citationFor(chunk, product),
        });
      }
      return results;
    },

    getProduct(orderNumber: string): { product: SickProduct; spec: NormalizedSpec } | undefined {
      const key = typeof orderNumber === "string" ? orderNumber.trim() : "";
      const product = productsByOrder.get(key);
      if (product === undefined) return undefined;
      return {
        product,
        spec: specsByOrder.get(key) ?? { orderNumber: key, lowConfidence: [] },
      };
    },

    getFamily(family: string): SickProduct[] {
      const key = typeof family === "string" ? family.trim().toLowerCase() : "";
      // Copied so a caller cannot mutate the retriever's own index.
      return [...(productsByFamily.get(key) ?? [])];
    },

    solveConstraints(constraints: SpecConstraints, opts: SolveOptions = {}): SolveResult[] {
      let candidates: readonly SickProduct[] = index.products;
      if (opts.candidates !== undefined) {
        const wanted: SickProduct[] = [];
        const seen = new Set<string>();
        for (const orderNumber of opts.candidates) {
          if (typeof orderNumber !== "string") continue;
          const key = orderNumber.trim();
          if (seen.has(key)) continue;
          seen.add(key);
          const product = productsByOrder.get(key);
          // An order number this index does not carry is skipped, not faked: a
          // synthesized empty product would be evaluated as all-unknown and then
          // ranked as a viable candidate for a part we have no page for.
          if (product !== undefined) wanted.push(product);
        }
        candidates = wanted;
      }

      const results = solve(candidates, index.specs, constraints);
      const limit = opts.topK;
      if (limit === undefined || !Number.isFinite(limit) || limit < 1) return results;
      return results.slice(0, Math.floor(limit));
    },

    stats(): IndexProvenance & { denseAvailable: boolean } {
      // Fresh object: `provenance` is quoted verbatim by the agent when it states
      // its own coverage, and a caller mutating it would rewrite that claim.
      return { ...index.provenance, denseAvailable: dense.embeddedCount > 0 };
    },
  };
}
