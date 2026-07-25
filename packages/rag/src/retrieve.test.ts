/**
 * Retrieval engine tests.
 *
 * The corpus here is a **real slice of the shipped catalog**, loaded off disk and
 * chunked by the real chunker — four families deliberately chosen to be
 * confusable in the ways this pipeline has to survive:
 *
 * - `G6` (section B) — photoelectric: diffuse, background-suppression,
 *   retroreflective and through-beam variants, PNP and NPN, M8 and cable.
 * - `IQ Standard` (section C) — inductive proximity switches.
 * - `UM30` (section H) — ultrasonic distance sensors, the only family here that
 *   prints a response time.
 * - `DFS60` (section N) — incremental encoders, with real accessory rows.
 *
 * Nothing is invented. Every order number, type code and Spanish string asserted
 * on below was read out of `sick-catalog-dataset/products.jsonl`; a test that
 * passes against fabricated Spanish proves nothing, because the entire job is
 * surviving the catalog's real vocabulary.
 *
 * The index is built with **no vectors**, which is also the shipped
 * lexical-only fallback: these tests therefore run the exact code path a laptop
 * with no API key and no network runs.
 */

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildChunks } from "./corpus/chunker.js";
import { loadCatalogSync } from "./corpus/loadCatalog.js";
import { normalizeAll } from "./filter/normalize.js";
import { serializeIndex } from "./index/store.js";
import { createRetriever, RERANK_WINDOW, type Retriever } from "./retrieve.js";
import type { Catalog, RetrievalResult, SerializedIndex, SickProduct } from "./types.js";

// ---------------------------------------------------------------------------
// A real slice of the real catalog
// ---------------------------------------------------------------------------

const DATASET_DIR = fileURLToPath(new URL("../../../sick-catalog-dataset/", import.meta.url));

const SLICE = new Set(["G6", "IQ Standard", "UM30", "DFS60"]);

const full = loadCatalogSync(DATASET_DIR);
const products: SickProduct[] = full.products.filter(
  (p) => p.family !== undefined && SLICE.has(p.family),
);
const catalog: Catalog = {
  products,
  families: full.families.filter((f) => SLICE.has(f.family)),
  sourceDir: full.sourceDir,
};
const chunks = buildChunks(catalog);
const specs = normalizeAll(products);

function buildIndex(vectors?: (number[] | null)[]): SerializedIndex {
  return serializeIndex({
    provenance: {
      builtAt: "2026-07-25T00:00:00.000Z",
      sourceDir: catalog.sourceDir,
      chunkCount: 0,
      documentCount: 4,
      productCount: products.length,
      embeddedChunkCount: 0,
      embeddingModel: vectors === undefined ? null : "test-model",
      embeddingDimension: vectors === undefined ? null : 3,
    },
    chunks,
    ...(vectors !== undefined ? { vectors } : {}),
    specs,
    products,
    families: catalog.families,
  });
}

const index = buildIndex();
const retriever: Retriever = createRetriever(index);

const ids = (results: readonly RetrievalResult[]): string[] => results.map((r) => r.chunk.id);
const families = (results: readonly RetrievalResult[]): (string | undefined)[] =>
  results.map((r) => r.chunk.family);

// Sanity: the slice really is the shape the assertions below assume.
describe("the test corpus", () => {
  it("is a real slice of the shipped catalog", () => {
    expect(products.length).toBe(106);
    expect(products.some((p) => p.orderNumber === "1052442" && p.typeCode === "GTB6-P4212")).toBe(
      true,
    );
    // Four family cards + one chunk per SKU.
    expect(chunks.filter((c) => c.kind === "family")).toHaveLength(4);
    expect(chunks.filter((c) => c.kind === "sku")).toHaveLength(products.length);
  });

  it("states no enclosure rating anywhere — the honest-unknown fixture", () => {
    // The summary catalog omits IP ratings for all four of these families. That
    // is what makes the fail-open test below meaningful rather than incidental.
    expect(products.every((p) => p.enclosureRating === undefined)).toBe(true);
    expect(specs.every((s) => s.ipRating === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-language retrieval
// ---------------------------------------------------------------------------

describe("search across the Spanish/English gap", () => {
  it("finds the inductive family from Spanish and from English", async () => {
    const es = await retriever.search("sensor de proximidad inductivo", { topK: 5 });
    const en = await retriever.search("inductive proximity switch", { topK: 5 });

    expect(families(es)).toContain("IQ Standard");
    expect(families(en)).toContain("IQ Standard");
    // The English query has literally zero tokens in common with the Spanish
    // catalog text; it only works because the chunker glosses and adds industry
    // synonyms. If that ever regresses this assertion is the tripwire.
    expect(en.every((r) => r.chunk.family === "IQ Standard")).toBe(true);
  });

  it("finds the ultrasonic family from Spanish and from English", async () => {
    const es = await retriever.search("sensor de distancia por ultrasonidos", { topK: 5 });
    const en = await retriever.search("ultrasonic distance sensor", { topK: 5 });

    expect(families(es)).toContain("UM30");
    expect(families(en)).toContain("UM30");
  });

  it("finds the encoder family from Spanish and from English", async () => {
    const es = await retriever.search("encoder incremental con eje hueco", { topK: 5 });
    const en = await retriever.search("incremental rotary shaft encoder", { topK: 5 });

    expect(families(es)).toContain("DFS60");
    expect(families(en)).toContain("DFS60");
  });

  it("separates background suppression from the rest of the photoelectric family", async () => {
    const results = await retriever.search("background suppression photoelectric sensor BGS", {
      topK: 5,
    });
    // Every GTB6 row prints `supresión del fondo`; the GTE6/GL6/GSE6 rows do not.
    const top = results[0];
    expect(top).toBeDefined();
    expect(top?.chunk.family).toBe("G6");
    expect(results.some((r) => r.product?.typeCode?.startsWith("GTB6") === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part numbers — the highest-precision query this system receives
// ---------------------------------------------------------------------------

describe("search by type code / order number", () => {
  it("puts the exact SKU in the top few for a hyphenated type code", async () => {
    const results = await retriever.search("GTB6-P4212", { topK: 5 });
    expect(ids(results).slice(0, 3)).toContain("sku:1052442");
    const hit = results.find((r) => r.chunk.id === "sku:1052442");
    expect(hit?.product?.orderNumber).toBe("1052442");
    // The row itself prints no URL; the citation falls back to the family's
    // rollup link so a reviewer always has somewhere to go.
    expect(hit?.product?.productUrl).toBeUndefined();
    expect(hit?.citation).toEqual({
      orderNumber: "1052442",
      typeCode: "GTB6-P4212",
      family: "G6",
      sourcePage: "B-17",
      pdfPage: 16,
      productUrl: "www.mysick.com/es/G6",
    });
  });

  it("finds the same SKU with the separators stripped, as a BOM row prints it", async () => {
    const results = await retriever.search("GTB6P4212", { topK: 5 });
    expect(ids(results).slice(0, 3)).toContain("sku:1052442");
  });

  it("finds a SKU by its 7-digit order number", async () => {
    const results = await retriever.search("1036726", { topK: 5 });
    expect(ids(results)[0]).toBe("sku:1036726");
    expect(results[0]?.product?.typeCode).toBe("DFS60A-S4PC65536");
  });

  it("never returns the same chunk id twice", async () => {
    const results = await retriever.search("fotocélula PNP conector macho M8", { topK: 20 });
    expect(new Set(ids(results)).size).toBe(results.length);
  });
});

// ---------------------------------------------------------------------------
// The structured prefilter
// ---------------------------------------------------------------------------

describe("structured prefilter", () => {
  it("restricts the candidate set before the lanes rank anything", async () => {
    const unfiltered = await retriever.search("conector macho M8", { topK: 20 });
    expect(new Set(families(unfiltered)).size).toBeGreaterThan(1);

    const filtered = await retriever.search("conector macho M8", {
      topK: 20,
      constraints: { family: ["IQ Standard"] },
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.chunk.family === "IQ Standard")).toBe(true);
  });

  it("keeps a family card alive when any of its SKUs survives", async () => {
    const results = await retriever.search("inductive proximity sensors IQ Standard", {
      topK: 20,
      constraints: { section: ["C"] },
    });
    expect(ids(results)).toContain("family:C:IQ Standard");
    expect(results.every((r) => r.chunk.section === "C")).toBe(true);
  });

  it("drops SKUs whose printed output type verifiably violates the request", async () => {
    const results = await retriever.search("fotocélula conector macho M8", {
      topK: 20,
      constraints: { outputType: ["NPN"] },
    });
    expect(results.length).toBeGreaterThan(0);
    // Every G6 row prints its switching output, so a PNP row is a verified fail.
    expect(results.some((r) => r.product?.switchingOutput === "NPN")).toBe(true);
    expect(results.every((r) => r.product?.switchingOutput !== "PNP")).toBe(true);
  });

  it("filters first rather than post-filtering the top-K", async () => {
    // "conector macho M8" matches ~50 chunks; with a candidate budget of 3 and no
    // constraint, no NPN GTE6 row is anywhere near the top. A post-filter would
    // therefore return nothing at all here. A real prefilter returns the top of
    // the *conforming* set.
    const constrained = await retriever.search("fotocélula conector macho M8", {
      topK: 3,
      candidateK: 3,
      constraints: { family: ["G6"], outputType: ["NPN"], connector: ["M8"] },
    });
    expect(constrained.length).toBeGreaterThan(0);
    for (const result of constrained) {
      if (result.product === undefined) continue;
      expect(result.product.switchingOutput).toBe("NPN");
    }
  });

  it("returns nothing when the constraints are genuinely unsatisfiable", async () => {
    const results = await retriever.search("sensor", {
      topK: 10,
      constraints: { family: ["W4-3"] }, // real family, not in this slice
    });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Absent is not failing
// ---------------------------------------------------------------------------

describe("honest unknowns", () => {
  it("does not drop SKUs for a spec the catalog never printed", async () => {
    // Not one row in this slice states an enclosure rating. Treating "not
    // printed" as "fails IP67" would empty the result set and the agent would
    // then answer from whatever scraps survived.
    const results = await retriever.search("inductive proximity sensor", {
      topK: 10,
      constraints: { minIpRating: 67, ip69k: true },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(families(results)).toContain("IQ Standard");
  });

  it("reports the unverifiable constraints instead of hiding them", () => {
    const solved = retriever.solveConstraints(
      { minIpRating: 67, outputType: ["PNP"] },
      { candidates: ["1055447"], topK: 1 },
    );
    const [first] = solved;
    expect(first?.product.orderNumber).toBe("1055447");
    expect(first?.viable).toBe(true);
    expect(first?.failed).toBe(0);
    // PNP is printed and passes; the IP rating is not printed at all.
    expect(first?.passed).toBe(1);
    expect(first?.unknown).toBe(1);
    expect(first?.verdicts.find((v) => v.field === "minIpRating")?.status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Lane signals
// ---------------------------------------------------------------------------

describe("retrieval signals", () => {
  it("reports denseRank: null rather than fabricating a rank for a lane that never ran", async () => {
    const results = await retriever.search("fotocélula de detección sobre objeto", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.signals.denseRank).toBeNull();
      expect(result.signals.denseScore).toBeNull();
      expect(result.signals.bm25Rank).toBeTypeOf("number");
      expect(result.signals.bm25Score).toBeTypeOf("number");
      expect(result.signals.rrfScore).toBeGreaterThan(0);
    }
    expect(results[0]?.signals.bm25Rank).toBe(0);
  });

  it("reports rerankRank: null when the reranker fell back to identity", async () => {
    // No key, no network: `voyageRerank` returns the input order with synthetic
    // scores. Publishing those as a rerank position would claim a cross-encoder
    // ran when nothing did.
    const results = await retriever.search("inductive proximity sensor", { topK: 5 });
    for (const result of results) {
      expect(result.signals.rerankRank).toBeNull();
      expect(result.signals.rerankScore).toBeNull();
    }
  });

  it("reports a real dense rank once the lane actually runs", async () => {
    // Three-dimensional toy vectors: one axis per family bucket, so cosine has a
    // defensible answer. The point is the plumbing and the honesty of the
    // signals, not embedding quality.
    const axis = (chunkFamily: string | undefined): number[] => {
      if (chunkFamily === "IQ Standard") return [1, 0, 0];
      if (chunkFamily === "UM30") return [0, 1, 0];
      return [0, 0, 1];
    };
    const vectorIndex = buildIndex(chunks.map((c) => axis(c.family)));
    const withDense = createRetriever(vectorIndex, {
      embedQuery: async () => Promise.resolve([1, 0, 0]),
    });

    expect(withDense.stats().denseAvailable).toBe(true);
    const results = await withDense.search("proximity", { topK: 5 });
    const dense = results.filter((r) => r.signals.denseRank !== null);
    expect(dense.length).toBeGreaterThan(0);
    expect(dense.every((r) => r.chunk.family === "IQ Standard")).toBe(true);
    expect(dense[0]?.signals.denseScore).toBeCloseTo(1, 6);
  });

  it("skips the dense lane on request, even with vectors present", async () => {
    const vectorIndex = buildIndex(chunks.map(() => [1, 0, 0]));
    const embedQuery = vi.fn(async () => Promise.resolve([1, 0, 0]));
    const withDense = createRetriever(vectorIndex, { embedQuery });

    const results = await withDense.search("proximity sensor", { topK: 5, noDense: true });
    expect(embedQuery).not.toHaveBeenCalled();
    expect(results.every((r) => r.signals.denseRank === null)).toBe(true);
    // `denseAvailable` still reports the artifact's truth, not this query's.
    expect(withDense.stats().denseAvailable).toBe(true);
  });

  it("skips the dense lane when the embedding call comes back empty", async () => {
    const vectorIndex = buildIndex(chunks.map(() => [1, 0, 0]));
    const withDense = createRetriever(vectorIndex, {
      // Exactly what `voyageContextEmbedQuery` returns with no key / no network.
      embedQuery: async () => Promise.resolve([]),
    });
    const results = await withDense.search("proximity sensor", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.signals.denseRank === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

describe("rerank lane", () => {
  /**
   * A cross-encoder that exactly reverses the fused order, best-first.
   *
   * Note the scores: `1 / (i + 2)` rather than the `(total - i) / total` shape
   * `voyageRerank` uses for its offline fallback. Reproducing that shape here
   * would make this mock indistinguishable from the fallback — which is the
   * whole point of the fallback detection in `retrieve.ts` — and the test would
   * silently assert nothing.
   */
  const reversing = vi.fn(async (_query: string, documents: string[]) =>
    Promise.resolve(
      documents.map((_doc, i) => ({ index: documents.length - 1 - i, score: 1 / (i + 2) })),
    ),
  );

  afterEach(() => {
    reversing.mockClear();
  });

  it("lets the cross-encoder reorder the fused head and records honest ranks", async () => {
    const fused = await retriever.search("fotocélula PNP", { topK: 200, noRerank: true });
    const window = Math.min(fused.length, RERANK_WINDOW);
    expect(window).toBeGreaterThan(6);

    const reranked = await createRetriever(index, { rerank: reversing }).search("fotocélula PNP", {
      topK: 6,
    });

    expect(reversing).toHaveBeenCalledTimes(1);
    // The reranker owns the order of its window outright — including promoting
    // chunk 49 to first, which is exactly the "ranking cannot be second-guessed
    // by fusion" behavior a real cross-encoder needs.
    expect(ids(reranked)).toEqual(ids(fused).slice(0, window).reverse().slice(0, 6));
    reranked.forEach((result, i) => {
      expect(result.signals.rerankRank).toBe(i);
      expect(result.signals.rerankScore).toBeTypeOf("number");
    });
    // Fusion evidence survives reranking — the trace panel shows both.
    expect(reranked.every((r) => r.signals.rrfScore > 0)).toBe(true);
  });

  it("does not call the reranker at all when noRerank is set", async () => {
    const results = await createRetriever(index, { rerank: reversing }).search("fotocélula PNP", {
      topK: 6,
      noRerank: true,
    });
    expect(reversing).not.toHaveBeenCalled();
    expect(results.every((r) => r.signals.rerankRank === null)).toBe(true);
  });

  it("keeps every candidate when the reranker returns a truncated list", async () => {
    // Returns a verdict on exactly one of its ~50 inputs. The other 49 must not
    // vanish — a truncated response silently deleting candidates is how a
    // cross-reference tool ends up saying "no equivalent part exists".
    const truncating = async (_q: string, documents: string[]) =>
      Promise.resolve(documents.length > 0 ? [{ index: documents.length - 1, score: 0.9 }] : []);
    const partial = createRetriever(index, { rerank: truncating });

    const fused = await retriever.search("fotocélula PNP", { topK: 200, noRerank: true });
    const window = Math.min(fused.length, RERANK_WINDOW);
    const results = await partial.search("fotocélula PNP", { topK: 8 });

    expect(results).toHaveLength(8);
    // The one item it ranked leads; every untouched item keeps its fused order.
    expect(ids(results)[0]).toBe(ids(fused)[window - 1]);
    expect(ids(results).slice(1)).toEqual(ids(fused).slice(0, 7));
    expect(results[0]?.signals.rerankRank).toBe(0);
    expect(results.slice(1).every((r) => r.signals.rerankRank === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No network, no key
// ---------------------------------------------------------------------------

describe("offline operation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("searches successfully with a key configured and every socket refused", async () => {
    // The nastier of the two offline cases: a key IS present, so both Voyage
    // lanes will genuinely try, and every attempt explodes.
    vi.stubEnv("VOYAGE_API_KEY", "test-key-not-used");
    const fetchImpl = vi.fn(() => {
      throw new Error("network is disabled in this test");
    });
    vi.stubGlobal("fetch", fetchImpl);

    const vectorIndex = buildIndex(chunks.map(() => [1, 0, 0]));
    const offline = createRetriever(vectorIndex);
    const results = await offline.search("inductive proximity switch M8 PNP", { topK: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(families(results)).toContain("IQ Standard");
    // Both remote lanes degraded, and both said so instead of inventing a rank.
    expect(results.every((r) => r.signals.denseRank === null)).toBe(true);
    expect(results.every((r) => r.signals.rerankRank === null)).toBe(true);
    expect(results.every((r) => r.signals.bm25Rank !== null)).toBe(true);
  });

  it("searches successfully with no key at all", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    vi.stubEnv("VOYAGE_CONTEXT_API_KEY", "");
    vi.stubEnv("VOYAGE_RERANK_API_KEY", "");
    vi.stubGlobal("fetch", undefined);

    const results = await retriever.search("ultrasonic distance sensor 250 mm", { topK: 5 });
    expect(families(results)).toContain("UM30");
  });
});

// ---------------------------------------------------------------------------
// Direct lookups
// ---------------------------------------------------------------------------

describe("getProduct", () => {
  it("returns the catalog row and its normalized spec", () => {
    const found = retriever.getProduct("1052442");
    expect(found?.product.typeCode).toBe("GTB6-P4212");
    expect(found?.product.sourcePage).toBe("B-17");
    expect(found?.spec.outputType).toBe("PNP");
    expect(found?.spec.connector).toBe("M8");
    expect(found?.spec.sensingRangeMaxMm).toBe(250);
    // Not printed on page B-16 — and therefore absent, not zero.
    expect(found?.spec.ipRating).toBeUndefined();
    expect(found?.spec.supplyVoltageMinV).toBeUndefined();
  });

  it("returns undefined for an order number this index does not carry", () => {
    // A real SICK order number, from a family outside the slice.
    expect(retriever.getProduct("1028082")).toBeUndefined();
    expect(retriever.getProduct("")).toBeUndefined();
  });
});

describe("getFamily", () => {
  it("returns every SKU in the family, accessories included", () => {
    const dfs60 = retriever.getFamily("DFS60");
    expect(dfs60).toHaveLength(20);
    expect(dfs60.filter((p) => p.rowType === "accessory")).toHaveLength(10);
    expect(dfs60.map((p) => p.orderNumber)).toContain("1036726");
  });

  it("matches case-insensitively and returns [] for an unknown family", () => {
    expect(retriever.getFamily("iq standard")).toHaveLength(28);
    expect(retriever.getFamily("W4-3")).toEqual([]);
  });

  it("hands back a copy, so a caller cannot corrupt the index", () => {
    const first = retriever.getFamily("DFS60");
    first.length = 0;
    expect(retriever.getFamily("DFS60")).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// The deterministic path
// ---------------------------------------------------------------------------

describe("solveConstraints", () => {
  it("solves over the whole index with no semantic component", () => {
    const results = retriever.solveConstraints({
      family: ["G6"],
      outputType: ["NPN"],
      connector: ["M8"],
      sensingRangeMm: { max: 200 },
    });
    const viable = results.filter((r) => r.viable);
    expect(viable.length).toBeGreaterThan(0);
    for (const result of viable) {
      expect(result.product.family).toBe("G6");
      // Either printed NPN, or the catalog is silent — never a printed PNP.
      expect(result.spec.outputType === "NPN" || result.spec.outputType === undefined).toBe(true);
    }
    // Non-viable candidates are ranked last, not deleted: the agent can say why.
    const rejected = results.filter((r) => !r.viable);
    expect(rejected.length).toBeGreaterThan(0);
    expect(results.indexOf(rejected[0]!)).toBeGreaterThan(results.indexOf(viable[0]!));
    expect(rejected[0]?.verdicts.some((v) => v.status === "fail")).toBe(true);
  });

  it("is the second half of the intended two-step: search narrows, solver decides", async () => {
    const hits = await retriever.search("fotocélula supresión del fondo PNP", { topK: 12 });
    const candidates = hits
      .map((h) => h.citation.orderNumber)
      .filter((n): n is string => n !== undefined);
    expect(candidates.length).toBeGreaterThan(0);

    const solved = retriever.solveConstraints({ outputType: ["PNP"] }, { candidates, topK: 5 });
    expect(solved.length).toBeLessThanOrEqual(5);
    expect(solved.every((r) => candidates.includes(r.product.orderNumber))).toBe(true);
    expect(solved[0]?.viable).toBe(true);
  });

  it("treats an explicitly empty candidate list as empty, not as the whole catalog", () => {
    expect(retriever.solveConstraints({ outputType: ["PNP"] }, { candidates: [] })).toEqual([]);
  });

  it("skips candidate order numbers this index does not carry", () => {
    const solved = retriever.solveConstraints(
      { outputType: ["PNP"] },
      { candidates: ["1052442", "9999999", "1028082"] },
    );
    expect(solved.map((r) => r.product.orderNumber)).toEqual(["1052442"]);
  });

  it("solves the whole index when no candidate list is given", () => {
    const solved = retriever.solveConstraints({ rowType: ["accessory"] });
    expect(solved).toHaveLength(products.length);
    expect(solved.filter((r) => r.viable)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("stats", () => {
  it("states the index's own limits, including the missing dense lane", () => {
    const stats = retriever.stats();
    expect(stats.denseAvailable).toBe(false);
    expect(stats.embeddedChunkCount).toBe(0);
    expect(stats.embeddingModel).toBeNull();
    expect(stats.chunkCount).toBe(chunks.length);
    expect(stats.productCount).toBe(products.length);
    expect(stats.sourceDir).toBe(catalog.sourceDir);
  });

  it("hands back a copy, so a caller cannot rewrite the coverage claim", () => {
    const stats = retriever.stats();
    stats.productCount = 0;
    expect(retriever.stats().productCount).toBe(products.length);
  });

  it("reports denseAvailable once the artifact actually carries vectors", () => {
    const vectorIndex = buildIndex(chunks.map((_c, i) => (i === 0 ? null : [1, 0, 0])));
    const stats = createRetriever(vectorIndex).stats();
    expect(stats.denseAvailable).toBe(true);
    expect(stats.embeddedChunkCount).toBe(chunks.length - 1);
  });
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

describe("degenerate queries", () => {
  it("returns [] for a blank query rather than an arbitrary order", async () => {
    expect(await retriever.search("")).toEqual([]);
    expect(await retriever.search("   ")).toEqual([]);
  });

  it("returns [] when no lane matched anything", async () => {
    expect(await retriever.search("zzzqqq nonexistent token")).toEqual([]);
  });

  it("treats junk topK / candidateK as the defaults", async () => {
    const results = await retriever.search("fotocélula", { topK: 0, candidateK: -5 });
    expect(results).toHaveLength(10);
  });
});
