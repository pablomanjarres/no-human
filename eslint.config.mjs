// Flat ESLint config for the no-human monorepo.
//
// Kept intentionally minimal for 0.0.1:
//   - no import/order (too heavy for placeholder packages)
//   - no-explicit-any downgraded to warn (placeholder packages need `any`)
//
// Revisit after the first real PR cycle.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Environments are spelled out rather than pulled from the `globals` package to avoid adding a
// dependency just to name a dozen identifiers. Without these, `no-undef` fires on every use of
// `process` in scripts/ and every use of `document` in a browser file.
const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  URL: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

const BROWSER_GLOBALS = {
  document: "readonly",
  window: "readonly",
  localStorage: "readonly",
  fetch: "readonly",
  history: "readonly",
  location: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  Intl: "readonly",
};

export default [
  {
    ignores: ["**/dist/**", "**/.next/**", "**/.turbo/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // repo-level operational scripts and flat configs run in Node
    files: ["scripts/**/*.mjs", "*.config.mjs"],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    // static frontends ship these files straight to the browser
    files: ["apps/**/*.js"],
    languageOptions: { globals: BROWSER_GLOBALS },
  },
  {
    files: ["**/*.test.{js,mjs}"],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
