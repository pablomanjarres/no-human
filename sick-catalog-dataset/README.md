# SICK Product Catalog 2015/2016 — Extracted Product Dataset

Structured dataset of **every orderable product** in the SICK *Catálogo resumido —
Selección de productos para la automatización industrial* (Spanish, doc. `8014481`,
240 pages, "SICK-Kompakt-2014").

Source PDF: `CATALOGO-PRODUCTOS-SICK.pdf` · Publisher: SICK AG · © Sujeto a cambio sin previo aviso.
This dataset is a faithful transcription of that catalog for internal/project use.

## Headline numbers

| Metric | Value |
|---|---|
| Orderable SKUs (distinct 7-digit order numbers) | **1,776** |
| — main product variants | 1,507 |
| — accessories (brackets, cables, connectors, reflectors, …) | 519 |
| Extracted rows incl. cross-page duplicates | 2,026 |
| Product families | 110 |
| Product categories (catalog sections B–N) | 13 |
| Catalog pages parsed | 192 (of 240; rest are covers/TOC/dividers/intros) |
| **Order-number coverage vs. source** | **100.0 %** (0 missing, 0 unparseable, 0 hallucinated) |

## Files

| File | Rows | What it is |
|---|---|---|
| `products.csv` | 1,776 | **Primary flat table** — one row per distinct SKU. Best for spreadsheets / pandas. |
| `products.json` | 1,776 | Same records as a JSON array (nested `provenance` / `other_specs` preserved). |
| `products.jsonl` | 1,776 | Same, as JSON Lines (one object per line). |
| `products_all_rows.jsonl` | 2,026 | **Every extracted row**, including a shared accessory repeated on each page it appears on. Use this if you care about per-page placement rather than the deduped SKU list. |
| `families.csv` | 110 | Roll-up by product family: variant/accessory counts, pages, catalog URL. |
| `coverage_report.json` | — | QA report: counts, per-section totals, coverage %, any gaps. |
| `images.json` | 1,776 | Product photo per SKU (or `null`), with match method, confidence and provenance. See [Product images](#product-images-imagesjson). |

In the deduped files (`products.*`), a SKU that appears on several pages (118 shared
accessories) is kept **once**; `occurrences` and `also_on_pages` record the extras.
`products_all_rows.jsonl` keeps every occurrence.

## Data dictionary (`products.csv` columns)

**Identity**
| Column | Notes |
|---|---|
| `order_number` | SICK *Referencia* — exactly 7 digits. **Primary key.** |
| `type_code` | SICK *Tipo* — orderable type/order key (e.g. `GTB6-P4212`, `DT35-B15251`). |
| `family` | Product family heading (e.g. `G6`, `W4-3`, `DFS60`). |
| `subfamily` | Variant sub-series within a family (e.g. `GTE6` vs `GTB6`), else empty. |
| `row_type` | `product` (main sensor variant) or `accessory` (mounting, cabling, reflectors…). |
| `category` | Catalog section name (English gloss in parentheses). |
| `section` | Section letter `B`–`N`. |
| `source_page` | Printed catalog page code (e.g. `B-16`). |
| `pdf_page` | 0-based page index in the PDF. |
| `occurrences` / `also_on_pages` | How many pages this SKU appears on, and the other page codes. |
| `product_name` | Short description assembled from the family's descriptive bullets. |
| `product_url` | `www.mysick.com/...` link printed on the page, if any. |

**Normalized numeric** — units stripped, values converted, ranges split into `_min`/`_max`. Empty = not stated on the page (never inferred).
| Column | Unit | Populated |
|---|---|---|
| `sensing_range_min_mm` / `sensing_range_max_mm` | mm | 657 / 829 |
| `supply_voltage_min_v` / `supply_voltage_max_v` | V | 41 |
| `output_current_max_ma` | mA | 80 |
| `response_time_ms` | ms | 96 |
| `switching_frequency_hz` | Hz | 48 |
| `operating_temp_min_c` / `operating_temp_max_c` | °C | 109 |
| `resolution_value` + `resolution_unit` | e.g. `16 bits`, `1024 ppr` | 132 |

**Categorical (verbatim Spanish, empty = not stated)**
`switching_output` (PNP/NPN), `output_function`, `connection`, `scope_of_delivery`,
`sensor_principle`, `detection_principle`, `light_type`, `light_spot`, `adjustment`,
`enclosure_rating` (e.g. `IP 67`), `housing_material`, `interface`, `short_description`.

**Catch-all & audit**
| Column | Notes |
|---|---|
| `other_specs_json` | JSON object of any additional labelled spec not mapped to a named column. |
| `low_confidence` | `;`-separated list of fields read from prose/bullets/footnotes rather than a labelled table cell. (JSON files also carry `provenance` = the verbatim source substring for every populated field.) |

## Product images (`images.json`)

`images.json` keys every SKU to the product photo extracted from the same PDF, or to `null` when
the catalog has no photo for it. The image files themselves live in
`apps/sick-clone-ui/assets/products/` (one copy, referenced by basename) because the frontend
serves them directly.

| Metric | Value |
|---|---|
| SKUs with a photo | **1,458 / 1,776 (82.1 %)** |
| Distinct photos | 297 (≈1.1 MB WebP) |
| SKUs with no photo in the source | 318 |

Regenerate with (needs `pdftohtml`, `pdftoppm`, ImageMagick, and the source PDF):

```bash
node scripts/extract-product-images.mjs            # PDF  -> images + images.json
node scripts/build-catalog-data.mjs                # join -> apps/sick-clone-ui/data/catalog.json
```

**How a photo is matched to a SKU.** The catalog holds two kinds of photo, matched differently:

| `match_method` | How | Confidence |
|---|---|---|
| `row_aligned` | Small photo in an ordering/accessory table row; its vertical centre lines up with that row's 7-digit order number (typically within 2 px). Matched to **one exact SKU**. | exact |
| `page_hero` | Large photo at the top of a page. Depicts the family, so every *product* variant on that page gets it. | exact page, family-level subject |
| `family_hero` | Family's opening-page photo, applied to variants of the same subfamily whose own page carries no photo. | family-level, `low_confidence` |
| `family_hero_loose` | Same, but matched only at family level (subfamily unknown or absent). | family-level, `low_confidence` |

Every entry records `provenance` — source PDF page, the image's placement box, and for row matches
the pixel offset to the order number it matched.

Rules this follows, consistent with the field rules above:

1. **Never inferred.** No photo in the source ⇒ `image: null` with a reason. No stand-ins, no
   placeholders baked into the data.
2. **Accessories never inherit a sensor photo.** A mounting bracket only gets the thumbnail from its
   own catalog row; it is never given the family's hero photo.
3. **Family-level photos are flagged**, not silently presented as the exact variant
   (`low_confidence: true`, surfaced in the UI as *"Foto de familia"*).
4. **Page-wide decorative bands are excluded** (any image ≥ 70 % of page width), as are pictograms
   too small to be a product photo and certification marks (e.g. the UL logo).
5. **Pixels come from rendering the page and cropping the placement box**, not from raw image
   extraction — raw extraction drops a PDF soft mask, which turned page B-61's GR18S photo into a
   black rectangle.

## Extraction rules honored

1. **Never inferred.** A field absent from the page is left empty/null — no guessing, no defaults.
2. **No cross-carry.** Values are never copied between products, *except* a spec stated once
   in a header/bullet above a variant table, which correctly applies to each row beneath it.
3. **One row per orderable variant.** A table row listing several order numbers becomes several rows;
   merged/rowspan cells (a single `PNP` or delivery-scope spanning rows) are propagated to each row they cover.
4. **Provenance + confidence.** Every populated field records the verbatim substring it came from
   (`provenance`, JSON files) and is flagged `low_confidence` when not from a labelled cell.
5. **Identity required.** Rows without a 7-digit order number are dropped (no identity-less products).

## Methodology

1. Text extracted from the PDF with `pdftotext -layout` (layout preserved for table alignment).
2. Pages classified; 192 product pages isolated from covers/TOC/section dividers/feature pages.
   The catalog ID `8014481` (in every footer) and type-code digit-runs were excluded from the
   order-number space.
3. **Fan-out extraction:** one LLM agent per page read the raw page and emitted normalized JSONL
   under the rules above (196 agents total).
4. **Coverage self-check + re-extraction:** each page's emitted order numbers were compared against
   the 7-digit numbers detected on that page; 4 pages with a gap were automatically re-extracted at
   higher effort. Final gap: 0.
5. Consolidation deduped by order number, split product/accessory, rolled up families, and produced
   the files here.

## Caveats

- This is the **summary** catalog (*resumido*), so its selection tables list ordering options
  (output, connection, range) but usually **omit full electrical datasheet specs** — hence many
  `supply_voltage`/`temp`/`current` cells are empty. That is faithful to the source, not a gap.
- `low_confidence` is deliberately conservative: descriptive bullets above a table (e.g.
  *Principio del sensor*) are flagged low even though they are labelled, because they sit outside the
  table grid. Treat it as "double-check before relying on," not "likely wrong."
- Values are kept in the catalog's original Spanish. Category names carry an English gloss.
- Some modular families (e.g. encoders configured via a type-code builder) expose fixed order numbers
  only for accessories in this catalog; those are captured, the abstract configurator is not.

## Quick start

```python
import pandas as pd
df = pd.read_csv("products.csv")

df[df.row_type == "product"].groupby("category").order_number.nunique()      # SKUs per category
df[(df.section == "B") & (df.switching_output == "PNP")]                      # PNP photoelectric sensors
df[df.sensing_range_max_mm >= 1000][["order_number","type_code","family","sensing_range_max_mm"]]
df[df.family == "W4-3"].sort_values("type_code")                             # one family's variants
```

*Generated from `CATALOGO-PRODUCTOS-SICK.pdf`. Product data © SICK AG; extraction for project use.*
