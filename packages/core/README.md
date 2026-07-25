# @no-human/core

Shared domain primitives for no-human.

Placeholder at `0.0.1-alpha.0` — it pins the workspace conventions (ESM, dual
`tsconfig` for check-vs-emit, vitest gate) so new packages have something to
copy. Replace the contents once the real domain model exists.

```bash
pnpm --filter @no-human/core typecheck
pnpm --filter @no-human/core build
pnpm --filter @no-human/core test
```
