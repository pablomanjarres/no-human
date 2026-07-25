/**
 * Deterministic competitor lookup — the module that keeps the Resolver honest.
 *
 * For a competitor part we actually hold extracted data on, the specs must be
 * **looked up and cited**, never recalled by a model. A hallucinated SICK order
 * number gets caught downstream: the solver only ever scores real catalog rows,
 * and the Challenger re-checks every claim against the spec table. A
 * hallucinated *Banner* spec gets caught by nothing at all — it silently becomes
 * the left-hand column of the comparison, and every verdict derived from it is
 * wrong in a way no citation can reveal. That asymmetry is the entire reason
 * this file exists and is 100 % file-driven.
 *
 * Three artifacts back it:
 *
 * - `banner-catalog-dataset/banner_products.jsonl` — 62 Banner products
 *   (a *series* is a product here; Banner's guide is a selection guide of
 *   modular families, not a per-SKU order list).
 * - `banner-to-sick-equivalence/banner_to_sick_crossref.csv` — the precomputed
 *   (Banner product × sensing mode) → SICK recommendation.
 * - `banner-to-sick-equivalence/equivalence_gaps.csv` — the (Banner product ×
 *   mode) rows where the SICK summary catalog has no adequate answer.
 *
 * The crossref is **prior work, not an answer**. It is a hint the orchestrator
 * may use to sanity-check its own run — it never short-circuits retrieval or
 * the solve. Its rows were themselves LLM-adjudicated over a deterministic
 * shortlist, so they carry exactly as much authority as their `confidence`
 * column claims and no more.
 *
 * ## What this module refuses to do
 *
 * It will not invent a spec. Banner's guide leaves most per-mode ranges blank
 * for prose-described products, so {@link toConstraints} emits *fewer*
 * constraints than you might expect. A null range becoming `sensingRangeMm:
 * { min: 0 }` would make every SICK sensor on earth "pass" a constraint that was
 * never stated — an unknown laundered into a pass, which is the most damaging
 * bug available in this codebase.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Citation, NormalizedSpec, SensingPrinciple, SpecConstraints } from "@no-human/rag";

import type { IdentifiedPart } from "./types.js";

// ---------------------------------------------------------------------------
// Dataset paths
// ---------------------------------------------------------------------------

/** Repo-relative path of the Banner product records. */
const BANNER_PRODUCTS_REL = path.join("banner-catalog-dataset", "banner_products.jsonl");
/** Repo-relative path of the precomputed Banner→SICK crossref. */
const CROSSREF_REL = path.join("banner-to-sick-equivalence", "banner_to_sick_crossref.csv");
/** Repo-relative path of the known-gap rows. */
const GAPS_REL = path.join("banner-to-sick-equivalence", "equivalence_gaps.csv");

// ---------------------------------------------------------------------------
// Competitor records
// ---------------------------------------------------------------------------

/**
 * Banner's sensing-mode taxonomy, verbatim from the dataset.
 *
 * Kept as its own union rather than folded into {@link SensingPrinciple}
 * because the two vocabularies genuinely differ: Banner distinguishes
 * `convergent` from `fixed_field`, SICK collapses both onto
 * `background-suppression`, and `fiber_optic` has no SICK counterpart in the
 * summary catalog at all. Translating too early would erase that.
 */
export type BannerSensingModeName =
  | "opposed"
  | "retroreflective"
  | "diffuse"
  | "convergent"
  | "fixed_field"
  | "fiber_optic"
  | "ultrasonic";

/**
 * Banner mode → SICK {@link SensingPrinciple}.
 *
 * `fiber_optic` maps to `null` **on purpose**: SICK's summary catalog carries no
 * fiber-optic amplifier family, so every fiber row in the crossref is a gap.
 * Mapping it to something adjacent (`diffuse`, say) would manufacture a
 * plausible-looking recommendation for a product line we cannot replace — the
 * exact confident-wrong-answer failure this layer exists to prevent.
 */
export const BANNER_MODE_TO_PRINCIPLE: Readonly<
  Record<BannerSensingModeName, SensingPrinciple | null>
> = {
  opposed: "through-beam",
  retroreflective: "retroreflective",
  diffuse: "diffuse",
  convergent: "background-suppression",
  fixed_field: "background-suppression",
  ultrasonic: "ultrasonic",
  fiber_optic: null,
};

/** One (mode, variant, range) row of a Banner product's sensing profile. */
export interface BannerSensingMode {
  /** Verbatim Banner mode token. Typed as `string` because the dataset is the
   *  authority — an unrecognized token must survive to the trace, not throw. */
  mode: string;
  /** Sub-variant, e.g. `polarized`, `long range`. */
  variant?: string;
  /** Best-case reach for this mode, in mm. Absent when the guide printed prose
   *  instead of a number — absent, never zero. */
  rangeMaxMm?: number;
  focusMm?: number;
  material?: string;
}

/** A switching/analog output option offered by the series. */
export interface BannerOutput {
  type: string;
  detail?: string;
  currentMa?: number;
}

/** An electrical connection option offered by the series. */
export interface BannerConnection {
  type: string;
  detail?: string;
}

/**
 * One Banner product, camelCase mirror of a `banner_products.jsonl` row.
 *
 * Field presence is faithful to the source: a spec the guide never printed is
 * `undefined` here, never defaulted. `provenance` holds the verbatim source
 * substring per field and `lowConfidence` names the fields read from prose or
 * footnotes rather than a spec cell — both are carried through so the agent can
 * say *how well* it knows the left-hand column of a comparison.
 */
export interface BannerProduct {
  vendor: string;
  /** Product series, e.g. `MINI-BEAM`. Absent for a few unnamed accessories. */
  series?: string;
  /** Specific model, e.g. `SME312LPC`. Most rows are series-level only. */
  model?: string;
  productCategory: string;
  productSubtype?: string;
  description?: string;
  /** 1-based page in `BannerProductos.pdf` this record was extracted from. */
  sourcePage: number;
  /** Every page the product appears on, 1-based. */
  sourcePages: number[];
  sensingModes: BannerSensingMode[];
  outputs: BannerOutput[];
  connections: BannerConnection[];
  features: string[];
  housingMaterial?: string;
  /** Raw rating text, e.g. `IP67; NEMA 6P`. Both scales, exactly as printed. */
  enclosureRating?: string;
  operatingTempMinC?: number;
  operatingTempMaxC?: number;
  supplyVoltageDcMinV?: number;
  supplyVoltageDcMaxV?: number;
  supplyVoltageAcRaw?: string;
  dimensionsMm?: string;
  otherSpecs: Record<string, string>;
  provenance: Record<string, string>;
  /** Fields read from prose/footnotes. Anything named here is a spec to
   *  double-check before quoting, not one to assert. */
  lowConfidence: string[];
}

/**
 * How precisely a lookup landed.
 *
 * The caller **must** surface this. `model` means the user's part number is a
 * model we hold a record for. `series` means we matched the family, so the
 * specs are the family's envelope and the user's specific variant may be
 * narrower. `series-prefix` means we matched only the leading family token of a
 * longer order code — the suffix (output type, connector, range variant) was
 * *not* understood, and treating those specs as the user's is a guess.
 */
export type CompetitorMatchKind = "model" | "series" | "series-prefix";

/** A competitor part resolved out of the dataset, with its precision stated. */
export interface CompetitorMatch {
  /** The record chosen — the most fully specified of the candidates that hit. */
  product: BannerProduct;
  kind: CompetitorMatchKind;
  /** The normalized key that matched, e.g. `MINIBEAM`. */
  matchedKey: string;
  /** The part number exactly as the caller passed it, for `rawInput`. */
  query: string;
  /**
   * Other records that matched the same key, richest first. Non-empty means the
   * dataset holds several rows under this identifier (a series card plus a
   * "new products" teaser, say) and the caller may want to mention it.
   */
  alternatives: BannerProduct[];
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

/** The adjudicator's own confidence in a crossref row. */
export type CrossRefConfidence = "high" | "medium" | "low";

/** Values {@link CrossRefConfidence} accepts, for parsing the CSV column. */
const CROSSREF_CONFIDENCE: readonly CrossRefConfidence[] = ["high", "medium", "low"];

/**
 * One precomputed (Banner product × sensing mode) → SICK judgement.
 *
 * `adequate === false` is not an error row; it is the honest-gap signal. Rows
 * with `source === "deterministic"` never reached an adjudicator at all — the
 * shortlist was empty, which is the strongest possible "no equivalent".
 */
export interface CrossRefRow {
  bannerSeries?: string;
  bannerModel?: string;
  /** Banner mode token; occasionally carries a parenthesized variant,
   *  e.g. `diffuse (long range)`. */
  bannerMode: string;
  bannerRangeMaxMm?: number;
  sickTypeCode?: string;
  sickOrderNumber?: string;
  sickFamily?: string;
  /** Whether the recommended SICK part actually covers the Banner spec. */
  adequate: boolean;
  /** Absent on `deterministic` rows — there was nothing to be confident about. */
  confidence?: CrossRefConfidence;
  rationale: string;
  /** `judge` — an LLM picked from a real deterministic shortlist.
   *  `deterministic` — the shortlist was empty, no model was involved. */
  source: string;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/**
 * Loaded competitor data, queried by part number.
 *
 * Every method is synchronous and pure over data read once at load time: the
 * Resolver can call it inside a tool handler without an await, and two calls
 * with the same argument always return the same thing. Nothing here consults a
 * model.
 */
export interface CompetitorIndex {
  /**
   * Resolve a competitor part number to a record, or `undefined` when we simply
   * do not hold it.
   *
   * `undefined` is the correct, useful answer for an unknown part — it tells the
   * Resolver to fall back to `specSource: "inferred" | "unknown"` and say so.
   * A fuzzy "closest series" guess here would be indistinguishable from real
   * data three layers downstream.
   */
  lookup(partNumber: string): CompetitorMatch | undefined;
  /** Precomputed crossref rows naming this series or model, in file order. */
  priorRecommendation(seriesOrModel: string): CrossRefRow[];
  /**
   * True when *any* (product × mode) row for this identifier was flagged as an
   * honest gap. Pass `mode` to ask about one sensing mode — a modular series is
   * usually replaceable in four modes and a gap in the fifth, so the unfiltered
   * answer is a prompt to check per mode, not a verdict on the whole family.
   */
  knownGap(seriesOrModel: string, mode?: string): boolean;
  /** Distinct vendors held, sorted. Today: `["Banner"]`. */
  vendors(): string[];
  /** Number of competitor products held. */
  size(): number;
  /** Every product, in file order — for enumeration and diagnostics. */
  products(): BannerProduct[];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Collapse a part number to a comparison key: uppercase, then drop everything
 * that is not `A–Z0–9`.
 *
 * Nameplates, BOMs, quotes and humans all disagree about hyphens, spaces, dots
 * and registered-trademark glyphs, so `QS18VN6LV`, `qs18-vn6lv` and
 * `QS18 VN6LV` must be one key. The cost is real and worth naming: `QM(T)42`
 * and `QMT42` are two distinct Banner records that collapse to the same key.
 * {@link CompetitorMatch.alternatives} is how that collision reaches the caller
 * instead of being silently resolved.
 */
export function normalizePartKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * Canonicalize a Banner sensing-mode token so `"Fixed Field"`, `"fixed-field"`
 * and `"fixed_field"` all select the same rows. Any parenthesized variant
 * (`diffuse (long range)`) is dropped — that suffix qualifies the row, it does
 * not name a different mode.
 */
export function normalizeModeToken(value: string): string {
  const base = value.split("(")[0] ?? value;
  return base
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Banner mode → SICK principle, or `undefined` when there is no honest map. */
export function bannerModeToPrinciple(mode: string): SensingPrinciple | undefined {
  const key = normalizeModeToken(mode);
  const mapped = (BANNER_MODE_TO_PRINCIPLE as Record<string, SensingPrinciple | null | undefined>)[
    key
  ];
  return mapped ?? undefined;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Minimal RFC 4180 reader: quoted fields, embedded commas, `""` escapes, CRLF.
 *
 * Hand-rolled because the crossref's `rationale` column is prose full of commas
 * and a `split(",")` would shear it mid-sentence — and a sheared rationale is a
 * *plausible* rationale, so nothing downstream would notice. No dependency is
 * warranted for 40 lines.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Zip a parsed CSV against its header row. Missing trailing cells read `""`. */
function csvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return [];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    if (cells === undefined) continue;
    if (cells.length === 1 && cells[0] === "") continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      const key = header[c];
      if (key === undefined) continue;
      record[key] = cells[c] ?? "";
    }
    out.push(record);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSONL → BannerProduct
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Non-empty string, or `undefined`. Blank and `null` both mean "not stated". */
function readString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Finite number, or `undefined`. `null` means "not printed", never `0`. */
function readNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  return Array.isArray(value) ? value : [];
}

function readStringArray(row: Record<string, unknown>, key: string): string[] {
  return readArray(row, key).filter((v): v is string => typeof v === "string");
}

function readStringMap(row: Record<string, unknown>, key: string): Record<string, string> {
  const nested = asRecord(row[key]);
  if (nested === undefined) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(nested)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number") out[k] = String(v);
  }
  return out;
}

function toSensingMode(value: unknown): BannerSensingMode | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const mode = readString(row, "mode");
  if (mode === undefined) return undefined;
  return {
    mode,
    ...conditional("variant", readString(row, "variant")),
    ...conditional("rangeMaxMm", readNumber(row, "range_max_mm")),
    ...conditional("focusMm", readNumber(row, "focus_mm")),
    ...conditional("material", readString(row, "material")),
  };
}

/**
 * Build `{ key: value }` when `value` is stated, `{}` when it is not.
 *
 * `exactOptionalPropertyTypes` makes `{ variant: undefined }` a type error, and
 * for good reason: a present-but-undefined property reads as "we looked and
 * found nothing", which is a different claim from "the field is absent".
 */
function conditional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function toBannerProduct(value: unknown): BannerProduct | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const vendor = readString(row, "vendor");
  const productCategory = readString(row, "product_category");
  const sourcePage = readNumber(row, "source_page");
  if (vendor === undefined || productCategory === undefined || sourcePage === undefined) {
    return undefined;
  }

  const sensingModes = readArray(row, "sensing_modes")
    .map(toSensingMode)
    .filter((m): m is BannerSensingMode => m !== undefined);

  const outputs = readArray(row, "outputs")
    .map((raw): BannerOutput | undefined => {
      const o = asRecord(raw);
      if (o === undefined) return undefined;
      const type = readString(o, "type");
      if (type === undefined) return undefined;
      return {
        type,
        ...conditional("detail", readString(o, "detail")),
        ...conditional("currentMa", readNumber(o, "current_ma")),
      };
    })
    .filter((o): o is BannerOutput => o !== undefined);

  const connections = readArray(row, "connections")
    .map((raw): BannerConnection | undefined => {
      const c = asRecord(raw);
      if (c === undefined) return undefined;
      const type = readString(c, "type");
      if (type === undefined) return undefined;
      return { type, ...conditional("detail", readString(c, "detail")) };
    })
    .filter((c): c is BannerConnection => c !== undefined);

  const sourcePages = readArray(row, "source_pages").filter(
    (p): p is number => typeof p === "number" && Number.isFinite(p),
  );

  return {
    vendor,
    ...conditional("series", readString(row, "series")),
    ...conditional("model", readString(row, "model")),
    productCategory,
    ...conditional("productSubtype", readString(row, "product_subtype")),
    ...conditional("description", readString(row, "description")),
    sourcePage,
    sourcePages: sourcePages.length > 0 ? sourcePages : [sourcePage],
    sensingModes,
    outputs,
    connections,
    features: readStringArray(row, "features"),
    ...conditional("housingMaterial", readString(row, "housing_material")),
    ...conditional("enclosureRating", readString(row, "enclosure_rating")),
    ...conditional("operatingTempMinC", readNumber(row, "operating_temp_min_c")),
    ...conditional("operatingTempMaxC", readNumber(row, "operating_temp_max_c")),
    ...conditional("supplyVoltageDcMinV", readNumber(row, "supply_voltage_dc_min_v")),
    ...conditional("supplyVoltageDcMaxV", readNumber(row, "supply_voltage_dc_max_v")),
    ...conditional("supplyVoltageAcRaw", readString(row, "supply_voltage_ac_raw")),
    ...conditional("dimensionsMm", readString(row, "dimensions_mm")),
    otherSpecs: readStringMap(row, "other_specs"),
    provenance: readStringMap(row, "provenance"),
    lowConfidence: readStringArray(row, "low_confidence"),
  };
}

function toCrossRefRow(record: Record<string, string>): CrossRefRow | undefined {
  const mode = record["banner_mode"]?.trim();
  if (mode === undefined || mode === "") return undefined;
  const rangeRaw = record["banner_range_max_mm"]?.trim() ?? "";
  const range = rangeRaw === "" ? Number.NaN : Number(rangeRaw);
  const confidenceRaw = record["confidence"]?.trim().toLowerCase() ?? "";
  const confidence = CROSSREF_CONFIDENCE.find((level) => level === confidenceRaw);
  const nonEmpty = (key: string): string | undefined => {
    const v = record[key]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  return {
    ...conditional("bannerSeries", nonEmpty("banner_series")),
    ...conditional("bannerModel", nonEmpty("banner_model")),
    bannerMode: mode,
    ...conditional("bannerRangeMaxMm", Number.isFinite(range) ? range : undefined),
    ...conditional("sickTypeCode", nonEmpty("sick_type_code")),
    ...conditional("sickOrderNumber", nonEmpty("sick_order_number")),
    ...conditional("sickFamily", nonEmpty("sick_family")),
    adequate: (record["adequate"] ?? "").trim().toLowerCase() === "true",
    ...conditional("confidence", confidence),
    rationale: record["rationale"] ?? "",
    source: (record["source"] ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * How much this record actually *states*.
 *
 * Used to break key collisions. Banner's guide lists a family twice — once as a
 * full spec card and once as a one-line "Productos Nuevos" teaser — and both
 * carry the same series name. Preferring the teaser would silently strip every
 * sensing mode out of the comparison while still looking like a successful
 * lookup, so the fuller record wins and the other is returned as an alternative.
 * Sensing modes count double: they are the load-bearing spec for equivalence.
 */
function statedSpecCount(product: BannerProduct): number {
  let n = product.sensingModes.length * 2;
  n += product.outputs.length + product.connections.length + product.features.length;
  n += Object.keys(product.otherSpecs).length;
  for (const stated of [
    product.description,
    product.housingMaterial,
    product.enclosureRating,
    product.supplyVoltageAcRaw,
    product.dimensionsMm,
  ]) {
    if (stated !== undefined) n += 1;
  }
  for (const stated of [
    product.operatingTempMinC,
    product.operatingTempMaxC,
    product.supplyVoltageDcMinV,
    product.supplyVoltageDcMaxV,
  ]) {
    if (stated !== undefined) n += 1;
  }
  return n;
}

interface Entry {
  product: BannerProduct;
  order: number;
  richness: number;
  modelKey: string;
  seriesKey: string;
}

/** Richest first; file order breaks ties so the result never depends on Map iteration luck. */
function rank(a: Entry, b: Entry): number {
  return b.richness - a.richness || a.order - b.order;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function readTextFile(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    throw new Error(
      `Cannot load ${what} from ${file}. Competitor specs must be read from disk, never recalled — ` +
        `refusing to build a competitor index without it.`,
      { cause },
    );
  }
}

/**
 * Load the competitor dataset from a repo root.
 *
 * All three files are required. Degrading quietly to an empty index would be
 * the worst outcome available: every lookup would miss, the Resolver would fall
 * back to `specSource: "inferred"`, and a run that should have been
 * dataset-backed would quietly become model-recalled — with no visible failure
 * anywhere. So a missing file throws, loudly, naming the path.
 */
export async function loadCompetitorIndex(rootDir: string): Promise<CompetitorIndex> {
  const productsPath = path.join(rootDir, BANNER_PRODUCTS_REL);
  const crossRefPath = path.join(rootDir, CROSSREF_REL);
  const gapsPath = path.join(rootDir, GAPS_REL);

  const [productsText, crossRefText, gapsText] = await Promise.all([
    readTextFile(productsPath, "competitor products"),
    readTextFile(crossRefPath, "Banner→SICK crossref"),
    readTextFile(gapsPath, "Banner→SICK equivalence gaps"),
  ]);

  const productList: BannerProduct[] = [];
  for (const line of productsText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const product = toBannerProduct(JSON.parse(trimmed));
    if (product !== undefined) productList.push(product);
  }

  const entries: Entry[] = productList.map((product, order) => ({
    product,
    order,
    richness: statedSpecCount(product),
    modelKey: product.model === undefined ? "" : normalizePartKey(product.model),
    seriesKey: product.series === undefined ? "" : normalizePartKey(product.series),
  }));

  /** Every distinct series key, longest first — the prefix fallback scans this. */
  const seriesKeys = [
    ...new Set(entries.map((e) => e.seriesKey).filter((k) => k.length >= 3)),
  ].sort((a, b) => b.length - a.length);

  const vendorKeys = [...new Set(productList.map((p) => normalizePartKey(p.vendor)))].filter(
    (v) => v.length > 0,
  );

  const crossRefRows = csvRecords(crossRefText)
    .map(toCrossRefRow)
    .filter((r): r is CrossRefRow => r !== undefined);
  const gapRows = csvRecords(gapsText)
    .map(toCrossRefRow)
    .filter((r): r is CrossRefRow => r !== undefined);

  const rowNames = (row: CrossRefRow, key: string): boolean =>
    (row.bannerSeries !== undefined && normalizePartKey(row.bannerSeries) === key) ||
    (row.bannerModel !== undefined && normalizePartKey(row.bannerModel) === key);

  return {
    lookup(partNumber: string): CompetitorMatch | undefined {
      let key = normalizePartKey(partNumber);
      // "Banner QS18" and "QS18" are the same question. Strip a leading vendor
      // token, but never to nothing — "BANNER" alone identifies no part.
      for (const vendor of vendorKeys) {
        if (key.length > vendor.length && key.startsWith(vendor)) {
          key = key.slice(vendor.length);
          break;
        }
      }
      if (key === "") return undefined;

      // Exact tier: model OR series. A model hit does not automatically outrank
      // a series hit — see statedSpecCount() for why the fuller record wins.
      let hits = entries.filter((e) => e.modelKey === key || e.seriesKey === key);
      let kind: CompetitorMatchKind = "model";
      if (hits.length > 0) {
        hits = [...hits].sort(rank);
      } else {
        const prefix = seriesKeys.find((s) => key.length > s.length && key.startsWith(s));
        if (prefix === undefined) return undefined;
        hits = entries.filter((e) => e.seriesKey === prefix).sort(rank);
        if (hits.length === 0) return undefined;
        kind = "series-prefix";
        key = prefix;
      }

      const best = hits[0];
      if (best === undefined) return undefined;
      if (kind !== "series-prefix") {
        kind = best.modelKey === key ? "model" : "series";
      }
      return {
        product: best.product,
        kind,
        matchedKey: key,
        query: partNumber,
        alternatives: hits.slice(1).map((e) => e.product),
      };
    },

    priorRecommendation(seriesOrModel: string): CrossRefRow[] {
      const key = normalizePartKey(seriesOrModel);
      if (key === "") return [];
      return crossRefRows.filter((row) => rowNames(row, key));
    },

    knownGap(seriesOrModel: string, mode?: string): boolean {
      const key = normalizePartKey(seriesOrModel);
      if (key === "") return false;
      const wanted = mode === undefined ? undefined : normalizeModeToken(mode);
      return gapRows.some(
        (row) =>
          rowNames(row, key) &&
          (wanted === undefined || normalizeModeToken(row.bannerMode) === wanted),
      );
    },

    vendors(): string[] {
      return [...new Set(productList.map((p) => p.vendor))].sort();
    },

    size(): number {
      return productList.length;
    },

    products(): BannerProduct[] {
      return [...productList];
    },
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Cite a Banner record back to the page it was extracted from.
 *
 * {@link Citation} was written for the SICK catalog, so read the fields with
 * that in mind: `sourcePage` is prefixed `Banner p.N` precisely so a citation
 * pointing at the *competitor* PDF can never be mistaken for one pointing at
 * `CATALOGO-PRODUCTOS-SICK.pdf`, and `pdfPage` is the 0-based index into
 * `BannerProductos.pdf`. `orderNumber` stays absent: Banner series have no SICK
 * order number, and inventing one would corrupt the field every downstream
 * lookup keys on.
 */
export function bannerCitation(product: BannerProduct): Citation {
  const identifier = product.model ?? product.series;
  return {
    ...conditional("typeCode", identifier),
    ...conditional("family", product.series),
    sourcePage: `Banner p.${String(product.sourcePage)}`,
    pdfPage: Math.max(0, product.sourcePage - 1),
  };
}

/**
 * Project a match into the Resolver's {@link IdentifiedPart}.
 *
 * `specSource` is hardcoded `"dataset"` because reaching this function means the
 * specs came off disk with a page behind them. Never call it on a part the
 * index missed — that part's specs are `inferred` or `unknown`, and mislabeling
 * them `dataset` would dress a model's recollection up as extracted data, which
 * is the one lie nothing downstream can catch.
 */
export function toIdentifiedPart(match: CompetitorMatch): IdentifiedPart {
  const { product } = match;
  return {
    vendor: product.vendor,
    ...conditional("series", product.series),
    ...conditional("model", product.model),
    rawInput: match.query,
    ...conditional("description", product.description),
    specSource: "dataset",
    citation: bannerCitation(product),
  };
}

/** Housing tokens the SICK-side normalizer speaks. */
type HousingToken = NonNullable<NormalizedSpec["housing"]>;

/**
 * Map Banner's free-text housing material onto SICK's canonical tokens.
 *
 * Returns a *set*, because several Banner series print a genuinely disjunctive
 * material ("S18: PBT; M18: s. steel") and {@link SpecConstraints.housing} is an
 * OR-list — so the ambiguity survives as an ambiguity instead of being resolved
 * by coin flip. An unrecognized material yields an empty set and therefore no
 * constraint at all; guessing `"other"` would be a fabricated requirement that
 * could fail a perfectly good SICK part.
 */
export function mapHousing(material: string): HousingToken[] {
  const text = material.toLowerCase();
  const out: HousingToken[] = [];
  const stainless = /stainless|inoxidable|s\.\s*steel|inox/.test(text);
  if (stainless) out.push("stainless-steel");
  // Strip the stainless phrases before testing for plain metal, or "acero
  // inoxidable" would also register as generic steel.
  const withoutStainless = text.replace(/stainless\s*steel|acero\s+inoxidable|s\.\s*steel/g, " ");
  if (/plastic|pbt|abs|lexan|teflon|polyester|polycarbonate|acetal|nylon|plástico/.test(text)) {
    out.push("plastic");
  }
  if (/zinc|alumin|brass|die.?cast|\bmetal\b|\bsteel\b|\bacero\b/.test(withoutStainless)) {
    out.push("metal");
  }
  if (/glass|vidrio/.test(text)) out.push("other");
  return [...new Set(out)];
}

/** Pull an IP rating out of a raw enclosure string, e.g. `IP67; NEMA 6P` → 67. */
function parseIpRating(raw: string): { ip?: number; ip69k: boolean } {
  const match = /IP\s*(\d{2})\s*(K?)/i.exec(raw);
  if (match === null) return { ip69k: false };
  const digits = match[1];
  if (digits === undefined) return { ip69k: false };
  const ip = Number.parseInt(digits, 10);
  if (!Number.isFinite(ip)) return { ip69k: false };
  return { ip, ip69k: ip === 69 && (match[2] ?? "").toUpperCase() === "K" };
}

/**
 * Derive the SICK-side constraint set from a competitor record.
 *
 * ## The rule
 *
 * A constraint is emitted **only** for a spec the Banner data actually states.
 * Banner's guide leaves most per-mode ranges blank for prose-described products;
 * turning a null range into `{ min: 0 }` would let every sensor in the catalog
 * "pass" a requirement nobody ever stated. Absent stays absent, and the solver
 * gets to report `unknown` — which is the truth.
 *
 * ## Why `mode` matters
 *
 * A Banner series is modular: one MINI-BEAM covers through-beam at 30 m,
 * retroreflective at 4.5 m and diffuse at 130 mm. Without `mode` this returns
 * the union of principles and **no range at all**, because there is no single
 * number that describes four different optics — a max across them would demand
 * 30 m from a diffuse sensor and refuse every real answer. Pass the mode the
 * user actually runs to get a range.
 *
 * With one principle selected, `sensingRangeMm.min` is the **largest** stated
 * reach among the matching variants: the family's best case. That is an
 * assumption ("replace the longest-range variant"), it is stated here, and the
 * Resolver should surface it in `ResolvedInput.assumptions` so the user can
 * reject it.
 *
 * ## What is deliberately left out
 *
 * - **Output type.** A series-level record lists every output option Banner
 *   sells (`NPN+PNP`, `SCR/FET`, `E/M relay`…). Pinning one would invent a
 *   configuration the user never stated. Ask instead.
 * - **Supply voltage.** Only 41 of 1,776 SICK SKUs print one, so the constraint
 *   would resolve to `unknown` almost everywhere while looking like diligence.
 */
export function toConstraints(match: CompetitorMatch, mode?: string): SpecConstraints {
  const { product } = match;
  const wanted = mode === undefined ? undefined : normalizeModeToken(mode);
  const selected =
    wanted === undefined
      ? product.sensingModes
      : product.sensingModes.filter((m) => normalizeModeToken(m.mode) === wanted);

  const principles: SensingPrinciple[] = [];
  for (const sensing of selected) {
    const principle = bannerModeToPrinciple(sensing.mode);
    if (principle !== undefined && !principles.includes(principle)) principles.push(principle);
  }

  // A range is only meaningful once the optics are pinned to one principle.
  let rangeMin: number | undefined;
  if (principles.length === 1) {
    const target = principles[0];
    const ranges = selected
      .filter((m) => bannerModeToPrinciple(m.mode) === target)
      .map((m) => m.rangeMaxMm)
      .filter((r): r is number => r !== undefined);
    if (ranges.length > 0) rangeMin = Math.max(...ranges);
  }

  const housing = product.housingMaterial === undefined ? [] : mapHousing(product.housingMaterial);
  const ingress =
    product.enclosureRating === undefined
      ? { ip69k: false }
      : parseIpRating(product.enclosureRating);

  const temp: { min?: number; max?: number } = {
    ...conditional("min", product.operatingTempMinC),
    ...conditional("max", product.operatingTempMaxC),
  };

  return {
    ...(principles.length > 0 ? { principle: principles } : {}),
    ...(rangeMin !== undefined ? { sensingRangeMm: { min: rangeMin } } : {}),
    ...(Object.keys(temp).length > 0 ? { operatingTempC: temp } : {}),
    ...(housing.length > 0 ? { housing } : {}),
    ...conditional("minIpRating", ingress.ip),
    ...(ingress.ip69k ? { ip69k: true } : {}),
  };
}
