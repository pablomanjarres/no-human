# Architecture

> Status: skeleton. Fill this in with the first real feature — every other doc
> and every `tasks/*.md` file links back here.

## What this is

TODO: one paragraph. What the system does, for whom, and the single sentence
that explains why it exists.

## Repository layout

| Path        | Contents                                                         |
| ----------- | ---------------------------------------------------------------- |
| `apps/`     | Deployable units — services, frontends, CLIs, daemons            |
| `packages/` | Shared libraries consumed by apps and by each other              |
| `infra/`    | VM/systemd/launchd/database config — deployment inputs, not code |
| `scripts/`  | Repo-level operational scripts (deploy, codegen, secrets)        |
| `docs/`     | Durable knowledge: contracts, runbooks, decisions                |
| `tasks/`    | Queue of planned work, one markdown file per unit                |

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
