import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Flat config (ESLint 9). Design: docs/design/linting.md.
// ESLint judges code; Prettier judges layout (eslint-config-prettier spread last).
export default defineConfig([
  // Generated/build output is never linted. Convex's _generated is also excluded
  // so the root tsconfig's `**/*` include can't double-claim it under projectService.
  globalIgnores([
    "convex/_generated/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // Next.js presets: core-web-vitals + the TypeScript ruleset (registers the
  // @typescript-eslint plugin and parser).
  ...nextCoreWebVitals,
  ...nextTypescript,

  // The payload: hand-picked type-aware async rules. `no-floating-promises`
  // catches an un-awaited Convex mutation that silently no-ops (a pick that
  // never saves, a lock that never enforces) — invisible to tsc. Deliberately
  // NOT recommendedTypeChecked / no-unsafe-* (too noisy against Convex _generated).
  {
    name: "ff-pickem/type-aware-async",
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Auto-maps each file to its nearest tsconfig:
        // app/* -> tsconfig.json, convex/* -> convex/tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },

  // Must be last: disables every ESLint rule that overlaps Prettier's formatting.
  eslintConfigPrettier,
]);
