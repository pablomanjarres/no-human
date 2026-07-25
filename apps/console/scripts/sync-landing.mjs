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

/** Everything the page needs at runtime. The scrape scripts stay behind. */
const ENTRIES = [
  "index.html",
  "styles.css",
  "app.js",
  "assets",
  "consult.html",
  "consult.css",
  "consult.js",
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
