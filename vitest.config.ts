import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions run on an edge-like runtime; convex-test needs a
    // matching environment. See https://docs.convex.dev/testing/convex-test.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The Playwright suite lives in e2e/ and runs via `npm run test:e2e`; keep
    // Vitest from loading its specs (they import @playwright/test).
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
