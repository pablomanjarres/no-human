# @no-human/rag

Hybrid retrieval + indexing over the SICK 2015/2016 catalog, and the
deterministic spec-constraint solver that sits behind it.

**Read [`docs/rag-index.md`](../../docs/rag-index.md) first** for the design and
the two rules that govern every module here:

1. **Retrieval never picks the part.** Search produces candidates; the match is
   a deterministic solve over normalized structured specs.
2. **Absent is not failing.** A spec the catalog does not print is `unknown`,
   never `fail`.

Then read [`src/types.ts`](./src/types.ts) — it is the full contract, and every
module codes against it.

## Quick start

> Run the built CLI, not `--experimental-strip-types` on the sources: every
> module imports with `.js` specifiers, and Node's type-stripping does not
> rewrite those to `.ts`. Build first with `pnpm --filter @no-human/rag build`
> (or `pnpm build` at the root, which turbo orders for you).

```bash
# Build the index (add --no-embed to force lexical-only)
node dist/cli.js index

# Search, with hard constraints applied before ranking
node dist/cli.js search "sees a box at 40 cm" --pnp --ip 67

# Deterministic solve — prints the per-constraint verdict table
node dist/cli.js solve --pnp --ip69k --response-max 12
```

No `VOYAGE_API_KEY` is required. Without one the dense and rerank lanes are
skipped and everything still works offline. See [`.env.example`](../../.env.example).

## Scripts

| Command          | Does                        |
| ---------------- | --------------------------- |
| `pnpm typecheck` | `tsc --noEmit`              |
| `pnpm build`     | Emit to `dist/`             |
| `pnpm test`      | `vitest run`                |
| `pnpm lint`      | ESLint over `src`           |
