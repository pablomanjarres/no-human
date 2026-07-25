# Consultancy tool

Takes a plain-language description of an industrial sensing problem and returns
the SICK products that solve it, with the reasoning and the caveats.

## Why it is built this way

The product data comes from the SICK *catálogo resumido*, which lists ordering
options but omits most datasheet specs. Measured fill rates across the 1,493
products:

| Constraint | Stated in catalog |
| --- | --- |
| sensing distance | 59% |
| enclosure rating (IP) | 29% |
| communication protocol | 19% (6.6% before enrichment) |
| resolution | 13% |
| ambient temperature | 7% |
| **price** | **0% — no pricing data exists** |

Hard-filtering on those fields returns nothing for realistic queries. So every
constraint falls into one of three tiers:

1. **Hard** — a *stated* value that violates the requirement disqualifies.
2. **Soft** — a stated mismatch does not disqualify, because the catalog's list
   is not exhaustive (communication protocol).
3. **Absent** — an unstated value **never** disqualifies. It is recorded as
   `unverified` and lowers the evidence score instead.

Two scores come out and are deliberately never collapsed into one:

- **fit** — weighted match across constraints the catalog could verify
- **evidence** — how much of the requirement the catalog could verify at all

Ranking uses `fit × (0.55 + 0.45 × evidence)`, so a well-evidenced product wins a
tie without a sparsely-documented one being buried.

## Shape

```
sick-catalog-dataset/catalog.enriched.json   committed build artifact
scripts/enrich-catalog.mjs                   offline enrichment + coverage report
packages/consultancy-engine/                 pure scoring; no I/O, no network
apps/consultancy-api/                        HTTP server; holds the model credential
apps/sick-clone-ui/consult.html              the console
```

Prompts and response schemas live in the **engine**, not the API app — they are
domain logic, and keeping them there makes the intelligence unit-testable
without a network. Only HTTP transport lives in the app.

## Enrichment

`scripts/enrich-catalog.mjs` reads `products.jsonl` (never modified) and writes
`catalog.enriched.json` plus `enrichment_report.json`. Coverage lift:

| Field | Before | After |
| --- | --- | --- |
| `solution_class` | — | 100% |
| `sensing_mode` | 24.2% | 67.8% |
| `protocols` | 6.6% | 19.2% |
| `safety_resolution_mm` | 24 rows | 117 rows |
| `protective_field_height_mm` | — | 121 rows |
| `mounting_type` / `process_connection` | — | 132 / 185 rows |

Rules: a derived field never overwrites a stated one, every derived field records
`derived_from`, and absence stays absence. Two parsing details matter:

- Spanish number format — `1.020 mm` is 1020 mm, not 1.02. Reading it wrong
  understated light-curtain field heights by 1000×.
- Light-curtain resolution is written both as `14 mm` and bare `14`. Failing to
  read the bare form let a 30 mm hand-detection curtain pass a 14 mm
  finger-detection requirement as merely "unverified".

Regenerate with `node scripts/enrich-catalog.mjs`.

## Running it

```sh
pnpm --filter @no-human/consultancy-api build
ANTHROPIC_API_KEY=sk-... node apps/consultancy-api/dist/server.js
# → http://localhost:3400/consult.html
```

Without a key it still runs and ranks deterministically, and says on every
response that it could not diagnose the application.

## Model use

`claude-opus-5`, two calls per consultation, both with structured outputs
(`output_config.format`) and server-side refusal fallback enabled:

1. **parse** (effort `medium`) — problem text → structured requirement
2. **adjudicate** (effort `high`) — shortlist → recommendation and comparison

**Anti-hallucination is enforced in code, not requested in the prompt.** Any
order number the adjudicator returns that was not in the candidate set is
dropped and reported in `diagnostics.dropped_order_numbers`; if the primary
recommendation is fabricated, the deterministic answer stands. Each model step
degrades independently — a failed parse falls back to keyword matching, a failed
adjudication falls back to the scoring trace.

## Functional safety

271 of the 1,493 products are safety devices. Any recommendation touching them
carries a notice that a risk assessment and PL/SIL determination
(EN ISO 13849-1 / IEC 62061) are required and that this tool does not replace
them. Light-curtain selection scores protective field height and detection
resolution as hard constraints — a curtain shorter than the opening or coarser
than the body part at risk is excluded, not merely down-ranked.

## Budget

The catalog has no pricing. Budget is accepted as an input and reported back in
`not_applied` stating plainly that it did not influence ranking. No proxy, no
estimate, no silent drop.
