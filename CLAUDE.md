# no-human — Claude Code project guide

**Read first:** `docs/architecture.md`, then whatever doc under `docs/` matches your task.

## What this repo is

A **cross-brand equivalence engine** for industrial sensors, built for SICK.
Give it a competitor part number (Banner, Keyence, Pepperl+Fuchs, Balluff) as a
part number, a description, a photo of a label, or a BOM, and it returns the
SICK equivalent parameter-by-parameter, cited to the catalog page — or an honest
no-match that quantifies what you lose. The first milestone is the part-number
path end to end, then the adversarial challenger, then free-text description
input.

This repo is a pnpm + turbo monorepo:

- `packages/rag` — retrieval + indexing over the SICK catalog, plus the deterministic spec-constraint solver. See `docs/rag-index.md`.
- `packages/agent` — the runtime agents (Resolver, Challenger, consultant) and the traced orchestrator. See `docs/agent-layer.md`.
- `packages/core` — placeholder that pins the workspace conventions. Delete or repurpose it once real packages exist.
- `apps/` — deployable units, one directory per app. Empty for now.
- `infra/` — VM / systemd / launchd / database config. Deployment inputs, not workspace packages.
- `scripts/` — repo-level operational scripts (deploy, codegen, secrets). Shell or Node ESM, no build step.
- `docs/` — the source of truth for every Claude Code session in this repo.
- `tasks/` — queue of planned work, one markdown file per unit. Deleted when the PR merges.

## Critical context to internalize before editing

1. **Retrieval never picks the part.** Semantic search produces *candidates*;
   the match is a deterministic solve over normalized structured specs
   (`packages/rag/src/filter/constraints.ts`). Never let a similarity score
   feed a correctness decision — that claim is the product's whole defense.
2. **Absent ≠ failing.** `sick-catalog-dataset/` is the *summary* catalog, so
   most electrical specs are genuinely unprinted. A spec the catalog does not
   state is `unknown`, never `fail`. Dropping a SKU for an unstated spec turns
   "cannot verify" into a confident wrong answer — the worst bug this repo can
   have. `viable` means `failed === 0`; it does **not** mean verified, so
   always surface the unknown count alongside it.
3. **Every network lane is fail-open.** No Voyage key, a 5xx, or a timeout must
   degrade retrieval, never break it. The demo has to run with no network.
   A lane that did not run reports `null` signals — never fabricate a rank.
4. **The catalog is in Spanish; the queries are in English.** Chunk text is
   rendered bilingually with industry-standard English synonyms. Adding a
   category or principle without extending the term map in
   `packages/rag/src/corpus/chunker.ts` silently makes those SKUs unfindable.
5. **Secrets live in env only** (`.env` is gitignored; `.env.example` documents
   the surface). Never commit a key, and never inline one in a source file.

## Workflow rules

- **Plan first** for any change touching more than one package. Use plan mode.
- **Update docs in the same PR as the code change** when behavior or contracts change. Stale docs poison future sessions.
- **Single source of truth:** every script and every config exists in exactly one place in this repo.
- **Tests are a hard CI gate.** A package with no tests yet passes via `vitest run --passWithNoTests`. Never add `continue-on-error` or `|| true` to make a red run green.
- **Every new workspace package** extends `tsconfig.base.json`, is ESM, and defines the five turbo scripts (`build`, `dev`, `typecheck`, `lint`, `test`).

## Toolchain

Node 22 (`.nvmrc`), pnpm 10.28.0 (pinned via `packageManager`, enforced by
`engine-strict=true`), TypeScript 6 strict, turbo for the task graph, ESLint
flat config + Prettier, vitest. CI is one job running
`turbo run typecheck lint build test`, with `--affected` on pull requests.

## What to do when ambiguous

1. Read the matching doc under `docs/`.
2. If still ambiguous, ask Pablo. Don't guess on architecture decisions.

## Quick reference

| Want to                  | Read                                   |
| ------------------------ | -------------------------------------- |
| Understand the system    | `docs/architecture.md`                 |
| Work on search/indexing  | `docs/rag-index.md`, then `packages/rag/src/types.ts` |
| Work on the agents       | `docs/agent-layer.md`, then `packages/agent/src/types.ts` |
| Know the catalog data    | `sick-catalog-dataset/README.md`       |
| Add a new package or app | `packages/README.md`, `apps/README.md` |
| Know what CI enforces    | `.github/workflows/ci.yml`             |
| Pick up planned work     | `tasks/`                               |
