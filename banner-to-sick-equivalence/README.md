# Banner → SICK Equivalence Cross-Reference

Maps each **Banner** sensor product/series to its closest **SICK** equivalent, by sensing mode + range + output, so a Banner model can be replaced with a SICK part.

Inputs: `../banner-catalog-dataset/` (62 Banner products) and `../sick-catalog-dataset/` (1,776 SICK SKUs).

## Headline numbers

| Metric | Value |
|---|---|
| Banner products judged | 35 (those with range-comparable modes) |
| (Banner product × sensing-mode) rows | **123** |
| Rows with a recommended SICK part | **112** |
| — of those, flagged *not fully adequate* (e.g. range shortfall) | 9 |
| Rows with no SICK part at all (true gap) | 11 |
| Total rows to review (`equivalence_gaps.csv`) | 20 |
| Recommendation confidence | **63 high · 28 medium · 21 low** |
| SICK records considered (photoelectric + ultrasonic, mode-tagged) | 362 |

## Files

| File | What it is |
|---|---|
| `equivalence_summary.md` | **Start here** — one-line recommended SICK family per Banner series, with confidence |
| `banner_to_sick_crossref.csv` | **Main table** — one row per (Banner product, sensing mode) → recommended SICK `type_code` / `order_number` / `family`, `adequate`, `confidence`, `rationale` |
| `banner_to_sick_by_product.json` | Full per-product judgement incl. an `overall` recommendation + caveats |
| `equivalence_gaps.csv` | Banner modes with no adequate SICK match (competitive gaps) |
| `banner_to_sick_candidates_deterministic.csv` | The pre-LLM ranked candidate shortlist (audit trail) |
| `sick_long.csv` | SICK products tagged with the common `sensing_mode` (the matching key) |

## How the match is made

1. **Common taxonomy.** Both catalogs are tagged with a normalized `sensing_mode`. SICK's principle maps as: `barrera emisor-receptor → opposed`, `barrera fotoeléctrica de reflexión → retroreflective`, `fotocélula de detección sobre objeto → diffuse`, `Ultrasonidos → ultrasonic`.
2. **Deterministic shortlist.** For each Banner (product, mode, range) the SICK products of the same mode are ranked by range closeness (log-ratio), keeping the top 5 real candidates. Coverage (SICK range ≥ Banner range) is preferred.
3. **LLM adjudication.** One agent per Banner product picks the best SICK equivalent **only from those real candidates** (no invented part numbers), weighing range adequacy, sub-mode fit (e.g. Banner convergent/fixed-field → SICK *supresión del fondo*), and output/voltage compatibility — with a per-mode confidence, rationale, and an overall replacement recommendation + caveats.

## Reading it

- `confidence = high` → a clean same-mode, comparable-range SICK part exists.
- `adequate = false` / rows in `equivalence_gaps.csv` → SICK's *summary* catalog has no comparable product (e.g. Banner's 200 m through-beam, laser measurement L-GAGE, measuring light-curtain arrays). These are honest gaps, not errors.
- **Modular Banner series map to several SICK families** — one per mode (e.g. Q45 → W280-2 for opposed, G-series for retro/diffuse). Use the per-mode rows, not just the single overall family.

## Caveats

- Equivalence is **spec-based** (mode, range, output), not application-certified — validate mechanically/electrically before quoting a replacement.
- SICK side is the *resumido* summary catalog, so some SICK long-range/specialty families may exist but aren't in the source dataset → shown as gaps.
- Banner data is from the 2000/2001 guide; current Banner equivalents may differ.

*Derived from the Banner and SICK datasets in this repo. For project use.*
