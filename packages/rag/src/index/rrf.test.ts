import { describe, expect, it } from "vitest";

import { DEFAULT_RRF_K } from "../types.js";
import { cosineSim, rrfFuse, rrfScores } from "./rrf.js";

describe("rrfScores", () => {
  it("matches the RRF formula computed by hand", () => {
    // Lexical lane ranked [3, 1, 2]; dense lane ranked [1, 3]. k = 60.
    //   item 3 -> 1/(60+0) + 1/(60+1)
    //   item 1 -> 1/(60+1) + 1/(60+0)   (same sum, mirrored positions)
    //   item 2 -> 1/(60+2)              (lexical only)
    const scores = rrfScores([
      [3, 1, 2],
      [1, 3],
    ]);

    expect(scores.get(3)).toBeCloseTo(1 / 60 + 1 / 61, 12);
    expect(scores.get(1)).toBeCloseTo(1 / 61 + 1 / 60, 12);
    expect(scores.get(2)).toBeCloseTo(1 / 62, 12);
    expect(scores.size).toBe(3);
  });

  it("uses DEFAULT_RRF_K and falls back to it for a nonsense k", () => {
    const expected = 1 / DEFAULT_RRF_K;
    expect(rrfScores([[7]]).get(7)).toBeCloseTo(expected, 12);
    expect(rrfScores([[7]], { k: 0 }).get(7)).toBeCloseTo(expected, 12);
    expect(rrfScores([[7]], { k: Number.NaN }).get(7)).toBeCloseTo(expected, 12);
  });

  it("scores an item absent from a lane as contributing zero, not a penalty", () => {
    // Chunk 7 was found only by BM25. It must still score, and must not be
    // dragged below chunk 5 by some imaginary "missing from dense" penalty.
    const scores = rrfScores([[5], [7, 5]]);
    expect(scores.get(5)).toBeCloseTo(1 / 60 + 1 / 61, 12);
    expect(scores.get(7)).toBeCloseTo(1 / 60, 12);
  });

  it("counts only an item's best position when a lane repeats it", () => {
    const scores = rrfScores([[4, 4, 9]]);
    expect(scores.get(4)).toBeCloseTo(1 / 60, 12);
    expect(scores.get(9)).toBeCloseTo(1 / 62, 12);
  });

  it("applies per-lane weights and defaults a missing weight to 1", () => {
    // k = 1 keeps the arithmetic checkable: lane0 weight 2, lane1 weight 1.
    //   item 0 -> 2/(1+0) + 1/(1+1) = 2.5
    //   item 1 -> 2/(1+1) + 1/(1+0) = 2.0
    const weighted = rrfScores(
      [
        [0, 1],
        [1, 0],
      ],
      { k: 1, weights: [2, 1] },
    );
    expect(weighted.get(0)).toBeCloseTo(2.5, 12);
    expect(weighted.get(1)).toBeCloseTo(2.0, 12);

    // A short weights array must not silently zero out the un-weighted lane.
    const short = rrfScores(
      [
        [0, 1],
        [1, 0],
      ],
      { k: 1, weights: [2] },
    );
    expect(short.get(0)).toBeCloseTo(2.5, 12);
    expect(short.get(1)).toBeCloseTo(2.0, 12);
  });

  it("degrades instead of throwing on malformed entries", () => {
    const scores = rrfScores([[-1, 2.5, 3]]);
    expect(scores.size).toBe(1);
    expect(scores.get(3)).toBeCloseTo(1 / 62, 12);
  });

  it("returns an empty map for no lanes and for empty lanes", () => {
    expect(rrfScores([]).size).toBe(0);
    expect(rrfScores([[], []]).size).toBe(0);
  });
});

describe("rrfFuse", () => {
  it("orders by fused score and breaks exact ties by ascending index", () => {
    // Items 1 and 3 tie exactly (mirrored ranks); 1 wins on index.
    expect(
      rrfFuse([
        [3, 1, 2],
        [1, 3],
      ]),
    ).toEqual([1, 3, 2]);
  });

  it("is deterministic regardless of lane order", () => {
    const a = rrfFuse([
      [3, 1, 2],
      [1, 3],
    ]);
    const b = rrfFuse([
      [1, 3],
      [3, 1, 2],
    ]);
    expect(a).toEqual(b);
  });

  it("returns the deduped union across partial lanes of different lengths", () => {
    expect(rrfFuse([[5], [7, 5], [5, 7]])).toEqual([5, 7]);
    expect(rrfFuse([])).toEqual([]);
  });

  it("honors weights in the final order", () => {
    expect(
      rrfFuse(
        [
          [0, 1],
          [1, 0],
        ],
        { k: 1, weights: [1, 2] },
      ),
    ).toEqual([1, 0]);
  });
});

describe("cosineSim", () => {
  it("computes similarity and clamps to [-1, 1]", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeLessThanOrEqual(1);
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSim([3, 4], [4, 3])).toBeCloseTo(24 / 25, 12);
  });

  it("fails soft to 0 rather than NaN or a throw", () => {
    // Dimension mismatch: a stray wrong-width vector must sink, not explode.
    expect(cosineSim([1, 2], [1, 2, 3])).toBe(0);
    // Empty vectors: an un-embedded chunk that slipped through.
    expect(cosineSim([], [])).toBe(0);
    expect(cosineSim([], [1])).toBe(0);
    // Zero magnitude: division by zero would otherwise be NaN.
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
    expect(cosineSim([1, 1], [0, 0])).toBe(0);
    // Non-finite components from a corrupted decode.
    expect(cosineSim([Number.NaN, 1], [1, 1])).toBe(0);
    expect(cosineSim([Number.POSITIVE_INFINITY, 1], [1, 1])).toBe(0);
  });

  it("never returns NaN, so sort comparators stay well-defined", () => {
    const cases: number[][] = [[], [0, 0], [Number.NaN], [1, 2, 3]];
    for (const a of cases) {
      for (const b of cases) {
        expect(Number.isNaN(cosineSim(a, b))).toBe(false);
      }
    }
  });
});
