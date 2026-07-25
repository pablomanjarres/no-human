// Flat ESLint config for the no-human monorepo.
//
// Kept intentionally minimal for 0.0.1:
//   - no import/order (too heavy for placeholder packages)
//   - no-explicit-any downgraded to warn (placeholder packages need `any`)
//
// Revisit after the first real PR cycle.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/dist/**", "**/.next/**", "**/.turbo/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
