# no-human — Claude Code project guide

**Read first:** `docs/architecture.md`, then whatever doc under `docs/` matches your task.

## What this repo is

TODO: two or three sentences. What the product is, who it is for, what ships in
the first milestone. Every future session boots off this paragraph — keep it
accurate or it poisons them.

This repo is a pnpm + turbo monorepo:

- `packages/core` — placeholder that pins the workspace conventions. Delete or repurpose it once real packages exist.
- `apps/` — deployable units, one directory per app. Empty for now.
- `infra/` — VM / systemd / launchd / database config. Deployment inputs, not workspace packages.
- `scripts/` — repo-level operational scripts (deploy, codegen, secrets). Shell or Node ESM, no build step.
- `docs/` — the source of truth for every Claude Code session in this repo.
- `tasks/` — queue of planned work, one markdown file per unit. Deleted when the PR merges.

## Critical context to internalize before editing

TODO: the things that cause wrong wiring if a session doesn't know them —
naming collisions, tenancy rules, which secrets live where, which paths are
read-only vs. write. Number them; they are the highest-value lines in this file.

1. …
2. …

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
| Add a new package or app | `packages/README.md`, `apps/README.md` |
| Know what CI enforces    | `.github/workflows/ci.yml`             |
| Pick up planned work     | `tasks/`                               |
