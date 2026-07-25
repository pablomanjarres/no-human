# apps/

Deployable units — one directory per app, each its own workspace package
(`apps/*` in `pnpm-workspace.yaml`). Web frontends, HTTP services, CLIs,
daemons, browser extensions.

An app may depend on `packages/*`; nothing in `packages/` may depend on an app.

New app checklist:

- `package.json` with `"type": "module"` and the standard
  `build` / `dev` / `typecheck` / `lint` / `test` scripts (turbo keys off these)
- `tsconfig.json` extending `../../tsconfig.base.json`
- `test` script uses `vitest run --passWithNoTests` so CI's gate stays green
  before the first test lands
- add a `references` entry in the root `tsconfig.json`
