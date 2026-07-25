/**
 * Solver tests, run against REAL rows of the shipped catalog dataset.
 *
 * Two deliberate choices:
 *
 * 1. **No invented products.** Every `SickProduct` here is read out of
 *    `sick-catalog-dataset/products.jsonl` at test time, and the `fixtures
 *    mirror the shipped dataset` block re-asserts the raw values each expectation
 *    depends on. If the dataset is ever re-extracted and a value moves, these
 *    tests fail loudly on the fixture rather than lying about the solver.
 *
 * 2. **Specs are hand-derived, not imported from the normalizer.** The
 *    `NormalizedSpec` literals below are what a human reads off the same catalog
 *    row — the exact contract `filter/normalize.ts` owes this module. Importing
 *    the normalizer would make a solver bug and a normalizer bug cancel out.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  ConstraintVerdict,
  NormalizedSpec,
  RowType,
  SickProduct,
  SolveResult,
  SpecConstraints,
} from "../types.js";
import { evaluate, prefilter, solve } from "./constraints.js";

// ---------------------------------------------------------------------------
// Real catalog rows
// ---------------------------------------------------------------------------

const DATASET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../sick-catalog-dataset/products.jsonl",
);

const ROWS: Map<string, Record<string, unknown>> = new Map(
  readFileSync(DATASET, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((r) => [String(r["order_number"]), r] as const),
);

function row(orderNumber: string): Record<string, unknown> {
  const r = ROWS.get(orderNumber);
  if (r === undefined) throw new Error(`order number ${orderNumber} is not in ${DATASET}`);
  return r;
}

function optStr(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function reqStr(r: Record<string, unknown>, key: string): string {
  const v = optStr(r, key);
  if (v === undefined) throw new Error(`row is missing required field ${key}`);
  return v;
}

function optNum(r: Record<string, unknown>, key: string): number | undefined {
  const v = r[key];
  return typeof v === "number" ? v : undefined;
}

/** Minimal snake_case → camelCase projection of the fields the solver reads. */
function productOf(orderNumber: string): SickProduct {
  const r = row(orderNumber);
  const rowType = reqStr(r, "row_type");
  if (rowType !== "product" && rowType !== "accessory") throw new Error(`bad row_type ${rowType}`);
  const typeCode = optStr(r, "type_code");
  const family = optStr(r, "family");
  const subfamily = optStr(r, "subfamily");
  const productName = optStr(r, "product_name");
  const alsoOn = r["also_on_pages"];
  return {
    orderNumber: reqStr(r, "order_number"),
    rowType: rowType satisfies RowType,
    category: reqStr(r, "category"),
    section: reqStr(r, "section"),
    sourcePage: reqStr(r, "source_page"),
    pdfPage: optNum(r, "pdf_page") ?? 0,
    occurrences: optNum(r, "occurrences") ?? 1,
    alsoOnPages: Array.isArray(alsoOn) ? alsoOn.map(String) : [],
    ...(typeCode !== undefined ? { typeCode } : {}),
    ...(family !== undefined ? { family } : {}),
    ...(subfamily !== undefined ? { subfamily } : {}),
    ...(productName !== undefined ? { productName } : {}),
  };
}

// -- the SKUs under test ----------------------------------------------------

/** GTE6-P4212, B-16 — diffuse photoelectric. Range printed as `≤ 300 mm` only. */
const GTE6 = productOf("1051781");
/** UP56-211118, F-123 — ultrasonic fluid sensor. The richest spec table here. */
const UP56 = productOf("6041658");
/** CM18-08BPP-KW1, C-86 — capacitive proximity. One of 41 rows with supply voltage. */
const CM18 = productOf("6020136");
/** DT50-P1113, H-164 — laser distance. Housing `fundición de cinc` → unclassifiable. */
const DT50 = productOf("1044369");
/** KTM-MB31111P, G-138 — contrast sensor, 0.05 ms response. */
const KTM_CORE = productOf("1062202");
/** KTM-WP117A1P, G-139 — IO-Link contrast sensor, nothing flagged low-confidence. */
const KTM_PRIME = productOf("1061770");
/** WTT280L-2P2531, B-59 — long-range laser, 1000 Hz. */
const WTT280 = productOf("6048061");
/** PLH25-M12, B-32 — IP69K stainless reflector. An `accessory` row. */
const PLH25 = productOf("2063403");
/** CLV620-0000, E-102 — barcode scanner, IP 65. */
const CLV620 = productOf("1040288");
/** BEF-WG-M12, C-78 — mounting plate with no `family` printed at all. */
const BEF_WG = productOf("5321869");

// ---------------------------------------------------------------------------
// Hand-derived normalized specs (the contract normalize.ts owes the solver)
// ---------------------------------------------------------------------------

const SPEC_GTE6: NormalizedSpec = {
  orderNumber: GTE6.orderNumber,
  outputType: "PNP",
  connector: "M8",
  connectorPins: 4,
  sensingRangeMaxMm: 300,
  principle: "diffuse",
  light: "red",
  lowConfidence: ["sensor_principle", "detection_principle", "light_type"],
};

const SPEC_UP56: NormalizedSpec = {
  orderNumber: UP56.orderNumber,
  outputType: "PNP",
  connector: "M12",
  connectorPins: 5,
  ipRating: 67,
  ip69k: false,
  sensingRangeMinMm: 30,
  sensingRangeMaxMm: 250,
  operatingTempMinC: -25,
  operatingTempMaxC: 70,
  principle: "ultrasonic",
  housing: "stainless-steel",
  lowConfidence: [
    "sensing_range_min_mm",
    "sensing_range_max_mm",
    "operating_temp_min_c",
    "operating_temp_max_c",
    "switching_output",
    "connection",
  ],
};

const SPEC_CM18: NormalizedSpec = {
  orderNumber: CM18.orderNumber,
  outputType: "PNP",
  connector: "cable",
  ipRating: 67,
  ip69k: false,
  sensingRangeMaxMm: 8,
  supplyVoltageMinV: 10,
  supplyVoltageMaxV: 40,
  principle: "capacitive",
  lowConfidence: ["sensing_range_max_mm", "supply_voltage_min_v", "supply_voltage_max_v", "enclosure_rating"],
};

const SPEC_DT50: NormalizedSpec = {
  orderNumber: DT50.orderNumber,
  outputType: "PNP",
  sensingRangeMinMm: 200,
  sensingRangeMaxMm: 10000,
  responseTimeMs: 20,
  operatingTempMinC: -30,
  operatingTempMaxC: 65,
  // "fundición de cinc" (zinc die-cast) maps to no canonical bucket.
  housing: "other",
  light: "laser",
  principle: "laser-distance",
  lowConfidence: ["operating_temp_min_c", "operating_temp_max_c", "housing_material", "light_type", "response_time_ms"],
};

const SPEC_KTM_CORE: NormalizedSpec = {
  orderNumber: KTM_CORE.orderNumber,
  outputType: "PNP/NPN",
  connector: "M8",
  connectorPins: 4,
  sensingRangeMinMm: 12.5,
  sensingRangeMaxMm: 12.5,
  responseTimeMs: 0.05,
  housing: "plastic",
  light: "white",
  principle: "contrast",
  lowConfidence: ["response_time_ms", "housing_material"],
};

const SPEC_KTM_PRIME: NormalizedSpec = {
  orderNumber: KTM_PRIME.orderNumber,
  outputType: "PNP",
  ioLink: true,
  connector: "M8",
  connectorPins: 4,
  responseTimeMs: 0.035,
  housing: "plastic",
  principle: "contrast",
  lowConfidence: [],
};

const SPEC_WTT280: NormalizedSpec = {
  orderNumber: WTT280.orderNumber,
  outputType: "PNP",
  connector: "M12",
  connectorPins: 5,
  sensingRangeMinMm: 200,
  sensingRangeMaxMm: 4000,
  switchingFrequencyHz: 1000,
  light: "laser",
  principle: "diffuse",
  lowConfidence: ["light_type", "switching_frequency_hz"],
};

const SPEC_PLH25: NormalizedSpec = {
  orderNumber: PLH25.orderNumber,
  ipRating: 69,
  ip69k: true,
  lowConfidence: [],
};

const SPEC_CLV620: NormalizedSpec = {
  orderNumber: CLV620.orderNumber,
  connector: "cable",
  ipRating: 65,
  ip69k: false,
  sensingRangeMinMm: 60,
  sensingRangeMaxMm: 365,
  lowConfidence: ["sensing_range_min_mm", "sensing_range_max_mm"],
};

/** No spec at all — nothing on the page normalizes to a comparable value. */
const SPEC_BEF_WG: NormalizedSpec = { orderNumber: BEF_WG.orderNumber, lowConfidence: [] };

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function verdictFor(result: SolveResult, field: string): ConstraintVerdict {
  const matches = result.verdicts.filter((v) => v.field === field);
  expect(matches, `expected exactly one verdict for ${field}`).toHaveLength(1);
  return matches[0]!;
}

function statusOf(
  product: SickProduct,
  spec: NormalizedSpec,
  constraints: SpecConstraints,
  field: string,
): ConstraintVerdict["status"] {
  return verdictFor(evaluate(product, spec, constraints), field).status;
}

// ---------------------------------------------------------------------------

describe("fixtures mirror the shipped dataset", () => {
  it("reads the 1,776-SKU catalog", () => {
    expect(ROWS.size).toBe(1776);
  });

  it("matches the raw values every expectation below leans on", () => {
    expect(row("1051781")["switching_output"]).toBe("PNP");
    expect(row("1051781")["connection"]).toBe("Conector macho M8 de 4 polos");
    expect(row("1051781")["sensing_range_max_mm"]).toBe(300);
    // The near bound of the range is simply not printed on B-16.
    expect(row("1051781")["sensing_range_min_mm"]).toBeUndefined();
    expect(row("1051781")["enclosure_rating"]).toBeUndefined();

    expect(row("6041658")["enclosure_rating"]).toBe("IP 67");
    expect(row("6041658")["sensing_range_min_mm"]).toBe(30);
    expect(row("6041658")["sensing_range_max_mm"]).toBe(250);
    expect(row("6041658")["operating_temp_min_c"]).toBe(-25);
    expect(row("6041658")["operating_temp_max_c"]).toBe(70);
    expect(row("6041658")["connection"]).toBe("1 conector circular M12 de 5 polos");
    expect(row("6041658")["low_confidence"]).toContain("switching_output");

    expect(row("6020136")["supply_voltage_min_v"]).toBe(10);
    expect(row("6020136")["supply_voltage_max_v"]).toBe(40);

    expect(row("1044369")["response_time_ms"]).toBe(20);
    expect(row("1044369")["housing_material"]).toBe("fundición de cinc");
    expect(row("1062202")["response_time_ms"]).toBe(0.05);
    expect(row("1061770")["switching_output"]).toBe("PNP, IO-Link");
    expect(row("1061770")["low_confidence"]).toBeUndefined();
    expect(row("6048061")["switching_frequency_hz"]).toBe(1000);
    expect(row("2063403")["enclosure_rating"]).toBe("IP 69K");
    expect(row("2063403")["row_type"]).toBe("accessory");
    expect(row("1040288")["enclosure_rating"]).toBe("IP 65");
    // Some rows carry an explicit `null` rather than omitting the key, which is
    // why the projection above treats null and absent identically.
    expect(optStr(row("5321869"), "family")).toBeUndefined();
  });
});

describe("enum constraints", () => {
  it("outputType: pass / fail / unknown", () => {
    expect(statusOf(GTE6, SPEC_GTE6, { outputType: ["PNP", "PNP/NPN"] }, "outputType")).toBe("pass");
    expect(statusOf(GTE6, SPEC_GTE6, { outputType: ["NPN"] }, "outputType")).toBe("fail");
    // PLH25-M12 is a reflector — B-32 prints no switching output for it.
    expect(statusOf(PLH25, SPEC_PLH25, { outputType: ["PNP"] }, "outputType")).toBe("unknown");
  });

  it("outputType: the `unknown` sentinel is inconclusive, not a violation", () => {
    // What normalize.ts emits when a switching-output string exists but resists
    // canonicalization. Failing on it would delete a possibly-correct part.
    const murky: NormalizedSpec = { ...SPEC_GTE6, outputType: "unknown" };
    const v = verdictFor(evaluate(GTE6, murky, { outputType: ["PNP"] }), "outputType");
    expect(v.status).toBe("unknown");
    expect(v.detail).toContain("could not be resolved");
  });

  it("connector: pass / fail / unknown", () => {
    expect(statusOf(GTE6, SPEC_GTE6, { connector: ["M8", "M12"] }, "connector")).toBe("pass");
    expect(statusOf(GTE6, SPEC_GTE6, { connector: ["M12"] }, "connector")).toBe("fail");
    expect(statusOf(PLH25, SPEC_PLH25, { connector: ["M12"] }, "connector")).toBe("unknown");
  });

  it("principle: pass / fail / unknown", () => {
    expect(statusOf(UP56, SPEC_UP56, { principle: ["ultrasonic"] }, "principle")).toBe("pass");
    expect(statusOf(UP56, SPEC_UP56, { principle: ["inductive", "capacitive"] }, "principle")).toBe("fail");
    expect(statusOf(PLH25, SPEC_PLH25, { principle: ["retroreflective"] }, "principle")).toBe("unknown");
  });

  it("housing: pass / fail / unknown, where `other` means unclassifiable", () => {
    expect(statusOf(KTM_CORE, SPEC_KTM_CORE, { housing: ["plastic"] }, "housing")).toBe("pass");
    expect(statusOf(KTM_CORE, SPEC_KTM_CORE, { housing: ["stainless-steel"] }, "housing")).toBe("fail");
    // DT50 prints "fundición de cinc" — arguably metal, but we did not resolve
    // it, so we must not claim it violates a "metal" requirement.
    expect(statusOf(DT50, SPEC_DT50, { housing: ["metal"] }, "housing")).toBe("unknown");
    expect(statusOf(WTT280, SPEC_WTT280, { housing: ["metal"] }, "housing")).toBe("unknown");
  });

  it("light: pass / fail / unknown", () => {
    expect(statusOf(WTT280, SPEC_WTT280, { light: ["laser"] }, "light")).toBe("pass");
    expect(statusOf(WTT280, SPEC_WTT280, { light: ["red", "infrared"] }, "light")).toBe("fail");
    expect(statusOf(CM18, SPEC_CM18, { light: ["red"] }, "light")).toBe("unknown");
  });

  it("section / rowType / family come off the source row", () => {
    expect(statusOf(GTE6, SPEC_GTE6, { section: ["B"] }, "section")).toBe("pass");
    expect(statusOf(GTE6, SPEC_GTE6, { section: ["C", "F"] }, "section")).toBe("fail");
    // Section is matched case-insensitively — BOM rows arrive in any casing.
    expect(statusOf(GTE6, SPEC_GTE6, { section: ["b"] }, "section")).toBe("pass");

    expect(statusOf(GTE6, SPEC_GTE6, { rowType: ["product"] }, "rowType")).toBe("pass");
    expect(statusOf(PLH25, SPEC_PLH25, { rowType: ["product"] }, "rowType")).toBe("fail");

    expect(statusOf(GTE6, SPEC_GTE6, { family: ["G6"] }, "family")).toBe("pass");
    expect(statusOf(GTE6, SPEC_GTE6, { family: ["W4-3"] }, "family")).toBe("fail");
    // C-78 prints no family heading for this mounting plate.
    expect(statusOf(BEF_WG, SPEC_BEF_WG, { family: ["CM"] }, "family")).toBe("unknown");
  });

  it("ioLink: pass / fail / unknown", () => {
    expect(statusOf(KTM_PRIME, SPEC_KTM_PRIME, { ioLink: true }, "ioLink")).toBe("pass");
    expect(statusOf(KTM_PRIME, SPEC_KTM_PRIME, { ioLink: false }, "ioLink")).toBe("fail");
    expect(statusOf(KTM_CORE, SPEC_KTM_CORE, { ioLink: true }, "ioLink")).toBe("unknown");
  });

  it("an empty allowed list is unconstrained, not unsatisfiable", () => {
    // An extractor that found nothing must not accidentally filter everything out.
    const result = evaluate(GTE6, SPEC_GTE6, { outputType: [], connector: [], section: [] });
    expect(result.verdicts).toHaveLength(0);
    expect(result.viable).toBe(true);
  });
});

describe("ingress protection", () => {
  it("minIpRating: pass / fail / unknown", () => {
    expect(statusOf(UP56, SPEC_UP56, { minIpRating: 67 }, "minIpRating")).toBe("pass");
    expect(statusOf(CLV620, SPEC_CLV620, { minIpRating: 67 }, "minIpRating")).toBe("fail");
    // B-16 prints no enclosure rating for the G6 family at all.
    expect(statusOf(GTE6, SPEC_GTE6, { minIpRating: 67 }, "minIpRating")).toBe("unknown");
  });

  it("writes a detail a judge can re-derive by hand", () => {
    const v = verdictFor(evaluate(UP56, SPEC_UP56, { minIpRating: 69 }), "minIpRating");
    expect(v.status).toBe("fail");
    expect(v.detail).toBe("requires IP ≥ 69, catalog states IP 67");
  });

  it("ip69k: pass / fail / unknown", () => {
    expect(statusOf(PLH25, SPEC_PLH25, { ip69k: true }, "ip69k")).toBe("pass");
    // IP 67 is printed, so we positively know it is not a washdown rating.
    expect(statusOf(UP56, SPEC_UP56, { ip69k: true }, "ip69k")).toBe("fail");
    expect(statusOf(GTE6, SPEC_GTE6, { ip69k: true }, "ip69k")).toBe("unknown");
  });

  it("ip69k is unknown when the normalizer defaults the flag with no rating printed", () => {
    // 1,347 of 1,776 rows print no enclosure rating. If a normalizer emits
    // `ip69k: false` by default for those, we still must not fail them.
    const defaulted: NormalizedSpec = { ...SPEC_GTE6, ip69k: false };
    expect(statusOf(GTE6, defaulted, { ip69k: true }, "ip69k")).toBe("unknown");
  });
});

describe("connectorPins", () => {
  it("exact match: pass / fail / unknown", () => {
    expect(statusOf(GTE6, SPEC_GTE6, { connectorPins: 4 }, "connectorPins")).toBe("pass");
    expect(statusOf(UP56, SPEC_UP56, { connectorPins: 4 }, "connectorPins")).toBe("fail");
    // H-164 prints no connection row for the DT50.
    expect(statusOf(DT50, SPEC_DT50, { connectorPins: 4 }, "connectorPins")).toBe("unknown");
  });
});

describe("sensingRangeMm — the candidate's capability window must cover the request", () => {
  it("passes when the requested distance sits inside the window", () => {
    const v = verdictFor(evaluate(UP56, SPEC_UP56, { sensingRangeMm: { min: 100 } }), "sensingRangeMm");
    expect(v.status).toBe("pass");
    expect(v.detail).toBe(
      "requires detection at 100 mm, catalog states a sensing range of 30 mm ... 250 mm",
    );
  });

  it("fails a target beyond the maximum sensing distance", () => {
    const v = verdictFor(evaluate(UP56, SPEC_UP56, { sensingRangeMm: { min: 400 } }), "sensingRangeMm");
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("beyond its maximum sensing distance");
  });

  it("fails a target closer than the minimum working distance", () => {
    // 10 mm is inside the UP56's 30 mm blind zone: a real, verified violation,
    // not a preference.
    const v = verdictFor(evaluate(UP56, SPEC_UP56, { sensingRangeMm: { min: 10 } }), "sensingRangeMm");
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("closer than its minimum working distance");
  });

  it("requires the whole requested window to be covered", () => {
    expect(statusOf(UP56, SPEC_UP56, { sensingRangeMm: { min: 50, max: 200 } }, "sensingRangeMm")).toBe("pass");
    expect(statusOf(UP56, SPEC_UP56, { sensingRangeMm: { min: 50, max: 900 } }, "sensingRangeMm")).toBe("fail");
  });

  it("an unprinted minimum working distance does not block a pass", () => {
    // B-16 states only `≤ 300 mm`. Demanding a printed near bound would turn
    // nearly every range check unknown; see the TSDoc for the residual risk.
    expect(statusOf(GTE6, SPEC_GTE6, { sensingRangeMm: { min: 100 } }, "sensingRangeMm")).toBe("pass");
    expect(statusOf(GTE6, SPEC_GTE6, { sensingRangeMm: { min: 350 } }, "sensingRangeMm")).toBe("fail");
  });

  it("is unknown when the catalog states no range at all", () => {
    const v = verdictFor(evaluate(KTM_PRIME, SPEC_KTM_PRIME, { sensingRangeMm: { min: 10 } }), "sensingRangeMm");
    expect(v.status).toBe("unknown");
    expect(v.detail).toContain("does not state a sensing range");
  });

  it("is unknown when only the near bound is printed and no violation is provable", () => {
    // Defensive: a normalization gap that drops the maximum must degrade to
    // "cannot verify reach", never to a pass.
    const nearOnly: NormalizedSpec = { ...SPEC_DT50 };
    delete nearOnly.sensingRangeMaxMm;
    expect(statusOf(DT50, nearOnly, { sensingRangeMm: { min: 5000 } }, "sensingRangeMm")).toBe("unknown");
    // …but a stated bound that is violated still fails.
    expect(statusOf(DT50, nearOnly, { sensingRangeMm: { min: 50 } }, "sensingRangeMm")).toBe("fail");
  });
});

describe("scalar bounds", () => {
  it("responseTimeMs: pass / fail / unknown", () => {
    expect(statusOf(KTM_CORE, SPEC_KTM_CORE, { responseTimeMs: { max: 12 } }, "responseTimeMs")).toBe("pass");
    expect(statusOf(DT50, SPEC_DT50, { responseTimeMs: { max: 12 } }, "responseTimeMs")).toBe("fail");
    // Response time is printed for 96 of 1,776 rows — this is the common case.
    expect(statusOf(GTE6, SPEC_GTE6, { responseTimeMs: { max: 12 } }, "responseTimeMs")).toBe("unknown");
  });

  it("switchingFrequencyHz: pass / fail / unknown", () => {
    expect(
      statusOf(WTT280, SPEC_WTT280, { switchingFrequencyHz: { min: 500 } }, "switchingFrequencyHz"),
    ).toBe("pass");
    expect(
      statusOf(WTT280, SPEC_WTT280, { switchingFrequencyHz: { min: 2000 } }, "switchingFrequencyHz"),
    ).toBe("fail");
    expect(statusOf(GTE6, SPEC_GTE6, { switchingFrequencyHz: { min: 500 } }, "switchingFrequencyHz")).toBe(
      "unknown",
    );
  });

  it("formats sub-millisecond values without float noise", () => {
    const v = verdictFor(evaluate(KTM_CORE, SPEC_KTM_CORE, { responseTimeMs: { max: 0.1 } }), "responseTimeMs");
    expect(v.detail).toBe("requires response time ≤ 0.1 ms, catalog states 0.05 ms");
  });
});

describe("supplyVoltageV — the requested supply must fall inside the accepted range", () => {
  it("pass / fail / unknown", () => {
    expect(statusOf(CM18, SPEC_CM18, { supplyVoltageV: { min: 24, max: 24 } }, "supplyVoltageV")).toBe("pass");
    expect(statusOf(CM18, SPEC_CM18, { supplyVoltageV: { min: 48 } }, "supplyVoltageV")).toBe("fail");
    expect(statusOf(CM18, SPEC_CM18, { supplyVoltageV: { min: 5 } }, "supplyVoltageV")).toBe("fail");
    // Supply voltage is printed for 41 of 1,776 rows.
    expect(statusOf(UP56, SPEC_UP56, { supplyVoltageV: { min: 24 } }, "supplyVoltageV")).toBe("unknown");
  });

  it("does not reject a wide-range supply for being wider than asked", () => {
    // The classic inverted-containment bug: 10 ... 40 V happily runs on 24 V.
    const v = verdictFor(evaluate(CM18, SPEC_CM18, { supplyVoltageV: { min: 24 } }), "supplyVoltageV");
    expect(v.status).toBe("pass");
    expect(v.detail).toBe("requires operation on 24 V, catalog states a supply voltage of 10 V ... 40 V");
  });
});

describe("operatingTempC — the candidate range must contain the requested window", () => {
  it("pass / fail / unknown", () => {
    expect(statusOf(UP56, SPEC_UP56, { operatingTempC: { min: -20, max: 60 } }, "operatingTempC")).toBe("pass");
    expect(statusOf(UP56, SPEC_UP56, { operatingTempC: { min: -40, max: 60 } }, "operatingTempC")).toBe("fail");
    expect(statusOf(UP56, SPEC_UP56, { operatingTempC: { min: -20, max: 85 } }, "operatingTempC")).toBe("fail");
    expect(statusOf(GTE6, SPEC_GTE6, { operatingTempC: { min: -20, max: 60 } }, "operatingTempC")).toBe(
      "unknown",
    );
  });

  it("only checks the sides the caller constrained", () => {
    const v = verdictFor(evaluate(DT50, SPEC_DT50, { operatingTempC: { min: -25 } }), "operatingTempC");
    expect(v.status).toBe("pass");
    expect(v.detail).toBe("requires operation across ≥ -25 °C, catalog states -30 °C ... 65 °C");
  });
});

describe("low-confidence propagation", () => {
  it("flags a verdict whose underlying catalog field was read from prose", () => {
    // F-123 lists switching output and connection in bullets, not a labelled cell.
    const v = verdictFor(evaluate(UP56, SPEC_UP56, { outputType: ["PNP"] }), "outputType");
    expect(v.status).toBe("pass");
    expect(v.lowConfidence).toBe(true);
  });

  it("does not flag a verdict backed by a labelled table cell", () => {
    const v = verdictFor(evaluate(KTM_PRIME, SPEC_KTM_PRIME, { outputType: ["PNP"] }), "outputType");
    expect(v.status).toBe("pass");
    expect(v.lowConfidence).toBeUndefined();
  });

  it("never flags an unknown — there was no value to be shaky about", () => {
    const v = verdictFor(evaluate(UP56, SPEC_UP56, { supplyVoltageV: { min: 24 } }), "supplyVoltageV");
    expect(v.status).toBe("unknown");
    expect(v.lowConfidence).toBeUndefined();
  });
});

describe("viable is not verified", () => {
  it("counts unknowns and still reports viable", () => {
    const result = evaluate(GTE6, SPEC_GTE6, {
      minIpRating: 67,
      responseTimeMs: { max: 12 },
      supplyVoltageV: { min: 24 },
      operatingTempC: { min: -20, max: 60 },
      switchingFrequencyHz: { min: 100 },
      outputType: ["PNP"],
    });
    expect(result.failed).toBe(0);
    expect(result.viable).toBe(true);
    expect(result.unknown).toBe(5);
    expect(result.passed).toBe(1);
    // The caller has to be able to say "1 of 6 requirements actually verified".
    expect(result.verdicts).toHaveLength(6);
  });

  it("emits no verdict for an omitted or vacuous constraint", () => {
    const result = evaluate(GTE6, SPEC_GTE6, { responseTimeMs: {}, sensingRangeMm: {} });
    expect(result.verdicts).toHaveLength(0);
    expect(result.unknown).toBe(0);
  });
});

describe("prefilter", () => {
  const products = [GTE6, UP56, CM18, DT50, WTT280, PLH25, CLV620];
  const specs = [SPEC_GTE6, SPEC_UP56, SPEC_CM18, SPEC_DT50, SPEC_WTT280, SPEC_PLH25, SPEC_CLV620];

  it("never drops a candidate for an unstated spec", () => {
    // Only CLV620 (IP 65, printed) is verifiably below IP 67. Everything with no
    // enclosure rating printed must survive.
    const kept = prefilter(products, specs, { minIpRating: 67 });
    const numbers = kept.map((p) => p.orderNumber);
    expect(numbers).toContain(GTE6.orderNumber); // no rating printed at all
    expect(numbers).toContain(DT50.orderNumber); // no rating printed at all
    expect(numbers).toContain(UP56.orderNumber); // IP 67, verified pass
    expect(numbers).not.toContain(CLV620.orderNumber); // IP 65, verified fail
  });

  it("keeps everything when the whole constraint set is unstated for a SKU", () => {
    const kept = prefilter([GTE6], [SPEC_GTE6], {
      supplyVoltageV: { min: 24 },
      operatingTempC: { min: -20, max: 60 },
      responseTimeMs: { max: 5 },
      ip69k: true,
    });
    expect(kept).toEqual([GTE6]);
  });

  it("keeps a product whose spec row is missing entirely", () => {
    // A normalization gap must degrade to "cannot verify", never to a drop.
    const kept = prefilter([UP56], [], { outputType: ["NPN"], minIpRating: 69 });
    expect(kept).toEqual([UP56]);
  });

  it("drops only verified violations and preserves input order", () => {
    const kept = prefilter(products, specs, { outputType: ["PNP"], rowType: ["product"] });
    expect(kept.map((p) => p.orderNumber)).toEqual([
      GTE6.orderNumber,
      UP56.orderNumber,
      CM18.orderNumber,
      DT50.orderNumber,
      WTT280.orderNumber,
      // PLH25 is an accessory → verified rowType violation.
      // CLV620 states no switching output, so it survives on `unknown`.
      CLV620.orderNumber,
    ]);
  });

  it("agrees with evaluate on every candidate", () => {
    // A prefilter that drops what the solver would have kept is a silent recall
    // bug no single-function test would catch. Pin the equivalence.
    const constraints: SpecConstraints = {
      outputType: ["PNP"],
      minIpRating: 67,
      sensingRangeMm: { min: 100 },
    };
    const kept = new Set(prefilter(products, specs, constraints).map((p) => p.orderNumber));
    for (const [i, product] of products.entries()) {
      const result = evaluate(product, specs[i]!, constraints);
      expect(kept.has(product.orderNumber)).toBe(result.viable);
    }
  });
});

describe("solve ordering", () => {
  it("ranks the fully-verified candidate above an equally-viable but unverified one", () => {
    // Both survive; UP56 answers all six from the printed table, GTE6 answers
    // four and is silent on two.
    const results = solve([GTE6, UP56], [SPEC_GTE6, SPEC_UP56], {
      outputType: ["PNP"],
      minIpRating: 65,
      operatingTempC: { min: -20, max: 60 },
      sensingRangeMm: { min: 100, max: 200 },
      rowType: ["product"],
      section: ["B", "F"],
    });
    expect(results.map((r) => r.product.orderNumber)).toEqual([UP56.orderNumber, GTE6.orderNumber]);

    const [best, second] = results;
    expect(best!.passed).toBe(6);
    expect(best!.unknown).toBe(0);
    expect(second!.passed).toBe(4);
    expect(second!.unknown).toBe(2);
    expect(best!.viable && second!.viable).toBe(true);
  });

  it("sinks candidates with a verified violation below every viable one", () => {
    const results = solve(
      [UP56, PLH25, CLV620, GTE6],
      [SPEC_UP56, SPEC_PLH25, SPEC_CLV620, SPEC_GTE6],
      { rowType: ["product"], minIpRating: 67 },
    );
    const viable = results.filter((r) => r.viable).map((r) => r.product.orderNumber);
    const rejected = results.slice(viable.length).map((r) => r.product.orderNumber);
    expect(viable).toEqual([UP56.orderNumber, GTE6.orderNumber]);
    // PLH25 fails rowType; CLV620 fails IP. Both are reported, not deleted.
    expect(rejected.sort()).toEqual([CLV620.orderNumber, PLH25.orderNumber].sort());
    expect(results).toHaveLength(4);
  });

  it("is deterministic and does not mutate its input", () => {
    const products = [WTT280, UP56, GTE6];
    const snapshot = [...products];
    const constraints: SpecConstraints = { outputType: ["PNP"] };
    const a = solve(products, [SPEC_WTT280, SPEC_UP56, SPEC_GTE6], constraints);
    const b = solve(products, [SPEC_WTT280, SPEC_UP56, SPEC_GTE6], constraints);
    expect(a.map((r) => r.product.orderNumber)).toEqual(b.map((r) => r.product.orderNumber));
    expect(products).toEqual(snapshot);
  });

  it("pairs each product with its own spec regardless of array order", () => {
    const results = solve([GTE6, UP56], [SPEC_UP56, SPEC_GTE6], { connectorPins: 5 });
    const byNumber = new Map(results.map((r) => [r.product.orderNumber, r]));
    expect(verdictFor(byNumber.get(UP56.orderNumber)!, "connectorPins").status).toBe("pass");
    expect(verdictFor(byNumber.get(GTE6.orderNumber)!, "connectorPins").status).toBe("fail");
  });
});
