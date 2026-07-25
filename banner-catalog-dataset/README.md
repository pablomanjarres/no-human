# Banner Engineering — Extracted Product Dataset

Structured dataset of the products in the **Banner Engineering** *Guía de Selecciones — Sensores Fotoeléctricos y Ultrasónicos* (Spanish "Specifiers Guide", 20 pp, ~2000/2001).

Source PDF: `BannerProductos.pdf` · Publisher: Banner Engineering Corp.
Extracted for internal competitive-analysis / project use. Aligned to the same normalized schema as the SICK dataset so the two are directly comparable (see `../banner-to-sick-equivalence/`).

## Headline numbers

| Metric | Value |
|---|---|
| Distinct products (series / model) | **62** |
| — photoelectric | 51 |
| — ultrasonic | 5 |
| — accessories / optical-touch / laser | 6 |
| Sensing-mode rows (long form) | 123 |
| Pages parsed | 17 of 20 |

Banner's guide is a **selection guide of product *series*** (OMNI-BEAM, MULTI-BEAM, MAXI-BEAM, MINI-BEAM, Q-series, S/T-series, ULTRA-BEAM …), each a modular family configurable to several sensing modes — not a per-SKU order list. So a "product" here is a series (or a specific named model), with a full spec profile.

## Files

| File | What it is |
|---|---|
| `banner_products.csv` | One row per product/series; sensing ranges summarized per mode (`range_opposed_mm`, `range_diffuse_mm`, …) |
| `banner_products.json` / `.jsonl` | Full nested records (structured `sensing_modes[]`, `outputs[]`, `provenance`, `low_confidence`) |
| `banner_sensing_modes.csv` | **Long form** — one row per (product, sensing mode, range). Matching-ready. |
| `banner_report.json` | Counts / QA |

## Schema (per product)
- **Identity:** `vendor` (Banner), `series`, `model`, `product_category`, `product_subtype`, `source_page`, `description`
- **Sensing:** `sensing_modes[]` = `{mode ∈ opposed|retroreflective|diffuse|convergent|fixed_field|fiber_optic|ultrasonic, variant, range_max_mm, focus_mm, material}` — **ranges converted from metres to mm**
- **Electrical:** `supply_voltage_dc_min/max_v`, `supply_voltage_ac_raw`, `outputs[]` (`type`, `detail`, `current_ma`)
- **Mechanical:** `connections[]`, `housing_material`, `enclosure_rating` (IP + NEMA), `operating_temp_min/max_c`, `dimensions_mm`
- **Other:** `features[]`, `other_specs{}`, `provenance{}` (verbatim source per field), `low_confidence[]`

## Method
Because the guide is graphics-heavy with **transposed spec matrices** (series as columns) and prose, extraction was **vision-based**: each page was rendered to a 170-DPI PNG and read by a vision agent (image = source of truth, extracted text as a spelling aid). A second **completeness-critic** agent re-examined each page image to catch products named only in prose and fix bindings — it added missed color-mark/receiver models on 3 pages. Records deduped by (series, model).

## Caveats
- 2000/2001 catalog — model line is of that era.
- Units converted to mm/V/°C/mA; original metre ranges preserved verbatim in `provenance`.
- `low_confidence` flags values read from prose/footnotes or ambiguous cells (e.g. "several models to 200 m").
- Ranges are the family's best-case per mode; specific sub-models vary.

*Generated from `BannerProductos.pdf`. Product data © Banner Engineering; extraction for project use.*
