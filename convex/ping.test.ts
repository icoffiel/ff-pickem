/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";

// The reusable Convex-function seam (build-spec M0 / issue #24): exercises the
// `ping` query through convex-test — in-process, no deployment, no browser.
// Every later milestone (M2/M4/M5) reuses this pattern for its own functions.
const modules = import.meta.glob("./**/*.ts");

test("ping.get returns its constant through the convex-test seam", async () => {
  const t = convexTest(undefined, modules);
  const result = await t.query(api.ping.get, {});
  expect(result).toBe("pong");
});
