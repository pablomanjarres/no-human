/**
 * Resolver tests.
 *
 * Two rules govern what is worth asserting here. First, **no network**: the LLM
 * is a scripted {@link createFakeClient} and the vision client is four lines of
 * object literal, so a failure here is always a failure in this package.
 * Second, the competitor index is the **real dataset**, because the single most
 * valuable property of this module is "a part we hold data on never reaches a
 * model", and a fixture would let that drift while still passing.
 *
 * The paths under test are the ones that cost money when they break: the
 * deterministic dataset path, the honest-unknown path, the refusal path, and the
 * needs-input gate. A happy-path recommendation is the *least* interesting thing
 * this module does.
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createFakeClient, type ScriptedResponse } from "./claude.js";
import { loadCompetitorIndex, type CompetitorIndex } from "./competitors.js";
import type { VisionClient } from "./inputs/vision.js";
import { createTrace, type Trace } from "./trace.js";
import type { AgentInput, TraceEvent } from "./types.js";
import {
  assessSufficiency,
  containsSickPartReference,
  MAX_QUESTIONS,
  resolve,
  statedFields,
  type ResolverDeps,
} from "./resolver.js";

/** Repo root: `packages/agent/src/` → up three. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const competitors: CompetitorIndex = await loadCompetitorIndex(ROOT);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A complete, all-null extraction payload. Tests override only what they mean
 *  to assert, which keeps a schema change from rewriting every fixture. */
function extraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    principle: null,
    sensingRangeMinMm: null,
    sensingRangeMaxMm: null,
    responseTimeMaxMs: null,
    switchingFrequencyMinHz: null,
    supplyVoltageMinV: null,
    supplyVoltageMaxV: null,
    operatingTempMinC: null,
    operatingTempMaxC: null,
    outputType: null,
    connector: null,
    connectorPins: null,
    minIpRating: null,
    ip69k: null,
    ioLink: null,
    housing: null,
    light: null,
    questions: [],
    assumptions: [],
    notes: null,
    ...overrides,
  };
}

interface Harness {
  deps: ResolverDeps;
  trace: Trace;
  events: TraceEvent[];
  client: ReturnType<typeof createFakeClient>;
}

function harness(script: readonly ScriptedResponse[] = [], vision?: VisionClient): Harness {
  const events: TraceEvent[] = [];
  let clock = 0;
  const trace = createTrace({ now: () => (clock += 1), onEvent: (event) => events.push(event) });
  const client = createFakeClient(script);
  return {
    client,
    trace,
    events,
    deps: { client, competitors, trace, ...(vision !== undefined ? { vision } : {}) },
  };
}

/** A vision client that replays one canned nameplate reading. */
function fakeVision(label: Record<string, unknown>): VisionClient {
  return {
    messages: {
      create: async () => ({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(label) }],
      }),
    },
  };
}

function types(events: readonly TraceEvent[]): string[] {
  return events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// The sufficiency gate, in isolation
// ---------------------------------------------------------------------------

describe("assessSufficiency", () => {
  it("requires an anchor AND a discriminating constraint", () => {
    expect(assessSufficiency({}).sufficient).toBe(false);
    // Anchor only — a third of section B, with nothing to fail a candidate on.
    expect(assessSufficiency({ principle: ["diffuse"] }).sufficient).toBe(false);
    // Discriminator only — spans inductive, photoelectric and ultrasonic alike.
    expect(assessSufficiency({ outputType: ["PNP"] }).sufficient).toBe(false);
    expect(assessSufficiency({ principle: ["diffuse"], outputType: ["PNP"] }).sufficient).toBe(true);
  });

  it("accepts a catalog category in place of a principle", () => {
    expect(assessSufficiency({ section: ["B"], sensingRangeMm: { min: 200 } }).sufficient).toBe(true);
    expect(assessSufficiency({ family: ["W4-3"], minIpRating: 67 }).sufficient).toBe(true);
  });

  it("refuses to treat a whole catalog section as an anchor", () => {
    const broad = assessSufficiency({
      principle: ["through-beam", "retroreflective", "diffuse", "background-suppression"],
      operatingTempC: { min: -40, max: 70 },
    });
    expect(broad.sufficient).toBe(false);
    expect(broad.anchored).toBe(false);
    expect(broad.reason).toMatch(/4 sensing principles/);
  });

  it("does not count housing or light as discriminating", () => {
    const assessment = assessSufficiency({ principle: ["diffuse"], housing: ["plastic"], light: ["red"] });
    expect(assessment.anchored).toBe(true);
    expect(assessment.discriminators).toEqual([]);
    expect(assessment.sufficient).toBe(false);
  });

  it("treats an empty range and an unknown enum as absent, not as constraints", () => {
    expect(statedFields({ sensingRangeMm: {} })).toEqual([]);
    expect(statedFields({ outputType: ["unknown"] })).toEqual([]);
    expect(statedFields({ principle: ["unknown"] })).toEqual([]);
    expect(assessSufficiency({ principle: ["diffuse"], sensingRangeMm: {} }).sufficient).toBe(false);
  });

  it("counts a stated false as a constraint — 'must not be IO-Link' is a requirement", () => {
    expect(statedFields({ ioLink: false })).toEqual(["ioLink"]);
    expect(assessSufficiency({ principle: ["inductive"], ioLink: false }).sufficient).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: the model may not name a SICK part
// ---------------------------------------------------------------------------

describe("containsSickPartReference", () => {
  it("catches order numbers and type codes", () => {
    expect(containsSickPartReference("Order number 1052445 is the closest match.")).toBe(true);
    expect(containsSickPartReference("Use GTB6-P4212.")).toBe(true);
    expect(containsSickPartReference("WTB4-3P2264 covers it")).toBe(true);
    expect(containsSickPartReference("DT35-B15251")).toBe(true);
  });

  it("does not fire on ordinary engineering prose", () => {
    for (const clean of [
      "A 4-pin M12 connector on an IP67-rated housing.",
      "The Banner MINI-BEAM covers 30 m in through-beam mode.",
      "QS18VN6LV, SME312LPC and Q45BW13 are competitor identifiers.",
      "Response time under 12 ms at 24 V DC.",
    ]) {
      expect(containsSickPartReference(clean)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Path: part number, dataset hit
// ---------------------------------------------------------------------------

describe("resolve — a competitor part we hold data on", () => {
  it("resolves deterministically without ever calling the model", async () => {
    const h = harness([]); // an empty script: any model call throws.
    const resolved = await resolve({ kind: "part_number", value: "T18U" }, h.deps);

    expect(h.client.calls).toHaveLength(0);
    expect(resolved.sufficient).toBe(true);
    expect(resolved.questions).toEqual([]);
    expect(resolved.identified?.vendor).toBe("Banner");
    expect(resolved.identified?.specSource).toBe("dataset");
    expect(resolved.identified?.citation?.sourcePage).toMatch(/^Banner p\./);
    expect(resolved.constraints.principle).toEqual(["ultrasonic"]);
    expect(resolved.constraints.sensingRangeMm).toEqual({ min: 600 });
    expect(resolved.constraints.minIpRating).toBe(67);
    expect(resolved.rationale).toMatch(/no model was asked to recall a spec/);
  });

  it("is insensitive to how the user punctuated the part number", async () => {
    const a = await resolve({ kind: "part_number", value: "T18U" }, harness([]).deps);
    const b = await resolve({ kind: "part_number", value: " banner t-18-u " }, harness([]).deps);
    expect(b.constraints).toEqual(a.constraints);
  });

  it("surfaces the family-envelope assumption instead of burying it", async () => {
    const resolved = await resolve({ kind: "part_number", value: "T18U" }, harness([]).deps);
    expect(resolved.assumptions.join(" ")).toMatch(/longest-range variant/);
    expect(resolved.assumptions.join(" ")).toMatch(/operating temperature/);
    // The output options a modular series sells were NOT pinned to one.
    expect(resolved.constraints.outputType).toBeUndefined();
    expect(resolved.assumptions.join(" ")).toMatch(/No output type was constrained/);
  });

  it("asks which sensing mode when a modular series spans the whole section", async () => {
    const h = harness([]);
    const resolved = await resolve({ kind: "part_number", value: "Q45" }, h.deps);

    expect(h.client.calls).toHaveLength(0);
    expect(resolved.sufficient).toBe(false);
    const first = resolved.questions[0];
    expect(first?.field).toBe("principle");
    // Answerable in the vocabulary printed on the user's own datasheet.
    expect(first?.options).toContain("opposed");
    expect(first?.why).toMatch(/decides which part of the catalog/);
    expect(resolved.rationale).toMatch(/sensing principles are in play/);
  });

  it("still reports the constraints it did derive when it stops to ask", async () => {
    const resolved = await resolve({ kind: "part_number", value: "Q45" }, harness([]).deps);
    expect(resolved.sufficient).toBe(false);
    expect(resolved.constraints.minIpRating).toBe(67);
    expect(resolved.missing).toContain("outputType");
    expect(resolved.missing).not.toContain("minIpRating");
  });
});

// ---------------------------------------------------------------------------
// Path: part number, no dataset record
// ---------------------------------------------------------------------------

describe("resolve — a competitor part we hold no data on", () => {
  it("marks model-derived specs as inferred and says so in the assumptions", async () => {
    const h = harness([
      {
        type: "structured",
        value: extraction({ principle: ["inductive"], sensingRangeMinMm: 8, outputType: ["PNP"] }),
      },
    ]);
    const resolved = await resolve(
      { kind: "part_number", value: "E2E-X8MD1", vendorHint: "Omron" },
      h.deps,
    );

    expect(h.client.calls).toHaveLength(1);
    expect(h.client.calls[0]?.effort).toBe("high");
    expect(resolved.identified?.specSource).toBe("inferred");
    expect(resolved.identified?.vendor).toBe("Omron");
    expect(resolved.identified?.citation).toBeUndefined();
    expect(resolved.assumptions.join(" ")).toMatch(/inferred from the part number/);
    expect(resolved.sufficient).toBe(true);
  });

  it("reports specSource 'unknown' when the model could infer nothing", async () => {
    const h = harness([{ type: "structured", value: extraction() }]);
    const resolved = await resolve({ kind: "part_number", value: "XZ-99" }, h.deps);

    expect(resolved.identified?.specSource).toBe("unknown");
    expect(resolved.identified?.vendor).toBe("unknown");
    expect(resolved.sufficient).toBe(false);
    expect(resolved.questions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Path: description
// ---------------------------------------------------------------------------

describe("resolve — free-text description", () => {
  it("returns questions rather than a guess when the input is thin", async () => {
    const h = harness([{ type: "structured", value: extraction() }]);
    const resolved = await resolve({ kind: "description", value: "I need a sensor" }, h.deps);

    expect(resolved.sufficient).toBe(false);
    expect(resolved.constraints).toEqual({});
    expect(resolved.questions.length).toBeGreaterThan(0);
    expect(resolved.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    // Most discriminating first: which part of the catalog are we even in.
    expect(resolved.questions[0]?.field).toBe("principle");
    for (const question of resolved.questions) {
      expect(question.why.length).toBeGreaterThan(20);
      expect(question.why).not.toBe(question.question);
    }
    expect(resolved.rationale).toMatch(/Not sufficient/);
  });

  it("resolves a specific description without asking anything", async () => {
    const h = harness([
      {
        type: "structured",
        value: extraction({
          principle: ["background-suppression"],
          sensingRangeMinMm: 250,
          responseTimeMaxMs: 12,
          outputType: ["PNP"],
          connector: ["M12"],
          minIpRating: 69,
          ip69k: true,
          assumptions: ["Read \"a quarter metre\" as 250 mm."],
          notes: "The user described a wash-down bottling line.",
        }),
      },
    ]);
    const resolved = await resolve(
      {
        kind: "description",
        value:
          "Background suppression at a quarter metre, PNP on an M12 plug, under 12 ms, wash-down IP69K line.",
      },
      h.deps,
    );

    expect(resolved.sufficient).toBe(true);
    expect(resolved.questions).toEqual([]);
    expect(resolved.constraints).toEqual({
      principle: ["background-suppression"],
      sensingRangeMm: { min: 250 },
      responseTimeMs: { max: 12 },
      outputType: ["PNP"],
      connector: ["M12"],
      minIpRating: 69,
      ip69k: true,
    });
    expect(resolved.assumptions).toContain('Read "a quarter metre" as 250 mm.');
    expect(resolved.rationale).toMatch(/wash-down bottling line/);
    expect(resolved.identified).toBeUndefined();
  });

  it("drops enum tokens the solver cannot interpret rather than passing them through", async () => {
    const h = harness([
      {
        type: "structured",
        value: extraction({
          principle: ["photoelectric", "diffuse"],
          outputType: ["PNP", "triac"],
          connectorPins: 4.5,
          minIpRating: 67,
        }),
      },
    ]);
    const resolved = await resolve({ kind: "description", value: "…" }, h.deps);

    expect(resolved.constraints.principle).toEqual(["diffuse"]);
    expect(resolved.constraints.outputType).toEqual(["PNP"]);
    // 4.5 pins is not a pin count; a rounded guess would be a fabricated spec.
    expect(resolved.constraints.connectorPins).toBeUndefined();
    expect(resolved.constraints.minIpRating).toBe(67);
  });

  it("treats a model refusal as a reportable outcome, not a crash", async () => {
    const h = harness([{ type: "refusal", reason: "declined" }]);
    const resolved = await resolve({ kind: "description", value: "something" }, h.deps);

    expect(resolved.sufficient).toBe(false);
    // Nothing was extracted, so the run falls back to asking directly — the
    // open question first, then the fields that would unblock a search.
    expect(resolved.questions[0]?.field).toBe("description");
    expect(resolved.questions.map((q) => q.field)).toContain("principle");
    expect(resolved.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    expect(types(h.events)).toContain("error");
  });
});

// ---------------------------------------------------------------------------
// Rule 1, end to end
// ---------------------------------------------------------------------------

describe("resolve — a model that tries to pick the part", () => {
  it("discards every SICK identifier it emitted and records the violation", async () => {
    const h = harness([
      {
        type: "structured",
        value: extraction({
          principle: ["diffuse"],
          sensingRangeMinMm: 300,
          assumptions: [
            "Assumed a 300 mm reach.",
            "The correct replacement is GTB6-P4212, order number 1052445.",
          ],
          questions: [
            {
              field: "connector",
              question: "Confirm you want 1052445 with the M12 plug?",
              why: "It changes the order number.",
              options: null,
            },
          ],
          notes: "Recommend WTB4-3P2264.",
        }),
      },
    ]);
    const resolved = await resolve({ kind: "description", value: "diffuse at 300 mm" }, h.deps);

    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toMatch(/1052445/);
    expect(serialized).not.toMatch(/GTB6-P4212/);
    expect(serialized).not.toMatch(/WTB4-3P2264/);

    // The clean parts of the extraction survive — sanitizing is not discarding.
    expect(resolved.constraints).toEqual({ principle: ["diffuse"], sensingRangeMm: { min: 300 } });
    expect(resolved.assumptions).toEqual(["Assumed a 300 mm reach."]);
    expect(resolved.rationale).toMatch(/Rule 1 violation/);
  });
});

// ---------------------------------------------------------------------------
// Path: nameplate photograph
// ---------------------------------------------------------------------------

const IMAGE: Extract<AgentInput, { kind: "image" }> = {
  kind: "image",
  mediaType: "image/jpeg",
  base64: "aGVsbG8=",
};

describe("resolve — nameplate photograph", () => {
  it("asks the user to confirm an ambiguous glyph instead of committing to it", async () => {
    const h = harness(
      [],
      fakeVision({
        vendor: "Banner",
        partNumber: "QS18VN6LV",
        otherText: ["10-30V DC", "IP67"],
        legible: true, // the model's own claim; the honesty clamp overrides it
        confidence: "high",
        uncertainCharacters: ["4:8|B"],
      }),
    );
    const resolved = await resolve(IMAGE, h.deps);

    expect(h.client.calls).toHaveLength(0);
    expect(resolved.sufficient).toBe(false);
    const question = resolved.questions[0];
    expect(question?.field).toBe("partNumber");
    expect(question?.question).toMatch(/QS18VN6LV/);
    expect(question?.question).toMatch(/could be "B"/);
    expect(resolved.identified?.specSource).toBe("unknown");
    // The rest of the plate is not thrown away — it is the recovery path.
    expect(resolved.rationale).toMatch(/10-30V DC/);
    expect(types(h.events)).toContain("resolver.question");
  });

  it("asks a plain question when no part number could be read at all", async () => {
    const h = harness(
      [],
      fakeVision({
        vendor: null,
        partNumber: null,
        otherText: ["24 VDC"],
        legible: false,
        confidence: "low",
        uncertainCharacters: [],
      }),
    );
    const resolved = await resolve(IMAGE, h.deps);

    expect(resolved.sufficient).toBe(false);
    expect(resolved.questions[0]?.field).toBe("partNumber");
    expect(resolved.questions[0]?.question).toMatch(/No part number could be read/);
    expect(resolved.identified).toBeUndefined();
  });

  it("routes a clean reading through the dataset path, not the model", async () => {
    const h = harness(
      [],
      fakeVision({
        vendor: "Banner",
        partNumber: "T18U",
        otherText: ["IP67"],
        legible: true,
        confidence: "high",
        uncertainCharacters: [],
      }),
    );
    const resolved = await resolve(IMAGE, h.deps);

    expect(h.client.calls).toHaveLength(0);
    expect(resolved.sufficient).toBe(true);
    expect(resolved.identified?.specSource).toBe("dataset");
    expect(resolved.constraints.principle).toEqual(["ultrasonic"]);
    expect(resolved.rationale).toMatch(/character by character/);
  });

  it("refuses to run an image input with no vision client rather than guessing", async () => {
    await expect(resolve(IMAGE, harness([]).deps)).rejects.toThrow(/no `vision` client/);
  });
});

// ---------------------------------------------------------------------------
// Inputs that belong elsewhere
// ---------------------------------------------------------------------------

describe("resolve — inputs owned by other entry points", () => {
  it("refuses a BOM and names the right entry point", async () => {
    await expect(resolve({ kind: "bom", csv: "part\nT18U\n" }, harness([]).deps)).rejects.toThrow(
      /parseBom/,
    );
  });

  it("refuses a problem statement", async () => {
    await expect(
      resolve({ kind: "problem", value: "count bottles" }, harness([]).deps),
    ).rejects.toThrow(/Consultant mode/);
  });
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

describe("resolve — trace", () => {
  it("emits start, identified and constraints on a resolved run", async () => {
    const h = harness([]);
    await resolve({ kind: "part_number", value: "T18U" }, h.deps);
    expect(types(h.events)).toEqual([
      "resolver.start",
      "resolver.identified",
      "resolver.constraints",
    ]);
    const constraints = h.events.find((event) => event.type === "resolver.constraints");
    expect(constraints).toBeDefined();
    if (constraints?.type === "resolver.constraints") {
      expect(constraints.constraints.principle).toEqual(["ultrasonic"]);
      expect(constraints.missing).toContain("outputType");
    }
  });

  it("emits a question event whenever it stops to ask", async () => {
    const h = harness([{ type: "structured", value: extraction() }]);
    await resolve({ kind: "description", value: "I need a sensor" }, h.deps);
    expect(types(h.events)).toEqual([
      "resolver.start",
      "resolver.constraints",
      "resolver.question",
    ]);
    const question = h.events.find((event) => event.type === "resolver.question");
    if (question?.type === "resolver.question") {
      expect(question.questions.length).toBeGreaterThan(0);
    }
  });

  it("carries a child trace's label prefix so a per-row BOM run stays grouped", async () => {
    const h = harness([]);
    await resolve(
      { kind: "part_number", value: "T18U" },
      { ...h.deps, trace: h.trace.child("row 3") },
    );
    expect(h.events[0]?.label.startsWith("row 3 · ")).toBe(true);
  });
});
