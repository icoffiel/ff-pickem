import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { readEnvVar } from "./scripts/lib/env-file.mjs";

// e2e config for the browser-auth flow (#39). Two backing servers:
//  - `next dev` (started here as a webServer) serves the app.
//  - `convex dev` (started in global-setup) pushes functions and streams the
//    server log the magic-link test tails.

// Each worktree pins its own Next dev port (`npm run setup:worktree`) so its
// deployment's SITE_URL keeps naming the right origin; the suite has to visit
// the same origin the magic links point at. 3000 is what `next dev` falls back
// to when nothing is pinned.
//
// `.env.local` is resolved from this file, not the cwd, so running the suite
// from a subdirectory can't silently fall back to 3000 while `next dev` serves
// the pinned port. `Number` rather than `??`, because a blank `PORT=` line —
// what `.env.example` ships — parses as "" and would build `http://localhost:`.
const pinnedPort = Number(
  readEnvVar(
    existsSync(path.join(__dirname, ".env.local"))
      ? readFileSync(path.join(__dirname, ".env.local"), "utf8")
      : "",
    "PORT",
  ),
);
const baseURL = `http://localhost:${Number.isInteger(pinnedPort) && pinnedPort > 0 ? pinnedPort : 3000}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:frontend",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
