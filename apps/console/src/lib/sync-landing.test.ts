import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain ESM script, no types, deliberately not part of the build.
import { ENTRIES, ENTRY_POINTS, source } from "../../scripts/sync-landing.mjs";

/**
 * The landing page ships by being copied file-by-file into `public/`, and the
 * copy list is hand-maintained. Twice now a page has been added to
 * `apps/sick-clone-ui` and left off that list, which 404s in production while
 * working perfectly from the filesystem — the failure is invisible locally,
 * which is exactly why it needs a test rather than care.
 *
 * This walks the real HTML and JS and asserts every local thing they reference
 * is actually carried by `ENTRIES`.
 */

const entries: string[] = ENTRIES;
const entryPoints: string[] = ENTRY_POINTS;
const root: string = source;

/**
 * Paths the Next app serves itself, so they are legitimately absent from the
 * copy list. The landing page links to `/console`, and that is a route, not a
 * file — resolving it through `public/` would be the wrong fix.
 */
const APP_ROUTES = ["console", "api"];

function isAppRoute(ref: string): boolean {
  return APP_ROUTES.some((route) => ref === route || ref.startsWith(`${route}/`));
}

/** `assets/products/x.webp` is carried by the entry `assets`, `data/catalog.json` only by itself. */
function isCarried(ref: string): boolean {
  if (isAppRoute(ref)) return true;
  return entries.some((entry) => entry === ref || ref.startsWith(`${entry}/`));
}

/** Local, same-origin references only. Anchors, protocol URLs and data URIs are not files we ship. */
function isLocalRef(ref: string): boolean {
  if (ref === "" || ref.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // http:, https:, mailto:, data:
  if (ref.startsWith("//")) return false;
  return true;
}

function normalise(ref: string): string {
  return ref.split("?")[0]!.split("#")[0]!.replace(/^\.\//, "").replace(/^\//, "");
}

async function refsIn(file: string): Promise<string[]> {
  const html = await readFile(join(root, file), "utf8");
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)) {
    const ref = normalise(match[1]!);
    if (isLocalRef(ref)) found.add(ref);
  }
  return [...found];
}

describe("sync-landing ENTRIES", () => {
  it("carries every entry point itself", () => {
    for (const page of entryPoints) {
      expect(isCarried(page), `${page} is an entry point but is not in ENTRIES`).toBe(true);
    }
  });

  it.each(["index.html", "productos.html"])("carries everything %s references", async (page) => {
    const missing: string[] = [];
    for (const ref of await refsIn(page)) {
      if (!isCarried(ref)) missing.push(ref);
    }
    expect(missing, `${page} references files that sync-landing never copies`).toEqual([]);
  });

  it("carries the catalogue data that catalog.js fetches at load", async () => {
    const js = await readFile(join(root, "catalog.js"), "utf8");
    const fetched = [...js.matchAll(/fetch\(\s*['"`]([^'"`]+)['"`]/g)]
      .map((m) => normalise(m[1]!))
      .filter(isLocalRef);

    // If this is empty the assertion below would pass vacuously and the test
    // would quietly stop protecting anything.
    expect(fetched.length).toBeGreaterThan(0);

    for (const ref of fetched) {
      expect(isCarried(ref), `catalog.js fetches ${ref}, which ENTRIES does not carry`).toBe(true);
    }
  });

  it("does not list anything the source tree no longer has", async () => {
    const { access } = await import("node:fs/promises");
    for (const entry of entries) {
      await expect(
        access(join(root, entry)),
        `ENTRIES lists ${entry}, which does not exist in apps/sick-clone-ui`,
      ).resolves.toBeUndefined();
    }
  });
});
