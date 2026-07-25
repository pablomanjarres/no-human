import { describe, it, expect } from "vitest";

import {
  buildChunks,
  createRetriever,
  normalizeAll,
  serializeIndex,
  type Catalog,
  type IndexProvenance,
  type Retriever,
  type SickFamily,
  type SickProduct,
} from "@no-human/rag";

import { createFakeClient, type ScriptedResponse } from "./claude.js";
import { consult } from "./consultant.js";
import { createTrace } from "./trace.js";
import type { TraceEvent } from "./types.js";

// ---------------------------------------------------------------------------
// A small but real catalog index
// ---------------------------------------------------------------------------
//
// Real rather than mocked on purpose: the guarantee under test is "an order
// number the model proposed is resolved against the actual catalog", and a
// stubbed `getProduct` would let that pass while the real lookup was broken.
// Three rows are enough — a sensor, a bracket and a cordset — because the point
// is which of them survive resolution, not how many there are.

const SENSOR: SickProduct = {
  orderNumber: "1052442",
  typeCode: "WTB4-3P2261",
  family: "W4-3",
  rowType: "product",
  category: "Fotocelulas (Photoelectric sensors)",
  section: "B",
  sourcePage: "B-16",
  pdfPage: 40,
  occurrences: 1,
  alsoOnPages: [],
  productName: "Fotocélula miniatura con supresión de fondo",
  sensingRangeMinMm: 20,
  sensingRangeMaxMm: 550,
  switchingOutput: "PNP",
  connection: "Conector M8 de 4 polos",
  enclosureRating: "IP 67",
  sensorPrinciple: "Supresión del fondo",
  lightType: "Luz roja",
};

const BRACKET: SickProduct = {
  orderNumber: "2051422",
  typeCode: "BEF-WN-W4S",
  family: "W4-3",
  rowType: "accessory",
  category: "Fotocelulas (Photoelectric sensors)",
  section: "B",
  sourcePage: "B-21",
  pdfPage: 45,
  occurrences: 2,
  alsoOnPages: ["B-24"],
  productName: "Escuadra de montaje",
};

const CORDSET: SickProduct = {
  orderNumber: "6009382",
  typeCode: "DOL-0804-G02M",
  family: "W4-3",
  rowType: "accessory",
  category: "Fotocelulas (Photoelectric sensors)",
  section: "B",
  sourcePage: "B-21",
  pdfPage: 45,
  occurrences: 3,
  alsoOnPages: ["B-24", "B-30"],
  productName: "Conector hembra M8 de 4 polos, cable 2 m",
  connection: "Conector M8 de 4 polos",
};

const FAMILY: SickFamily = {
  section: "B",
  category: "Fotocelulas (Photoelectric sensors)",
  family: "W4-3",
  productVariants: 1,
  accessoryRows: 2,
  nPages: 2,
  pages: ["B-16", "B-21"],
};

function makeRetriever(): Retriever {
  const products = [SENSOR, BRACKET, CORDSET];
  const catalog: Catalog = { products, families: [FAMILY], sourceDir: "/test" };
  const provenance: IndexProvenance = {
    builtAt: "2026-01-01T00:00:00.000Z",
    sourceDir: "/test",
    chunkCount: 0,
    documentCount: 1,
    productCount: products.length,
    embeddingModel: null,
    embeddingDimension: null,
    embeddedChunkCount: 0,
  };
  return createRetriever(
    serializeIndex({
      provenance,
      chunks: buildChunks(catalog),
      specs: normalizeAll(products),
      products,
      families: [FAMILY],
    }),
  );
}

// ---------------------------------------------------------------------------
// Scripted model output
// ---------------------------------------------------------------------------

interface GapScript {
  field: string;
  status: "stated" | "missing";
  evidence: string | null;
}

/** Every standard gap, defaulting to `missing`, with the given ones overridden. */
function gaps(stated: readonly GapScript[]): unknown[] {
  const fields = [
    "targetObject",
    "targetSurface",
    "sensingDistance",
    "lineSpeed",
    "ambientConditions",
    "mountingSpace",
    "outputType",
    "supplyVoltage",
    "budget",
  ];
  const overrides = new Map(stated.map((g) => [g.field, g]));
  return fields.map((field) => {
    const override = overrides.get(field);
    return {
      field,
      status: override?.status ?? "missing",
      evidence: override?.evidence ?? null,
      question: `What about ${field}?`,
      why: `Because ${field} changes which sensing principle and which variant are viable.`,
      options: [],
    };
  });
}

function triage(principleFamily: string, stated: readonly GapScript[]): ScriptedResponse {
  return {
    type: "structured",
    value: {
      understood: "Detect a box on a conveyor.",
      principleFamily,
      requirements: ["Detect the box reliably."],
      assumptions: [],
      gaps: gaps(stated),
    },
  };
}

/** The problem used by every test that is meant to get past the gate. */
const SPECIFIED_PROBLEM =
  "I need to detect a matte black cardboard box on a conveyor at 400 mm, with a PNP output into a Siemens PLC, 24 V DC supply, dry indoor plant, plenty of mounting space.";

const SPECIFIED_GAPS: GapScript[] = [
  { field: "targetObject", status: "stated", evidence: "matte black cardboard box" },
  { field: "targetSurface", status: "stated", evidence: "matte black" },
  { field: "sensingDistance", status: "stated", evidence: "at 400 mm" },
  { field: "outputType", status: "stated", evidence: "a PNP output into a Siemens PLC" },
];

function design(bom: readonly { role: string; orderNumber: string; quantity: number }[]): ScriptedResponse {
  return {
    type: "structured",
    value: {
      problem: "Detect a matte black cardboard box at 400 mm on a conveyor.",
      requirements: ["Detect matte black cardboard at 400 mm", "PNP output"],
      assumptions: ["Line speed is moderate."],
      approach: "Background suppression, because matte black returns too little light for a diffuse sensor.",
      alternativesConsidered: [
        { approach: "Diffuse sensor", rejectedBecause: "Matte black returns ~6 % remission, gutting the range." },
        { approach: "Through-beam pair", rejectedBecause: "Needs a mounting point on both sides of the conveyor." },
      ],
      billOfMaterials: bom.map((line) => ({ ...line, why: `Needed as the ${line.role}.` })),
      requiredOutputType: "PNP",
      requiredSupplyVoltageV: 24,
      requiredSensingDistanceMm: 400,
      requiresWashdown: false,
      limitations: [],
      confidence: "high",
    },
  };
}

// The investigation must actually CALL the tools, not just narrate having done
// so. `consult` only accepts a BOM line whose order number a tool returned on
// this turn -- a part the model merely recalled is dropped even when it exists
// in the catalog -- so a scripted turn that executes nothing produces a design
// with every line stripped.
const INVESTIGATION: ScriptedResponse = {
  type: "text",
  text: "Shortlisted 1052442 (WTB4-3P2261, page B-16) plus bracket 2051422 and cordset 6009382 on page B-21.",
  invoke: [
    { name: "get_product", input: { orderNumber: "1052442" } },
    { name: "get_product", input: { orderNumber: "2051422" } },
    { name: "get_product", input: { orderNumber: "6009382" } },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consult — the needs-input path", () => {
  it("returns questions, not a design, when the problem is vague", async () => {
    const client = createFakeClient([triage("photoelectric", [])]);
    const events: TraceEvent[] = [];
    const trace = createTrace({ onEvent: (e) => events.push(e) });

    const outcome = await consult(
      { problem: "I need to detect black boxes on a conveyor" },
      { client, retriever: makeRetriever(), trace },
    );

    expect(outcome.kind).toBe("needs_input");
    if (outcome.kind !== "needs_input") throw new Error("unreachable");

    // One model call and no design: the run stopped before it could guess.
    expect(client.calls).toHaveLength(1);
    expect(client.remaining).toBe(0);

    const asked = outcome.questions.map((q) => q.field);
    expect(asked).toContain("sensingDistance");
    expect(asked).toContain("outputType");
    // Photoelectric, so the surface question is load-bearing and must be asked.
    expect(asked).toContain("targetSurface");

    for (const question of outcome.questions) {
      expect(question.question.trim()).not.toBe("");
      expect(question.why.trim()).not.toBe("");
      // A `why` that merely restates the question is the stalling this field
      // exists to disprove.
      expect(question.why).not.toBe(question.question);
    }

    expect(events.some((e) => e.type === "resolver.question")).toBe(true);
    expect(events.filter((e) => e.type === "report.ready")).toHaveLength(1);
  });

  it("falls back to its own questions when the model supplies none", async () => {
    const client = createFakeClient([
      {
        type: "structured",
        value: { understood: "", principleFamily: "photoelectric", requirements: [], assumptions: [], gaps: [] },
      },
    ]);

    const outcome = await consult({ problem: "detect something" }, { client, retriever: makeRetriever() });

    expect(outcome.kind).toBe("needs_input");
    if (outcome.kind !== "needs_input") throw new Error("unreachable");
    // Rule 2 has to survive a model that returns nothing useful.
    expect(outcome.questions.length).toBeGreaterThanOrEqual(4);
    for (const question of outcome.questions) expect(question.why.length).toBeGreaterThan(30);
  });

  it("treats a claim of coverage the user never made as missing", async () => {
    // The model says the distance was stated and quotes words that are not in
    // the problem. Believing it is exactly how thin input becomes a confident
    // answer, so the claim is downgraded and the question is asked anyway.
    const client = createFakeClient([
      triage("proximity", [
        { field: "targetObject", status: "stated", evidence: "steel gear teeth" },
        { field: "outputType", status: "stated", evidence: "PNP" },
        { field: "sensingDistance", status: "stated", evidence: "mounted 4 mm from the target" },
      ]),
    ]);
    const events: TraceEvent[] = [];
    const trace = createTrace({ onEvent: (e) => events.push(e) });

    const outcome = await consult(
      { problem: "detect steel gear teeth, PNP into the PLC" },
      { client, retriever: makeRetriever(), trace },
    );

    expect(outcome.kind).toBe("needs_input");
    if (outcome.kind !== "needs_input") throw new Error("unreachable");
    expect(outcome.questions.map((q) => q.field)).toEqual(["sensingDistance"]);
    // Not photoelectric, so the surface question is correctly not asked.
    expect(outcome.questions.map((q) => q.field)).not.toContain("targetSurface");

    const downgrade = events.find((e) => e.type === "error" && e.label.includes("sensingDistance"));
    expect(downgrade).toBeDefined();
    expect(downgrade?.type === "error" ? downgrade.recoverable : false).toBe(true);
  });

  it("accepts a gap answered through a previous run's question", async () => {
    const client = createFakeClient([
      triage("proximity", [
        { field: "targetObject", status: "stated", evidence: "steel gear teeth" },
        { field: "outputType", status: "stated", evidence: "PNP" },
      ]),
      INVESTIGATION,
      design([{ role: "sensor", orderNumber: "1052442", quantity: 1 }]),
    ]);

    const outcome = await consult(
      {
        problem: "detect steel gear teeth, PNP into the PLC",
        answers: { sensingDistance: "4 mm" },
      },
      { client, retriever: makeRetriever() },
    );

    // The answer came back through our own question, so it needs no quote.
    expect(outcome.kind).toBe("solution");
  });
});

describe("consult — the design path", () => {
  it("drops a real catalog part that no tool returned on this turn", async () => {
    // Rule 1's dangerous case. A 7-digit number recalled from training that
    // happens to exist in the catalog passes an existence check, renders with a
    // genuine citation, and is indistinguishable from a researched part. The
    // only thing that separates them is whether a tool actually returned it.
    const client = createFakeClient([
      triage("photoelectric", SPECIFIED_GAPS),
      // A narrower investigation: the sensor only. The bracket is never looked up.
      {
        type: "text",
        text: "Shortlisted 1052442 (WTB4-3P2261, page B-16).",
        invoke: [{ name: "get_product", input: { orderNumber: "1052442" } }],
      },
      design([
        { role: "sensor", orderNumber: "1052442", quantity: 1 },
        // Real, in this catalog — but no tool returned it on this turn.
        { role: "accessory", orderNumber: "2051422", quantity: 1 },
      ]),
    ]);

    const retriever = makeRetriever();
    // Guard the premise: the part IS in the catalog, so an existence check
    // alone would have let it through.
    expect(retriever.getProduct("2051422")).toBeDefined();

    const outcome = await consult({ problem: SPECIFIED_PROBLEM }, { client, retriever });

    expect(outcome.kind).toBe("solution");
    if (outcome.kind !== "solution") throw new Error("unreachable");
    const numbers = outcome.design.billOfMaterials.map((l) => l.product.orderNumber);
    expect(numbers).toContain("1052442");
    expect(numbers).not.toContain("2051422");
  });

  it("designs an installation whose every line is a real, cited catalog row", async () => {
    const client = createFakeClient([
      triage("photoelectric", SPECIFIED_GAPS),
      INVESTIGATION,
      design([
        { role: "sensor", orderNumber: "1052442", quantity: 1 },
        { role: "accessory", orderNumber: "2051422", quantity: 1 },
        { role: "cable", orderNumber: "6009382", quantity: 1 },
      ]),
    ]);

    const outcome = await consult({ problem: SPECIFIED_PROBLEM }, { client, retriever: makeRetriever() });

    expect(outcome.kind).toBe("solution");
    if (outcome.kind !== "solution") throw new Error("unreachable");
    const { design: solution } = outcome;

    expect(solution.billOfMaterials).toHaveLength(3);

    // An installation, not a part number: at least one accessory row.
    expect(solution.billOfMaterials.some((l) => l.product.rowType === "accessory")).toBe(true);
    expect(solution.billOfMaterials.some((l) => l.role !== "sensor")).toBe(true);

    // Rule 3: every claim carries a citation, and it points at a real page.
    for (const line of solution.billOfMaterials) {
      expect(line.citation.orderNumber).toBe(line.product.orderNumber);
      expect(line.citation.sourcePage).toBe(line.product.sourcePage);
      expect(line.citation.pdfPage).toBe(line.product.pdfPage);
      expect(line.why.trim()).not.toBe("");
      expect(line.quantity).toBeGreaterThanOrEqual(1);
    }

    // A recommendation with no rejected alternatives reads as a lookup.
    expect(solution.alternativesConsidered.length).toBeGreaterThanOrEqual(2);
  });

  it("reports specs the catalog does not print as unverified, never ok", async () => {
    const client = createFakeClient([
      triage("photoelectric", SPECIFIED_GAPS),
      INVESTIGATION,
      design([
        { role: "sensor", orderNumber: "1052442", quantity: 1 },
        { role: "cable", orderNumber: "6009382", quantity: 1 },
      ]),
    ]);

    const outcome = await consult({ problem: SPECIFIED_PROBLEM }, { client, retriever: makeRetriever() });
    if (outcome.kind !== "solution") throw new Error("expected a solution");
    const { compatibility, confidence, limitations } = outcome.design;

    expect(compatibility.length).toBeGreaterThan(0);
    for (const c of compatibility) expect(["ok", "warning", "unverified"]).toContain(c.status);

    // No row in this catalog prints a supply voltage, so the 24 V requirement
    // cannot be checked — and must not come back as satisfied.
    const voltage = compatibility.find((c) => c.check.toLowerCase().includes("supply voltage"));
    expect(voltage?.status).toBe("unverified");

    // The model claimed "high". Unverified checks cap it below that.
    expect(confidence).not.toBe("high");
    expect(limitations.some((l) => l.toLowerCase().includes("unverified is not a pass"))).toBe(true);
  });

  it("drops an order number the catalog does not contain instead of returning it", async () => {
    const client = createFakeClient([
      triage("photoelectric", SPECIFIED_GAPS),
      INVESTIGATION,
      design([
        { role: "sensor", orderNumber: "1052442", quantity: 1 },
        // Well-formed, plausible, and entirely from the model's memory.
        { role: "accessory", orderNumber: "9999999", quantity: 1 },
        { role: "cable", orderNumber: "6009382", quantity: 1 },
      ]),
    ]);
    const events: TraceEvent[] = [];
    const trace = createTrace({ onEvent: (e) => events.push(e) });

    const outcome = await consult(
      { problem: SPECIFIED_PROBLEM },
      { client, retriever: makeRetriever(), trace },
    );
    if (outcome.kind !== "solution") throw new Error("expected a solution");

    const numbers = outcome.design.billOfMaterials.map((l) => l.product.orderNumber);
    expect(numbers).toEqual(["1052442", "6009382"]);
    expect(numbers).not.toContain("9999999");

    // Dropped loudly: on the trace, and in what the user reads.
    const dropped = events.find((e) => e.type === "error" && e.label.includes("9999999"));
    expect(dropped).toBeDefined();
    expect(dropped?.type === "error" ? dropped.recoverable : false).toBe(true);
    expect(outcome.design.limitations.some((l) => l.includes("9999999"))).toBe(true);
  });

  it("refuses to ship a bill of materials when no proposed sensor exists", async () => {
    const client = createFakeClient([
      triage("photoelectric", SPECIFIED_GAPS),
      INVESTIGATION,
      design([{ role: "sensor", orderNumber: "9999999", quantity: 1 }]),
    ]);

    const outcome = await consult({ problem: SPECIFIED_PROBLEM }, { client, retriever: makeRetriever() });

    // Not a design with a hole in it, and not a fabricated part: a question.
    expect(outcome.kind).toBe("needs_input");
    if (outcome.kind !== "needs_input") throw new Error("unreachable");
    expect(outcome.questions).toHaveLength(1);
    expect(outcome.questions[0]?.why).toContain("9999999");
  });

  it("reclassifies an accessory row the model labelled as the sensor", async () => {
    const client = createFakeClient([
      triage("photoelectric", SPECIFIED_GAPS),
      INVESTIGATION,
      design([
        { role: "sensor", orderNumber: "1052442", quantity: 1 },
        // The catalog says 2051422 is a bracket. The catalog wins.
        { role: "sensor", orderNumber: "2051422", quantity: 1 },
      ]),
    ]);

    const outcome = await consult({ problem: SPECIFIED_PROBLEM }, { client, retriever: makeRetriever() });
    if (outcome.kind !== "solution") throw new Error("expected a solution");

    const bracket = outcome.design.billOfMaterials.find((l) => l.product.orderNumber === "2051422");
    expect(bracket?.role).toBe("accessory");
  });
});
