# @no-human/console

The cross-brand equivalence console. Hand it a competitor part number and it
returns the SICK equivalent parameter by parameter, citing both datasheets — or
refuses and quantifies what you lose.

## Run it

```bash
pnpm install
pnpm --filter @no-human/console dev   # http://localhost:3200
```

`dev` and `build` first run two generators:

- `scripts/sync-landing.mjs` copies the landing page from `apps/sick-clone-ui`
  into `public/`, so both surfaces ship from one deployment on one URL.
- `scripts/build-catalog.mjs` distils `sick-catalog-dataset/` into
  `src/data/catalog.generated.json` — 796 sensing SKUs the solver runs over.

Both outputs are gitignored. Their sources are the single source of truth.

No network is required at request time. Fonts are self-hosted by `next/font` at
build time and there are no remote images. The landing page pulls Font Awesome
from a CDN, so it loses its glyphs offline; the console does not care.

## Routes

| Route | What it is |
| --- | --- |
| `/` | The SICK landing page, rewritten to the synced static file |
| `/console` | The workspace: source part, SICK equivalent, consultation thread |
| `/console/product/[sku]` | SICK product record, led by the competitor families it replaces |
| `/console/corpus` | Extraction swarm output and the verifier dispute ledger |
| `/console/doc/[docId]?page=N` | Where every citation lands — the extracted text layer for that page |

## Demo deep links

The replay is deterministic and scrubbable, so each beat of the pitch is a URL.

| URL | Beat |
| --- | --- |
| `/console?q=QS18VN6LV` | Plays the full solve from zero |
| `/console?q=QS18VN6LV&t=900` | Freezes one frame before the challenger kills rank 1 |
| `/console?q=QS18VN6LV&t=end` | Straight to the verdict and its three named losses |
| `/console?q=ML100-8-1000-RT/95/103` | The refusal. Two undocumented option codes, no defensible match |
| `/console?q=Necesito detectar cajas negras sobre una banda transportadora&mode=describe` | The consultant path — a question, not a guess |
| `/console?solve=400` | The **real** catalogue solve: 400 mm on a dark target, over 796 SKUs |
| `/console?solve=400&remission=90pct` | Same distance, white target — watch the required range drop 3× |

Anything not in the corpus returns an honest "not in the corpus" refusal rather
than a guess, so a judge typing an unseen part number is a feature, not a crash.
Part-number matching is exact on purpose: `QS18VP6LV` is a real Banner part and a
*different* one, so it refuses rather than handing back the `QS18VN6LV` answer.

## Two engines behind one seam

`src/lib/engine.ts` — `solve(input)` resolves the scripted runs in
`src/data/runs.ts`. These carry the rehearsed narrative: the challenger killing
rank 1 on a remission derating table, and the ML100 refusal. They are fixtures,
and the corpus board says so.

`src/lib/solver.ts` — `solveCatalog(spec)` is real. It runs a deterministic pass
over 796 sensing SKUs transcribed from the SICK *Catálogo resumido* (doc. 8014481,
240 pp) with real order numbers, type codes and catalogue pages. It will not:

1. Treat a missing value as a pass. If the catalogue does not print a field, that
   part is set aside as unverifiable rather than ranked.
2. Silently promote a value read from prose. The dataset records which fields came
   from a bullet rather than a labelled cell, and those are marked on the row.
3. Rank by anything except distance from the stated constraints.

No model is involved anywhere in either file. A judge can re-derive any result by
hand from the same table.

`src/lib/types.ts` is the contract between them. Constraints carry their origin
(`extracted` / `asked` / `assumed` / `default`), spec rows carry a citation and an
optional extractor-vs-verifier dispute, and every evaluation carries the signed
delta that makes up "what you lose".

## Deploying

Root directory is `apps/console`. See `docs/deploy.md`.
