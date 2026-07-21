import { join } from "node:path";

// Playwright runs from the project root, so anchor artifacts there. The convex
// log is where global-setup tees `convex dev` output and where the magic-link
// reader tails for issued links.
export const ARTIFACT_DIR = join(process.cwd(), "e2e", ".artifacts");
export const CONVEX_LOG = join(ARTIFACT_DIR, "convex.log");
