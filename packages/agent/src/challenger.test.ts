import { describe, it, expect } from "vitest";

import type { ConstraintVerdict, NormalizedSpec, SickProduct, SolveResult } from "@no-human/rag";

import { challenge, challengeAll, seedChallenges, type ChallengeCandidate } from "./challenger.js";
import { createFakeClient, type ScriptedResponse } from "./claude.js";
import { createTrace, type Trace } from "./trace.js";
import type { ChallengeReport, ResolvedInput, TraceEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures — a real-shaped catalog row, deliberately half-silent
// ---------------------------------------------------------------------------

/** A W4-3 style photoelectric row: connector and IP printed, electricals not. */
function makeProduct(overrides: Partial<SickProduct> = {}): SickProduct {
  return {
    orderNumber: "1041182",
    typeCode: "WTB4-3P2261",
    family: "W4-3",
    rowType: "product",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-16",
    pdfPage: 42,
    occurrences: 1,
    alsoOnPages: [],
    productName: "Fotocélula de detección sobre objeto, W4-3",
    switchingOutput: "PNP",
    connection: "Conector M8 de 3 polos",
    enclosureRating: "IP 67",
    ...overrides,
  };
}

function makeSpec(overrides: Partial<NormalizedSpec> = {}): NormalizedSpec {
  return {
    orderNumber: "1041182",
    outputType: "PNP",
    connector: "M8",
    connectorPins: 3,
    ipRating: 67,
    sensingRangeMinMm: 0,
    sensingRangeMaxMm: 900,
    lowConfidence: [],
    ...overrides,
  };
}

function verdict(
  field: string,
  status: ConstraintVerdict["status"],
  detail = `${field} ${status}`,
  lowConfidence?: boolean,
): ConstraintVerdict {
  return { field, status, detail, ...(lowConfidence !== undefined ? { lowConfidence } : {}) };
}

function makeSolve(verdicts: ConstraintVerdict[], product = makeProduct(), spec = makeSpec()): SolveResult {
  const failed = verdicts.filter((v) => v.status === "fail").length;
  return {
    product,
    spec,
    verdicts,
    passed: verdicts.filter((v) => v.status === "pass").length,
    failed,
    unknown: verdicts.filter((v) => v.status === "unknown").length,
    viable: failed === 0,
  };
}

function makeCandidate(verdicts: ConstraintVerdict[], overrides: Partial<SickProduct> = {}): ChallengeCandidate {
  const product = makeProduct(overrides);
  const spec = makeSpec(
    overrides.orderNumber !== undefined ? { orderNumber: overrides.orderNumber } : {},
  );
  return { product, solve: makeSolve(verdicts, product, spec) };
}

const RESOLVED: ResolvedInput = {
  constraints: { outputType: ["PNP"], connector: ["M12"], sensingRangeMm: { min: 800 } },
  missing: ["responseTimeMs"],
  questions: [],
  sufficient: true,
  rationale: "Banner QS18 replaced on a washdown line.",
  assumptions: ["The existing harness terminates in an M12 4-pin plug."],
};

/** A trace with a deterministic clock, plus the log it fills. */
function makeTrace(): { trace: Trace; events: TraceEvent[] } {
  let t = 0;
  const trace = createTrace({ now: () => (t += 1) });
  return { trace, events: trace.events() as TraceEvent[] };
}

/** One scripted model turn, in the Challenger's output shape. */
function modelTurn(
  challenges: readonly Record<string, unknown>[],
  summary = "Attacked on mounting and optics.",
): ScriptedResponse {
  return { type: "structured", value: { summary, challenges } };
}

// ---------------------------------------------------------------------------
// Deterministic seeds — these must exist with or without a model
// ---------------------------------------------------------------------------

describe("seedChallenges", () => {
  it("turns every solver `unknown` into an unverifiable challenge, never a pass", () => {
    const candidate = makeCandidate([
      verdict("supplyVoltageV", "unknown", "requires 10 … 30 V, catalog does not state a supply voltage"),
      verdict("responseTimeMs", "unknown", "requires ≤ 12 ms, catalog does not state a response time"),
      verdict("outputType", "pass"),
    ]);

    const seeds = seedChallenges(candidate);
    const unverifiable = seeds.filter((c) => c.verdict === "unverifiable");

    expect(unverifiable.map((c) => c.field)).toEqual(["supplyVoltageV", "responseTimeMs"]);
    // Not one of them may read as satisfied, and each must point at the page
    // whose silence a reader can go and confirm.
    expect(unverifiable.every((c) => c.verdict !== "upheld" && c.citation?.sourcePage === "B-16")).toBe(true);
    expect(unverifiable[0]?.evidence).toMatch(/absent is not passing/i);
    // A clean pass is not a challenge.
    expect(seeds.some((c) => c.field === "outputType")).toBe(false);
  });

  it("turns every solver `fail` into an upheld fatal, ordered before the unknowns", () => {
    const seeds = seedChallenges(
      makeCandidate([
        verdict("supplyVoltageV", "unknown"),
        verdict("connector", "fail", "requires M12, catalog states M8"),
      ]),
    );

    expect(seeds[0]).toMatchObject({ field: "connector", severity: "fatal", verdict: "upheld" });
    expect(seeds[1]).toMatchObject({ field: "supplyVoltageV", verdict: "unverifiable" });
  });

  it("flags a pass that rests on a low-confidence field instead of folding it into the clean passes", () => {
    const seeds = seedChallenges(
      makeCandidate([verdict("ip69k", "pass", "requires IP69K, catalog states IP69K", true)]),
    );

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ field: "ip69k", severity: "minor", verdict: "unverifiable" });
  });
});

// ---------------------------------------------------------------------------
// challenge()
// ---------------------------------------------------------------------------

describe("challenge", () => {
  it("reports every unknown as an unverifiable risk and still survives when nothing fatal lands", async () => {
    const candidate = makeCandidate([
      verdict("supplyVoltageV", "unknown"),
      verdict("responseTimeMs", "unknown"),
      verdict("outputType", "pass"),
    ]);
    const { trace } = makeTrace();
    const client = createFakeClient([modelTurn([])]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.orderNumber).toBe("1041182");
    expect(report.challenges).toHaveLength(2);
    expect(report.challenges.every((c) => c.verdict === "unverifiable")).toBe(true);
    // Survival means "nothing printed contradicts this" — the summary must not
    // let two unverified requirements read as verification.
    expect(report.survives).toBe(true);
    expect(report.summary).toMatch(/2 unverifiable \(catalog silent — unverified risk, not a pass\)/);
  });

  it("lets a solver `fail` kill the candidate without consulting the model", async () => {
    const candidate = makeCandidate([verdict("connector", "fail", "requires M12, catalog states M8")]);
    const { trace } = makeTrace();
    const client = createFakeClient([modelTurn([])]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.survives).toBe(false);
    expect(report.summary).toMatch(/^Killed: 1 fatal objection upheld/);
  });

  it("emits start, one attack per challenge, and a verdict", async () => {
    const candidate = makeCandidate([verdict("supplyVoltageV", "unknown")]);
    const { trace, events } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "The M8 barrel will not clear the existing bracket cutout.",
          severity: "minor",
          field: null,
          verdict: "upheld",
          evidence: "Mounting is not in the catalog table.",
          assertedValue: null,
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("challenger.start");
    expect(types.at(-1)).toBe("challenger.verdict");
    expect(types.filter((t) => t === "challenger.attack")).toHaveLength(report.challenges.length);
    // Every attack is grouped under the candidate so the panel can land them one
    // at a time without splitting the timeline.
    expect(events[0]?.label.startsWith("WTB4-3P2261 · ")).toBe(true);
  });

  it("downgrades a model claim that contradicts the catalog to refuted, and says why", async () => {
    const candidate = makeCandidate([verdict("outputType", "pass")]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "The sensor is only rated IP40, which fails a washdown line.",
          severity: "fatal",
          field: "ipRating",
          verdict: "upheld",
          evidence: "Washdown needs IP69K.",
          assertedValue: "IP 40",
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    const attack = report.challenges[0];
    expect(attack?.verdict).toBe("refuted");
    expect(attack?.evidence).toMatch(/REFUTED against the catalog record/);
    expect(attack?.evidence).toMatch(/catalog states 67/);
    // A refuted fatal must not kill the candidate — the model does not get the
    // last word on a fact the catalog prints.
    expect(report.survives).toBe(true);
  });

  it("keeps a model claim that agrees with the catalog, and attaches the citation", async () => {
    const candidate = makeCandidate([verdict("outputType", "pass")]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "The M8 3-pin plug cannot carry the fourth wire the existing harness uses.",
          severity: "fatal",
          field: "connector",
          verdict: "upheld",
          evidence: "The line is wired M12 4-pin.",
          assertedValue: "M8",
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges[0]?.verdict).toBe("upheld");
    expect(report.challenges[0]?.citation?.sourcePage).toBe("B-16");
    expect(report.challenges[0]?.evidence).toMatch(/checked against the catalog record/);
    expect(report.survives).toBe(false);
  });

  it("accepts an assertion in different units rather than falsely refuting it", async () => {
    // Catalog range is 0…900 mm; the model writes 0.9 m. Refuting that would
    // discard a valid objection, which is the dangerous direction.
    const candidate = makeCandidate([verdict("sensingRangeMm", "pass")]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "0.9 m leaves no margin once the lens fogs on a washdown line.",
          severity: "major",
          field: "sensingRangeMm",
          verdict: "upheld",
          evidence: "The target sits at 800 mm.",
          assertedValue: "0.9 m",
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges[0]?.verdict).toBe("upheld");
    expect(report.challenges[0]?.evidence).not.toMatch(/REFUTED/);
  });

  it("downgrades an upheld claim to unverifiable when the catalog is silent on the field it asserts", async () => {
    const candidate = makeCandidate([verdict("outputType", "pass")]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "A 25 ms response time misses the 12 ms machine cycle.",
          severity: "fatal",
          field: "responseTimeMs",
          verdict: "upheld",
          evidence: "The cycle allows 12 ms.",
          assertedValue: "25 ms",
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    // The catalog prints no response time, so upholding a fatal on 25 ms would
    // be asserting a spec with no source. The risk survives as unquantified.
    expect(report.challenges[0]?.verdict).toBe("unverifiable");
    expect(report.challenges[0]?.evidence).toMatch(/DOWNGRADED to unverifiable/);
    expect(report.challenges[0]?.citation).toBeUndefined();
    expect(report.survives).toBe(true);
  });

  it("leaves application-level objections alone — we hold no fact to check them with", async () => {
    const candidate = makeCandidate([]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "The cable exits axially where the machine guard needs a radial exit.",
          severity: "major",
          field: "mountingClearance",
          verdict: "upheld",
          evidence: "Not expressible in the spec table.",
          assertedValue: "axial",
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges[0]?.verdict).toBe("upheld");
    expect(report.challenges[0]?.citation).toBeUndefined();
    expect(report.challenges[0]?.evidence).not.toMatch(/REFUTED|DOWNGRADED/);
  });

  it("defaults a garbled verdict to upheld rather than resolving doubt in the candidate's favour", async () => {
    const candidate = makeCandidate([]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "Alignment over 1.2 m on a vibrating frame will drift.",
          severity: "totally fatal",
          field: null,
          verdict: "probably",
          evidence: "Through-beam alignment is unforgiving.",
          assertedValue: null,
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges[0]?.verdict).toBe("upheld");
    // Severity falls back to `major`, not `fatal` — an unreadable severity is a
    // reason to warn, not a reason to kill.
    expect(report.challenges[0]?.severity).toBe("major");
    expect(report.survives).toBe(true);
  });

  it("redacts any SICK order number the model proposes other than the candidate's", async () => {
    const candidate = makeCandidate([]);
    const { trace } = makeTrace();
    const client = createFakeClient([
      modelTurn([
        {
          claim: "Use 1041999 instead, it has the M12 plug.",
          severity: "major",
          field: null,
          verdict: "upheld",
          evidence: "1041182 has the wrong plug; 1041999 does not.",
          assertedValue: null,
        },
      ]),
    ]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges[0]?.claim).not.toMatch(/1041999/);
    expect(report.challenges[0]?.claim).toMatch(/redacted/);
    // The candidate's own order number is a legitimate reference and stays.
    expect(report.challenges[0]?.evidence).toMatch(/1041182/);
    expect(report.challenges[0]?.evidence).not.toMatch(/1041999/);
  });

  it("returns the deterministic report and notes the degradation when the model call throws", async () => {
    const candidate = makeCandidate([
      verdict("supplyVoltageV", "unknown"),
      verdict("connector", "fail", "requires M12, catalog states M8"),
    ]);
    const { trace, events } = makeTrace();
    const client = createFakeClient([{ type: "throw", error: new Error("socket hang up") }]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges).toHaveLength(2);
    expect(report.survives).toBe(false);
    expect(report.summary).toMatch(/socket hang up/);
    expect(report.summary).toMatch(/deterministic seeds only/);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.recoverable).toBe(true);
  });

  it("returns the deterministic report when the model refuses", async () => {
    const candidate = makeCandidate([verdict("supplyVoltageV", "unknown")]);
    const { trace } = makeTrace();
    const client = createFakeClient([{ type: "refusal", reason: "declined this request" }]);

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace });

    expect(report.challenges).toHaveLength(1);
    expect(report.summary).toMatch(/declined this request/);
    expect(report.summary).toMatch(/deterministic seeds only/);
  });

  it("skips the model entirely when the run is already aborted, and still reports", async () => {
    const candidate = makeCandidate([verdict("supplyVoltageV", "unknown")]);
    const { trace } = makeTrace();
    const client = createFakeClient([]);
    const controller = new AbortController();
    controller.abort();

    const report = await challenge(candidate, { resolved: RESOLVED }, { client, trace, signal: controller.signal });

    expect(report.challenges).toHaveLength(1);
    expect(report.summary).toMatch(/aborted/);
    // Nothing was asked of the model; an exhausted script would have thrown.
    expect(client.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// challengeAll()
// ---------------------------------------------------------------------------

describe("challengeAll", () => {
  const rank1 = makeCandidate([verdict("connector", "fail", "requires M12, catalog states M8")], {
    orderNumber: "1041182",
    typeCode: "WTB4-3P2261",
  });
  const rank2 = makeCandidate([verdict("supplyVoltageV", "unknown")], {
    orderNumber: "1041183",
    typeCode: "WTB4-3P2262",
  });
  const rank3 = makeCandidate([verdict("outputType", "pass")], {
    orderNumber: "1041184",
    typeCode: "WTB4-3P2263",
  });

  it("stops at the first survivor and never pays for the candidates behind it", async () => {
    const { trace } = makeTrace();
    const client = createFakeClient([modelTurn([]), modelTurn([])]);

    const reports = await challengeAll([rank1, rank2, rank3], { resolved: RESOLVED }, { client, trace });

    expect(reports.map((r) => r.orderNumber)).toEqual(["1041182", "1041183"]);
    expect(reports.map((r) => r.survives)).toEqual([false, true]);
    // Two candidates challenged, two model calls, nothing spent on rank 3.
    expect(client.calls).toHaveLength(2);
    expect(client.remaining).toBe(0);
  });

  it("emits candidate.promoted carrying the objection that killed the rank above", async () => {
    const { trace, events } = makeTrace();
    const client = createFakeClient([modelTurn([]), modelTurn([])]);

    await challengeAll([rank1, rank2], { resolved: RESOLVED }, { client, trace });

    const promoted = events.find((e) => e.type === "candidate.promoted");
    expect(promoted?.type === "candidate.promoted" && promoted.from).toBe("1041182");
    expect(promoted?.type === "candidate.promoted" && promoted.to).toBe("1041183");
    expect(promoted?.type === "candidate.promoted" && promoted.because).toMatch(/connection type/);
  });

  it("does not emit a promotion when rank 1 survives on its own", async () => {
    const { trace, events } = makeTrace();
    const client = createFakeClient([modelTurn([])]);

    const reports = await challengeAll([rank3, rank2], { resolved: RESOLVED }, { client, trace });

    expect(reports).toHaveLength(1);
    expect(events.some((e) => e.type === "candidate.promoted")).toBe(false);
  });

  it("returns every report when nothing survives, so the caller can refuse honestly", async () => {
    const { trace } = makeTrace();
    const client = createFakeClient([modelTurn([]), modelTurn([])]);
    const alsoDead = makeCandidate([verdict("principle", "fail", "requires through-beam, catalog states diffuse")], {
      orderNumber: "1041185",
      typeCode: "WTB4-3P2265",
    });

    const reports: ChallengeReport[] = await challengeAll([rank1, alsoDead], { resolved: RESOLVED }, { client, trace });

    expect(reports).toHaveLength(2);
    expect(reports.every((r) => !r.survives)).toBe(true);
  });

  it("returns an empty list for no candidates rather than inventing an outcome", async () => {
    const { trace } = makeTrace();
    const client = createFakeClient([]);

    expect(await challengeAll([], { resolved: RESOLVED }, { client, trace })).toEqual([]);
  });
});
