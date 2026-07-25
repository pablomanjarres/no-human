/**
 * @no-human/core
 *
 * Placeholder package. It exists so the workspace, the turbo task graph, and
 * CI all have something real to run before the first feature lands — delete
 * or repurpose it once the actual domain packages exist.
 *
 * Conventions worth copying into every new package:
 *   - ESM only (`"type": "module"`), `.js` extensions on relative imports
 *   - `tsconfig.json` type-checks (noEmit), `tsconfig.build.json` emits to dist/
 *   - `exports` maps to dist/ for consumers, src/ as the dev fallback
 */

export const PACKAGE_NAME = "@no-human/core";

/** Build-time marker so downstream packages can assert they linked the workspace copy. */
export function packageInfo(): { name: string; version: string } {
  return { name: PACKAGE_NAME, version: "0.0.1-alpha.0" };
}
