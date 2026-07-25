/**
 * Stage the enriched SICK catalogue for the consultancy route.
 *
 * Source: sick-catalog-dataset/catalog.enriched.json — the committed artifact
 * produced by scripts/enrich-catalog.mjs at the repo root. Copying it into
 * src/data means the route handler can `import` it, so Next bundles it into the
 * serverless function and there is no filesystem tracing to get wrong on Vercel.
 *
 * Same shape as build-catalog.mjs: gitignored output, rebuilt before dev/build.
 *
 * Output: src/data/consult-catalog.generated.json
 */
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "..", "sick-catalog-dataset", "catalog.enriched.json");
const outFile = resolve(here, "..", "src", "data", "consult-catalog.generated.json");

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(source))) {
  console.error(
    `[build-consult-catalog] missing ${source}\n` +
      `  Regenerate it with: node scripts/enrich-catalog.mjs (from the repo root)`,
  );
  process.exit(1);
}

const rows = JSON.parse(await readFile(source, "utf8"));
if (!Array.isArray(rows) || rows.length === 0) {
  console.error("[build-consult-catalog] enriched catalogue is empty or not an array");
  process.exit(1);
}

// Drop the fields the consultancy route never reads. `provenance`-style payloads
// and the per-page audit trail belong in the dataset, not in a function bundle.
const SHIPPED = rows.map((r) => {
  const { other_specs: _o, derived_from: _d, ...rest } = r;
  return rest;
});

// Write then rename. `turbo run typecheck build` runs both tasks concurrently
// and both regenerate this file; a plain write lets tsc read a half-written 3 MB
// JSON and fail. Rename is atomic on one filesystem, so a concurrent reader sees
// either the old complete file or the new one — never a partial.
await mkdir(dirname(outFile), { recursive: true });
const tmpFile = `${outFile}.${process.pid}.tmp`;
await writeFile(tmpFile, JSON.stringify(SHIPPED));
await rename(tmpFile, outFile);

const products = SHIPPED.filter((r) => r.row_type === "product").length;
const bytes = Buffer.byteLength(JSON.stringify(SHIPPED));
console.log(
  `[build-consult-catalog] ${SHIPPED.length} rows (${products} products) → ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB`,
);
