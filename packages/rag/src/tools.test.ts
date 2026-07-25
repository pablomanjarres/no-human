/**
 * Tests for the Claude tool-use surface.
 *
 * Everything here runs against the **real** `sick-catalog-dataset`, not
 * fixtures. The behaviour that matters in this module is how it reports what
 * the printed catalog does and does not say, and an invented fixture would let
 * us assert whatever shape we felt like. The SKUs referenced below were looked
 * up in `products.jsonl` first:
 *
 * - `1058200` — GRTE18S-P2342, family GR18S, page B-61 / pdf 60. States PNP,
 *   `M12 de 3 pines`, `IP 67`, `5 mm ... 550 mm`. States **no** response time,
 *   supply voltage or operating temperature — which is typical, not exceptional:
 *   this is the summary catalog.
 * - `1059408` — GRTE18S-N2312, same family and page, states **NPN**. The pair
 *   gives a verified `fail` to hold against `1058200`'s verified `pass` and
 *   against the many `unknown`s both share.
 *
 * The retriever is a hand-built stub rather than the real one on purpose:
 * `tools.ts` is the boundary layer, so its tests must fail for reasons in
 * `tools.ts`. Every product, spec, chunk and verdict the stub serves is
 * genuine — loaded, chunked and solved by the real modules.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildChunks } from "./corpus/chunker.js";
import { loadCatalogSync } from "./corpus/loadCatalog.js";
import { prefilter, solve } from "./filter/constraints.js";
import { normalizeAll } from "./filter/normalize.js";
import {
  CatalogToolInputError,
  createCatalogTools,
  type CatalogRetrieverLike,
  type CatalogTool,
} from "./tools.js";
import type { Catalog, RagChunk, RetrievalResult, SearchOptions, SickProduct } from "./types.js";

// ---------------------------------------------------------------------------
// A real catalog, loaded once
// ---------------------------------------------------------------------------

const DATASET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "sick-catalog-dataset",
);

const catalog: Catalog = loadCatalogSync(DATASET_DIR);
const specs = normalizeAll(catalog.products);
const chunks: RagChunk[] = buildChunks(catalog);
const byOrderNumber = new Map(catalog.products.map((p) => [p.orderNumber, p] as const));

/** Every catalog row, in the order the tools would cite them. */
function citation(orderNumber: string): { sourcePage: string; pdfPage: number } {
  const p = byOrderNumber.get(orderNumber);
  if (p === undefined) throw new Error(`test setup: ${orderNumber} missing from the dataset`);
  return { sourcePage: p.sourcePage, pdfPage: p.pdfPage };
}

/**
 * A minimal retriever over the real catalog.
 *
 * `search` is a deterministic token-overlap scan, not BM25: the point of these
 * tests is what `tools.ts` does with hits, and a stub lane reports `null` for
 * the dense and rerank ranks — which is exactly the degraded, no-API-key state
 * the tool layer has to describe honestly.
 */
function makeRetriever(pool: readonly SickProduct[] = catalog.products): CatalogRetrieverLike {
  return {
    search(query: string, opts?: SearchOptions): RetrievalResult[] {
      const allowed =
        opts?.constraints === undefined ? pool : prefilter(pool, specs, opts.constraints);
      const allowedIds = new Set(allowed.map((p) => p.orderNumber));
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1);
      const scored: { chunk: RagChunk; score: number }[] = [];
      for (const chunk of chunks) {
        if (chunk.orderNumber !== undefined && !allowedIds.has(chunk.orderNumber)) continue;
        const text = chunk.text.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
        if (score > 0) scored.push({ chunk, score });
      }
      scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
      return scored.slice(0, opts?.topK ?? 10).map(({ chunk, score }, i) => {
        const product =
          chunk.orderNumber === undefined ? undefined : byOrderNumber.get(chunk.orderNumber);
        return {
          chunk,
          ...(product !== undefined ? { product } : {}),
          signals: {
            bm25Rank: i,
            bm25Score: score,
            denseRank: null,
            denseScore: null,
            rerankRank: null,
            rerankScore: null,
            rrfScore: 1 / (60 + i + 1),
          },
          citation: {
            ...(chunk.orderNumber !== undefined ? { orderNumber: chunk.orderNumber } : {}),
            ...(chunk.family !== undefined ? { family: chunk.family } : {}),
            sourcePage: chunk.sourcePage,
            pdfPage: chunk.pdfPage,
          },
        };
      });
    },
    getProduct(orderNumber: string): SickProduct | undefined {
      return byOrderNumber.get(orderNumber);
    },
    getFamily(family: string) {
      return {
        family: catalog.families.find((f) => f.family === family),
        products: catalog.products.filter((p) => p.family === family),
      };
    },
    solveConstraints(constraints) {
      return solve(pool, specs, constraints);
    },
    stats() {
      return {
        productCount: catalog.products.length,
        familyCount: catalog.families.length,
        embeddingModel: null,
      };
    },
  };
}

const tools = createCatalogTools(makeRetriever());

/**
 * The same tools over a GR18S-only pool.
 *
 * `solve` ranks the *whole* catalog, so a deliberately-failing SKU sinks below
 * ~1,700 rows that fail on `family` alone and no `topK` can reach it. Scoping
 * the pool is how the fail-path assertions stay about `tools.ts` rather than
 * about the solver's global sort order.
 */
const gr18s = catalog.products.filter((p) => p.family === "GR18S");
const familyTools = createCatalogTools(makeRetriever(gr18s));

function tool(name: string, from: readonly CatalogTool[] = tools): CatalogTool {
  const t = from.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool named ${name}`);
  return t;
}

/** Narrow a tool result to a record so tests can read fields without casts everywhere. */
async function run(
  name: string,
  input: unknown,
  from: readonly CatalogTool[] = tools,
): Promise<Record<string, unknown>> {
  const out = await tool(name, from).run(input);
  expect(typeof out).toBe("object");
  return out as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("createCatalogTools — definition shape", () => {
  it("exposes exactly the six documented tools, with unique names", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "search_catalog",
      "get_product",
      "solve_constraints",
      "compare_products",
      "list_family",
      "index_stats",
    ]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("gives every tool a non-empty name and a prescriptive description", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // Short descriptions are the documented failure mode here: models
      // under-reach for tools that do not say when to call them.
      expect(t.description.length).toBeGreaterThan(200);
      expect(t.description.trim()).toBe(t.description);
      expect(typeof t.run).toBe("function");
    }
  });

  it("gives every tool a strict object schema with additionalProperties:false and required", () => {
    for (const t of tools) {
      const schema = t.input_schema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
      expect(typeof schema.properties).toBe("object");
      // A required key that is not declared is silently unenforceable.
      for (const key of schema.required) {
        expect(Object.keys(schema.properties)).toContain(key);
      }
      for (const [key, prop] of Object.entries(schema.properties)) {
        expect(typeof prop.type, `${t.name}.${key} needs a type`).toBe("string");
        expect(typeof prop.description, `${t.name}.${key} needs a description`).toBe("string");
      }
    }
  });

  it("declares nested constraint objects strictly too", () => {
    const constraints = tool("solve_constraints").input_schema.properties["constraints"];
    expect(constraints?.additionalProperties).toBe(false);
    expect(constraints?.properties?.["minIpRating"]?.type).toBe("integer");
    expect(constraints?.properties?.["responseTimeMs"]?.additionalProperties).toBe(false);
    // The two tools must advertise the identical constraint vocabulary, or the
    // agent can prefilter on something the solver will not verify.
    expect(constraints).toBe(tool("search_catalog").input_schema.properties["constraints"]);
  });

  it("never offers 'unknown' as a constrainable enum value", () => {
    const props =
      tool("solve_constraints").input_schema.properties["constraints"]?.properties ?? {};
    for (const field of ["outputType", "connector", "principle"]) {
      expect(props[field]?.items?.enum).not.toContain("unknown");
    }
    expect(props["outputType"]?.items?.enum).toContain("PNP");
    expect(props["principle"]?.items?.enum).toContain("background-suppression");
  });
});

describe("tool descriptions carry the architectural rules", () => {
  it("search_catalog disclaims its ranking as evidence and points at solve_constraints", () => {
    const d = tool("search_catalog").description;
    expect(d).toMatch(/relevance heuristic/i);
    expect(d).toMatch(/NOT be used as evidence/i);
    expect(d).toMatch(/solve_constraints/);
  });

  it("solve_constraints explains that unknown means the catalog is silent", () => {
    const d = tool("solve_constraints").description;
    expect(d).toMatch(/SILENT/);
    expect(d).toMatch(/not a pass|NOT a pass/);
    expect(d).toMatch(/unverified/i);
  });
});

// ---------------------------------------------------------------------------

describe("get_product", () => {
  it("returns the full record with a citation to the printed page", async () => {
    const out = await run("get_product", { orderNumber: "1058200" });
    expect(out["found"]).toBe(true);
    expect(out["typeCode"]).toBe("GRTE18S-P2342");
    expect(out["family"]).toBe("GR18S");
    expect(out["citation"]).toMatchObject({
      orderNumber: "1058200",
      typeCode: "GRTE18S-P2342",
      ...citation("1058200"),
    });
  });

  it("distinguishes a stated spec from one the catalog never prints", async () => {
    const out = await run("get_product", { orderNumber: "1058200" });
    const specs = out["specs"] as {
      field: string;
      stated: boolean;
      value: unknown;
      catalogText: unknown;
    }[];

    const outputType = specs.find((s) => s.field === "outputType");
    expect(outputType).toMatchObject({ stated: true, value: "PNP" });
    expect(outputType?.catalogText).toBe("PNP");

    const ip = specs.find((s) => s.field === "ipRating");
    expect(ip).toMatchObject({ stated: true, value: 67 });
    expect(String(ip?.catalogText)).toContain("IP 67");

    // The honest-unknown path: the page simply does not print these.
    const responseTime = specs.find((s) => s.field === "responseTimeMs");
    expect(responseTime).toMatchObject({ stated: false, value: null, catalogText: null });

    expect(out["notStated"]).toEqual(
      expect.arrayContaining(["responseTimeMs", "supplyVoltageMinV", "operatingTempMinC"]),
    );
    expect(out["notStated"]).not.toEqual(expect.arrayContaining(["outputType"]));
  });

  it("reports every spec field for every SKU, present or not", async () => {
    const out = await run("get_product", { orderNumber: "1058200" });
    const specs = out["specs"] as { field: string; stated: boolean }[];
    // A report that listed only populated fields would make silence invisible.
    expect(specs.length).toBeGreaterThan(20);
    expect(specs.some((s) => !s.stated)).toBe(true);
    expect(specs.some((s) => s.stated)).toBe(true);
  });

  it("flags values read from prose rather than a labelled table cell", async () => {
    const out = await run("get_product", { orderNumber: "1058200" });
    // `enclosure_rating` is in this row's low_confidence list in the dataset.
    expect(out["lowConfidenceFields"]).toEqual(expect.arrayContaining(["ipRating"]));
  });

  it("keeps provenance so a claim can be checked against the page text", async () => {
    const out = await run("get_product", { orderNumber: "1058200" });
    const provenance = out["provenance"] as Record<string, string>;
    expect(provenance["enclosureRating"]).toContain("IP 67");
  });

  it("returns found:false — not an error — for a well-formed order number absent from the catalog", async () => {
    const out = await run("get_product", { orderNumber: "9999999" });
    expect(out["found"]).toBe(false);
    expect(out["orderNumber"]).toBe("9999999");
    expect(String(out["message"])).toMatch(/not in the SICK 2015\/2016 summary catalog/);
  });

  it("rejects a malformed order number loudly", async () => {
    await expect(tool("get_product").run({ orderNumber: "GTB6-P4212" })).rejects.toBeInstanceOf(
      CatalogToolInputError,
    );
    await expect(tool("get_product").run({})).rejects.toBeInstanceOf(CatalogToolInputError);
  });
});

// ---------------------------------------------------------------------------

describe("solve_constraints", () => {
  it("marks a spec the catalog never prints as unknown, and still calls the SKU viable", async () => {
    const out = await run("solve_constraints", {
      constraints: { family: ["GR18S"], outputType: ["PNP"], responseTimeMs: { max: 12 } },
      topK: 5,
    });
    const results = out["results"] as {
      orderNumber: string;
      viable: boolean;
      unknown: number;
      unverifiedConstraints: string[];
      verdicts: { field: string; status: string; detail: string }[];
    }[];
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first).toBeDefined();
    expect(first?.viable).toBe(true);
    // GR18S prints no response time anywhere, so this can only be `unknown`.
    const responseVerdict = first?.verdicts.find((v) => v.field === "responseTimeMs");
    expect(responseVerdict?.status).toBe("unknown");
    expect(first?.unverifiedConstraints).toContain("responseTimeMs");
    expect(first?.unknown).toBeGreaterThan(0);
    // Viable but unverified must never be reported as a clean match.
    expect(out["fullyVerifiedCount"]).toBe(0);
    expect(String(out["summary"])).toMatch(/NONE has every requested spec printed/);
  });

  it("distinguishes a verified violation from an unverifiable spec", async () => {
    const out = await run(
      "solve_constraints",
      {
        constraints: { outputType: ["NPN"], responseTimeMs: { max: 12 } },
        viableOnly: false,
        topK: 100,
      },
      familyTools,
    );
    const results = out["results"] as {
      orderNumber: string;
      viable: boolean;
      failed: number;
      verdicts: { field: string; status: string }[];
    }[];

    // 1059408 is GRTE18S-N2312 — the catalog states NPN, so it passes.
    const npn = results.find((r) => r.orderNumber === "1059408");
    expect(npn?.verdicts.find((v) => v.field === "outputType")?.status).toBe("pass");

    // 1058200 states PNP — a *verified* violation, which is the only thing
    // allowed to disqualify a SKU.
    const pnp = results.find((r) => r.orderNumber === "1058200");
    expect(pnp?.verdicts.find((v) => v.field === "outputType")?.status).toBe("fail");
    expect(pnp?.viable).toBe(false);
    expect(pnp?.failed).toBeGreaterThan(0);

    // Same SKU, same solve: the unstated response time is still `unknown`, not
    // rolled into the failure.
    expect(pnp?.verdicts.find((v) => v.field === "responseTimeMs")?.status).toBe("unknown");
  });

  it("carries the unknown-is-silence caveat and honest totals in the payload", async () => {
    const out = await run("solve_constraints", {
      constraints: { family: ["GR18S"], outputType: ["PNP"] },
      topK: 3,
    });
    expect(String(out["verdictSemantics"])).toMatch(/SILENT/);
    expect(out["evaluated"]).toBe(catalog.products.length);
    expect(Number(out["returned"])).toBeLessThanOrEqual(3);
    expect(Number(out["viableCount"])).toBeGreaterThan(3);
  });

  it("keeps a SKU alive on an absurd constraint the catalog never states for it", async () => {
    // 500 metres. Every GR18S row that *prints* a sensing range is a verified
    // violation; the ones that survive are precisely the rows the catalog is
    // silent about. Dropping those would be the confident-wrong-answer bug.
    const out = await run(
      "solve_constraints",
      { constraints: { sensingRangeMm: { min: 500_000 } } },
      familyTools,
    );
    const results = out["results"] as {
      unknown: number;
      unverifiedConstraints: string[];
      verdicts: { field: string; status: string; detail: string }[];
    }[];
    expect(Number(out["viableCount"])).toBeGreaterThan(0);
    expect(Number(out["disqualifiedCount"])).toBeGreaterThan(0);
    expect(out["fullyVerifiedCount"]).toBe(0);
    for (const r of results) {
      expect(r.verdicts.find((v) => v.field === "sensingRangeMm")?.status).toBe("unknown");
      expect(r.unverifiedConstraints).toContain("sensingRangeMm");
      expect(r.verdicts.find((v) => v.field === "sensingRangeMm")?.detail).toMatch(
        /does not state/i,
      );
    }
  });

  it("returns an honest empty answer rather than a best-effort substitute", async () => {
    // `section` is the one field printed for literally every row, so it is
    // among the very few constraints that can disqualify the whole catalog.
    // (`family` cannot: the catalog prints some SKUs under no family heading,
    // and those survive with an honest `unknown` rather than a fail.)
    const out = await run("solve_constraints", { constraints: { section: ["Z"] } });
    expect(out["viableCount"]).toBe(0);
    expect(out["results"]).toEqual([]);
    expect(String(out["summary"])).toMatch(/No SKU in this catalog survives/);

    const familyless = await run("solve_constraints", {
      constraints: { family: ["NoSuchFamily"] },
    });
    expect(Number(familyless["viableCount"])).toBeGreaterThan(0);
    const survivors = familyless["results"] as { verdicts: { field: string; status: string }[] }[];
    for (const s of survivors) {
      expect(s.verdicts.find((v) => v.field === "family")?.status).toBe("unknown");
    }
  });

  it("echoes the constraints it actually enforced", async () => {
    const out = await run("solve_constraints", {
      constraints: { minIpRating: 67, outputType: ["PNP"] },
      topK: 1,
    });
    expect(out["constraints"]).toEqual({ minIpRating: 67, outputType: ["PNP"] });
  });

  it("refuses a misspelled or empty constraint set instead of silently narrowing it", async () => {
    await expect(tool("solve_constraints").run({ constraints: { ipRating: 67 } })).rejects.toThrow(
      /unknown field/i,
    );
    await expect(tool("solve_constraints").run({ constraints: {} })).rejects.toThrow(
      /at least one constraint/i,
    );
    await expect(
      tool("solve_constraints").run({ constraints: { outputType: ["pnp"] } }),
    ).rejects.toThrow(/not one of/i);
    await expect(
      tool("solve_constraints").run({ constraints: { responseTimeMs: {} } }),
    ).rejects.toThrow(/needs a min, a max, or both/i);
    await expect(
      tool("solve_constraints").run({ constraints: { responseTimeMs: { min: 20, max: 10 } } }),
    ).rejects.toThrow(/greater than max/i);
  });
});

// ---------------------------------------------------------------------------

describe("compare_products", () => {
  it("rejects fewer than 2 order numbers", async () => {
    await expect(
      tool("compare_products").run({ orderNumbers: ["1058200"] }),
    ).rejects.toBeInstanceOf(CatalogToolInputError);
    await expect(tool("compare_products").run({ orderNumbers: [] })).rejects.toThrow(/2 to 5/);
  });

  it("rejects more than 5 order numbers", async () => {
    await expect(
      tool("compare_products").run({
        orderNumbers: ["1058200", "1058204", "1059408", "1059409", "1059436", "1059440"],
      }),
    ).rejects.toThrow(/2 to 5/);
  });

  it("rejects duplicates, which would produce a vacuous 'identical' verdict", async () => {
    await expect(
      tool("compare_products").run({ orderNumbers: ["1058200", "1058200"] }),
    ).rejects.toThrow(/distinct/);
  });

  it("marks a field the catalog states for both as comparable, and reports whether it differs", async () => {
    const out = await run("compare_products", { orderNumbers: ["1058200", "1059408"] });
    const fields = out["fields"] as {
      field: string;
      comparable: boolean;
      identical: boolean | null;
      notStatedFor: string[];
      values: { orderNumber: string; stated: boolean; value: unknown }[];
    }[];

    const outputType = fields.find((f) => f.field === "outputType");
    expect(outputType?.comparable).toBe(true);
    expect(outputType?.identical).toBe(false); // PNP vs NPN
    expect(outputType?.values.map((v) => v.value)).toEqual(["PNP", "NPN"]);

    const ip = fields.find((f) => f.field === "ipRating");
    expect(ip?.comparable).toBe(true);
    expect(ip?.identical).toBe(true);
  });

  it("never reports 'identical' for a field the catalog does not state", async () => {
    const out = await run("compare_products", { orderNumbers: ["1058200", "1059408"] });
    const fields = out["fields"] as {
      field: string;
      comparable: boolean;
      identical: boolean | null;
      notStatedFor: string[];
    }[];

    const responseTime = fields.find((f) => f.field === "responseTimeMs");
    expect(responseTime?.comparable).toBe(false);
    // Both are silent. Silence is not agreement.
    expect(responseTime?.identical).toBeNull();
    expect(responseTime?.notStatedFor).toEqual(["1058200", "1059408"]);
  });

  it("carries a citation per compared part", async () => {
    const out = await run("compare_products", { orderNumbers: ["1058200", "1059408"] });
    const products = out["products"] as {
      orderNumber: string;
      citation: { sourcePage: string; pdfPage: number };
    }[];
    expect(products).toHaveLength(2);
    for (const p of products) {
      expect(p.citation).toMatchObject(citation(p.orderNumber));
    }
  });

  it("reports which requested parts are absent rather than quietly comparing the rest", async () => {
    const out = await run("compare_products", { orderNumbers: ["1058200", "9999999"] });
    expect(out["notInCatalog"]).toEqual(["9999999"]);
    expect(out["compared"]).toEqual(["1058200"]);
    expect(String(out["message"])).toMatch(/needs at least 2/);
  });
});

// ---------------------------------------------------------------------------

describe("list_family", () => {
  it("returns variants and accessories with citations", async () => {
    const out = await run("list_family", { family: "GR18S" });
    expect(out["found"]).toBe(true);
    expect(out["section"]).toBe("B");
    expect(Number(out["variantCount"])).toBeGreaterThan(10);
    expect(Number(out["accessoryCount"])).toBeGreaterThan(0);

    const variants = out["variants"] as { orderNumber: string; citation: { sourcePage: string } }[];
    const accessories = out["accessories"] as { orderNumber: string; rowType: string }[];
    for (const v of variants) expect(v.citation).toMatchObject(citation(v.orderNumber));
    for (const a of accessories) expect(a.rowType).toBe("accessory");
    expect(variants.some((v) => v.orderNumber === "1058200")).toBe(true);
  });

  it("can omit accessories without losing the count", async () => {
    const out = await run("list_family", { family: "GR18S", includeAccessories: false });
    expect(out["accessories"]).toEqual([]);
    expect(Number(out["accessoryCount"])).toBeGreaterThan(0);
  });

  it("surfaces per-variant unknowns alongside the key specs", async () => {
    const out = await run("list_family", { family: "GR18S" });
    const variants = out["variants"] as {
      keySpecs: { field: string; stated: boolean }[];
      notStated: string[];
    }[];
    const first = variants[0];
    expect(first?.keySpecs.some((s) => s.field === "outputType")).toBe(true);
    expect(first?.notStated).toContain("responseTimeMs");
  });

  it("returns found:false for a family the catalog does not have", async () => {
    const out = await run("list_family", { family: "not-a-family" });
    expect(out["found"]).toBe(false);
    expect(String(out["message"])).toMatch(/case-sensitive/);
  });
});

// ---------------------------------------------------------------------------

describe("search_catalog", () => {
  it("returns ranked candidates, each citable to a catalog page", async () => {
    const out = await run("search_catalog", { query: "fotocelula cilindrica GR18S", topK: 5 });
    const candidates = out["candidates"] as {
      rank: number;
      citation: { sourcePage: string; pdfPage: number };
      snippet: string;
    }[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(5);
    candidates.forEach((c, i) => {
      expect(c.rank).toBe(i);
      expect(typeof c.citation.sourcePage).toBe("string");
      expect(c.citation.sourcePage.length).toBeGreaterThan(0);
      expect(Number.isInteger(c.citation.pdfPage)).toBe(true);
      expect(c.snippet.length).toBeGreaterThan(0);
    });
  });

  it("attaches the ranking-is-not-evidence caveat to the result itself", async () => {
    const out = await run("search_catalog", { query: "photoelectric sensor", topK: 2 });
    expect(String(out["ranking"])).toMatch(/NOT evidence of technical equivalence/);
    expect(String(out["ranking"])).toMatch(/solve_constraints/);
  });

  it("reports lanes that did not run as unavailable instead of inventing a rank", async () => {
    const out = await run("search_catalog", { query: "GR18S", topK: 3 });
    expect(out["lanes"]).toEqual({
      lexicalBm25: "live",
      denseEmbedding: "unavailable",
      crossEncoderRerank: "unavailable",
    });
    const candidates = out["candidates"] as { signals: { denseRank: number | null } }[];
    for (const c of candidates) expect(c.signals.denseRank).toBeNull();
  });

  it("echoes the constraints it prefiltered on, so an unconstrained search is visible", async () => {
    const constrained = await run("search_catalog", {
      query: "cylindrical photoelectric sensor",
      constraints: { outputType: ["NPN"], family: ["GR18S"] },
      topK: 5,
    });
    expect(constrained["constraintsApplied"]).toEqual({ outputType: ["NPN"], family: ["GR18S"] });
    const candidates = constrained["candidates"] as { orderNumber: string | null }[];
    // Every surviving SKU must be one the prefilter kept — a PNP-stated row is
    // a verified violation and must not appear.
    expect(candidates.some((c) => c.orderNumber === "1058200")).toBe(false);

    const open = await run("search_catalog", {
      query: "cylindrical photoelectric sensor",
      topK: 5,
    });
    expect(open["constraintsApplied"]).toBeNull();
  });

  it("rejects a bad query rather than searching for nothing", async () => {
    await expect(tool("search_catalog").run({ query: "   " })).rejects.toBeInstanceOf(
      CatalogToolInputError,
    );
    await expect(tool("search_catalog").run({ query: "ok", nope: 1 })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("index_stats", () => {
  it("passes the retriever's stats through and states the catalog's own limits", async () => {
    const out = await run("index_stats", {});
    expect(out["productCount"]).toBe(catalog.products.length);
    expect(out["embeddingModel"]).toBeNull();

    const source = out["source"] as Record<string, unknown>;
    expect(String(source["catalog"])).toMatch(/resumido|Catálogo resumido/i);

    const limits = out["limits"] as string[];
    expect(limits.length).toBeGreaterThan(3);
    expect(limits.join(" ")).toMatch(/unknown, never a failure/i);
    expect(limits.join(" ")).toMatch(/relevance heuristic/i);
  });

  it("takes no input", () => {
    const schema = tool("index_stats").input_schema;
    expect(schema.properties).toEqual({});
    expect(schema.required).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("fail-open behaviour at the boundary", () => {
  it("survives a retriever whose stats() returns something unusable", async () => {
    const [, , , , , stats] = createCatalogTools({
      ...makeRetriever(),
      stats: () => null,
    });
    const out = (await stats?.run({})) as Record<string, unknown>;
    // No stats to report is not a reason to fail the call — the honest limits
    // are still worth returning.
    expect(Array.isArray(out["limits"])).toBe(true);
    expect(out["source"]).toBeDefined();
  });

  it("tolerates a retriever that wraps its product record", async () => {
    const product = byOrderNumber.get("1058200");
    const [, get] = createCatalogTools({
      ...makeRetriever(),
      getProduct: () => ({ product, spec: null, citation: null }),
    });
    const out = (await get?.run({ orderNumber: "1058200" })) as Record<string, unknown>;
    expect(out["found"]).toBe(true);
    expect(out["citation"]).toMatchObject(citation("1058200"));
  });

  it("reports an empty family lookup as not found rather than throwing", async () => {
    const [, , , , listFamily] = createCatalogTools({
      ...makeRetriever(),
      getFamily: () => undefined,
    });
    const out = (await listFamily?.run({ family: "GR18S" })) as Record<string, unknown>;
    expect(out["found"]).toBe(false);
  });
});
