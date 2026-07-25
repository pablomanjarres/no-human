# @no-human/console

The cross-brand equivalence console. Hand it a competitor part number and it
returns the SICK equivalent parameter by parameter, citing both datasheets — or
refuses and quantifies what you lose.

## Run it

```bash
pnpm install
pnpm --filter @no-human/console dev   # http://localhost:3200
```

No network is required at request time. Fonts are self-hosted by `next/font` at
build time, there are no remote images, and every citation resolves inside the app.

## Routes

| Route | What it is |
| --- | --- |
| `/` | The workspace: source part, SICK equivalent, consultation thread |
| `/product/[sku]` | SICK product record, led by the competitor families it replaces |
| `/corpus` | Extraction swarm output and the verifier dispute ledger |
| `/doc/[docId]?page=N` | Where every citation lands — the extracted text layer for that page |

## Demo deep links

The replay is deterministic and scrubbable, so each beat of the pitch is a URL.

| URL | Beat |
| --- | --- |
| `/?q=QS18VN6LV` | Plays the full solve from zero |
| `/?q=QS18VN6LV&t=900` | Freezes one frame before the challenger kills rank 1 |
| `/?q=QS18VN6LV&t=end` | Straight to the verdict and its three named losses |
| `/?q=ML100-8-1000-RT/95/103` | The refusal. Two undocumented option codes, no defensible match |
| `/?q=Necesito detectar cajas negras sobre una banda transportadora&mode=describe` | The consultant path — a question, not a guess |

Anything not in the corpus returns an honest "not in the corpus" refusal rather
than a guess, so a judge typing an unseen part number is a feature, not a crash.

## The seam

`src/lib/engine.ts` exports `solve(input): SolveRun | null`. It resolves scripted
runs from `src/data/runs.ts` today. The live resolver, deterministic constraint
solver and challenger drop in behind that signature without a component changing —
nothing above the seam knows whether a model was involved, which is the point.

`src/lib/types.ts` is the contract. It is shaped so a judge can re-derive a match
by hand: constraints carry their origin (`extracted` / `asked` / `assumed`), spec
rows carry a citation and an optional extractor-vs-verifier dispute, and every
evaluation carries the signed delta that makes up "what you lose".

## Deploying

Root directory is `apps/console`. See `docs/deploy.md`.
