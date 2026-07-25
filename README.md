# no-human

TODO: one-line description.

A pnpm + turbo TypeScript monorepo. See [docs/architecture.md](docs/architecture.md)
for the layout, toolchain, and the decisions behind them.

## Setup

```bash
nvm use              # Node 22, per .nvmrc
corepack enable      # pnpm 10.28.0, pinned via packageManager
pnpm install
```

## Commands

| Command             | What it does                                |
| ------------------- | ------------------------------------------- |
| `pnpm dev`          | Run every workspace's dev task (persistent) |
| `pnpm build`        | Build all packages in dependency order      |
| `pnpm typecheck`    | `tsc --noEmit` across the workspace         |
| `pnpm lint`         | ESLint across the workspace                 |
| `pnpm test`         | vitest across the workspace                 |
| `pnpm format`       | Prettier write                              |
| `pnpm format:check` | Prettier check, no writes                   |

Scope any of them to one package with pnpm's filter:

```bash
pnpm --filter @no-human/core test
```

## Layout

```
apps/       deployable units — services, frontends, CLIs, daemons
packages/   shared libraries (core/ is a placeholder pinning conventions)
infra/      VM / systemd / launchd / database config
scripts/    deploy, codegen, secret-pull scripts
docs/       durable knowledge: contracts, runbooks, decisions
tasks/      queue of planned work, one markdown file per unit
```
