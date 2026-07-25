/**
 * Orchestrator tests.
 *
 * The retriever here is the **real** one, built over a real slice of the shipped
 * SICK catalog (`G6` photoelectrics + `IQ Standard` inductives) with the real
 * chunker and the real deterministic solver. Nothing about the ranking or the
 * verdicts is simulated — the point of these tests is the *wiring*, and wiring
 * asserted against a fake solver proves nothing about whether an unknown reaches
 * the user as an unknown.
 *
 * Both Voyage lanes are stubbed to their fail-open shapes, so the tests run the
 * exact lexical-only code path a laptop with no API key runs, and never open a
 * socket.
 *
 * The Resolver and the Challenger are mocked. That is deliberate and not
 * laziness: this file is testing the *order the stages run in* and the *rules
 * enforced between them*, and driving those through two LLM agents' prompt
 * plumbing would make the assertions depend on prompt wording rather than on the
 * pipeline. Their own behaviour is tested in their own files.
 */

import { fileURLToPath } from "node:url";

import {
  buildChunks,
  createRetriever,
  loadCatalogSync,
  normalizeAll,
  serializeIndex,
  type Catalog,
  type ConstraintVerdict,
  type NormalizedSpec,
  type RetrievalResult,
  type Retriever,
  type SickProduct,
  type SolveResult,
  type SpecConstraints,
} from "@no-human/rag";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeClient } from "./claude.js";
import type { CompetitorIndex } from "./competitors.js";
import { createTrace } from "./trace.js";
import type {
  Challenge,
  ChallengeReport,
  ClarifyingQuestion,
  IdentifiedPart,
  MigrationReport,
  ResolvedInput,
  TraceEvent,
} from "./types.js";

import { challengeAll } from "./challenger.js";
import {
  buildRetrievalQuery,
  confidenceFor,
  runBomAudit,
  runMigration,
  type MigrationDeps,
} from "./orchestrator.js";
import { renderMarkdown, renderTraceSummary, SICK_NOT_STATED } from "./report.js";
import { resolve } from "./resolver.js";

vi.mock("./resolver.js", () => ({ resolve: vi.fn() }));
vi.mock("./challenger.js", () => ({ challengeAll: vi.fn() }));

const resolveMock = vi.mocked(resolve);
const challengeAllMock = vi.mocked(challengeAll);

// ---------------------------------------------------------------------------
// A real slice of the real catalog
// ---------------------------------------------------------------------------

const DATASET_DIR = fileURLToPath(new URL("../../../sick-catalog-dataset/", import.meta.url));
const SLICE = new Set(["G6", "IQ Standard"]);

const full = loadCatalogSync(DATASET_DIR);
const products: SickProduct[] = full.products.filter(
  (p) => p.family !== undefined && SLICE.has(p.family),
);
const catalog: Catalog = {
  products,
  families: full.families.filter((f) => SLICE.has(f.family)),
  sourceDir: full.sourceDir,
};
const specs = normalizeAll(products);
const index = serializeIndex({
  provenance: {
    builtAt: "2026-07-25T00:00:00.000Z",
    sourceDir: catalog.sourceDir,
    chunkCount: 0,
    documentCount: 2,
    productCount: products.length,
    embeddedChunkCount: 0,
    embeddingModel: null,
    embeddingDimension: null,
  },
  chunks: buildChunks(catalog),
  specs,
  products,
  families: catalog.families,
});

/**
 * Both network lanes, pinned to their fail-open shapes.
 *
 * `embedQuery` returning `[]` is exactly what "no Voyage key" produces, and the
 * rerank stub reproduces `voyageRerank`'s identity fallback byte for byte so the
 * retriever's `isIdentityFallback` detector reports `rerankRank: null` — which
 * is what makes the "lanes are honest" assertion below meaningful.
 */
function realRetriever(): Retriever {
  return createRetriever(index, {
    embedQuery: async () => [],
    rerank: async (_query, documents) =>
      documents.map((_doc, i) => ({ index: i, score: (documents.length - i) / documents.length })),
  });
}

/** The Resolver is mocked, so the index is only ever passed through. */
const competitors: CompetitorIndex = {
  lookup: () => undefined,
  priorRecommendation: () => [],
  knownGap: () => false,
  vendors: () => ["Banner"],
  size: () => 0,
  products: () => [],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTIFIED: IdentifiedPart = {
  vendor: "Banner",
  series: "MINI-BEAM",
  rawInput: "SM312D",
  description: "Miniature self-contained photoelectric sensor",
  specSource: "dataset",
  citation: { typeCode: "MINI-BEAM", family: "MINI-BEAM", sourcePage: "Banner p.12", pdfPage: 11 },
};

/**
 * A constraint set the real catalog answers *partially*: PNP and the 200 mm
 * working distance are printed on the G6 pages, the response time is not. That
 * asymmetry is the whole subject of this suite.
 */
const CONSTRAINTS: SpecConstraints = {
  outputType: ["PNP"],
  sensingRangeMm: { min: 200 },
  responseTimeMs: { max: 10 },
};

function resolved(overrides: Partial<ResolvedInput> = {}): ResolvedInput {
  return {
    constraints: CONSTRAINTS,
    identified: IDENTIFIED,
    missing: ["supplyVoltageV"],
    questions: [],
    sufficient: true,
    rationale: "Banner MINI-BEAM diffuse at 200 mm, PNP.",
    assumptions: ["Replacing the longest-range diffuse variant of the series."],
    ...overrides,
  };
}

const QUESTION: ClarifyingQuestion = {
  field: "sensingRangeMm",
  question: "How far is the target from the sensor face?",
  why: "A diffuse sensor's range decides the entire family shortlist.",
  options: ["under 100 mm", "100–500 mm"],
};

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    claim: "The M8 connector does not fit the existing M12 cordset.",
    severity: "fatal",
    field: "connector",
    verdict: "upheld",
    evidence: "Catalog states a 4-pin M8 male connector.",
    ...overrides,
  };
}

function report(orderNumber: string, survives: boolean, challenges: Challenge[] = []): ChallengeReport {
  return {
    orderNumber,
    challenges,
    survives,
    summary: survives ? "No fatal objection landed." : "Killed on a fatal objection.",
  };
}

function deps(retriever: Retriever = realRetriever()): MigrationDeps {
  return { client: createFakeClient([]), retriever, competitors };
}

/** Every event type in the report's trace, in order. */
function types(trace: readonly TraceEvent[]): string[] {
  return trace.map((event) => event.type);
}

function orderNumbers(report_: MigrationReport): string[] {
  return report_.outcome.kind === "recommendation"
    ? report_.outcome.recommendations.map((r) => r.product.orderNumber)
    : [];
}

beforeEach(() => {
  resolveMock.mockReset();
  challengeAllMock.mockReset();
});

// ---------------------------------------------------------------------------

describe("the test corpus", () => {
  it("is a real slice of the shipped catalog", () => {
    expect(products.length).toBeGreaterThan(30);
    expect(products.some((p) => p.orderNumber === "1052442" && p.typeCode === "GTB6-P4212")).toBe(true);
    // The premise of the whole suite: response time is genuinely unprinted here.
    expect(products.every((p) => p.responseTimeMs === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — the gate
// ---------------------------------------------------------------------------

describe("underspecified input", () => {
  it("returns needs_input without touching retrieval or the challenger", async () => {
    resolveMock.mockResolvedValue(resolved({ sufficient: false, questions: [QUESTION] }));

    const retriever = realRetriever();
    const searchSpy = vi.spyOn(retriever, "search");
    const solveSpy = vi.spyOn(retriever, "solveConstraints");

    const result = await runMigration({ kind: "description", value: "a sensor" }, deps(retriever));

    expect(result.outcome.kind).toBe("needs_input");
    if (result.outcome.kind !== "needs_input") throw new Error("unreachable");
    expect(result.outcome.questions).toEqual([QUESTION]);

    // The assertions this test exists for.
    expect(searchSpy).not.toHaveBeenCalled();
    expect(solveSpy).not.toHaveBeenCalled();
    expect(challengeAllMock).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
  });

  it("emits no retrieval or solver events on the short-circuit path", async () => {
    resolveMock.mockResolvedValue(resolved({ sufficient: false, questions: [QUESTION] }));

    const result = await runMigration({ kind: "description", value: "a sensor" }, deps());

    expect(types(result.trace)).toEqual(["run.start", "report.ready"]);
    expect(types(result.trace)).not.toContain("retrieval.start");
    expect(types(result.trace)).not.toContain("solver.verdicts");
  });

  it("never returns needs_input with nothing for the user to answer", async () => {
    resolveMock.mockResolvedValue(resolved({ sufficient: false, questions: [] }));

    const result = await runMigration({ kind: "description", value: "a sensor" }, deps());

    if (result.outcome.kind !== "needs_input") throw new Error("expected needs_input");
    expect(result.outcome.questions.length).toBeGreaterThan(0);
    expect(result.outcome.questions[0]?.why).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Rule: the solver ranks, not retrieval
// ---------------------------------------------------------------------------

describe("recommendation order", () => {
  it("follows the deterministic solver, not the retrieval ranking", async () => {
    resolveMock.mockResolvedValue(resolved());

    const retriever = realRetriever();
    const query = buildRetrievalQuery(resolved(), { kind: "description", value: "diffuse PNP" });
    const natural = await retriever.search(query, { topK: 12, constraints: CONSTRAINTS });
    expect(natural.length).toBeGreaterThan(2);

    // Hand retrieval back deliberately *reversed*, so "retrieval order" and
    // "solver order" cannot coincide by accident.
    const reversed: RetrievalResult[] = [...natural].reverse();
    vi.spyOn(retriever, "search").mockResolvedValue(reversed);

    const retrievalOrder = reversed
      .map((r) => r.chunk.orderNumber)
      .filter((o): o is string => o !== undefined);
    const solverOrder = retriever
      .solveConstraints(CONSTRAINTS, { candidates: retrievalOrder })
      .map((s) => s.product.orderNumber);

    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps(retriever));

    const challenged = (challengeAllMock.mock.calls[0]?.[0] ?? []).map(
      (c) => c.product.orderNumber,
    );
    expect(challenged).toEqual(solverOrder.slice(0, challenged.length));
    // The two orders genuinely differ — otherwise the assertion above is vacuous.
    expect(solverOrder).not.toEqual(retrievalOrder);
    expect(orderNumbers(result)[0]).toBe(solverOrder[0]);
    expect(orderNumbers(result)[0]).not.toBe(retrievalOrder[0]);
  });

  it("reports which retrieval lanes actually ran, with honest nulls", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());

    const event = result.trace.find((e) => e.type === "retrieval.results");
    if (event?.type !== "retrieval.results") throw new Error("no retrieval.results event");
    expect(event.lanes.bm25).toBe(true);
    // No vectors in the artifact and no reranker: never claim a lane that never ran.
    expect(event.lanes.dense).toBe(false);
    expect(event.lanes.rerank).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — refusal is a successful run
// ---------------------------------------------------------------------------

describe("no survivor", () => {
  it("returns no_equivalent with a closest candidate and a populated lost list", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, false, [challenge()])),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());

    expect(result.outcome.kind).toBe("no_equivalent");
    if (result.outcome.kind !== "no_equivalent") throw new Error("unreachable");
    expect(result.outcome.closest).toBeDefined();
    expect(result.outcome.lost.length).toBeGreaterThan(0);
    // The upheld objection is priced concretely...
    expect(result.outcome.lost.join("\n")).toContain("M8 connector does not fit");
    // ...and so is every constraint the catalog could not answer.
    expect(result.outcome.lost.some((l) => l.startsWith("Unverifiable:"))).toBe(true);
    expect(result.outcome.reason).toContain("unverified");
  });

  it("emits candidate.promoted when rank 1 dies and rank 2 survives", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c, i) =>
        i === 0
          ? report(c.product.orderNumber, false, [challenge()])
          : report(c.product.orderNumber, true),
      ),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());

    const promotion = result.trace.find((e) => e.type === "candidate.promoted");
    if (promotion?.type !== "candidate.promoted") throw new Error("no promotion event");
    expect(promotion.from).not.toBe(promotion.to);
    expect(promotion.because).toContain("M8 connector does not fit");
    expect(result.outcome.kind).toBe("recommendation");
    expect(orderNumbers(result)[0]).toBe(promotion.to);
  });

  it("returns no_equivalent when retrieval surfaces nothing", async () => {
    resolveMock.mockResolvedValue(resolved());
    const retriever = realRetriever();
    vi.spyOn(retriever, "search").mockResolvedValue([]);

    const result = await runMigration({ kind: "description", value: "nothing" }, deps(retriever));

    expect(result.outcome.kind).toBe("no_equivalent");
    if (result.outcome.kind !== "no_equivalent") throw new Error("unreachable");
    expect(result.outcome.closest).toBeUndefined();
    expect(result.outcome.reason).toContain("no SKU");
    expect(challengeAllMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — an agent may reject a candidate, never introduce one
// ---------------------------------------------------------------------------

describe("the LLM never picks the part", () => {
  it("discards a challenge report naming a SKU the solver never ranked", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockResolvedValue([report("9999999", true)]);

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());

    expect(orderNumbers(result)).not.toContain("9999999");
    expect(result.outcome.kind).toBe("no_equivalent");
    const error = result.trace.find((e) => e.type === "error");
    if (error?.type !== "error") throw new Error("no error event");
    expect(error.recoverable).toBe(true);
    expect(error.message).toContain("9999999");
  });
});

// ---------------------------------------------------------------------------
// Unknown is not pass
// ---------------------------------------------------------------------------

function verdict(field: string, status: ConstraintVerdict["status"]): ConstraintVerdict {
  return { field, status, detail: `requires ${field} something, catalog states something` };
}

function solveResult(verdicts: ConstraintVerdict[]): SolveResult {
  const product = products[0]!;
  const spec: NormalizedSpec = { orderNumber: product.orderNumber, lowConfidence: [] };
  return {
    product,
    spec,
    verdicts,
    passed: verdicts.filter((v) => v.status === "pass").length,
    failed: verdicts.filter((v) => v.status === "fail").length,
    unknown: verdicts.filter((v) => v.status === "unknown").length,
    viable: verdicts.every((v) => v.status !== "fail"),
  };
}

describe("confidenceFor", () => {
  it("caps at low when any requested constraint is unverified", () => {
    const solve = solveResult([verdict("outputType", "pass"), verdict("responseTimeMs", "unknown")]);
    expect(confidenceFor(solve, report("x", true))).toBe("low");
  });

  it("caps at low for a safety-relevant unknown even alongside many passes", () => {
    const solve = solveResult([
      verdict("outputType", "pass"),
      verdict("connector", "pass"),
      verdict("principle", "pass"),
      verdict("minIpRating", "unknown"),
    ]);
    expect(confidenceFor(solve, report("x", true))).toBe("low");
  });

  it("is high only when everything requested passes and no major objection is upheld", () => {
    const solve = solveResult([verdict("outputType", "pass"), verdict("connector", "pass")]);
    expect(confidenceFor(solve, report("x", true))).toBe("high");
    expect(confidenceFor(solve)).toBe("high");
  });

  it("drops to medium when a major objection is upheld", () => {
    const solve = solveResult([verdict("outputType", "pass")]);
    const upheld = report("x", true, [
      challenge({ severity: "major", verdict: "upheld", claim: "Alignment tolerance is tighter." }),
    ]);
    expect(confidenceFor(solve, upheld)).toBe("medium");
  });

  it("is not raised by a refuted or unverifiable objection", () => {
    const solve = solveResult([verdict("outputType", "pass")]);
    const refuted = report("x", true, [
      challenge({ severity: "major", verdict: "refuted" }),
      challenge({ severity: "major", verdict: "unverifiable" }),
    ]);
    expect(confidenceFor(solve, refuted)).toBe("high");
  });

  it("is low when nothing was checked at all", () => {
    expect(confidenceFor(solveResult([]), report("x", true))).toBe("low");
  });

  it("is low when a constraint is verified to fail", () => {
    expect(confidenceFor(solveResult([verdict("outputType", "fail")]))).toBe("low");
  });

  it("caps a real end-to-end recommendation at low when the catalog is silent", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());

    if (result.outcome.kind !== "recommendation") throw new Error("expected a recommendation");
    const top = result.outcome.recommendations[0]!;
    expect(top.solve.unknown).toBeGreaterThan(0);
    expect(top.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  it("marks unverified specs rather than letting them read as a match", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());
    const markdown = renderMarkdown(result);

    expect(markdown).toContain("unverified");
    expect(markdown).toContain("It is **not** a pass");
    expect(markdown).toContain(SICK_NOT_STATED);
    expect(markdown).toContain("confidence: low");
    // Every asserted spec carries a page.
    expect(markdown).toMatch(/catalog page B-\d+, PDF page \d+/);
    expect(markdown).toContain("## Citations");
  });

  it("renders the questions and nothing else for needs_input", async () => {
    resolveMock.mockResolvedValue(resolved({ sufficient: false, questions: [QUESTION] }));

    const result = await runMigration({ kind: "description", value: "a sensor" }, deps());
    const markdown = renderMarkdown(result);

    expect(markdown).toContain(QUESTION.question);
    expect(markdown).toContain(QUESTION.why);
    expect(markdown).not.toContain("## Recommendations");
    expect(markdown).not.toContain("#### Comparison");
    expect(markdown).not.toContain("## Citations");
  });

  it("leads a no_equivalent with the refusal and what is lost", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, false, [challenge()])),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());
    const markdown = renderMarkdown(result);

    expect(markdown.indexOf("# No honest SICK equivalent")).toBe(0);
    expect(markdown.indexOf("## What you give up")).toBeLessThan(markdown.indexOf("## Problem"));
    expect(markdown).toContain("Closest candidate (rejected)");
  });
});

describe("renderTraceSummary", () => {
  it("lists every stage with its timing", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const result = await runMigration({ kind: "description", value: "diffuse PNP" }, deps());
    const summary = renderTraceSummary(result);

    expect(summary).toContain("run.start");
    expect(summary).toContain("retrieval.results");
    expect(summary).toContain("solver.verdicts");
    expect(summary).toContain("report.ready");
    expect(summary.split("\n").length).toBeGreaterThan(result.trace.length);
  });
});

// ---------------------------------------------------------------------------
// BOM audit
// ---------------------------------------------------------------------------

describe("runBomAudit", () => {
  const CSV = [
    "Part Number,Qty,Vendor,Description",
    "SM312D,2,Banner,Diffuse photoelectric sensor",
    ",1,,Bracket for the above",
    "TOTAL,,,",
  ].join("\n");

  it("reports a row with no part number as unprocessable rather than skipping it", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const entries = await runBomAudit(CSV, deps());

    // Three data rows in, three audited rows out. Nothing was dropped.
    expect(entries).toHaveLength(3);
    const unprocessable = entries.filter((e) => e.row.partNumber === undefined);
    expect(unprocessable.length).toBeGreaterThan(0);
    for (const entry of unprocessable) {
      expect(entry.report.outcome.kind).toBe("needs_input");
      if (entry.report.outcome.kind !== "needs_input") throw new Error("unreachable");
      expect(entry.report.outcome.questions[0]?.field).toBe("partNumber");
      expect(entry.report.outcome.questions[0]?.question).toContain(String(entry.row.line));
    }
    // An unprocessable row costs nothing — no model call is made for it.
    expect(resolveMock).toHaveBeenCalledTimes(entries.length - unprocessable.length);
  });

  it("carries the row's vendor into the migration input", async () => {
    resolveMock.mockResolvedValue(resolved());
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const entries = await runBomAudit(CSV, deps());
    const processed = entries.find((e) => e.row.partNumber !== undefined);
    expect(processed?.report.input).toEqual({
      kind: "part_number",
      value: "SM312D",
      vendorHint: "Banner",
    });
  });

  it("gives each row its own trace and forwards it into a shared parent", async () => {
    resolveMock.mockResolvedValue(resolved({ sufficient: false, questions: [QUESTION] }));

    const parent = createTrace();
    const entries = await runBomAudit(CSV, { ...deps(), trace: parent });

    for (const entry of entries) {
      // Self-contained: a row's report never carries another row's events.
      expect(entry.report.trace.length).toBeGreaterThan(0);
      expect(entry.report.trace.length).toBeLessThan(parent.events().length);
    }
    expect(parent.events().some((e) => e.label.startsWith("bom line "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

describe("stats", () => {
  it("meters every model call made by any stage", async () => {
    resolveMock.mockImplementation(async (_input, options) => {
      // Stand in for the real Resolver's structured call.
      await options.client.structured({
        system: "s",
        messages: [],
        schema: {},
      });
      return resolved();
    });
    challengeAllMock.mockImplementation(async (candidates) =>
      candidates.map((c) => report(c.product.orderNumber, true)),
    );

    const client = createFakeClient([
      { type: "structured", value: {}, usage: { inputTokens: 120, outputTokens: 40 } },
    ]);
    const result = await runMigration(
      { kind: "description", value: "diffuse PNP" },
      { client, retriever: realRetriever(), competitors },
    );

    expect(result.stats.inputTokens).toBe(120);
    expect(result.stats.outputTokens).toBe(40);
    expect(result.stats.ms).toBeGreaterThanOrEqual(0);
  });
});
