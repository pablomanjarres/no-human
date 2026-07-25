import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The `@/` alias is a tsconfig path, which vitest does not read on its own.
 * Without this the lib modules resolve in Next and nowhere else, which is how a
 * package with a vitest dependency ends up with no tests that can import it.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
