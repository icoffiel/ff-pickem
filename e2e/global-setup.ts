import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { ARTIFACT_DIR, CONVEX_LOG } from "./paths";

// The magic-link e2e (#39) needs the link the console transport writes to the
// Convex *server* log. `convex dev` is the only thing that streams those logs
// locally, so run it for the duration of the suite and tee its output to a file
// the test can tail. It also pushes the current functions to the dev deployment
// so the browser calls the code under test, not a stale push.

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(CONVEX_LOG, ""); // start each run from an empty log

  const out = createWriteStream(CONVEX_LOG, { flags: "a" });
  const child = spawn("npx", ["convex", "dev"], {
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);

  await waitFor(
    () =>
      /Convex functions ready|ready!/i.test(readFileSync(CONVEX_LOG, "utf8")),
    120_000,
    "`convex dev` to finish its first push",
  );

  return async () => {
    if (!child.pid) return;
    // `npx convex dev` spawns a child node process; kill the whole tree so no
    // convex watcher is left running after the suite.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      child.kill("SIGTERM");
    }
  };
}
