/**
 * The dense lane: brute-force cosine over the contextualized chunk vectors.
 *
 * 1,776 SKUs is small enough that an exact linear scan beats any approximate
 * structure — no HNSW, no quantization, no extra dependency, and (the part that
 * matters here) no probabilistic recall. A candidate that exists is always
 * found, so a missing part is never explained away as "the ANN index skipped
 * it".
 *
 * This lane's job is vocabulary, not correctness: it maps *"sensor that sees a
 * black rubber part against a shiny conveyor"* onto the SKUs whose catalog page
 * says *supresión del fondo*. It never decides which part is right.
 *
 * Pure: no I/O, no network. Embedding is somebody else's module.
 */

import { cosineSim } from "./rrf.js";

/** One dense hit: a position in the vector array the index was built from. */
export interface DenseHit {
  /** Position in the `vectors` array passed to {@link buildDenseIndex}. */
  index: number;
  /** Cosine similarity in [-1, 1]. See {@link cosineSim} for the fail-soft cases. */
  score: number;
}

/** A built dense index. Immutable; rebuild to change the corpus. */
export interface DenseIndex {
  /**
   * How many chunks actually carry a usable vector.
   *
   * Reported (not hidden) because it feeds `IndexProvenance.embeddedChunkCount`:
   * if a partial embedding run left half the catalog unvectorized, the agent has
   * to be able to say so rather than quietly search half a catalog.
   */
  readonly embeddedCount: number;
  /**
   * Best-first hits, at most `topK`. Empty for an empty query vector, an index
   * with no embedded chunks, or `topK <= 0`.
   */
  search(queryVec: readonly number[], topK: number): DenseHit[];
}

/**
 * Builds the dense index from vectors positionally aligned to the chunk array.
 *
 * `null` / `undefined` / empty entries are *skipped*, not scored as 0. A chunk
 * with no vector was never embedded (an interrupted run, a lexical-only build,
 * a row Voyage rejected); it is an absence of evidence, and scoring it 0 would
 * plant it in the middle of the ranking above genuinely dissimilar chunks. The
 * lexical lane still reaches those chunks, and RRF still fuses them in — which
 * is precisely the fail-open behavior this pipeline needs.
 *
 * Dimension mismatches are not filtered at build time: {@link cosineSim} returns
 * 0 for them, so a stray wrong-width vector sinks to the bottom instead of
 * throwing mid-query. Prefer that over an exception in a retrieval hot path.
 */
export function buildDenseIndex(
  vectors: ReadonlyArray<readonly number[] | null | undefined>,
): DenseIndex {
  const embedded: { index: number; vec: readonly number[] }[] = [];
  for (let i = 0; i < vectors.length; i += 1) {
    const vec = vectors[i];
    if (vec === null || vec === undefined || vec.length === 0) continue;
    embedded.push({ index: i, vec });
  }

  return {
    embeddedCount: embedded.length,
    search(queryVec: readonly number[], topK: number): DenseHit[] {
      if (embedded.length === 0 || topK <= 0 || queryVec.length === 0) return [];

      const hits: DenseHit[] = embedded.map(({ index, vec }) => ({
        index,
        score: cosineSim(queryVec, vec),
      }));

      // Explicit ascending-index tie-break: duplicate chunk texts embed to
      // identical vectors, and a stable-but-unspecified order would make the
      // same query return a different top-K across builds.
      hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
      return hits.slice(0, topK);
    },
  };
}
