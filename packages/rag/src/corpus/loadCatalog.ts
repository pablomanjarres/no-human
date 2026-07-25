/**
 * Disk → {@link Catalog}. **This module is the package's only snake_case boundary.**
 *
 * `products.jsonl` and `families.csv` are the extraction pipeline's wire format:
 * snake_case keys, `null` for "the printed page did not state it", and a
 * `;`-separated `pages` column. Everything downstream (chunking, normalization,
 * the constraint solver, the CLI) codes against the camelCase types in
 * `../types.ts` and must never see a wire key. If you find yourself writing
 * `product["sensing_range_max_mm"]` anywhere else in this package, the fix
 * belongs here, not there.
 *
 * ## Three rules this loader exists to enforce
 *
 * 1. **Absent stays absent.** `null`, a missing key, and `""` all become
 *    `undefined` — never `0`, never `""`, never a defaulted string. The catalog
 *    is the *resumido* (summary) edition and genuinely omits most electrical
 *    specs; a `0` here would later read as "this sensor draws 0 mA" and the
 *    solver would confidently reject or accept the wrong SKU. Optional fields
 *    are omitted from the object entirely (conditional assignment), so
 *    `"supplyVoltageMinV" in product` is a truthful presence test.
 * 2. **Identity is non-negotiable.** A row without a 7-digit `order_number`
 *    throws, naming the file and the 1-based line. A half-loaded corpus that
 *    silently drops rows produces an index that is *quietly* missing parts —
 *    the worst possible failure for a cross-reference tool.
 * 3. **Keys are translated everywhere, including inside records.** The keys of
 *    `provenance` and the entries of `lowConfidence` name *fields*, so they are
 *    mapped to camelCase too (unknown keys — the Spanish spec labels inside
 *    `otherSpecs` — pass through verbatim). Downstream code reads
 *    `provenance.sensingRangeMaxMm`, matching the property it explains.
 *
 * No network, no env, no writes: the only I/O is reading the two dataset files.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Catalog, RowType, SickFamily, SickProduct } from "../types.js";

/** Filename of the deduped one-row-per-SKU product table inside the dataset dir. */
export const PRODUCTS_FILE = "products.jsonl";
/** Filename of the family rollup inside the dataset dir. */
export const FAMILIES_FILE = "families.csv";

// ---------------------------------------------------------------------------
// Wire-key dictionary — the single source of truth for snake_case ↔ camelCase
// ---------------------------------------------------------------------------

/** Optional {@link SickProduct} fields whose wire value is free text. */
type OptionalStringField =
  | "typeCode"
  | "family"
  | "subfamily"
  | "productName"
  | "productUrl"
  | "resolutionUnit"
  | "switchingOutput"
  | "outputFunction"
  | "connection"
  | "scopeOfDelivery"
  | "sensorPrinciple"
  | "detectionPrinciple"
  | "lightType"
  | "lightSpot"
  | "adjustment"
  | "enclosureRating"
  | "housingMaterial"
  | "interface"
  | "shortDescription";

/** Optional {@link SickProduct} fields whose wire value is a unit-stripped number. */
type OptionalNumberField =
  | "sensingRangeMinMm"
  | "sensingRangeMaxMm"
  | "supplyVoltageMinV"
  | "supplyVoltageMaxV"
  | "outputCurrentMaxMa"
  | "responseTimeMs"
  | "switchingFrequencyHz"
  | "operatingTempMinC"
  | "operatingTempMaxC"
  | "resolutionValue";

const STRING_FIELDS: readonly (readonly [string, OptionalStringField])[] = [
  ["type_code", "typeCode"],
  ["family", "family"],
  ["subfamily", "subfamily"],
  ["product_name", "productName"],
  ["product_url", "productUrl"],
  ["resolution_unit", "resolutionUnit"],
  ["switching_output", "switchingOutput"],
  ["output_function", "outputFunction"],
  ["connection", "connection"],
  ["scope_of_delivery", "scopeOfDelivery"],
  ["sensor_principle", "sensorPrinciple"],
  ["detection_principle", "detectionPrinciple"],
  ["light_type", "lightType"],
  ["light_spot", "lightSpot"],
  ["adjustment", "adjustment"],
  ["enclosure_rating", "enclosureRating"],
  ["housing_material", "housingMaterial"],
  ["interface", "interface"],
  ["short_description", "shortDescription"],
];

const NUMBER_FIELDS: readonly (readonly [string, OptionalNumberField])[] = [
  ["sensing_range_min_mm", "sensingRangeMinMm"],
  ["sensing_range_max_mm", "sensingRangeMaxMm"],
  ["supply_voltage_min_v", "supplyVoltageMinV"],
  ["supply_voltage_max_v", "supplyVoltageMaxV"],
  ["output_current_max_ma", "outputCurrentMaxMa"],
  ["response_time_ms", "responseTimeMs"],
  ["switching_frequency_hz", "switchingFrequencyHz"],
  ["operating_temp_min_c", "operatingTempMinC"],
  ["operating_temp_max_c", "operatingTempMaxC"],
  ["resolution_value", "resolutionValue"],
];

/**
 * Every wire key → its camelCase field name, including the structural ones.
 *
 * Used both to build products and to rewrite the *keys* of `provenance` and the
 * *entries* of `lowConfidence`, which are field names rather than values. A key
 * absent from this map is not a field name (e.g. a Spanish spec label inside
 * `other_specs`) and is left exactly as printed.
 */
const WIRE_TO_FIELD: ReadonlyMap<string, string> = new Map<string, string>([
  ...STRING_FIELDS,
  ...NUMBER_FIELDS,
  ["order_number", "orderNumber"],
  ["row_type", "rowType"],
  ["category", "category"],
  ["section", "section"],
  ["source_page", "sourcePage"],
  ["pdf_page", "pdfPage"],
  ["occurrences", "occurrences"],
  ["also_on_pages", "alsoOnPages"],
  ["other_specs", "otherSpecs"],
  ["provenance", "provenance"],
  ["low_confidence", "lowConfidence"],
]);

/** A 7-digit SICK *Referencia*. Anything else is not an identity. */
const ORDER_NUMBER_RE = /^\d{7}$/;

// ---------------------------------------------------------------------------
// Value readers — every one of them returns `undefined` for "not stated"
// ---------------------------------------------------------------------------

/** `null`, missing, non-string, and whitespace-only all collapse to `undefined`. */
function readString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Numeric read that refuses to invent a zero.
 *
 * `Number("")` is `0` and `Number(null)` is `0` — the two most common wire
 * shapes for "not stated" — so both are short-circuited before `Number()` ever
 * runs. Non-finite results (`NaN`, `Infinity`) are `undefined`, not a value.
 */
function readNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === "boolean") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Non-array or all-blank input yields `undefined`; callers decide the default. */
function readStringArray(value: unknown, translateKeys = false): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const text = readString(entry);
    if (text === undefined) continue;
    out.push(translateKeys ? (WIRE_TO_FIELD.get(text) ?? text) : text);
  }
  return out.length === 0 ? undefined : out;
}

/**
 * Flatten a wire record into `Record<string, string>`.
 *
 * `provenance` nests one level (`provenance.other_specs` is itself a record of
 * label → verbatim substring), which the flat `Record<string, string>` contract
 * cannot hold. Nested entries are flattened to `otherSpecs.<label>` rather than
 * dropped, because provenance is what a skeptical reviewer uses to check a
 * claim against the page — losing it silently defeats the point.
 *
 * An empty record is indistinguishable from an absent one, so it becomes
 * `undefined` and callers never need `Object.keys(x).length` guards.
 */
function readRecord(value: unknown, translateKeys: boolean): Record<string, string> | undefined {
  const flat: Record<string, string> = {};
  collectRecord(value, "", translateKeys, flat);
  return Object.keys(flat).length === 0 ? undefined : flat;
}

function collectRecord(
  value: unknown,
  prefix: string,
  translateKeys: boolean,
  out: Record<string, string>,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = translateKeys && prefix === "" ? (WIRE_TO_FIELD.get(rawKey) ?? rawKey) : rawKey;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)) {
      collectRecord(rawValue, path, translateKeys, out);
      continue;
    }
    const text = readString(rawValue);
    if (text !== undefined) out[path] = text;
  }
}

/**
 * Assign only when the value is present.
 *
 * `exactOptionalPropertyTypes` makes `{ typeCode: undefined }` a type error and
 * — more importantly — a lie: it claims the key exists. This keeps "absent"
 * meaning "key not present".
 */
function setIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

// ---------------------------------------------------------------------------
// products.jsonl
// ---------------------------------------------------------------------------

/** Error that always names the file and 1-based line, so a bad corpus is fixable. */
function corpusError(file: string, line: number, message: string): Error {
  return new Error(`${file}:${line}: ${message}`);
}

/** Optional half of {@link SickProduct} — the part built by table-driven loops. */
type OptionalProductFields = Partial<
  Pick<
    SickProduct,
    OptionalStringField | OptionalNumberField | "otherSpecs" | "provenance" | "lowConfidence"
  >
>;

/**
 * Parse one JSONL line into a {@link SickProduct}.
 *
 * Exported for the index builder's incremental/streaming paths and for tests
 * that need to exercise a single malformed row without writing a file.
 *
 * @param line - the raw JSON text of one line (must not be blank)
 * @param file - path used in error messages
 * @param lineNumber - 1-based line number used in error messages
 */
export function parseProductLine(line: string, file: string, lineNumber: number): SickProduct {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    throw corpusError(
      file,
      lineNumber,
      `not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw corpusError(file, lineNumber, "expected a JSON object");
  }
  const row = raw as Record<string, unknown>;

  const orderNumber = readString(row["order_number"]);
  if (orderNumber === undefined || !ORDER_NUMBER_RE.test(orderNumber)) {
    throw corpusError(
      file,
      lineNumber,
      `missing or malformed order_number (expected 7 digits, got ${JSON.stringify(row["order_number"])})`,
    );
  }

  const rowTypeText = readString(row["row_type"]);
  if (rowTypeText !== "product" && rowTypeText !== "accessory") {
    throw corpusError(
      file,
      lineNumber,
      `order_number ${orderNumber}: row_type must be "product" or "accessory", got ${JSON.stringify(row["row_type"])}`,
    );
  }
  const rowType: RowType = rowTypeText;

  const category = readString(row["category"]);
  const section = readString(row["section"]);
  const sourcePage = readString(row["source_page"]);
  const pdfPage = readNumber(row["pdf_page"]);
  if (category === undefined) {
    throw corpusError(file, lineNumber, `order_number ${orderNumber}: missing category`);
  }
  if (section === undefined) {
    throw corpusError(file, lineNumber, `order_number ${orderNumber}: missing section`);
  }
  if (sourcePage === undefined) {
    throw corpusError(file, lineNumber, `order_number ${orderNumber}: missing source_page`);
  }
  if (pdfPage === undefined) {
    throw corpusError(file, lineNumber, `order_number ${orderNumber}: missing pdf_page`);
  }

  const alsoOnPages = readStringArray(row["also_on_pages"]) ?? [];
  // `occurrences` is how many catalog pages the SKU appears on; if the wire row
  // omits it, the page list still tells the truth (this page + the extras).
  const occurrences = readNumber(row["occurrences"]) ?? alsoOnPages.length + 1;

  const optional: OptionalProductFields = {};
  for (const [wireKey, field] of STRING_FIELDS) {
    setIfDefined(optional, field, readString(row[wireKey]));
  }
  for (const [wireKey, field] of NUMBER_FIELDS) {
    setIfDefined(optional, field, readNumber(row[wireKey]));
  }
  setIfDefined(optional, "otherSpecs", readRecord(row["other_specs"], false));
  setIfDefined(optional, "provenance", readRecord(row["provenance"], true));
  setIfDefined(optional, "lowConfidence", readStringArray(row["low_confidence"], true));

  return {
    orderNumber,
    rowType,
    category,
    section,
    sourcePage,
    pdfPage,
    occurrences,
    alsoOnPages,
    ...optional,
  };
}

/**
 * Parse a whole `products.jsonl` document.
 *
 * Blank lines are skipped (trailing newline, hand-edited files); every other
 * line must be a valid product or the whole load fails. Line numbers in errors
 * count blank lines, so they match what an editor shows.
 */
export function parseProductsJsonl(text: string, file: string): SickProduct[] {
  const products: SickProduct[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    products.push(parseProductLine(line, file, i + 1));
  }
  return products;
}

// ---------------------------------------------------------------------------
// families.csv
// ---------------------------------------------------------------------------

/** One parsed CSV record plus the 1-based line its first cell started on. */
export interface CsvRow {
  line: number;
  cells: string[];
}

/**
 * Minimal RFC 4180 reader — quotes, doubled `""` escapes, embedded commas and
 * newlines, and CRLF.
 *
 * Hand-rolled on purpose: the house rule forbids a new runtime dependency, and
 * `text.split(",")` corrupts exactly the cells this dataset cares about (a
 * category like `"Sensores, registro (…)"` or a quoted multi-page `pages` cell).
 * Line numbers are tracked through quoted newlines so error messages stay
 * accurate.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let sawContent = false;

  const endField = (): void => {
    cells.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    // A row of one empty cell is a blank line, not a record.
    if (!(cells.length === 1 && cells[0] === "")) rows.push({ line: rowLine, cells });
    cells = [];
    sawContent = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (!sawContent) {
      rowLine = line;
      sawContent = true;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      line += 1;
      continue;
    }
    field += ch;
  }
  if (sawContent || field !== "" || cells.length > 0) endRow();
  return rows;
}

const FAMILY_COLUMNS = [
  "section",
  "category",
  "family",
  "product_variants",
  "accessory_rows",
  "n_pages",
  "pages",
] as const;

/**
 * Parse `families.csv` into {@link SickFamily} records.
 *
 * Column positions are resolved from the header row rather than hard-coded, so
 * a reordered or extended export cannot silently shift `pages` into
 * `product_url`. `product_url` is genuinely blank for 27 of the 110 families,
 * so an empty cell there is `undefined`, not `""`; the three count columns are
 * required by the type and a non-numeric cell throws.
 */
export function parseFamiliesCsv(text: string, file: string): SickFamily[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) throw new Error(`${file}: empty file, expected a header row`);

  const columnIndex = new Map<string, number>();
  header.cells.forEach((name, index) => columnIndex.set(name.trim(), index));
  for (const required of FAMILY_COLUMNS) {
    if (!columnIndex.has(required)) {
      throw new Error(`${file}:${header.line}: missing required column "${required}"`);
    }
  }
  const cellAt = (row: CsvRow, column: string): string | undefined => {
    const index = columnIndex.get(column);
    return index === undefined ? undefined : readString(row.cells[index]);
  };

  const families: SickFamily[] = [];
  for (const row of rows.slice(1)) {
    const section = cellAt(row, "section");
    const category = cellAt(row, "category");
    const family = cellAt(row, "family");
    if (section === undefined || category === undefined || family === undefined) {
      throw new Error(`${file}:${row.line}: family row missing section/category/family identity`);
    }
    const count = (column: string): number => {
      const parsed = readNumber(cellAt(row, column));
      if (parsed === undefined) {
        throw new Error(
          `${file}:${row.line}: family ${family}: column "${column}" is not a number`,
        );
      }
      return parsed;
    };
    const productVariants = count("product_variants");
    const accessoryRows = count("accessory_rows");
    const nPages = count("n_pages");
    const pages = (cellAt(row, "pages") ?? "")
      .split(";")
      .map((page) => page.trim())
      .filter((page) => page !== "");
    const productUrl = cellAt(row, "product_url");

    families.push({
      section,
      category,
      family,
      productVariants,
      accessoryRows,
      nPages,
      pages,
      ...(productUrl !== undefined ? { productUrl } : {}),
    });
  }
  return families;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildCatalog(dir: string, productsText: string, familiesText: string): Catalog {
  const sourceDir = resolve(dir);
  return {
    products: parseProductsJsonl(productsText, join(sourceDir, PRODUCTS_FILE)),
    families: parseFamiliesCsv(familiesText, join(sourceDir, FAMILIES_FILE)),
    // Absolute: citations must stay resolvable no matter what cwd the CLI,
    // the index builder, or a consuming service happens to run under.
    sourceDir,
  };
}

/**
 * Load `products.jsonl` + `families.csv` from a dataset directory.
 *
 * Throws (rather than returning a partial catalog) on any malformed row: a RAG
 * index missing SKUs answers "no equivalent part exists" with total confidence,
 * which is worse than not answering at all.
 */
export async function loadCatalog(dir: string): Promise<Catalog> {
  const sourceDir = resolve(dir);
  const [productsText, familiesText] = await Promise.all([
    readFile(join(sourceDir, PRODUCTS_FILE), "utf8"),
    readFile(join(sourceDir, FAMILIES_FILE), "utf8"),
  ]);
  return buildCatalog(sourceDir, productsText, familiesText);
}

/**
 * Synchronous twin of {@link loadCatalog}, byte-for-byte identical in result.
 *
 * Exists for the CLI and for module-level test setup, where an `await` would
 * force every caller to become async for a 2 MB read that takes milliseconds.
 */
export function loadCatalogSync(dir: string): Catalog {
  const sourceDir = resolve(dir);
  return buildCatalog(
    sourceDir,
    readFileSync(join(sourceDir, PRODUCTS_FILE), "utf8"),
    readFileSync(join(sourceDir, FAMILIES_FILE), "utf8"),
  );
}

/**
 * Index products by their 7-digit order number for O(1) lookup.
 *
 * First occurrence wins. `products.jsonl` is already deduped, but
 * `products_all_rows.jsonl` repeats a shared accessory once per page it prints
 * on — and there the first row carries the same canonical page the deduped file
 * chose, so first-wins keeps the two files agreeing instead of silently
 * disagreeing about which page to cite.
 */
export function indexByOrderNumber(products: readonly SickProduct[]): Map<string, SickProduct> {
  const byOrderNumber = new Map<string, SickProduct>();
  for (const product of products) {
    if (!byOrderNumber.has(product.orderNumber)) byOrderNumber.set(product.orderNumber, product);
  }
  return byOrderNumber;
}
