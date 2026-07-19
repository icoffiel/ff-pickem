import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions run on an edge-like runtime; convex-test needs a
    // matching environment. See https://docs.convex.dev/testing/convex-test.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
