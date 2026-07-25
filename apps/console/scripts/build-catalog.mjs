/**
 * Distil the SICK catalogue into something the solver can run over.
 *
 * Source: sick-catalog-dataset/products.jsonl — 1,776 orderable SKUs transcribed
 * from the SICK Catálogo resumido (doc. 8014481, 240 pp), with 100% order-number
 * coverage against the source and per-row provenance.
 *
 * This is not a sample or a mock. Every order number, type code and page
 * reference in the output is the real one. Where the catalogue does not print a
 * value, the field is absent — the solver has to say it cannot evaluate that
 * constraint rather than assume one, which is the entire point of the product.
 *
 * Output: src/data/catalog.generated.json (gitignored, rebuilt before dev/build).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "..", "sick-catalog-dataset", "products.jsonl");
const outFile = resolve(here, "..", "src", "data", "catalog.generated.json");

/** Categories a cross-brand sensor replacement could plausibly land in. */
const SENSING_CATEGORIES = new Set([
  "Fotocelulas (Photoelectric sensors)",
  "Sensores de proximidad (Proximity sensors)",
  "Sensores de distancia (Distance sensors)",
  "Sensores de registro (Registration/contrast sensors)",
  "Sensores magneticos para cilindros (Magnetic cylinder sensors)",
]);

/** Spanish catalogue strings normalised to the solver's enum vocabulary. */
function normaliseOutput(raw) {
  if (!raw) return undefined;
  const s = String(raw).toUpperCase();
  if (s.includes("PNP") && s.includes("NPN")) return "PNP/NPN";
  if (s.includes("PNP")) return "PNP";
  if (s.includes("NPN")) return "NPN";
  return undefined;
}

function normaliseConnection(raw) {
  if (!raw) return undefined;
  const s = String(raw).toLowerCase();
  const pins = /(\d+)\s*polos/.exec(s)?.[1];
  if (s.includes("m12")) return `M12 ${pins ?? "4"}-pin`;
  if (s.includes("m8")) return `M8 ${pins ?? "4"}-pin`;
  if (s.includes("cable")) return "Cable";
  return undefined;
}

function normaliseIp(raw) {
  if (!raw) return undefined;
  const m = /IP\s*(\d{2})/i.exec(String(raw));
  return m?.[1] ? Number(m[1]) : undefined;
}

/** "energética" / "supresión de fondo" — the distinction that decides dark targets. */
function normalisePrinciple(row) {
  const hay = `${row.detection_principle ?? ""} ${row.sensor_principle ?? ""} ${row.product_name ?? ""}`.toLowerCase();
  if (hay.includes("supresión de fondo") || hay.includes("supresion de fondo")) return "background-suppression";
  if (hay.includes("energética") || hay.includes("energetica")) return "energetic";
  if (hay.includes("reflex") || hay.includes("réflex")) return "retroreflective";
  if (hay.includes("barrera")) return "through-beam";
  return undefined;
}

/**
 * The dataset's `low_confidence` is a per-field list, not a row-level flag: it
 * names the fields read from prose, a bullet or a footnote rather than a
 * labelled table cell. Treating it as one boolean per product would say 1,248 of
 * 1,776 rows are shaky, when what is actually shaky is mostly `product_name`.
 * Map it onto our field names so the solver can mark exactly the values that
 * came from prose — and so the challenger knows which ones to attack first.
 */
const FIELD_ALIASES = {
  sensing_range_max_mm: "rangeMaxMm",
  sensing_range_min_mm: "rangeMinMm",
  switching_output: "output",
  connection: "connection",
  enclosure_rating: "ipRating",
  response_time_ms: "responseMs",
  switching_frequency_hz: "switchingHz",
  operating_temp_min_c: "tempMinC",
  operating_temp_max_c: "tempMaxC",
  supply_voltage_min_v: "supplyMinV",
  supply_voltage_max_v: "supplyMaxV",
  output_function: "outputFunction",
  light_type: "lightType",
  housing_material: "housing",
  sensor_principle: "principle",
  detection_principle: "principle",
  product_name: "name",
};

function lowConfidenceFields(row) {
  const rawFlags = row.low_confidence;
  if (!rawFlags) return [];
  const list = Array.isArray(rawFlags)
    ? rawFlags
    : String(rawFlags)
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
  const mapped = new Set();
  for (const f of list) {
    const alias = FIELD_ALIASES[f];
    if (alias) mapped.add(alias);
  }
  return [...mapped].sort();
}

const raw = await readFile(source, "utf8");
const rows = raw
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const catalog = [];

for (const r of rows) {
  if (r.row_type !== "product") continue;
  if (!SENSING_CATEGORIES.has(r.category)) continue;
  if (!r.type_code || !r.order_number) continue;

  const entry = {
    orderNumber: String(r.order_number),
    typeCode: String(r.type_code),
    family: r.family ?? null,
    category: r.category,
    name: r.product_name ?? null,
    page: r.source_page ?? null,
    pdfPage: r.pdf_page ?? null,
    // Exactly which of this product's values came from prose rather than a
    // labelled table cell. Never collapsed to a single flag.
    prose: lowConfidenceFields(r),
  };

  if (typeof r.sensing_range_max_mm === "number") entry.rangeMaxMm = r.sensing_range_max_mm;
  if (typeof r.sensing_range_min_mm === "number") entry.rangeMinMm = r.sensing_range_min_mm;
  if (typeof r.response_time_ms === "number") entry.responseMs = r.response_time_ms;
  if (typeof r.switching_frequency_hz === "number") entry.switchingHz = r.switching_frequency_hz;
  if (typeof r.operating_temp_min_c === "number") entry.tempMinC = r.operating_temp_min_c;
  if (typeof r.operating_temp_max_c === "number") entry.tempMaxC = r.operating_temp_max_c;
  if (typeof r.supply_voltage_min_v === "number") entry.supplyMinV = r.supply_voltage_min_v;
  if (typeof r.supply_voltage_max_v === "number") entry.supplyMaxV = r.supply_voltage_max_v;

  const output = normaliseOutput(r.switching_output);
  if (output) entry.output = output;

  const connection = normaliseConnection(r.connection);
  if (connection) entry.connection = connection;

  const ip = normaliseIp(r.enclosure_rating);
  if (ip) entry.ipRating = ip;

  const principle = normalisePrinciple(r);
  if (principle) entry.principle = principle;

  if (r.light_type) entry.lightType = String(r.light_type);
  if (r.housing_material) entry.housing = String(r.housing_material);
  if (r.output_function) entry.outputFunction = String(r.output_function);

  // A prose flag on a field we did not end up storing says nothing about this
  // product. Two source fields collapse into `principle`, so without this the
  // flag count can exceed the value count and the coverage table lies.
  entry.prose = entry.prose.filter((f) => entry[f] !== undefined && entry[f] !== null);

  catalog.push(entry);
}

// Coverage, reported honestly. These numbers appear on the corpus board, so they
// have to be derived here rather than typed in by hand somewhere else.
const has = (k) => catalog.filter((c) => c[k] !== undefined).length;
const fromProse = (k) => catalog.filter((c) => c.prose.includes(k)).length;

/** Per-field: how many carry a value, and how many of those came from prose. */
const SOLVER_FIELDS = [
  "rangeMaxMm",
  "output",
  "connection",
  "ipRating",
  "responseMs",
  "principle",
  "tempMinC",
  "supplyMinV",
];

const coverage = {
  totalSkus: rows.filter((r) => r.row_type === "product").length,
  sensingSkus: catalog.length,
  solvable: catalog.filter((c) => c.rangeMaxMm !== undefined && c.output !== undefined).length,
  /** Products with at least one solver-relevant value read from prose. */
  anyProse: catalog.filter((c) => c.prose.some((f) => SOLVER_FIELDS.includes(f))).length,
  fields: Object.fromEntries(
    SOLVER_FIELDS.map((k) => [k, { present: has(k), fromProse: fromProse(k) }]),
  ),
  families: [...new Set(catalog.map((c) => c.family).filter(Boolean))].length,
  source: {
    document: "SICK Catálogo resumido — Selección de productos para la automatización industrial",
    docNumber: "8014481",
    pages: 240,
  },
};

// Write then rename: `turbo run typecheck build` runs both tasks concurrently
// and both regenerate this file. Rename is atomic, so a concurrent reader
// never sees a half-written JSON.
await mkdir(dirname(outFile), { recursive: true });
const tmpFile = `${outFile}.${process.pid}.tmp`;
await writeFile(tmpFile, JSON.stringify({ coverage, catalog }, null, 0));
await rename(tmpFile, outFile);

console.log(
  `[build-catalog] ${catalog.length} sensing SKUs from ${coverage.totalSkus} catalogue products · ` +
    `${coverage.solvable} solvable · ${coverage.anyProse} carry at least one solver field read from prose`,
);
