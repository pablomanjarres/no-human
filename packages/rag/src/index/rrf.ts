/**
 * Reciprocal Rank Fusion + the cosine primitive the dense lane rides on.
 *
 * RRF (Cormack, Clarke & Buettcher, SIGIR 2009) is the only sane way to merge
 * a BM25 ranking with a cosine ranking: the two lanes produce scores on
 * incomparable scales (BM25 is unbounded and corpus-dependent, cosine is
 * bounded in [-1, 1]), so any attempt to normalize-and-add silently weights one
 * lane by whatever its score distribution happens to be that day. RRF throws
 * the magnitudes away and fuses *positions*, which is scale-free and stable.
 *
 * Everything here is pure arithmetic — no I/O, no state, no clock. That matters
 * because the fused score is reported to the agent (`RetrievalSignals.rrfScore`)
 * and must be reproducible by hand from the two input rankings.
 *
 * Note the architectural boundary: fusion decides *which candidates the human
 * sees*, never *which part is correct*. The constraint solver owns correctness.
 */

import { DEFAULT_RRF_K } from "../types.js";

/** Tuning knobs for {@link rrfFuse} / {@link rrfScores}. */
export interface RrfOptions {
  /**
   * Smoothing constant. Larger `k` flattens the curve, so deep-but-agreed-upon
   * items can outrank a shallow single-lane hit. Defaults to
   * {@link DEFAULT_RRF_K} (60), the value from the original paper — do not
   * invent your own unless you are prepared to re-tune the whole pipeline.
   */
  k?: number;
  /**
   * Per-ranking weights, positionally aligned to `rankings`. A missing or
   * non-finite weight is treated as 1 rather than 0, because a caller that
   * passes a short weights array almost certainly means "leave the rest
   * alone", and silently zeroing a whole lane is an invisible catastrophe.
   */
  weights?: number[];
}

/** One ranking is a best-first list of item indices into some shared array. */
type Ranking = readonly number[];

/** Reads `k`, guarding against a caller passing 0 / NaN / a negative. */
function resolveK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k) || k <= 0) return DEFAULT_RRF_K;
  return k;
}

/** Reads the weight for lane `i`, defaulting to 1 (never 0 — see {@link RrfOptions}). */
function resolveWeight(weights: readonly number[] | undefined, i: number): number {
  const w = weights?.[i];
  if (w === undefined || !Number.isFinite(w)) return 1;
  return w;
}

/**
 * Raw fused scores, keyed by item index.
 *
 * Exposed separately from {@link rrfFuse} because the retrieval layer has to
 * report `rrfScore` per hit in `RetrievalSignals`; recomputing it there from the
 * fused order would be both wasteful and a chance for the reported number to
 * drift from the number that actually did the sorting.
 *
 * Rankings may be partial, of different lengths, and may overlap arbitrarily.
 * An item absent from a ranking contributes exactly 0 from that ranking — it is
 * *not* penalized, because "the lexical lane never saw this chunk" is not
 * evidence against it. If an item appears twice in one ranking (a caller bug,
 * but a cheap one to absorb) only its best position counts, so a duplicate can
 * never inflate a score.
 *
 * Non-integer, negative and non-finite entries are skipped rather than thrown
 * on: this sits in the middle of a retrieval pipeline, and degrading one lane is
 * always better than failing a whole query.
 */
export function rrfScores(
  rankings: ReadonlyArray<Ranking>,
  opts?: RrfOptions,
): Map<number, number> {
  const k = resolveK(opts?.k);
  const scores = new Map<number, number>();

  for (let lane = 0; lane < rankings.length; lane += 1) {
    const ranking = rankings[lane];
    if (ranking === undefined) continue;
    const weight = resolveWeight(opts?.weights, lane);
    const seen = new Set<number>();

    for (let rank = 0; rank < ranking.length; rank += 1) {
      const item = ranking[rank];
      if (item === undefined || !Number.isInteger(item) || item < 0) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      scores.set(item, (scores.get(item) ?? 0) + weight / (k + rank));
    }
  }

  return scores;
}

/**
 * The deduped union of every ranking, best-first.
 *
 * Ties are broken by ascending item index — not by lane order, not by insertion
 * order. Exact score ties are common (two lanes that agree, mirrored rankings),
 * and a nondeterministic tie-break would make the same query return different
 * top-K across runs, which destroys the "re-derivable by hand" property the
 * whole package is built on.
 */
export function rrfFuse(rankings: ReadonlyArray<Ranking>, opts?: RrfOptions): number[] {
  const scores = rrfScores(rankings, opts);
  return [...scores.keys()].sort((a, b) => {
    const sa = scores.get(a) ?? 0;
    const sb = scores.get(b) ?? 0;
    if (sb !== sa) return sb - sa;
    return a - b;
  });
}

/**
 * Cosine similarity, fail-soft.
 *
 * Returns 0 — never `NaN`, never a throw — for mismatched lengths, empty
 * vectors, a zero-magnitude vector, or any non-finite component. The dense lane
 * runs over vectors that came back from a remote embedding service and were
 * decoded from base64 floats; a single malformed row must degrade to "this
 * chunk simply doesn't rank" rather than poison a sort comparator with `NaN`
 * (which silently produces a garbage ordering) or abort the query.
 *
 * The result is clamped to [-1, 1] so floating-point drift can't hand a caller
 * a similarity of 1.0000000000000002 to reason about.
 */
export function cosineSim(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA <= 0 || normB <= 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(sim)) return 0;
  return Math.min(1, Math.max(-1, sim));
}
