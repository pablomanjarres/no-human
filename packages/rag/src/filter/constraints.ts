/**
 * The deterministic constraint solver — the part of this package a skeptical
 * engineer is allowed to trust.
 *
 * Retrieval hands us a candidate set. This module decides, per candidate and
 * per constraint, whether the *printed catalog* proves the candidate satisfies
 * it. No embedding score, no rank, no similarity ever enters a verdict: every
 * decision here is re-derivable by hand from the spec table on the cited page.
 *
 * ## Three-valued logic, and why it is the whole point
 *
 * The SICK 2015/2016 catalog is a *summary* catalog. Most SKUs print four to
 * eight specs; supply voltage is printed for 41 of 1,776 rows, response time for
 * 96, operating temperature for 109. A solver that treats "not printed" as
 * "does not satisfy" would silently delete the correct answer from the candidate
 * set and then confidently return the second-best part. So every constraint
 * resolves to `pass` / `fail` / `unknown`, and only a `fail` — a value the
 * catalog actually states, which actually violates the requirement — is ever
 * allowed to disqualify a SKU.
 *
 * The cost of that choice is that `viable` is a weak claim. It means "nothing
 * printed on the page contradicts the requirement", not "verified". Callers
 * MUST surface {@link SolveResult.unknown} alongside any recommendation.
 *
 * ## What lives here
 *
 * - {@link evaluate} — one candidate, full audit trail.
 * - {@link solve} — all candidates, ranked by evidence.
 * - {@link prefilter} — the hard filter applied before ranking.
 *
 * All three are pure: no I/O, no clock, no env, no mutation of the inputs.
 */

import type {
  ConstraintVerdict,
  NormalizedSpec,
  NumericConstraint,
  SickProduct,
  SolveResult,
  SpecConstraints,
} from "../types.js";

// ---------------------------------------------------------------------------
// Internal helpers — formatting and verdict construction
// ---------------------------------------------------------------------------

/**
 * Format a number for a human-readable `detail` sentence.
 *
 * Values arrive from JSON floats (`0.05` ms, `12.5` mm), so naive
 * `String(n)` can leak binary-float artifacts into a sentence a judge reads.
 * Rounding to 6 significant decimals then re-parsing drops the artifact without
 * changing any real catalog value.
 */
function fmt(n: number): string {
  return String(Number(n.toFixed(6)));
}

/**
 * Render a candidate's stated interval, tolerating a half-open one.
 *
 * The catalog frequently prints only one side (`≤ 300 mm` with no minimum
 * working distance). Collapsing that to `undefined–300` in a detail string
 * would hide *which* side was actually verified, which is exactly what a
 * reviewer is checking. Returns `null` when neither bound is stated.
 */
function intervalText(
  min: number | undefined,
  max: number | undefined,
  unit: string,
  joiner = " ... ",
): string | null {
  if (min !== undefined && max !== undefined) {
    return min === max ? `${fmt(min)} ${unit}` : `${fmt(min)} ${unit}${joiner}${fmt(max)} ${unit}`;
  }
  if (max !== undefined) return `≤ ${fmt(max)} ${unit}`;
  if (min !== undefined) return `≥ ${fmt(min)} ${unit}`;
  return null;
}

/** Render the requested side(s) of a {@link NumericConstraint} as a phrase. */
function requestText(c: NumericConstraint, unit: string): string {
  if (c.min !== undefined && c.max !== undefined) {
    return c.min === c.max ? `${fmt(c.min)} ${unit}` : `${fmt(c.min)} ${unit} ... ${fmt(c.max)} ${unit}`;
  }
  if (c.min !== undefined) return `≥ ${fmt(c.min)} ${unit}`;
  if (c.max !== undefined) return `≤ ${fmt(c.max)} ${unit}`;
  return `(unconstrained)`;
}

/**
 * Source-field aliases consulted to decide whether a verdict is low-confidence.
 *
 * `NormalizedSpec.lowConfidence` is a list of *field names*, but nothing in the
 * contract pins down whether the normalizer carries the catalog's snake_case
 * source names (`switching_output`) or its own camelCase normalized names
 * (`outputType`). Guessing wrong would silently drop every low-confidence flag —
 * a failure that no test of the normalizer alone would catch. So we accept both
 * spellings, plus the source fields a normalized value is derived from.
 */
const LOW_CONFIDENCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  outputType: ["outputType", "switchingOutput", "switching_output"],
  ioLink: ["ioLink", "interface", "switchingOutput", "switching_output"],
  connector: ["connector", "connection"],
  connectorPins: ["connectorPins", "connector", "connection"],
  minIpRating: ["ipRating", "enclosureRating", "enclosure_rating"],
  ip69k: ["ip69k", "ipRating", "enclosureRating", "enclosure_rating"],
  sensingRangeMm: [
    "sensingRangeMm",
    "sensingRangeMinMm",
    "sensingRangeMaxMm",
    "sensing_range_min_mm",
    "sensing_range_max_mm",
  ],
  responseTimeMs: ["responseTimeMs", "response_time_ms"],
  switchingFrequencyHz: ["switchingFrequencyHz", "switching_frequency_hz"],
  supplyVoltageV: [
    "supplyVoltageV",
    "supplyVoltageMinV",
    "supplyVoltageMaxV",
    "supply_voltage_min_v",
    "supply_voltage_max_v",
  ],
  operatingTempC: [
    "operatingTempC",
    "operatingTempMinC",
    "operatingTempMaxC",
    "operating_temp_min_c",
    "operating_temp_max_c",
  ],
  principle: [
    "principle",
    "sensorPrinciple",
    "sensor_principle",
    "detectionPrinciple",
    "detection_principle",
  ],
  housing: ["housing", "housingMaterial", "housing_material"],
  light: ["light", "lightType", "light_type"],
};

/** True when the catalog fields backing `field` were flagged low-confidence. */
function isFlagged(spec: NormalizedSpec, field: string): boolean {
  const flags = spec.lowConfidence ?? [];
  if (flags.length === 0) return false;
  const aliases = LOW_CONFIDENCE_ALIASES[field] ?? [field];
  return flags.some((f) => aliases.includes(f));
}

/**
 * Build one verdict.
 *
 * `lowConfidence` is attached only to `pass`/`fail`, because it qualifies a
 * value we actually read. Tagging an `unknown` — where no value was read at
 * all — would imply the catalog said something shaky when it said nothing.
 * Under `exactOptionalPropertyTypes` the property is spread in conditionally
 * rather than set to `undefined`.
 */
function mk(
  field: string,
  status: ConstraintVerdict["status"],
  detail: string,
  flagged = false,
): ConstraintVerdict {
  return {
    field,
    status,
    detail,
    ...(flagged && status !== "unknown" ? { lowConfidence: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-constraint checks
//
// Every check returns `null` when the constraint is absent or vacuous, so that
// `evaluate` emits exactly one verdict per *meaningfully* constrained field.
// ---------------------------------------------------------------------------

/**
 * Enum membership check.
 *
 * Two distinct kinds of non-answer are folded into `unknown` here, and the
 * distinction matters:
 *
 * 1. The value is absent — the catalog never printed the spec.
 * 2. The value is a sentinel (`"unknown"` for output/connector/principle,
 *    `"other"` for housing/light) — the catalog printed *something* the
 *    normalizer could not map onto a canonical token. `"fundición de cinc"`
 *    normalizes to housing `"other"`; that is a gap in our vocabulary, not
 *    evidence that the housing is not metal. Failing on it would delete a
 *    correct part over a translation miss.
 *
 * An explicitly empty `allowed` list means the upstream extractor produced no
 * constraint, so it is treated as unconstrained (`null`) rather than as
 * "nothing may pass" — fail open, never invent a filter nobody asked for.
 */
function enumCheck<T extends string>(
  field: string,
  label: string,
  allowedRaw: readonly (T | undefined)[] | undefined,
  value: T | undefined,
  inconclusive: readonly string[],
  missingLabel: string,
  flagged: boolean,
  normalize: (s: string) => string = (s) => s,
): ConstraintVerdict | null {
  const allowed = (allowedRaw ?? []).filter((a): a is T => a !== undefined);
  if (allowed.length === 0) return null;
  const req = `requires ${label} ${allowed.join(" or ")}`;
  if (value === undefined) {
    return mk(field, "unknown", `${req}, catalog does not state ${missingLabel}`);
  }
  if (allowed.some((a) => normalize(a) === normalize(value))) {
    return mk(field, "pass", `${req}, catalog states ${value}`, flagged);
  }
  if (inconclusive.includes(value)) {
    return mk(
      field,
      "unknown",
      `${req}, catalog text for ${missingLabel} could not be resolved to a canonical value (normalized to "${value}")`,
    );
  }
  return mk(field, "fail", `${req}, catalog states ${value}`, flagged);
}

/**
 * Scalar bound check for a single stated value (response time, frequency).
 *
 * Plain inclusive comparison — the only subtlety is that an absent value is
 * `unknown`, never `fail`.
 */
function scalarCheck(
  field: string,
  label: string,
  c: NumericConstraint | undefined,
  value: number | undefined,
  unit: string,
  flagged: boolean,
): ConstraintVerdict | null {
  if (c === undefined || (c.min === undefined && c.max === undefined)) return null;
  const req = `requires ${label} ${requestText(c, unit)}`;
  if (value === undefined) {
    return mk(field, "unknown", `${req}, catalog does not state ${label}`);
  }
  const found = `catalog states ${fmt(value)} ${unit}`;
  if (c.min !== undefined && value < c.min) return mk(field, "fail", `${req}, ${found}`, flagged);
  if (c.max !== undefined && value > c.max) return mk(field, "fail", `${req}, ${found}`, flagged);
  return mk(field, "pass", `${req}, ${found}`, flagged);
}

/**
 * Sensing-range check — the one whose semantics a reviewer will argue with, so
 * read this before changing it.
 *
 * **Interpretation.** `sensingRangeMm` describes the *distance(s) at which the
 * target actually sits*, not "how much range the sensor should have". The
 * candidate's `[sensingRangeMinMm, sensingRangeMaxMm]` is its *capability
 * window*: the minimum working distance (blind zone / start of the measuring
 * field) and the maximum sensing distance. The candidate passes when its window
 * covers the requested distance(s). A one-sided constraint (`{ min: 300 }`) is
 * read as the single distance 300 mm, not as "≥ 300 mm of range" — a sensor
 * whose window is 400 ... 2000 mm cannot see a target at 300 mm, and calling
 * that a pass is exactly the confident-wrong-answer this package exists to
 * avoid.
 *
 * **Asymmetry on absent bounds.** The far bound must be printed for a `pass`:
 * without a stated maximum there is nothing proving the sensor reaches the
 * target, so the verdict is `unknown`. An absent *minimum*, however, does not
 * block a pass. Rows printed as `≤ 300 mm` (829 rows state a max, only 657 a
 * min) are diffuse/proximity sensors whose measuring field starts at the face;
 * demanding a printed minimum would turn nearly every range check `unknown` and
 * make the solver useless. The residual risk is explicit: a
 * background-suppression sensor whose blind zone was not printed can pass a
 * request that in reality falls inside that blind zone. That is a `pass` whose
 * near side is unproven — which is why the far side is never assumed.
 *
 * A stated bound that is violated is always a `fail`, even when the other bound
 * is missing: a verified violation outranks an unverifiable side.
 */
function sensingRangeCheck(
  c: NumericConstraint | undefined,
  spec: NormalizedSpec,
  flagged: boolean,
): ConstraintVerdict | null {
  const field = "sensingRangeMm";
  if (c === undefined || (c.min === undefined && c.max === undefined)) return null;
  // Either bound alone denotes a single requested distance.
  const reqLow = c.min ?? (c.max as number);
  const reqHigh = c.max ?? (c.min as number);
  const req =
    reqLow === reqHigh
      ? `requires detection at ${fmt(reqLow)} mm`
      : `requires detection across ${fmt(reqLow)} mm ... ${fmt(reqHigh)} mm`;

  const candMin = spec.sensingRangeMinMm;
  const candMax = spec.sensingRangeMaxMm;
  const stated = intervalText(candMin, candMax, "mm");
  if (stated === null) {
    return mk(field, "unknown", `${req}, catalog does not state a sensing range`);
  }
  const found = `catalog states a sensing range of ${stated}`;

  if (candMax !== undefined && reqHigh > candMax) {
    return mk(field, "fail", `${req}, ${found} — beyond its maximum sensing distance`, flagged);
  }
  if (candMin !== undefined && reqLow < candMin) {
    return mk(field, "fail", `${req}, ${found} — closer than its minimum working distance`, flagged);
  }
  if (candMax === undefined) {
    return mk(
      field,
      "unknown",
      `${req}, ${found} — no maximum sensing distance printed, so reach cannot be verified`,
    );
  }
  return mk(field, "pass", `${req}, ${found}`, flagged);
}

/**
 * Containment check: the candidate's stated interval must cover the requested
 * one. Used for operating temperature and supply voltage.
 *
 * Only the sides the caller actually constrained are checked — a request of
 * `{ min: -20 }` says nothing about the upper end, so a missing candidate
 * maximum does not make the verdict `unknown`. A stated bound that is violated
 * is a `fail` even if the other side is unverifiable.
 */
function containmentCheck(
  field: string,
  label: string,
  c: NumericConstraint | undefined,
  candMin: number | undefined,
  candMax: number | undefined,
  unit: string,
  joiner: string,
  flagged: boolean,
): ConstraintVerdict | null {
  if (c === undefined || (c.min === undefined && c.max === undefined)) return null;
  const req = `requires ${label} ${requestText(c, unit)}`;
  const stated = intervalText(candMin, candMax, unit, joiner);
  if (stated === null) {
    return mk(field, "unknown", `${req}, catalog does not state ${label}`);
  }
  const found = `catalog states ${stated}`;
  if (c.min !== undefined && candMin !== undefined && candMin > c.min) {
    return mk(field, "fail", `${req}, ${found}`, flagged);
  }
  if (c.max !== undefined && candMax !== undefined && candMax < c.max) {
    return mk(field, "fail", `${req}, ${found}`, flagged);
  }
  if ((c.min !== undefined && candMin === undefined) || (c.max !== undefined && candMax === undefined)) {
    return mk(field, "unknown", `${req}, ${found} — one bound is not printed, so it cannot be verified`);
  }
  return mk(field, "pass", `${req}, ${found}`, flagged);
}

/**
 * Supply-voltage check.
 *
 * The constraint names the supply *available in the field* (e.g. 24 V DC); the
 * candidate's `supplyVoltageMinV ... supplyVoltageMaxV` is the range it accepts.
 * So the requested voltage(s) must fall inside the accepted range — the
 * containment runs the opposite way from a naive "min ≥ min, max ≤ max" read,
 * and getting it backwards silently rejects every wide-range sensor.
 */
function supplyVoltageCheck(
  c: NumericConstraint | undefined,
  spec: NormalizedSpec,
  flagged: boolean,
): ConstraintVerdict | null {
  const field = "supplyVoltageV";
  if (c === undefined || (c.min === undefined && c.max === undefined)) return null;
  const reqLow = c.min ?? (c.max as number);
  const reqHigh = c.max ?? (c.min as number);
  const req =
    reqLow === reqHigh
      ? `requires operation on ${fmt(reqLow)} V`
      : `requires operation on ${fmt(reqLow)} V ... ${fmt(reqHigh)} V`;

  const candMin = spec.supplyVoltageMinV;
  const candMax = spec.supplyVoltageMaxV;
  const stated = intervalText(candMin, candMax, "V");
  if (stated === null) {
    return mk(field, "unknown", `${req}, catalog does not state a supply voltage`);
  }
  const found = `catalog states a supply voltage of ${stated}`;
  if (candMin !== undefined && reqLow < candMin) return mk(field, "fail", `${req}, ${found}`, flagged);
  if (candMax !== undefined && reqHigh > candMax) return mk(field, "fail", `${req}, ${found}`, flagged);
  if (candMin === undefined || candMax === undefined) {
    return mk(field, "unknown", `${req}, ${found} — one bound is not printed, so it cannot be verified`);
  }
  return mk(field, "pass", `${req}, ${found}`, flagged);
}

/**
 * Ingress-protection check.
 *
 * `IP 69K` normalizes to `ipRating: 69`, so a plain numeric comparison ranks
 * IP69K above IP68 — which is wrong as an ordering (they are different tests:
 * dust+immersion vs. high-pressure hot washdown) but harmless as a threshold,
 * because a caller who actually needs washdown must ask for it via
 * {@link ip69kCheck}, not by asking for `minIpRating: 69`.
 */
function ipRatingCheck(
  min: number | undefined,
  spec: NormalizedSpec,
  flagged: boolean,
): ConstraintVerdict | null {
  if (min === undefined) return null;
  const field = "minIpRating";
  const req = `requires IP ≥ ${fmt(min)}`;
  if (spec.ipRating === undefined) {
    return mk(field, "unknown", `${req}, catalog does not state an enclosure rating`);
  }
  const found = `catalog states IP ${fmt(spec.ipRating)}${spec.ip69k === true ? "K" : ""}`;
  return mk(field, spec.ipRating >= min ? "pass" : "fail", `${req}, ${found}`, flagged);
}

/**
 * IP69K flag check.
 *
 * A `false` here is only a `fail` when the catalog printed *some* enclosure
 * rating — then we know it is not 69K. When no rating is printed at all, the
 * normalizer may legitimately leave `ip69k` unset or default it to `false`;
 * treating that as a fail would drop every SKU whose enclosure rating simply
 * was not in the summary table (1,347 of 1,776 rows).
 */
function ip69kCheck(
  want: boolean | undefined,
  spec: NormalizedSpec,
  flagged: boolean,
): ConstraintVerdict | null {
  if (want === undefined) return null;
  const field = "ip69k";
  const req = want ? `requires an IP69K washdown rating` : `requires a non-IP69K rating`;
  const has = spec.ip69k === true;
  // A bare `ip69k: false` proves nothing on its own — normalizers routinely
  // default booleans. Only a printed `ipRating` establishes that the catalog
  // actually stated a rating and that rating is not 69K.
  const ratingStated = spec.ipRating !== undefined;
  if (!has && !ratingStated) {
    return mk(field, "unknown", `${req}, catalog does not state an enclosure rating`);
  }
  const found = has
    ? `catalog states IP 69K`
    : `catalog states IP ${spec.ipRating !== undefined ? fmt(spec.ipRating) : "?"} and not IP69K`;
  return mk(field, has === want ? "pass" : "fail", `${req}, ${found}`, flagged);
}

/** IO-Link support check. Absent means the catalog never mentioned an interface. */
function ioLinkCheck(
  want: boolean | undefined,
  spec: NormalizedSpec,
  flagged: boolean,
): ConstraintVerdict | null {
  if (want === undefined) return null;
  const field = "ioLink";
  const req = want ? `requires IO-Link support` : `requires no IO-Link`;
  if (spec.ioLink === undefined) {
    return mk(field, "unknown", `${req}, catalog does not state an IO-Link interface`);
  }
  const found = spec.ioLink ? `catalog states IO-Link` : `catalog states no IO-Link`;
  return mk(field, spec.ioLink === want ? "pass" : "fail", `${req}, ${found}`, flagged);
}

/** Exact connector pin-count match. */
function pinsCheck(
  want: number | undefined,
  spec: NormalizedSpec,
  flagged: boolean,
): ConstraintVerdict | null {
  if (want === undefined) return null;
  const field = "connectorPins";
  const req = `requires a ${fmt(want)}-pin connector`;
  if (spec.connectorPins === undefined) {
    return mk(field, "unknown", `${req}, catalog does not state a pin count`);
  }
  return mk(
    field,
    spec.connectorPins === want ? "pass" : "fail",
    `${req}, catalog states ${fmt(spec.connectorPins)} pins`,
    flagged,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate one candidate against a constraint set, returning a verdict per
 * constrained field.
 *
 * Emits exactly one {@link ConstraintVerdict} per constraint that is actually
 * present and non-vacuous in `constraints` — an omitted field, an empty enum
 * list, or a `{}` numeric constraint produce no verdict at all, so `passed +
 * failed + unknown` is the number of requirements the caller genuinely stated.
 *
 * **`viable` does NOT mean verified.** It means `failed === 0`: nothing printed
 * in the catalog contradicts the request. A SKU with five `unknown` verdicts and
 * zero `fail` verdicts is `viable`, and presenting it as a confirmed match is a
 * lie the data does not support. Any caller rendering this result MUST show
 * {@link SolveResult.unknown} (and ideally the `unknown` verdict details) next
 * to the recommendation.
 *
 * `spec` supplies every electrical/optical value; `product` supplies the
 * catalog-structural constraints (`section`, `rowType`, `family`) that are read
 * straight off the source row and are therefore never low-confidence. Pure — it
 * neither reads nor mutates anything outside its arguments.
 */
export function evaluate(
  product: SickProduct,
  spec: NormalizedSpec,
  constraints: SpecConstraints,
): SolveResult {
  const verdicts: ConstraintVerdict[] = [];
  const push = (v: ConstraintVerdict | null): void => {
    if (v !== null) verdicts.push(v);
  };
  const flag = (field: string): boolean => isFlagged(spec, field);

  // -- electrical / interface ------------------------------------------------
  push(
    enumCheck(
      "outputType",
      "output type",
      constraints.outputType,
      spec.outputType,
      ["unknown"],
      "a switching output",
      flag("outputType"),
    ),
  );
  push(ioLinkCheck(constraints.ioLink, spec, flag("ioLink")));
  push(
    enumCheck(
      "connector",
      "connection",
      constraints.connector,
      spec.connector,
      ["unknown"],
      "a connection type",
      flag("connector"),
    ),
  );
  push(pinsCheck(constraints.connectorPins, spec, flag("connectorPins")));

  // -- environmental ---------------------------------------------------------
  push(ipRatingCheck(constraints.minIpRating, spec, flag("minIpRating")));
  push(ip69kCheck(constraints.ip69k, spec, flag("ip69k")));
  push(
    containmentCheck(
      "operatingTempC",
      "operation across",
      constraints.operatingTempC,
      spec.operatingTempMinC,
      spec.operatingTempMaxC,
      "°C",
      " ... ",
      flag("operatingTempC"),
    ),
  );

  // -- performance -----------------------------------------------------------
  push(sensingRangeCheck(constraints.sensingRangeMm, spec, flag("sensingRangeMm")));
  push(
    scalarCheck(
      "responseTimeMs",
      "response time",
      constraints.responseTimeMs,
      spec.responseTimeMs,
      "ms",
      flag("responseTimeMs"),
    ),
  );
  push(
    scalarCheck(
      "switchingFrequencyHz",
      "switching frequency",
      constraints.switchingFrequencyHz,
      spec.switchingFrequencyHz,
      "Hz",
      flag("switchingFrequencyHz"),
    ),
  );
  push(supplyVoltageCheck(constraints.supplyVoltageV, spec, flag("supplyVoltageV")));

  // -- optical / physical ----------------------------------------------------
  // A principle inferred from the section heading (`principleSource ===
  // "category"`) is not a printed spec, so it may corroborate a constraint but
  // must never disqualify a SKU. Downgrading its `fail` to `unknown` keeps the
  // part reachable and tells the reader exactly why the check is inconclusive.
  // Without this, a section that mixes principles silently deletes correct
  // parts — the absent-vs-fails bug, in its most damaging form.
  const principleVerdict = enumCheck(
    "principle",
    "sensing principle",
    constraints.principle,
    spec.principle,
    ["unknown"],
    "a sensing principle",
    flag("principle"),
  );
  if (
    principleVerdict !== null &&
    principleVerdict.status === "fail" &&
    spec.principleSource === "category"
  ) {
    push(
      mk(
        "principle",
        "unknown",
        `${principleVerdict.detail} — but the page states no sensing principle; ` +
          `this was inferred from the catalog section heading, so it cannot disqualify this part`,
        true,
      ),
    );
  } else {
    push(principleVerdict);
  }
  push(
    enumCheck(
      "housing",
      "housing",
      constraints.housing,
      spec.housing,
      ["other"],
      "a housing material",
      flag("housing"),
    ),
  );
  push(
    enumCheck("light", "light source", constraints.light, spec.light, ["other"], "a light type", flag("light")),
  );

  // -- catalog structure (read off the source row, never low-confidence) -----
  push(
    enumCheck(
      "section",
      "catalog section",
      constraints.section,
      product.section,
      [],
      "a catalog section",
      false,
      (s) => s.toUpperCase(),
    ),
  );
  push(enumCheck("rowType", "row type", constraints.rowType, product.rowType, [], "a row type", false));
  push(
    enumCheck(
      "family",
      "family",
      constraints.family,
      product.family,
      [],
      "a family",
      false,
      (s) => s.toUpperCase(),
    ),
  );

  let passed = 0;
  let failed = 0;
  let unknown = 0;
  for (const v of verdicts) {
    if (v.status === "pass") passed += 1;
    else if (v.status === "fail") failed += 1;
    else unknown += 1;
  }

  return { product, spec, verdicts, passed, failed, unknown, viable: failed === 0 };
}

/**
 * Index specs by order number so a candidate can be paired with its spec.
 *
 * A product with no matching spec row gets an empty spec — every constraint then
 * resolves to `unknown`, so a normalization gap degrades to "cannot verify"
 * rather than to a silent drop.
 */
function specIndex(specs: readonly NormalizedSpec[]): Map<string, NormalizedSpec> {
  const map = new Map<string, NormalizedSpec>();
  for (const s of specs) map.set(s.orderNumber, s);
  return map;
}

function specFor(product: SickProduct, index: Map<string, NormalizedSpec>): NormalizedSpec {
  return index.get(product.orderNumber) ?? { orderNumber: product.orderNumber, lowConfidence: [] };
}

/**
 * Evaluate every candidate and rank them by how well the catalog *evidences*
 * the match.
 *
 * Ordering, in strict precedence:
 *
 * 1. viable (`failed === 0`) before non-viable — a verified violation is
 *    disqualifying, so those sink to the bottom rather than disappearing; the
 *    caller can still show "rejected because…" with the failing verdict.
 * 2. fewest `failed` (only separates the non-viable tail).
 * 3. fewest `unknown` — **the load-bearing rule**. A candidate the catalog
 *    fully answers for outranks one the catalog is quiet about, even though
 *    both are "viable". Six verified passes beat two passes and four unknowns,
 *    because the second is mostly a guess.
 * 4. most `passed`.
 * 5. `orderNumber` ascending, purely so the output is deterministic and
 *    diffable across runs.
 *
 * Note what is absent: retrieval rank and similarity score. Ranking here is a
 * function of evidence only. Callers that want relevance ordering must apply it
 * *within* an equal-evidence band, never across one.
 *
 * Does not mutate `products`; the returned array is fresh.
 */
export function solve(
  products: readonly SickProduct[],
  specs: readonly NormalizedSpec[],
  constraints: SpecConstraints,
): SolveResult[] {
  const index = specIndex(specs);
  const results = products.map((p) => evaluate(p, specFor(p, index), constraints));
  results.sort((a, b) => {
    if (a.viable !== b.viable) return a.viable ? -1 : 1;
    if (a.failed !== b.failed) return a.failed - b.failed;
    if (a.unknown !== b.unknown) return a.unknown - b.unknown;
    if (a.passed !== b.passed) return b.passed - a.passed;
    return a.product.orderNumber.localeCompare(b.product.orderNumber);
  });
  return results;
}

/**
 * Hard prefilter applied before ranking: keep every candidate without a
 * *verified* violation.
 *
 * This is what makes "PNP and IP69K and under 12 ms" answerable — the retrieval
 * lanes only ever rank SKUs that already survive the structured requirements.
 *
 * It drops a candidate only when some constraint has status `fail`, i.e. the
 * catalog states a value and that value violates the request. Constraints the
 * catalog is silent about (`unknown`) never drop anything: with supply voltage
 * printed for 41 of 1,776 rows and response time for 96, filtering on unknowns
 * would empty the candidate set and the agent would then confidently answer
 * from whatever scraps survived.
 *
 * Implemented on top of {@link evaluate} on purpose. A separately hand-tuned
 * "fast path" is the classic source of a silent recall bug — a prefilter that
 * drops what the solver would have kept — and no test of either function alone
 * would catch the divergence. Order is preserved.
 */
export function prefilter(
  products: readonly SickProduct[],
  specs: readonly NormalizedSpec[],
  constraints: SpecConstraints,
): SickProduct[] {
  const index = specIndex(specs);
  return products.filter((p) => evaluate(p, specFor(p, index), constraints).failed === 0);
}
