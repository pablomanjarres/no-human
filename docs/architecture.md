# Architecture

## What this is

A **cross-brand equivalence engine** for industrial sensors. Someone hands it a
competitor part number — Banner, Keyence, Pepperl+Fuchs, Balluff — as a part
number, a plain description, a photo of a worn label, or a whole BOM, and it
returns the **SICK equivalent, parameter by parameter, cited to the catalog
page**. When there is no real equivalent it says so and quantifies what you lose.

The claim that makes it defensible: **the model never picks the part.** Agents
handle messy language and messy PDFs; the match itself is a deterministic solve
over structured specs, re-derivable by hand by a skeptical judge.

## Repository layout

| Path        | Contents                                                         |
| ----------- | ---------------------------------------------------------------- |
| `apps/`     | Deployable units — services, frontends, CLIs, daemons            |
| `packages/` | Shared libraries consumed by apps and by each other              |
| `infra/`    | VM/systemd/launchd/database config — deployment inputs, not code |
| `scripts/`  | Repo-level operational scripts (deploy, codegen, secrets)        |
| `docs/`     | Durable knowledge: contracts, runbooks, decisions                |
| `tasks/`    | Queue of planned work, one markdown file per unit                |

## Packages

| Package           | What it owns                                                          |
| ----------------- | --------------------------------------------------------------------- |
| `@no-human/rag`   | Retrieval + indexing over the SICK catalog, and the deterministic spec-constraint solver. See [`rag-index.md`](./rag-index.md). |
| `@no-human/agent` | The runtime agents — Resolver, Challenger, consultant mode — and the traced orchestrator. See [`agent-layer.md`](./agent-layer.md). |
| `@no-human/core`  | Placeholder pinning workspace conventions. Delete or repurpose.        |

### How they fit

```
 input ──▶ Resolver ──▶ SpecConstraints ──▶ retrieval ──▶ solver ──▶ Challenger ──▶ cited match
          (LLM)                             └──── @no-human/rag ────┘   (LLM)        or refusal
            └── underspecified? ask, don't guess
```

The seam between the two packages is the rule that makes the product
defensible: **agents narrow, question, and attack; the deterministic solver
decides.** A judge can re-derive any match by hand from the per-constraint
verdict table.

## Data

`sick-catalog-dataset/` — 1,776 orderable SKUs across 110 families, extracted
from the 240-page SICK 2015/2016 summary catalog at 100 % order-number coverage.
Extraction followed strict null-if-absent rules: a field absent from the printed
page is empty here, never inferred, and every populated field carries verbatim
`provenance` plus a `low_confidence` flag when it was read from prose rather
than a labelled table cell.

**This shapes everything downstream.** It is the *summary* catalog, so most
electrical specs are genuinely not printed (41 of 1,776 SKUs state a supply
voltage). Any component that treats an unstated spec as a constraint *failure*
rather than *unknown* will turn "cannot verify" into a confident wrong answer.

## Toolchain

- **Node 22** (`.nvmrc`), **pnpm 10.28.0** (`packageManager`, enforced by `engine-strict`)
- **pnpm workspaces** over `apps/*` and `packages/*`
- **turbo** for the task graph — `build` / `dev` / `typecheck` / `lint` / `test`,
  with `typecheck` and `test` depending on `^build`
- **TypeScript 6**, strict, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; every package extends `tsconfig.base.json`
- **ESLint flat config** at the root, **Prettier** for formatting
- **vitest** for tests

## CI

One `ubuntu-latest` job runs `turbo run typecheck lint build test` — a single
install, a single turbo invocation, turbo's cache reused across tasks. On pull
requests it adds `--affected` so only packages touched by the diff (and their
dependents) are validated. Draft PRs are skipped.

Tests are a hard gate. Packages without tests pass via
`vitest run --passWithNoTests`; do not add `continue-on-error` or `|| true`.

## Data pipelines

Catalog datasets live at the repo root (`sick-catalog-dataset/`, `banner-catalog-dataset/`,
`banner-to-sick-equivalence/`), one directory per source document, each with its own README acting
as the data dictionary. They are committed artifacts, not build output: the frontend has no build
step, so a fresh checkout must render without running anything.

The scripts that produce them live in `scripts/` and are re-runnable:

| Script | Input | Output |
| --- | --- | --- |
| `extract-product-images.mjs` | SICK catalog PDF (not in the repo) | `sick-catalog-dataset/images.json` + `apps/sick-clone-ui/assets/products/*.webp` |
| `build-catalog-data.mjs` | dataset + image manifest | `apps/sick-clone-ui/data/catalog.json` |

Regeneration steps and the image↔SKU matching rules are documented once, in
[`sick-catalog-dataset/README.md`](../sick-catalog-dataset/README.md) and
[`apps/sick-clone-ui/README.md`](../apps/sick-clone-ui/README.md) — not repeated here.

Because these artifacts are committed, staleness is a real failure mode. `apps/sick-clone-ui`'s
vitest suite asserts that the committed catalog and the committed images agree with each other, so a
half-done regeneration fails CI instead of silently shipping broken images.

## Decisions

- **No TypeScript project references.** Turbo already orders cross-package
  builds; composite builds add declaration/build-info ceremony for no gain at
  this size. The root `tsconfig.json` is solution-style for the IDE only.
- **Placeholder `@no-human/core`.** Keeps the workspace, task graph, and CI gate
  exercised before real code lands. Delete or repurpose it.
