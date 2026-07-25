/**
 * The Claude tool-use surface over the SICK catalog.
 *
 * {@link createCatalogTools} turns a retriever into six Anthropic Messages API
 * tool definitions. This module is prompt surface as much as it is code: the
 * `description` strings below are read by the model on every turn and are the
 * only place the *division of labour* between retrieval and the deterministic
 * solver is stated where the model will actually see it. Recent Claude models
 * under-reach for tools whose descriptions say what a tool does but not *when*
 * to call it, so every description here is written imperatively.
 *
 * ## The two invariants this file exists to enforce at the boundary
 *
 * 1. **Retrieval never picks the part.** `search_catalog` returns candidates
 *    ranked by a text-similarity heuristic. Nothing about that rank is evidence
 *    of technical equivalence. Its result payload therefore carries an explicit
 *    `ranking` caveat *in the data*, not just in the description — a model that
 *    skims the tool list still reads the tool result.
 * 2. **Absent is not failing.** Every result distinguishes three states, never
 *    two: the catalog states a value that satisfies the requirement, the catalog
 *    states a value that violates it, or the catalog is **silent**. Silence is
 *    reported as `unknown` / `stated: false` and counted, never folded into
 *    either of the other two. Folding silence into "pass" produces a confident
 *    wrong recommendation on a part someone bolts onto a machine; folding it
 *    into "fail" deletes the correct answer from the candidate set.
 *
 * Every tool result carries citations (`sourcePage` + `pdfPage`) so any claim
 * can be checked against the printed page, and every result is plain
 * JSON-serializable data — no class instances, no `undefined` leaking into what
 * gets stringified.
 *
 * ## Why parameter names are camelCase
 *
 * The constraint parameters mirror {@link SpecConstraints} *exactly*, key for
 * key. `corpus/loadCatalog.ts` is deliberately the package's only snake_case
 * boundary, and a second translation table here would be a place for a
 * constraint to get silently dropped in transit — which is the worst possible
 * bug in this file, because the result would still look like it honored the
 * requirement. JSON Schema has no case convention; the wire keys of the tool
 * *envelope* (`input_schema`) stay snake_case because that is the API's shape.
 *
 * Pure apart from whatever the injected retriever does: no network, no env, no
 * filesystem access originates here.
 */

import { normalizeSpec } from "./filter/normalize.js";
import type {
  Citation,
  ConnectorType,
  NormalizedSpec,
  NumericConstraint,
  OutputType,
  RetrievalResult,
  RowType,
  SearchOptions,
  SensingPrinciple,
  SickFamily,
  SickProduct,
  SolveResult,
  SpecConstraints,
} from "./types.js";

// ---------------------------------------------------------------------------
// The retriever contract this module consumes
// ---------------------------------------------------------------------------

/** A value that may or may not be wrapped in a promise. */
type MaybePromise<T> = T | Promise<T>;

/**
 * The slice of `retrieve.ts`'s retriever that the tool layer actually calls.
 *
 * Declared structurally, and deliberately *narrower* than the real retriever:
 * this module is the outermost boundary of the package, so pinning it to a
 * concrete implementation type would make the agent-facing surface break every
 * time the retriever grows a convenience field.
 *
 * The three accessors return `unknown` on purpose. Their exact wrapper shape
 * (`SickProduct` vs. `{ product, spec, citation }`) is a matter of taste inside
 * the retriever, but a tool result is a contract with the model — so this module
 * re-derives everything it emits from {@link SickProduct}, the one shape
 * `types.ts` actually pins, rather than trusting a wrapper's field names. See
 * {@link extractProduct}.
 */
export interface CatalogRetrieverLike {
  /** Hybrid search. Returns ranked candidates with citations and lane signals. */
  search(query: string, opts?: SearchOptions): MaybePromise<readonly RetrievalResult[]>;
  /** One SKU by 7-digit order number. Returns a falsy/empty value when absent. */
  getProduct(orderNumber: string): MaybePromise<unknown>;
  /** Every row of one product family, variants and accessories alike. */
  getFamily(family: string): MaybePromise<unknown>;
  /** The deterministic solve over the whole catalog, already ranked by evidence. */
  solveConstraints(
    constraints: SpecConstraints,
    opts?: unknown,
  ): MaybePromise<readonly SolveResult[]>;
  /** What the loaded index contains and which lanes are live. */
  stats(): MaybePromise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool shape
// ---------------------------------------------------------------------------

/** The subset of JSON Schema these tool definitions use. */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: readonly string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

/**
 * A tool's input schema.
 *
 * `additionalProperties: false` and an explicit `required` array are both
 * mandatory rather than stylistic: without them a tool definition is rejected
 * under `strict: true`, and — more importantly — a misspelled constraint would
 * be accepted and silently ignored, which reads to the caller as a satisfied
 * requirement.
 */
export interface ToolInputSchema extends JsonSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: readonly string[];
  additionalProperties: false;
}

/**
 * One Anthropic Messages API tool, plus the local executor for it.
 *
 * `name`, `description` and `input_schema` are exactly what goes in the
 * `tools` array of a request. `run` is not part of the wire shape — it is how
 * the host dispatches a `tool_use` block it got back.
 */
export interface CatalogTool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  /** Execute the tool. Returns plain JSON-serializable data. */
  run(input: unknown): Promise<unknown>;
}

/**
 * Thrown when a `tool_use` block's input is malformed or names a constraint that
 * does not exist.
 *
 * Deliberately loud. The alternative — ignoring the offending key and solving
 * with the constraints we *did* understand — returns a result that looks like it
 * honored the full requirement while having quietly dropped part of it. A thrown
 * error costs one turn; a silently narrowed constraint set costs a wrong part.
 *
 * Note the contrast with a SKU that simply is not in the catalog: that is not an
 * input error, it is an honest negative, and it is returned as data
 * (`found: false`) so the agent can say so rather than retry.
 */
export class CatalogToolInputError extends Error {
  override readonly name = "CatalogToolInputError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Enum surfaces, kept provably in sync with types.ts
// ---------------------------------------------------------------------------

/**
 * Enumerate a string union's members as an array.
 *
 * The `Record<U, true>` argument is what makes this worth a helper: the compiler
 * rejects the call if a member is missing *or* if an extra one is present. A
 * hand-written `readonly OutputType[]` literal would happily go stale the day
 * `types.ts` adds a sensing principle, and the only symptom would be a schema
 * that silently refuses a legitimate constraint.
 */
function unionMembers<U extends string>(members: Record<U, true>): U[] {
  return Object.keys(members) as U[];
}

/**
 * Constrainable output types.
 *
 * `"unknown"` is enumerated for the exhaustiveness check and then dropped from
 * the tool surface: `filter/normalize.ts` never *emits* `"unknown"` (it omits
 * the property instead), so a constraint asking for it could only ever produce a
 * permanent `unknown` verdict — an invitation for the model to waste a turn.
 */
const OUTPUT_TYPES: readonly OutputType[] = unionMembers<OutputType>({
  PNP: true,
  NPN: true,
  "PNP/NPN": true,
  "push-pull": true,
  analog: true,
  relay: true,
  unknown: true,
}).filter((t) => t !== "unknown");

/** Constrainable connector types. `"unknown"` dropped, same reasoning. */
const CONNECTOR_TYPES: readonly ConnectorType[] = unionMembers<ConnectorType>({
  M8: true,
  M12: true,
  M5: true,
  cable: true,
  terminal: true,
  other: true,
  unknown: true,
}).filter((t) => t !== "unknown");

/** Constrainable sensing principles. `"unknown"` dropped, same reasoning. */
const SENSING_PRINCIPLES: readonly SensingPrinciple[] = unionMembers<SensingPrinciple>({
  diffuse: true,
  "background-suppression": true,
  "foreground-suppression": true,
  retroreflective: true,
  "through-beam": true,
  inductive: true,
  capacitive: true,
  magnetic: true,
  ultrasonic: true,
  "laser-distance": true,
  contrast: true,
  luminescence: true,
  color: true,
  fork: true,
  "light-grid": true,
  "safety-light-curtain": true,
  encoder: true,
  vision: true,
  identification: true,
  fluid: true,
  "safety-switch": true,
  "safety-controller": true,
  unknown: true,
}).filter((p) => p !== "unknown");

/** Housing material tokens. `"other"` is genuinely emitted, so it stays. */
type Housing = NonNullable<NormalizedSpec["housing"]>;
const HOUSINGS: readonly Housing[] = unionMembers<Housing>({
  plastic: true,
  metal: true,
  "stainless-steel": true,
  other: true,
});

/** Light-source tokens. `"other"` is genuinely emitted, so it stays. */
type Light = NonNullable<NormalizedSpec["light"]>;
const LIGHTS: readonly Light[] = unionMembers<Light>({
  red: true,
  infrared: true,
  laser: true,
  white: true,
  rgb: true,
  green: true,
  other: true,
});

/** Catalog row types. */
const ROW_TYPES: readonly RowType[] = unionMembers<RowType>({ product: true, accessory: true });

// ---------------------------------------------------------------------------
// Constraint schema
// ---------------------------------------------------------------------------

/** A `{ min?, max? }` bound, rendered as JSON Schema with a field-specific gloss. */
function numericConstraintSchema(description: string): JsonSchema {
  return {
    type: "object",
    description,
    properties: {
      min: { type: "number", description: "Inclusive lower bound." },
      max: { type: "number", description: "Inclusive upper bound." },
    },
    required: [],
    additionalProperties: false,
  };
}

/** An `enum`-constrained array parameter. */
function enumArraySchema(values: readonly string[], description: string): JsonSchema {
  return {
    type: "array",
    description,
    items: { type: "string", enum: values },
    minItems: 1,
  };
}

/**
 * JSON Schema for {@link SpecConstraints} — the "spec vector" every input
 * modality collapses into.
 *
 * Shared verbatim by `search_catalog` (where it prefilters *before* ranking) and
 * `solve_constraints` (where it decides). One definition, so the two tools can
 * never disagree about what is constrainable.
 */
const CONSTRAINTS_PROPERTIES: Record<string, JsonSchema> = {
  outputType: enumArraySchema(
    OUTPUT_TYPES,
    "Acceptable switching-output types. A SKU passes if the catalog states one of these.",
  ),
  ioLink: {
    type: "boolean",
    description:
      "Require IO-Link. Only ever set true: this summary catalog's silence about IO-Link is not a denial of it, so `false` cannot be verified and is treated as no constraint.",
  },
  connector: enumArraySchema(CONNECTOR_TYPES, "Acceptable electrical connection forms."),
  connectorPins: { type: "integer", description: "Required pin count on the connector, e.g. 4." },
  minIpRating: {
    type: "integer",
    description: "Minimum acceptable IP enclosure rating as an integer. 67 accepts IP67 and IP69K.",
  },
  ip69k: { type: "boolean", description: "Require specifically IP69K (high-pressure washdown)." },
  sensingRangeMm: numericConstraintSchema(
    "Sensing distance the sensor must cover, in millimetres. Convert the user's units first: 40 cm is { min: 400 }.",
  ),
  responseTimeMs: numericConstraintSchema(
    "Response time window in milliseconds. 'under 12 ms' is { max: 12 }.",
  ),
  switchingFrequencyHz: numericConstraintSchema("Switching frequency window in hertz."),
  supplyVoltageV: numericConstraintSchema(
    "Supply voltage window in volts. Printed for only 41 of 1,776 SKUs, so expect `unknown` verdicts here.",
  ),
  operatingTempC: numericConstraintSchema(
    "Ambient temperature window in °C the sensor must cover end to end, e.g. { min: -25, max: 60 }.",
  ),
  principle: enumArraySchema(
    SENSING_PRINCIPLES,
    "Acceptable sensing principles. This is usually the single most discriminating constraint — set it whenever the input implies one.",
  ),
  housing: enumArraySchema(HOUSINGS, "Acceptable housing materials."),
  light: enumArraySchema(LIGHTS, "Acceptable light sources."),
  section: {
    type: "array",
    description: "Restrict to catalog section letters B–N, e.g. ['B'] for photoelectric sensors.",
    items: { type: "string" },
    minItems: 1,
  },
  rowType: enumArraySchema(
    ROW_TYPES,
    "Restrict to main product variants or to accessories. Omit to search both.",
  ),
  family: {
    type: "array",
    description: "Restrict to specific SICK product families, e.g. ['W4-3', 'G6'].",
    items: { type: "string" },
    minItems: 1,
  },
};

/** The constraints object as a nested parameter. */
const CONSTRAINTS_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Structured hard requirements the part must satisfy. Omitted fields are unconstrained (not 'don't care about correctness' — the result reports which constraints were actually checkable).",
  properties: CONSTRAINTS_PROPERTIES,
  required: [],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** JSON `null` and an absent key both mean "not supplied" on the tool wire. */
function supplied(rec: Record<string, unknown>, key: string): boolean {
  const v = rec[key];
  return v !== undefined && v !== null;
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogToolInputError(`${where} must be an object, got ${describeType(value)}.`);
  }
  return value as Record<string, unknown>;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function readString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CatalogToolInputError(`${where} must be a non-empty string.`);
  }
  return value.trim();
}

function readNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CatalogToolInputError(`${where} must be a finite number.`);
  }
  return value;
}

function readInteger(value: unknown, where: string): number {
  const n = readNumber(value, where);
  if (!Number.isInteger(n))
    throw new CatalogToolInputError(`${where} must be an integer, got ${n}.`);
  return n;
}

function readBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean")
    throw new CatalogToolInputError(`${where} must be true or false.`);
  return value;
}

/**
 * Read an integer parameter within bounds, falling back to a default.
 *
 * Out-of-range values are clamped rather than rejected: a `topK` of 500 is a
 * harmless over-ask, not a semantic error, and failing the whole call over it
 * would cost a turn for nothing. Contrast {@link readEnumArray}, where an
 * unrecognized value changes what the result *means* and so must throw.
 */
function readBoundedInt(
  value: unknown,
  where: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  const n = readInteger(value, where);
  return Math.min(max, Math.max(min, n));
}

function readStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value))
    throw new CatalogToolInputError(`${where} must be an array of strings.`);
  return value.map((v, i) => readString(v, `${where}[${i}]`));
}

/**
 * Read an array whose members must all belong to a closed set.
 *
 * Unrecognized members throw. Dropping them would narrow the constraint set
 * without saying so, and the caller would read the result as having enforced
 * the requirement it actually spelled wrong.
 */
function readEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T[] {
  const raw = readStringArray(value, where);
  const out: T[] = [];
  for (const v of raw) {
    const hit = allowed.find((a) => a === v);
    if (hit === undefined) {
      throw new CatalogToolInputError(`${where}: "${v}" is not one of ${allowed.join(", ")}.`);
    }
    out.push(hit);
  }
  if (out.length === 0) throw new CatalogToolInputError(`${where} must list at least one value.`);
  return out;
}

/**
 * Read a `{ min?, max? }` bound.
 *
 * An empty object is rejected. `{}` reads as a constraint but constrains
 * nothing, so it would show up in the echoed constraint set as a requirement the
 * caller believes was enforced.
 */
function readNumericConstraint(value: unknown, where: string): NumericConstraint {
  const rec = requireRecord(value, where);
  for (const key of Object.keys(rec)) {
    if (key !== "min" && key !== "max") {
      throw new CatalogToolInputError(`${where}: unknown key "${key}". Use min and/or max.`);
    }
  }
  const hasMin = supplied(rec, "min");
  const hasMax = supplied(rec, "max");
  if (!hasMin && !hasMax) throw new CatalogToolInputError(`${where} needs a min, a max, or both.`);
  const min = hasMin ? readNumber(rec["min"], `${where}.min`) : undefined;
  const max = hasMax ? readNumber(rec["max"], `${where}.max`) : undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new CatalogToolInputError(`${where}: min (${min}) is greater than max (${max}).`);
  }
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/**
 * Tool input → {@link SpecConstraints}.
 *
 * The allowed key list is derived from {@link CONSTRAINTS_PROPERTIES} rather
 * than written out again, so the schema advertised to the model and the parser
 * that enforces it cannot drift apart.
 */
function readConstraints(value: unknown): SpecConstraints {
  const rec = requireRecord(value, "constraints");
  for (const key of Object.keys(rec)) {
    if (!Object.prototype.hasOwnProperty.call(CONSTRAINTS_PROPERTIES, key)) {
      throw new CatalogToolInputError(
        `constraints: unknown field "${key}". Allowed: ${Object.keys(CONSTRAINTS_PROPERTIES).join(", ")}.`,
      );
    }
  }
  return {
    ...(supplied(rec, "outputType")
      ? { outputType: readEnumArray(rec["outputType"], OUTPUT_TYPES, "constraints.outputType") }
      : {}),
    ...(supplied(rec, "ioLink")
      ? { ioLink: readBoolean(rec["ioLink"], "constraints.ioLink") }
      : {}),
    ...(supplied(rec, "connector")
      ? { connector: readEnumArray(rec["connector"], CONNECTOR_TYPES, "constraints.connector") }
      : {}),
    ...(supplied(rec, "connectorPins")
      ? { connectorPins: readInteger(rec["connectorPins"], "constraints.connectorPins") }
      : {}),
    ...(supplied(rec, "minIpRating")
      ? { minIpRating: readInteger(rec["minIpRating"], "constraints.minIpRating") }
      : {}),
    ...(supplied(rec, "ip69k") ? { ip69k: readBoolean(rec["ip69k"], "constraints.ip69k") } : {}),
    ...(supplied(rec, "sensingRangeMm")
      ? {
          sensingRangeMm: readNumericConstraint(
            rec["sensingRangeMm"],
            "constraints.sensingRangeMm",
          ),
        }
      : {}),
    ...(supplied(rec, "responseTimeMs")
      ? {
          responseTimeMs: readNumericConstraint(
            rec["responseTimeMs"],
            "constraints.responseTimeMs",
          ),
        }
      : {}),
    ...(supplied(rec, "switchingFrequencyHz")
      ? {
          switchingFrequencyHz: readNumericConstraint(
            rec["switchingFrequencyHz"],
            "constraints.switchingFrequencyHz",
          ),
        }
      : {}),
    ...(supplied(rec, "supplyVoltageV")
      ? {
          supplyVoltageV: readNumericConstraint(
            rec["supplyVoltageV"],
            "constraints.supplyVoltageV",
          ),
        }
      : {}),
    ...(supplied(rec, "operatingTempC")
      ? {
          operatingTempC: readNumericConstraint(
            rec["operatingTempC"],
            "constraints.operatingTempC",
          ),
        }
      : {}),
    ...(supplied(rec, "principle")
      ? { principle: readEnumArray(rec["principle"], SENSING_PRINCIPLES, "constraints.principle") }
      : {}),
    ...(supplied(rec, "housing")
      ? { housing: readEnumArray(rec["housing"], HOUSINGS, "constraints.housing") }
      : {}),
    ...(supplied(rec, "light")
      ? { light: readEnumArray(rec["light"], LIGHTS, "constraints.light") }
      : {}),
    ...(supplied(rec, "section")
      ? { section: readStringArray(rec["section"], "constraints.section") }
      : {}),
    ...(supplied(rec, "rowType")
      ? { rowType: readEnumArray(rec["rowType"], ROW_TYPES, "constraints.rowType") }
      : {}),
    ...(supplied(rec, "family")
      ? { family: readStringArray(rec["family"], "constraints.family") }
      : {}),
  };
}

/**
 * A 7-digit SICK *Referencia*.
 *
 * Validated here rather than left to the lookup because the failure modes read
 * very differently to an agent: a malformed id is the agent's mistake to fix,
 * while a well-formed id that is absent is a fact about the catalog to report.
 */
function readOrderNumber(value: unknown, where: string): string {
  const s = readString(value, where);
  if (!/^\d{7}$/.test(s)) {
    throw new CatalogToolInputError(
      `${where}: "${s}" is not a SICK order number. Expected exactly 7 digits, e.g. "1058200".`,
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// Shape-tolerant readers over the retriever's return values
// ---------------------------------------------------------------------------

/** Structural test for a catalog row. Identity plus a citable page. */
function isSickProduct(value: unknown): value is SickProduct {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["orderNumber"] === "string" &&
    typeof r["sourcePage"] === "string" &&
    typeof r["pdfPage"] === "number"
  );
}

function isSickFamily(value: unknown): value is SickFamily {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r["family"] === "string" && typeof r["productVariants"] === "number";
}

/**
 * Pull the catalog row out of whatever `getProduct` returned.
 *
 * Accepts the bare row or any single-level wrapper around it. This tolerance is
 * not laziness: the tool result must cite a real page, and the only way to
 * guarantee that is to find the {@link SickProduct} and re-derive the citation
 * from it here, rather than forwarding a wrapper's citation field on trust.
 */
function extractProduct(value: unknown): SickProduct | undefined {
  if (isSickProduct(value)) return value;
  if (typeof value === "object" && value !== null) {
    const inner = (value as Record<string, unknown>)["product"];
    if (isSickProduct(inner)) return inner;
  }
  return undefined;
}

/** Same tolerance for the family lookup, which may group rows several ways. */
function extractProducts(value: unknown): SickProduct[] {
  if (Array.isArray(value)) return value.filter(isSickProduct);
  if (typeof value !== "object" || value === null) return [];
  const rec = value as Record<string, unknown>;
  const out: SickProduct[] = [];
  const seen = new Set<string>();
  for (const key of ["products", "variants", "accessories", "rows", "skus"]) {
    const list = rec[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isSickProduct(item) && !seen.has(item.orderNumber)) {
        seen.add(item.orderNumber);
        out.push(item);
      }
    }
  }
  return out;
}

/** The `families.csv` rollup row, when the retriever bundled one. */
function extractFamilyRow(value: unknown): SickFamily | undefined {
  if (isSickFamily(value)) return value;
  if (typeof value !== "object" || value === null) return undefined;
  const inner = (value as Record<string, unknown>)["family"];
  return isSickFamily(inner) ? inner : undefined;
}

/** Spread a stats payload without assuming it is an object. */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// Citations and spec reporting
// ---------------------------------------------------------------------------

/**
 * Build the citation for a SKU straight from its catalog row.
 *
 * Every tool result routes through this so a claim is always traceable to a
 * printed page code plus the 0-based PDF page a reviewer can actually open.
 */
export function citationFor(product: SickProduct): Citation {
  return {
    orderNumber: product.orderNumber,
    ...(product.typeCode !== undefined ? { typeCode: product.typeCode } : {}),
    ...(product.family !== undefined ? { family: product.family } : {}),
    sourcePage: product.sourcePage,
    pdfPage: product.pdfPage,
    ...(product.productUrl !== undefined ? { productUrl: product.productUrl } : {}),
  };
}

/** Fold a field name so `switching_output`, `switchingOutput` and `Switching Output` compare equal. */
function foldFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * How a single spec appears for one SKU.
 *
 * The point of this shape is the gap between `stated` and `catalogText`:
 *
 * - `stated: true` — the catalog prints a value we parsed into `value`. Usable
 *   as evidence.
 * - `stated: false`, `catalogText: null` — the page is **silent**. Not a
 *   failure, not a pass; unverifiable from this catalog.
 * - `stated: false`, `catalogText: "…"` — the page prints something the
 *   normalizer would not commit to parsing. Show the text, but treat it exactly
 *   like silence for any correctness decision.
 */
export interface SpecFieldReport {
  field: string;
  label: string;
  /** True only when a machine-comparable value was recovered. */
  stated: boolean;
  /** Normalized value, or `null` when the catalog does not state it. */
  value: string | number | boolean | null;
  /** Verbatim Spanish as printed, or `null`. This is what `provenance` cites. */
  catalogText: string | null;
  /** True when the backing catalog field came from prose rather than a table cell. */
  lowConfidence: boolean;
}

/** How a spec is recovered, which decides what "stated" means for it. */
type SpecFieldKind =
  /** Parsed into a machine value by `filter/normalize.ts`. */
  | "normalized"
  /** A predicate that the catalog can only ever assert, never deny (IO-Link, IP69K). */
  | "flag"
  /** Verbatim catalog prose kept as-is, with no normalized counterpart. */
  | "text";

interface SpecFieldDef {
  field: string;
  label: string;
  kind: SpecFieldKind;
  /** {@link SickProduct} fields backing this value, most specific first. */
  sources: readonly string[];
  value(spec: NormalizedSpec, product: SickProduct): string | number | boolean | undefined;
}

/**
 * The comparable spec surface of a SKU, in the order an engineer reads a
 * datasheet: what it senses, how far, how fast, what it outputs, how it mounts.
 *
 * Every field here is emitted for every SKU, present or not — that is the whole
 * point. A report that lists only populated fields makes "the catalog is silent
 * about response time" invisible, and invisible silence is indistinguishable
 * from a satisfied requirement.
 */
const SPEC_FIELDS: readonly SpecFieldDef[] = [
  {
    field: "principle",
    label: "Sensing principle",
    kind: "normalized",
    sources: ["sensorPrinciple", "detectionPrinciple"],
    value: (s) => s.principle,
  },
  {
    field: "sensingRangeMinMm",
    label: "Sensing range, minimum (mm)",
    kind: "normalized",
    sources: ["sensingRangeMinMm"],
    value: (s) => s.sensingRangeMinMm,
  },
  {
    field: "sensingRangeMaxMm",
    label: "Sensing range, maximum (mm)",
    kind: "normalized",
    sources: ["sensingRangeMaxMm"],
    value: (s) => s.sensingRangeMaxMm,
  },
  {
    field: "outputType",
    label: "Switching output type",
    kind: "normalized",
    sources: ["switchingOutput"],
    value: (s) => s.outputType,
  },
  {
    field: "outputCount",
    label: "Number of switching outputs",
    kind: "normalized",
    sources: ["switchingOutput"],
    value: (s) => s.outputCount,
  },
  {
    field: "ioLink",
    label: "IO-Link",
    kind: "flag",
    sources: ["switchingOutput", "interface"],
    value: (s) => s.ioLink,
  },
  {
    field: "outputCurrentMaxMa",
    label: "Max output current (mA)",
    kind: "normalized",
    sources: ["outputCurrentMaxMa", "switchingOutput"],
    value: (s) => s.outputCurrentMaxMa,
  },
  {
    field: "outputFunction",
    label: "Output function (light/dark operate)",
    kind: "text",
    sources: ["outputFunction"],
    value: (_s, p) => p.outputFunction,
  },
  {
    field: "responseTimeMs",
    label: "Response time (ms)",
    kind: "normalized",
    sources: ["responseTimeMs"],
    value: (s) => s.responseTimeMs,
  },
  {
    field: "switchingFrequencyHz",
    label: "Switching frequency (Hz)",
    kind: "normalized",
    sources: ["switchingFrequencyHz"],
    value: (s) => s.switchingFrequencyHz,
  },
  {
    field: "supplyVoltageMinV",
    label: "Supply voltage, minimum (V)",
    kind: "normalized",
    sources: ["supplyVoltageMinV"],
    value: (s) => s.supplyVoltageMinV,
  },
  {
    field: "supplyVoltageMaxV",
    label: "Supply voltage, maximum (V)",
    kind: "normalized",
    sources: ["supplyVoltageMaxV"],
    value: (s) => s.supplyVoltageMaxV,
  },
  {
    field: "connector",
    label: "Connection type",
    kind: "normalized",
    sources: ["connection"],
    value: (s) => s.connector,
  },
  {
    field: "connectorPins",
    label: "Connector pin count",
    kind: "normalized",
    sources: ["connection"],
    value: (s) => s.connectorPins,
  },
  {
    field: "ipRating",
    label: "IP enclosure rating",
    kind: "normalized",
    sources: ["enclosureRating"],
    value: (s) => s.ipRating,
  },
  {
    field: "ip69k",
    label: "IP69K washdown",
    kind: "flag",
    sources: ["enclosureRating"],
    value: (s) => s.ip69k,
  },
  {
    field: "operatingTempMinC",
    label: "Operating temperature, minimum (°C)",
    kind: "normalized",
    sources: ["operatingTempMinC"],
    value: (s) => s.operatingTempMinC,
  },
  {
    field: "operatingTempMaxC",
    label: "Operating temperature, maximum (°C)",
    kind: "normalized",
    sources: ["operatingTempMaxC"],
    value: (s) => s.operatingTempMaxC,
  },
  {
    field: "housing",
    label: "Housing material",
    kind: "normalized",
    sources: ["housingMaterial"],
    value: (s) => s.housing,
  },
  {
    field: "light",
    label: "Light source",
    kind: "normalized",
    sources: ["lightType"],
    value: (s) => s.light,
  },
  {
    field: "lightSpot",
    label: "Light spot",
    kind: "text",
    sources: ["lightSpot"],
    value: (_s, p) => p.lightSpot,
  },
  {
    field: "adjustment",
    label: "Adjustment",
    kind: "text",
    sources: ["adjustment"],
    value: (_s, p) => p.adjustment,
  },
  {
    field: "interface",
    label: "Interface",
    kind: "text",
    sources: ["interface"],
    value: (_s, p) => p.interface,
  },
  {
    field: "resolution",
    label: "Resolution",
    kind: "text",
    sources: ["resolutionValue", "resolutionUnit"],
    value: (_s, p) =>
      p.resolutionValue === undefined
        ? undefined
        : p.resolutionUnit === undefined
          ? p.resolutionValue
          : `${p.resolutionValue} ${p.resolutionUnit}`,
  },
  {
    field: "scopeOfDelivery",
    label: "Scope of delivery",
    kind: "text",
    sources: ["scopeOfDelivery"],
    value: (_s, p) => p.scopeOfDelivery,
  },
];

/**
 * The verbatim source substring for a field, preferring `provenance`.
 *
 * `provenance` is the exact string the extraction agent read off the page
 * (`"Grado de protección: IP 67"`), which is what a skeptical reviewer greps for
 * — strictly better evidence than the post-processed field value, so it wins.
 */
function verbatim(product: SickProduct, sources: readonly string[]): string | undefined {
  const record = product as unknown as Record<string, unknown>;
  for (const key of sources) {
    const p = product.provenance?.[key];
    if (typeof p === "string" && p.trim() !== "") return p.trim();
  }
  for (const key of sources) {
    const v = record[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * Whether the catalog fields behind a spec were flagged low-confidence.
 *
 * Both {@link SickProduct.lowConfidence} and {@link NormalizedSpec.lowConfidence}
 * are consulted, folded to a case- and separator-insensitive key, because
 * nothing in the contract pins down whether those lists carry source field names
 * or normalized ones. Guessing one spelling would silently drop every flag — a
 * failure no test of either module alone would catch.
 */
function isLowConfidence(product: SickProduct, spec: NormalizedSpec, def: SpecFieldDef): boolean {
  const flagged = new Set<string>();
  for (const name of product.lowConfidence ?? []) flagged.add(foldFieldName(name));
  for (const name of spec.lowConfidence) flagged.add(foldFieldName(name));
  if (flagged.size === 0) return false;
  if (flagged.has(foldFieldName(def.field))) return true;
  return def.sources.some((s) => flagged.has(foldFieldName(s)));
}

/** Project one SKU onto the full spec surface, silence included. */
export function describeSpecs(product: SickProduct, spec: NormalizedSpec): SpecFieldReport[] {
  return SPEC_FIELDS.map((def) => {
    const raw = def.value(spec, product);
    const text = verbatim(product, def.sources);
    // A flag can only ever be asserted, so its absence is silence, not denial —
    // and its catalog text is meaningless unless the flag is actually set.
    const stated = def.kind === "flag" ? raw === true : raw !== undefined;
    return {
      field: def.field,
      label: def.label,
      stated,
      value: raw === undefined ? null : raw,
      catalogText: def.kind === "flag" ? (stated ? (text ?? null) : null) : (text ?? null),
      lowConfidence: stated && isLowConfidence(product, spec, def),
    };
  });
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

/** Identity block repeated on every SKU-bearing result. */
function identityOf(product: SickProduct): Record<string, unknown> {
  return {
    orderNumber: product.orderNumber,
    typeCode: product.typeCode ?? null,
    family: product.family ?? null,
    subfamily: product.subfamily ?? null,
    rowType: product.rowType,
    category: product.category,
    section: product.section,
    productName: product.productName ?? null,
    citation: citationFor(product),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Which retrieval lanes actually produced a ranking.
 *
 * Derived from the hits' own `null` signals rather than from configuration, so
 * a lane that was configured but failed open (no API key, Voyage timeout) is
 * reported as `unavailable`. The agent is expected to state this limitation
 * out loud, and a fabricated "live" here would make it lie.
 */
function laneStatus(results: readonly RetrievalResult[]): Record<string, "live" | "unavailable"> {
  const live = (pick: (r: RetrievalResult) => number | null): "live" | "unavailable" =>
    results.some((r) => pick(r) !== null) ? "live" : "unavailable";
  return {
    lexicalBm25: live((r) => r.signals.bm25Rank),
    denseEmbedding: live((r) => r.signals.denseRank),
    crossEncoderRerank: live((r) => r.signals.rerankRank),
  };
}

/** The standing caveat attached to every ranked result payload. */
const RANKING_CAVEAT =
  "Ranking is a text-relevance heuristic over catalog card text. It is NOT evidence of technical equivalence. " +
  "Do not tell the user a part matches because it ranked highly — call solve_constraints and cite its verdicts.";

/** The standing caveat attached to every verdict-bearing payload. */
const UNKNOWN_CAVEAT =
  "An `unknown` verdict means the printed catalog is SILENT about that spec for that SKU — it is not a pass. " +
  "This is the summary (resumido) catalog: supply voltage is printed for 41 of 1,776 SKUs, response time for 96. " +
  "Report every unknown to the user as unverified rather than assuming it is satisfied.";

/** Shape one solver result for the wire, with the unverified specs called out. */
function solveResultPayload(result: SolveResult): Record<string, unknown> {
  const unverified = result.verdicts.filter((v) => v.status === "unknown").map((v) => v.field);
  return {
    ...identityOf(result.product),
    viable: result.viable,
    passed: result.passed,
    failed: result.failed,
    unknown: result.unknown,
    verdicts: result.verdicts.map((v) => ({
      field: v.field,
      status: v.status,
      detail: v.detail,
      lowConfidence: v.lowConfidence === true,
    })),
    unverifiedConstraints: unverified,
    evidenceSummary:
      result.failed > 0
        ? `Disqualified: the catalog states ${result.failed} value(s) that violate the requirements.`
        : unverified.length === 0
          ? `Every requested constraint was verified against the printed page (${result.passed} pass).`
          : `Nothing printed contradicts the requirements (${result.passed} verified), but ${unverified.length} constraint(s) could not be checked: ${unverified.join(", ")}.`,
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * Build the six Messages API tools over a retriever.
 *
 * Returned in the order the agent should reach for them: find candidates, look
 * one up, decide, compare, complete the solution, then state your own limits.
 * Tool order is weak but real prompt signal, and this order encodes the
 * workflow the architecture requires — `search_catalog` first, `solve_constraints`
 * before any equivalence claim.
 *
 * The retriever is injected rather than constructed here so this module stays
 * pure: no index loading, no filesystem, no network originates in the tool
 * layer, which is what makes every tool testable against a fixed catalog.
 */
export function createCatalogTools(retriever: CatalogRetrieverLike): CatalogTool[] {
  /** Resolve a SKU, distinguishing "not in the catalog" from a lookup failure. */
  const lookup = async (orderNumber: string): Promise<SickProduct | undefined> =>
    extractProduct(await retriever.getProduct(orderNumber));

  const searchCatalog: CatalogTool = {
    name: "search_catalog",
    description: [
      "Find candidate SICK parts from messy input: a competitor part number (Banner, Keyence, Pepperl+Fuchs, Balluff), a plain-language description of what the sensor has to do, text read off a label photo, or a BOM line.",
      "",
      "CALL THIS FIRST for any question about which SICK part to consider. It is the only tool that turns free text into a candidate set. Pass whatever the user gave you verbatim as `query` — the catalog cards are indexed bilingually (Spanish source plus English gloss and competitor-datasheet synonyms), so English queries and part numbers both work.",
      "",
      "Pass `constraints` whenever the user stated a hard requirement. Constraints are applied as a structured PREFILTER before anything is ranked, so 'PNP and IP69K and under 12 ms' actually narrows the candidate set instead of hoping the top hit happens to comply.",
      "",
      "CRITICAL — this tool finds candidates, it does NOT decide. Its ranking is a text-relevance heuristic and MUST NOT be used as evidence that a candidate is technically equivalent to the user's part. Never justify a recommendation with a rank or a score. Once you have candidates, call solve_constraints (or get_product for one SKU) and cite those verdicts instead.",
      "",
      "Each hit reports per-lane signals; a lane that did not run reports null rather than a made-up rank. Every hit carries a citation to the printed catalog page.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The user's words, a competitor part number, or a description of the sensing job. Do not pre-translate to Spanish.",
        },
        topK: {
          type: "integer",
          description: "How many candidates to return. Default 10, max 50.",
          minimum: 1,
          maximum: 50,
        },
        constraints: CONSTRAINTS_SCHEMA,
        noDense: {
          type: "boolean",
          description: "Skip the dense embedding lane and run lexical-only. Diagnostics only.",
        },
        noRerank: {
          type: "boolean",
          description: "Skip the cross-encoder rerank pass. Diagnostics only.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input) {
      const rec = requireRecord(input, "search_catalog input");
      const query = readString(rec["query"], "query");
      const topK = readBoundedInt(rec["topK"], "topK", 1, 50, 10);
      const constraints = supplied(rec, "constraints")
        ? readConstraints(rec["constraints"])
        : undefined;
      const opts: SearchOptions = {
        topK,
        ...(constraints !== undefined ? { constraints } : {}),
        ...(supplied(rec, "noDense") && readBoolean(rec["noDense"], "noDense")
          ? { noDense: true }
          : {}),
        ...(supplied(rec, "noRerank") && readBoolean(rec["noRerank"], "noRerank")
          ? { noRerank: true }
          : {}),
      };
      const results = await retriever.search(query, opts);
      return {
        query,
        // Echoed so the agent can see exactly what was enforced, and notice when
        // it enforced nothing.
        constraintsApplied: constraints ?? null,
        returned: results.length,
        lanes: laneStatus(results),
        candidates: results.map((hit, i) => ({
          rank: i,
          chunkKind: hit.chunk.kind,
          ...(hit.product !== undefined
            ? identityOf(hit.product)
            : {
                orderNumber: hit.chunk.orderNumber ?? null,
                family: hit.chunk.family ?? null,
                section: hit.chunk.section,
                category: hit.chunk.category,
                citation: hit.citation,
              }),
          snippet: truncate(hit.chunk.text, 600),
          signals: hit.signals,
        })),
        ranking: RANKING_CAVEAT,
      };
    },
  };

  const getProduct: CatalogTool = {
    name: "get_product",
    description: [
      "Get the complete catalog record for ONE SICK part by its 7-digit order number (SICK 'Referencia'), with its normalized machine-comparable spec, the verbatim Spanish source text for every field, and a citation.",
      "",
      "Call this after search_catalog to inspect a specific candidate, whenever the user names a SICK order number directly, and before quoting any individual spec value to the user.",
      "",
      "Read `specs` carefully. Every spec field is returned whether or not the catalog prints it. `stated: false` means the printed page is SILENT about that spec — report it as 'the catalog does not state this' and never as a zero, a default, or a satisfied requirement. `notStated` lists those fields directly. `lowConfidence: true` marks a value read from prose or a bullet rather than a labelled table cell: usable, but say so.",
      "",
      "Returns `found: false` (not an error) when the order number is well-formed but absent from this catalog. That is a fact to report, not a reason to retry.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        orderNumber: {
          type: "string",
          description: 'The 7-digit SICK order number / Referencia, e.g. "1058200".',
        },
      },
      required: ["orderNumber"],
      additionalProperties: false,
    },
    async run(input) {
      const rec = requireRecord(input, "get_product input");
      const orderNumber = readOrderNumber(rec["orderNumber"], "orderNumber");
      const product = await lookup(orderNumber);
      if (product === undefined) {
        return {
          found: false,
          orderNumber,
          message: `Order number ${orderNumber} is not in the SICK 2015/2016 summary catalog. It may be a valid SICK part that this catalog edition does not list — say that rather than substituting a different part.`,
        };
      }
      const spec = normalizeSpec(product);
      const specs = describeSpecs(product, spec);
      return {
        found: true,
        ...identityOf(product),
        productUrl: product.productUrl ?? null,
        shortDescription: product.shortDescription ?? null,
        occurrences: product.occurrences,
        alsoOnPages: product.alsoOnPages,
        normalizedSpec: spec,
        specs,
        notStated: specs.filter((s) => !s.stated).map((s) => s.field),
        lowConfidenceFields: specs.filter((s) => s.lowConfidence).map((s) => s.field),
        // Extra labelled specs the extraction did not map to a named field, kept
        // verbatim: dropping them would hide real printed information.
        otherSpecs: product.otherSpecs ?? {},
        provenance: product.provenance ?? {},
        note: "`stated: false` means the catalog page does not print this spec. It is unverifiable from this source, not a zero and not a pass.",
      };
    },
  };

  const solveConstraints: CatalogTool = {
    name: "solve_constraints",
    description: [
      "THE TOOL THAT DECIDES. Runs the deterministic constraint solve over the whole catalog and returns, for every candidate, a per-constraint pass / fail / unknown verdict with the reason.",
      "",
      "Call this before you claim ANY part is equivalent to, or a replacement for, anything. search_catalog ranks by text similarity and cannot establish equivalence; only these verdicts can. Every verdict is re-derivable by hand from the spec table on the cited page, which is exactly why it is trustworthy and a similarity score is not.",
      "",
      "Verdict semantics, and the one that matters most:",
      "- pass — the catalog states a value and it satisfies the constraint.",
      "- fail — the catalog states a value and it violates the constraint. Only a fail ever disqualifies a part.",
      "- unknown — the catalog is SILENT about that spec for that SKU. This is NOT a pass. It means you cannot verify the requirement from this source, and you must tell the user which specs are unverified before recommending anything.",
      "",
      "`viable: true` only means nothing printed contradicts the requirements. It does NOT mean verified. Always report the `unknown` count alongside it; `unverifiedConstraints` names them. Results are ranked by strength of evidence (fewest unknowns, then most passes), never by relevance.",
      "",
      "Give the solver every requirement the user stated. Convert units first: 40 cm is sensingRangeMm { min: 400 }; 'faster than 12 ms' is responseTimeMs { max: 12 }.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        constraints: CONSTRAINTS_SCHEMA,
        topK: {
          type: "integer",
          description:
            "How many ranked candidates to return. Default 20, max 100. Totals are always reported in full.",
          minimum: 1,
          maximum: 100,
        },
        viableOnly: {
          type: "boolean",
          description:
            "Return only candidates with zero verified violations. Default true. Set false to see why parts were disqualified.",
        },
      },
      required: ["constraints"],
      additionalProperties: false,
    },
    async run(input) {
      const rec = requireRecord(input, "solve_constraints input");
      const constraints = readConstraints(rec["constraints"]);
      if (Object.keys(constraints).length === 0) {
        throw new CatalogToolInputError(
          "solve_constraints needs at least one constraint. With none, every SKU is trivially viable and the result is meaningless — use search_catalog for open-ended exploration.",
        );
      }
      const topK = readBoundedInt(rec["topK"], "topK", 1, 100, 20);
      const viableOnly = supplied(rec, "viableOnly")
        ? readBoolean(rec["viableOnly"], "viableOnly")
        : true;

      const all = await retriever.solveConstraints(constraints);
      const viable = all.filter((r) => r.viable);
      const pool = viableOnly ? viable : all;
      const shown = pool.slice(0, topK);
      const fullyVerified = viable.filter((r) => r.unknown === 0).length;

      return {
        constraints,
        evaluated: all.length,
        viableCount: viable.length,
        disqualifiedCount: all.length - viable.length,
        fullyVerifiedCount: fullyVerified,
        returned: shown.length,
        results: shown.map(solveResultPayload),
        summary:
          viable.length === 0
            ? "No SKU in this catalog survives the stated constraints. Say so plainly and offer to relax a specific constraint — do not fall back to the best-ranked search hit."
            : fullyVerified === 0
              ? `${viable.length} SKU(s) are not contradicted by the catalog, but NONE has every requested spec printed. Any recommendation here rests on unverified specs — name them.`
              : `${fullyVerified} of ${viable.length} viable SKU(s) have every requested constraint verified against the printed page.`,
        verdictSemantics: UNKNOWN_CAVEAT,
      };
    },
  };

  const compareProducts: CatalogTool = {
    name: "compare_products",
    description: [
      "Compare 2 to 5 SICK parts field by field. For every spec it reports each part's value AND whether the catalog states that spec at all, so you can see where a comparison is genuinely impossible.",
      "",
      "Call this when the user asks how two parts differ, when you are choosing between shortlisted candidates from search_catalog, or when you need to justify preferring one variant over its siblings.",
      "",
      "Read `comparable` on each field before saying anything about it. `comparable: false` means at least one part does not print that spec, so the parts CANNOT be compared on it — `notStatedFor` names which ones. Saying two parts 'match' on a field the catalog never printed for one of them is the exact failure this tool exists to prevent. `identical` is null in that case, never true.",
      "",
      "Every part carries its own citation, so each value can be checked on its own catalog page.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        orderNumbers: {
          type: "array",
          description: "2 to 5 seven-digit SICK order numbers to compare.",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5,
        },
        differencesOnly: {
          type: "boolean",
          description:
            "Return only fields where the parts differ or where the catalog is silent for some of them. Default false.",
        },
      },
      required: ["orderNumbers"],
      additionalProperties: false,
    },
    async run(input) {
      const rec = requireRecord(input, "compare_products input");
      const raw = readStringArray(rec["orderNumbers"], "orderNumbers");
      if (raw.length < 2 || raw.length > 5) {
        throw new CatalogToolInputError(
          `compare_products needs 2 to 5 order numbers; got ${raw.length}. Use get_product for a single part.`,
        );
      }
      const ids = raw.map((v, i) => readOrderNumber(v, `orderNumbers[${i}]`));
      const unique = [...new Set(ids)];
      if (unique.length !== ids.length) {
        throw new CatalogToolInputError(
          `compare_products needs distinct order numbers; got duplicates in ${ids.join(", ")}.`,
        );
      }
      const differencesOnly = supplied(rec, "differencesOnly")
        ? readBoolean(rec["differencesOnly"], "differencesOnly")
        : false;

      const found: { product: SickProduct; reports: SpecFieldReport[] }[] = [];
      const missing: string[] = [];
      for (const id of unique) {
        const product = await lookup(id);
        if (product === undefined) {
          missing.push(id);
          continue;
        }
        found.push({ product, reports: describeSpecs(product, normalizeSpec(product)) });
      }
      if (found.length < 2) {
        return {
          compared: found.map((f) => f.product.orderNumber),
          notInCatalog: missing,
          fields: [],
          message: `Only ${found.length} of ${unique.length} order numbers are in this catalog (missing: ${missing.join(", ") || "none"}). A comparison needs at least 2.`,
        };
      }

      const fields = SPEC_FIELDS.map((def, i) => {
        const cells = found.map((f) => {
          const report = f.reports[i];
          return {
            orderNumber: f.product.orderNumber,
            stated: report?.stated ?? false,
            value: report?.value ?? null,
            catalogText: report?.catalogText ?? null,
            lowConfidence: report?.lowConfidence ?? false,
          };
        });
        const statedCells = cells.filter((c) => c.stated);
        const comparable = statedCells.length === cells.length;
        const distinct = new Set(statedCells.map((c) => JSON.stringify(c.value)));
        return {
          field: def.field,
          label: def.label,
          comparable,
          // `identical` is null, never true, when the catalog is silent for any
          // part: an unstated spec is not agreement.
          identical: comparable ? distinct.size === 1 : null,
          notStatedFor: cells.filter((c) => !c.stated).map((c) => c.orderNumber),
          values: cells,
        };
      }).filter((f) => (differencesOnly ? !f.comparable || f.identical === false : true));

      return {
        compared: found.map((f) => f.product.orderNumber),
        notInCatalog: missing,
        products: found.map((f) => identityOf(f.product)),
        fields,
        fullyComparableFields: fields.filter((f) => f.comparable).length,
        note: "`comparable: false` means at least one part does not print that spec, so the parts cannot be compared on it. `identical` is null there — not a match.",
      };
    },
  };

  const listFamily: CatalogTool = {
    name: "list_family",
    description: [
      "List every row the catalog prints for one SICK product family: all sensor variants AND all accessories (brackets, cables, connectors, reflectors), each with its own citation.",
      "",
      "Call this for 'what else do I need' questions — a retroreflective sensor needs a reflector, a cabled variant needs the right connector, a sensor needs a mounting bracket — and whenever you have picked a family but not yet the exact variant. The variants differ mostly in output type, connection and range, and this is the fastest way to see the whole option grid.",
      "",
      "Accessories are listed exactly as printed; the catalog does not always say which variant each accessory fits, so do not assert compatibility beyond what the page states. A shared accessory appears on several pages — `alsoOnPages` records the others.",
      "",
      "Family names are case-sensitive catalog headings such as 'W4-3', 'G6', 'DFS60'. Get one from a search_catalog hit or a get_product record rather than guessing.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        family: {
          type: "string",
          description: 'The catalog family heading, e.g. "W4-3", "G6", "DFS60".',
        },
        includeAccessories: {
          type: "boolean",
          description: "Include accessory rows. Default true — usually the point of the call.",
        },
      },
      required: ["family"],
      additionalProperties: false,
    },
    async run(input) {
      const rec = requireRecord(input, "list_family input");
      const family = readString(rec["family"], "family");
      const includeAccessories = supplied(rec, "includeAccessories")
        ? readBoolean(rec["includeAccessories"], "includeAccessories")
        : true;

      const raw = await retriever.getFamily(family);
      const rows = extractProducts(raw);
      const familyRow = extractFamilyRow(raw);
      if (rows.length === 0) {
        return {
          found: false,
          family,
          message: `No family named "${family}" in this catalog. Family headings are case-sensitive; take one from a search_catalog hit or a get_product record rather than guessing.`,
        };
      }

      const describe = (p: SickProduct): Record<string, unknown> => {
        const specs = describeSpecs(p, normalizeSpec(p));
        return {
          ...identityOf(p),
          shortDescription: p.shortDescription ?? null,
          occurrences: p.occurrences,
          alsoOnPages: p.alsoOnPages,
          // The variant-distinguishing axes, which is what the option grid is for.
          keySpecs: specs.filter((s) =>
            [
              "outputType",
              "connector",
              "connectorPins",
              "sensingRangeMaxMm",
              "ipRating",
              "light",
              "principle",
            ].includes(s.field),
          ),
          notStated: specs.filter((s) => !s.stated).map((s) => s.field),
        };
      };

      const variants = rows.filter((p) => p.rowType === "product");
      const accessories = rows.filter((p) => p.rowType === "accessory");
      const pages = [...new Set(rows.map((p) => p.sourcePage))].sort();

      return {
        found: true,
        family,
        section: rows[0]?.section ?? null,
        category: rows[0]?.category ?? null,
        productUrl:
          familyRow?.productUrl ?? rows.find((p) => p.productUrl !== undefined)?.productUrl ?? null,
        pages,
        variantCount: variants.length,
        accessoryCount: accessories.length,
        variants: variants.map(describe),
        accessories: includeAccessories ? accessories.map(describe) : [],
        note: "Accessory rows are transcribed as printed. The catalog does not always state which variant an accessory fits, so do not assert compatibility beyond the page.",
      };
    },
  };

  const indexStats: CatalogTool = {
    name: "index_stats",
    description: [
      "Report what the loaded catalog index actually contains and which retrieval lanes are live right now.",
      "",
      "Call this when the user asks what you can see, how current or complete your data is, why a part you would expect is missing, or when you need to state the limits of an answer honestly. Also call it before concluding 'this part does not exist' — the right claim is 'it is not in this catalog edition', which this tool lets you say precisely.",
      "",
      "The dense embedding and cross-encoder rerank lanes are optional and fail open. When they are unavailable the system still works on lexical search plus the deterministic solver, but recall on paraphrased descriptions is lower — say so rather than presenting a degraded search as complete.",
      "",
      "This is the SICK 2015/2016 summary catalog (catálogo resumido). It lists ordering options, not full electrical datasheets, so most SKUs genuinely do not print supply voltage, current or temperature. That is faithful to the source, not a data gap.",
    ].join("\n"),
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run() {
      const stats = toRecord(await retriever.stats());
      return {
        ...stats,
        source: {
          catalog:
            "SICK Catálogo resumido — Selección de productos para la automatización industrial (2015/2016)",
          document: "8014481",
          pdf: "CATALOGO-PRODUCTOS-SICK.pdf",
          language: "Spanish, with deterministic English glosses in the index cards",
          orderNumberCoverage:
            "100% of the 7-digit order numbers printed on the 192 parsed product pages",
        },
        limits: [
          "Summary catalog: selection tables list ordering options (output, connection, range) and usually omit full electrical specs. Supply voltage is printed for 41 of 1,776 SKUs, response time for 96, operating temperature for 109.",
          "A spec absent from the page is unknown, never a failure. Never present an unverified spec as confirmed.",
          "Search ranking is a relevance heuristic; only solve_constraints establishes whether a part meets a requirement.",
          "Modular families configured through a type-code builder expose fixed order numbers only for their accessories here.",
          "Absence from this index means absence from this catalog edition — not that the part does not exist.",
        ],
      };
    },
  };

  return [searchCatalog, getProduct, solveConstraints, compareProducts, listFamily, indexStats].map(
    enforceSchema,
  );
}

/**
 * Make each tool's runtime honour the schema it advertises.
 *
 * `additionalProperties: false` and `required` are declarations to the model,
 * but nothing enforces them locally — a `tool_use` block with `top_k` instead of
 * `topK` would otherwise sail through and quietly return the default. Applied
 * as a wrapper rather than repeated inside each `run` so the check is derived
 * from {@link CatalogTool.input_schema} itself and cannot drift from it.
 *
 * A missing optional-but-`null` value is treated as absent, matching
 * {@link supplied}: models routinely send `null` for "I have no value for this".
 */
function enforceSchema(tool: CatalogTool): CatalogTool {
  const allowed = new Set(Object.keys(tool.input_schema.properties));
  const inner = tool.run.bind(tool);
  return {
    ...tool,
    async run(input: unknown): Promise<unknown> {
      const rec = requireRecord(input ?? {}, `${tool.name} input`);
      for (const key of Object.keys(rec)) {
        if (!allowed.has(key)) {
          throw new CatalogToolInputError(
            `${tool.name}: unknown parameter "${key}". Allowed: ${[...allowed].join(", ") || "(none)"}.`,
          );
        }
      }
      for (const key of tool.input_schema.required) {
        if (!supplied(rec, key)) throw new CatalogToolInputError(`${tool.name} requires "${key}".`);
      }
      return inner(rec);
    },
  };
}
