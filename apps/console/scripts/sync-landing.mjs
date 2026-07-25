/**
 * Copy the static landing page into this app's public/ directory.
 *
 * The landing page lives in apps/sick-clone-ui and that stays its only source of
 * truth — edit it there. This script runs before dev and before build so both
 * surfaces ship from one Vercel project on one URL: the landing at /, the
 * console at /console. The copies under public/ are gitignored.
 */
import { access, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "sick-clone-ui");
const target = resolve(here, "..", "public");

/**
 * Everything the pages need at runtime. The scrape scripts stay behind.
 *
 * There are two entry points, not one. `index.html` links to `productos.html`,
 * and that page carries its own stylesheet, its own script, and the generated
 * `data/catalog.json` the script fetches at load. Any one of them left out of
 * this list and the link 404s in production while working perfectly from the
 * filesystem — which is exactly how it shipped the first time.
 */
const ENTRIES = [
  "index.html",
  "styles.css",
  "app.js",
  "assets",
  "productos.html",
  "catalog.css",
  "catalog.js",
  "data/catalog.json",
];

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(source))) {
  console.error(`[sync-landing] apps/sick-clone-ui not found at ${source}`);
  process.exit(1);
}

for (const entry of ENTRIES) {
  const from = join(source, entry);
  const to = join(target, entry);

  if (!(await exists(from))) {
    console.warn(`[sync-landing] skipping ${entry} — not present in apps/sick-clone-ui`);
    continue;
  }

  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}

console.log(`[sync-landing] landing page synced into ${target}`);
