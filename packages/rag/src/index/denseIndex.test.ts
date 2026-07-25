import { describe, expect, it } from "vitest";

import { buildDenseIndex } from "./denseIndex.js";

/**
 * Vectors positionally aligned to a four-chunk corpus taken from real catalog
 * rows — order numbers 1051781 (GTE6-P4212), 1052442 (GTB6-P4212),
 * 1058200 (GRTE18S-P2342) and 2063403 (PLH25-M12).
 *
 * Position 2 is deliberately `null`: that is what a chunk looks like when the
 * embedding run was interrupted, or when the index was built lexical-only.
 * It must be skipped, never scored.
 */
const VECTORS: (number[] | null)[] = [
  [1, 0, 0], // 1051781 — diffuse, red light
  [0.8, 0.6, 0], // 1052442 — diffuse + background suppression
  null, // 1058200 — never embedded
  [0, 0, 1], // 2063403 — stainless reflector accessory
];

describe("buildDenseIndex", () => {
  it("counts only the chunks that actually carry a vector", () => {
    expect(buildDenseIndex(VECTORS).embeddedCount).toBe(3);
    expect(buildDenseIndex([]).embeddedCount).toBe(0);
    expect(buildDenseIndex([null, undefined, []]).embeddedCount).toBe(0);
  });

  it("ranks by cosine similarity, best-first", () => {
    const index = buildDenseIndex(VECTORS);
    const hits = index.search([1, 0, 0], 4);

    expect(hits.map((h) => h.index)).toEqual([0, 1, 3]);
    expect(hits[0]?.score).toBeCloseTo(1, 12);
    expect(hits[1]?.score).toBeCloseTo(0.8, 12);
    expect(hits[2]?.score).toBeCloseTo(0, 12);
  });

  it("never returns a chunk without a vector", () => {
    const index = buildDenseIndex(VECTORS);
    // Ask for more than the corpus holds: the un-embedded chunk still must not
    // appear. Absent is absent — it is the lexical lane's job to reach it.
    const hits = index.search([0.5, 0.5, 0.5], 99);
    expect(hits).toHaveLength(3);
    expect(hits.some((h) => h.index === 2)).toBe(false);
  });

  it("preserves the original array positions as ids", () => {
    const index = buildDenseIndex([null, null, [0, 1, 0]]);
    expect(index.search([0, 1, 0], 5)).toEqual([{ index: 2, score: 1 }]);
  });

  it("breaks exact score ties by ascending index", () => {
    // Duplicate chunk text embeds to an identical vector; the order must not
    // depend on the engine's sort stability.
    const index = buildDenseIndex([
      [0, 1, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
    const hits = index.search([1, 0, 0], 3);
    expect(hits.map((h) => h.index)).toEqual([1, 2, 0]);
  });

  it("honors topK", () => {
    const index = buildDenseIndex(VECTORS);
    expect(index.search([1, 0, 0], 2).map((h) => h.index)).toEqual([0, 1]);
    expect(index.search([1, 0, 0], 0)).toEqual([]);
    expect(index.search([1, 0, 0], -3)).toEqual([]);
  });

  it("returns [] instead of throwing when there is nothing to search", () => {
    expect(buildDenseIndex([]).search([1, 0, 0], 5)).toEqual([]);
    expect(buildDenseIndex([null, null]).search([1, 0, 0], 5)).toEqual([]);
    // An empty query vector means the query was never embedded — the dense lane
    // is simply unavailable for this query, which is not an error.
    expect(buildDenseIndex(VECTORS).search([], 5)).toEqual([]);
  });

  it("sinks a wrong-width vector to score 0 rather than throwing mid-query", () => {
    const index = buildDenseIndex([
      [1, 0, 0],
      [1, 0],
      [0.9, 0.1, 0],
    ]);
    const hits = index.search([1, 0, 0], 3);
    expect(hits[0]?.index).toBe(0);
    expect(hits[2]?.index).toBe(1);
    expect(hits[2]?.score).toBe(0);
  });

  it("keeps negative similarities in the ranking, at the bottom", () => {
    const index = buildDenseIndex([
      [-1, 0, 0],
      [1, 0, 0],
    ]);
    const hits = index.search([1, 0, 0], 2);
    expect(hits.map((h) => h.index)).toEqual([1, 0]);
    expect(hits[1]?.score).toBeCloseTo(-1, 12);
  });
});
