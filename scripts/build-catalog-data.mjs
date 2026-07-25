#!/usr/bin/env node
// Join the SICK dataset with the extracted image manifest into the catalog file the frontend reads.
//
// This is the only place the two artifacts are joined. It needs no PDF — run
// scripts/extract-product-images.mjs first if sick-catalog-dataset/images.json is missing or stale.
//
// Usage: node scripts/build-catalog-data.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DATASET = path.join(REPO, "sick-catalog-dataset");
const OUT = path.join(REPO, "apps", "sick-clone-ui", "data", "catalog.json");

const MANIFEST_PATH = path.join(DATASET, "images.json");
if (!existsSync(MANIFEST_PATH)) {
  process.stderr.write(
    `Missing ${path.relative(REPO, MANIFEST_PATH)}.\nRun: node scripts/extract-product-images.mjs\n`,
  );
  process.exit(1);
}

const readJsonl = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const skus = readJsonl(path.join(DATASET, "products.jsonl"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

// The manifest records where a photo came from as a 1-based PDF page index, but everything the UI
// shows elsewhere uses the catalog's printed page code ("B-44"). Translate, so a reader never sees
// two different page numbering systems side by side.
const printedPage = new Map();
for (const r of readJsonl(path.join(DATASET, "products_all_rows.jsonl"))) {
  if (!printedPage.has(r.pdf_page + 1)) printedPage.set(r.pdf_page + 1, r.source_page);
}

// Specs shown in the detail panel, in display order. Label is the catalog's own Spanish wording.
const SPEC_FIELDS = [
  ["short_description", "Descripción"],
  ["sensor_principle", "Principio del sensor"],
  ["detection_principle", "Principio de detección"],
  ["light_type", "Tipo de luz"],
  ["light_spot", "Punto de luz"],
  ["sensing_range_min_mm", "Alcance mín.", "mm"],
  ["sensing_range_max_mm", "Alcance máx.", "mm"],
  ["switching_output", "Salida conmutada"],
  ["output_function", "Función de salida"],
  ["switching_frequency_hz", "Frecuencia de conmutación", "Hz"],
  ["response_time_ms", "Tiempo de respuesta", "ms"],
  ["supply_voltage_min_v", "Tensión de alimentación mín.", "V"],
  ["supply_voltage_max_v", "Tensión de alimentación máx.", "V"],
  ["output_current_max_ma", "Corriente de salida máx.", "mA"],
  ["operating_temp_min_c", "Temp. de servicio mín.", "°C"],
  ["operating_temp_max_c", "Temp. de servicio máx.", "°C"],
  ["enclosure_rating", "Índice de protección"],
  ["housing_material", "Material de la carcasa"],
  ["connection", "Conexión"],
  ["interface", "Interfaz"],
  ["adjustment", "Ajuste"],
  ["scope_of_delivery", "Alcance del suministro"],
];

const has = (v) => v !== null && v !== undefined && v !== "";

const products = skus.map((s) => {
  const img = manifest.images[s.order_number] ?? { image: null };
  const lowConfidenceFields = new Set(s.low_confidence ?? []);

  const specs = [];
  for (const [field, label, unit] of SPEC_FIELDS) {
    if (!has(s[field])) continue;
    specs.push({
      label,
      value: unit ? `${s[field]} ${unit}` : String(s[field]),
      low: lowConfidenceFields.has(field),
    });
  }
  if (has(s.resolution_value)) {
    specs.push({
      label: "Resolución",
      value: `${s.resolution_value} ${s.resolution_unit ?? ""}`.trim(),
      low: lowConfidenceFields.has("resolution_value"),
    });
  }
  for (const [label, value] of Object.entries(s.other_specs ?? {})) {
    if (has(value)) specs.push({ label, value: String(value), low: true });
  }

  return {
    order_number: s.order_number,
    type_code: s.type_code || null,
    family: s.family || null,
    subfamily: s.subfamily || null,
    row_type: s.row_type,
    category: s.category,
    name: s.product_name || s.short_description || null,
    url: s.product_url || null,
    source_page: s.source_page,
    // headline spec for the card, so a card says something even before the panel opens
    headline: has(s.sensing_range_max_mm)
      ? `Alcance ≤ ${s.sensing_range_max_mm} mm`
      : has(s.enclosure_rating)
        ? String(s.enclosure_rating)
        : has(s.connection)
          ? String(s.connection)
          : null,
    image: img.image,
    // true when the photo depicts the family rather than this exact variant, or when several
    // photos on the page made the choice ambiguous — surfaced in the UI, never silently hidden
    image_is_family_photo: img.image ? Boolean(img.low_confidence) : false,
    image_match: img.image ? img.match_method : null,
    // printed page code of the page the photo was taken from, e.g. "B-44"
    image_page: img.image ? (printedPage.get(img.provenance.pdf_page) ?? null) : null,
    specs,
  };
});

const categories = [...new Set(products.map((p) => p.category))].sort();
const withImage = products.filter((p) => p.image).length;

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    generated_by: "scripts/build-catalog-data.mjs",
    source: {
      dataset: "sick-catalog-dataset/products.jsonl",
      images: "sick-catalog-dataset/images.json",
      image_dir: "assets/products",
    },
    summary: {
      total: products.length,
      products: products.filter((p) => p.row_type === "product").length,
      accessories: products.filter((p) => p.row_type === "accessory").length,
      with_image: withImage,
      coverage_pct: Number(((withImage / products.length) * 100).toFixed(1)),
      family_photo_count: products.filter((p) => p.image_is_family_photo).length,
    },
    categories,
    products,
  }),
);

const bytes = readFileSync(OUT).length;
process.stdout.write(
  `Wrote ${path.relative(REPO, OUT)}\n` +
    `  ${products.length} SKUs, ${withImage} with an image (${((withImage / products.length) * 100).toFixed(1)}%), ` +
    `${categories.length} categories\n` +
    `  ${(bytes / 1e6).toFixed(2)} MB\n`,
);
