#!/usr/bin/env node
/**
 * `npm run setup:worktree` — give this worktree its own isolated Convex backend.
 *
 * A fresh worktree starts with no Convex configuration (`.env.local` and
 * `.convex/` are both git-ignored), so `npm run dev` has no backend to talk to.
 * Copying `.env.local` across from another checkout is the wrong fix: it points
 * two branches at one shared deployment, where divergent schemas and data
 * quietly stomp on each other. Several checks below exist to catch exactly that
 * copy and refuse to build on top of it.
 *
 * This provisions a **local** deployment instead — state in a SQLite file under
 * `.convex/`, running only as a subprocess of `convex dev`. See
 * `docs/deploy/worktree-backends.md` for why local is the default, when to
 * reach for a cloud dev deployment, and how to tear one down.
 *
 * Non-interactive and safe to re-run: every step checks for the state it would
 * create before creating it.
 *
 * `--cloud` opts into configuring an already-selected *cloud* deployment.
 * Without it this refuses to write to one, because the selection may be a
 * shared deployment inherited from a copied `.env.local`, and writing
 * `SITE_URL` there would redirect everyone else's magic links at this machine.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { readEnvVar, upsertEnvVar } from "./lib/env-file.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ENV_LOCAL = path.join(REPO_ROOT, ".env.local");
/** The CLI's own record of this directory's local deployment. */
const LOCAL_DEPLOYMENT_CONFIG = path.join(
  REPO_ROOT,
  ".convex",
  "local",
  "default",
  "config.json",
);
/** Run the CLI's entry point on this Node, so no shell or `npx` is involved. */
const CONVEX_CLI = path.join(
  REPO_ROOT,
  "node_modules",
  "convex",
  "bin",
  "main.js",
);

// A fresh worktree has no configuration to infer the project from, so the slugs
// have to be supplied. Neither is a secret; both are overridable for a fork or
// a second Convex project.
const TEAM = process.env.CONVEX_TEAM ?? "iain-coffield";
const PROJECT = process.env.CONVEX_PROJECT ?? "ff-pickem";

const ALLOW_CLOUD = process.argv.slice(2).includes("--cloud");

const FIRST_DEV_PORT = 3000;
const LAST_DEV_PORT = 3099;
const BACKEND_READY_TIMEOUT_MS = 120_000;
const SITE_URL_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;
const PORT_PROBE_TIMEOUT_MS = 1_000;

const step = (message) => console.log(`\n▶ ${message}`);
const done = (message) => console.log(`✔ ${message}`);
const warn = (...lines) => console.log(`\n! ${lines.join("\n  ")}`);

function readEnvLocal() {
  return existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : "";
}

function writeEnvVar(name, value, comment) {
  writeFileSync(ENV_LOCAL, upsertEnvVar(readEnvLocal(), name, value, comment));
}

/** A positive integer, or null for missing, blank or malformed input. */
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Run a Convex CLI command to completion, failing the script if it fails. With
 * `capture`, the command's output is attached to the thrown error instead of
 * going straight to the terminal, so a caller that retries can stay quiet about
 * attempts that are about to be tried again.
 */
function convex(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [CONVEX_CLI, ...args], {
    cwd: REPO_ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const error = new Error(
      `\`convex ${args.join(" ")}\` exited with ${result.status}`,
    );
    error.output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw error;
  }
  return result.stdout ?? "";
}

/**
 * Run `action` until it stops throwing. The output of every attempt but the
 * last is swallowed; the last failure is reported in full and rethrown.
 */
async function withRetries(attempts, action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts) {
        process.stderr.write(error.output ?? "");
        throw error;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Step 1 — an isolated deployment, selected in `.env.local`.
 *
 * Returns what this worktree is now pointed at: `"local"` (ours, safe to
 * configure), `"cloud"` (someone's cloud deployment, and `--cloud` says to
 * configure it anyway), or `"foreign"` (a selection this worktree should not
 * write to).
 */
function ensureDeployment() {
  const selected = readEnvVar(readEnvLocal(), "CONVEX_DEPLOYMENT");
  // The CLI keeps a local deployment's admin key and database here. Without it,
  // a `local:` selection names a backend belonging to some other directory —
  // which is what a copied `.env.local` looks like.
  const ownsLocalState = existsSync(LOCAL_DEPLOYMENT_CONFIG);

  if (selected?.startsWith("local:")) {
    if (ownsLocalState) {
      done(`Already on an isolated local deployment: ${selected.slice(6)}`);
      return "local";
    }
    warn(
      `.env.local selects ${selected}, but this worktree has no .convex state`,
      `for it — the file was copied from another checkout. That deployment`,
      `belongs to that checkout; provisioning one of our own instead.`,
    );
  } else if (selected) {
    if (ALLOW_CLOUD) {
      done(`Configuring the selected cloud deployment: ${selected}`);
      return "cloud";
    }
    // Could be a deliberate per-worktree cloud deployment, or a copied
    // `.env.local` naming a deployment other people share. They are
    // indistinguishable from here, and the second is the dangerous one.
    warn(
      `.env.local selects ${selected}, which is not a local deployment.`,
      `Refusing to reconfigure it: if that came from copying .env.local, it is`,
      `shared, and setting SITE_URL on it would point other people's magic`,
      `links at this machine.`,
      ``,
      `  For an isolated backend:  delete .env.local and re-run`,
      `  If it is deliberately this worktree's cloud deployment:`,
      `                            npm run setup:worktree -- --cloud`,
    );
    return "foreign";
  }

  if (ownsLocalState) {
    step("Re-selecting this worktree's existing local deployment");
    convex(["deployment", "select", `${TEAM}:${PROJECT}:local`]);
    return "local";
  }
  step("Creating an isolated local deployment for this worktree");
  convex(["deployment", "create", `${TEAM}:${PROJECT}:local`, "--select"]);
  return "local";
}

/**
 * Free means "nothing is listening there right now".
 *
 * Asked by trying to *connect*, not by trying to bind: Node sets SO_REUSEADDR
 * on its servers, and on Windows that lets a second process bind a port another
 * one is already listening on. A bind probe there reports every port free, and
 * the second worktree happily pins a port the first is serving on.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settle = (free) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(false));
    // Unanswered rather than refused: treat as taken rather than race for it.
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(true));
  });
}

/**
 * The ports the other checkouts of this repository have already pinned.
 *
 * A listening socket only reveals a worktree that happens to be running; the
 * whole point of pinning is that the port stays this worktree's while it is
 * stopped. So the claims are read from where they are recorded — each sibling's
 * own `.env.local` — with `git worktree list` as the authority on who the
 * siblings are.
 */
function portsClaimedBySiblings() {
  const listing = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (listing.status !== 0) return new Set();

  const claimed = new Set();
  for (const line of listing.stdout.split(/\r?\n/)) {
    const match = line.match(/^worktree (.+)$/);
    if (!match) continue;
    const sibling = path.resolve(match[1].trim());
    if (sibling === REPO_ROOT) continue;
    const envLocal = path.join(sibling, ".env.local");
    if (!existsSync(envLocal)) continue;
    const port = positiveInteger(
      readEnvVar(readFileSync(envLocal, "utf8"), "PORT"),
    );
    if (port !== null) claimed.add(port);
  }
  return claimed;
}

/**
 * Step 2 — a stable dev origin for this worktree.
 *
 * `SITE_URL` has to name the origin the browser actually visits, so the port
 * cannot be whatever Next happens to fall back to on the day. It is pinned once,
 * here, and `dev:frontend` feeds it back to Next via `dotenv -e .env.local`,
 * which puts PORT in the environment before Next's CLI reads it.
 */
async function ensurePinnedPort() {
  const claimed = portsClaimedBySiblings();
  const existing = positiveInteger(readEnvVar(readEnvLocal(), "PORT"));
  if (existing !== null && !claimed.has(existing)) {
    done(`Next dev port already pinned for this worktree: ${existing}`);
    return existing;
  }
  if (existing !== null) {
    warn(
      `PORT=${existing} is already claimed by another checkout of this repo,`,
      `so it cannot be this worktree's. Pinning a different one.`,
    );
  }

  step("Pinning a Next dev port for this worktree");
  for (let port = FIRST_DEV_PORT; port <= LAST_DEV_PORT; port++) {
    if (claimed.has(port)) continue;
    if (!(await isPortFree(port))) continue;
    writeEnvVar(
      "PORT",
      String(port),
      "# The Next dev port for this worktree, pinned by `npm run setup:worktree`\n# so SITE_URL on its Convex deployment keeps naming the right origin.",
    );
    done(`Pinned Next dev port: ${port}`);
    return port;
  }
  throw new Error(
    `No free port between ${FIRST_DEV_PORT} and ${LAST_DEV_PORT} for the Next dev server`,
  );
}

/**
 * A local backend exists only while `convex dev` runs, and `convex env set`
 * will not start one — so step 3 holds a dev session open for as long as it
 * takes to write one variable.
 */
function startDevSession() {
  const output = [];
  const child = spawn(
    process.execPath,
    [CONVEX_CLI, "dev", "--typecheck", "disable", "--tail-logs", "disable"],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group on POSIX, so the whole tree can be signalled.
      // Windows has no process groups to detach into, and would open a console.
      detached: process.platform !== "win32",
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  return { child, output: () => Buffer.concat(output).toString("utf8") };
}

function stopDevSession(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // No signals on Windows: `convex dev`'s own cleanup cannot be triggered
    // from outside, so the tree — the CLI and the backend it spawned — is
    // killed directly. The backend's SQLite state survives an abrupt stop.
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {
    // Already gone between the check above and here.
  }
}

/** The deployment `.env.local` currently selects, without its `local:` prefix. */
function selectedDeploymentName() {
  const selected = readEnvVar(readEnvLocal(), "CONVEX_DEPLOYMENT") ?? "";
  return selected.split(":").pop() ?? "";
}

/**
 * Resolve once *this worktree's* backend answers.
 *
 * The identity check is the point: on a re-run the URL in `.env.local` can
 * still be the one from last time, and another worktree's backend may be
 * answering on it now. A 200 from the wrong deployment would send us on to
 * write SITE_URL before our own backend had finished starting.
 */
async function waitForBackend(session) {
  const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (session.child.exitCode !== null) {
      throw new Error(
        `\`convex dev\` exited with ${session.child.exitCode} before the backend was ready:\n${session.output()}`,
      );
    }
    // `convex dev` writes this once it has a backend to point the client at.
    const url = readEnvVar(readEnvLocal(), "NEXT_PUBLIC_CONVEX_URL");
    const expected = selectedDeploymentName();
    if (url && expected) {
      try {
        const response = await fetch(`${url}/instance_name`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok && (await response.text()).trim() === expected) {
          return url;
        }
      } catch {
        // Not listening yet.
      }
    }
    await sleep(500);
  }
  throw new Error(
    `The local backend was not ready within ${BACKEND_READY_TIMEOUT_MS / 1000}s:\n${session.output()}`,
  );
}

/**
 * Step 3 — `SITE_URL`, the one auth variable the project defaults cannot supply
 * (#73): the magic link is opened against this worktree's own origin.
 */
async function setSiteUrl(origin, target) {
  step(`Setting SITE_URL on this worktree's deployment`);
  if (target === "cloud") {
    // A cloud deployment is always reachable, so it needs no dev session — and
    // starting one would push this branch's functions to it as a side effect of
    // a command whose job is configuration.
    convex(["env", "set", "SITE_URL", origin]);
    done(`SITE_URL=${origin}`);
    return;
  }

  const session = startDevSession();
  const stop = () => stopDevSession(session.child);
  // A default-handled SIGINT skips `exit` listeners, so Ctrl-C here would leave
  // the backend running — the one thing a local deployment promises not to do.
  const stopAndExit = () => {
    stop();
    process.exit(130);
  };
  process.on("exit", stop);
  process.on("SIGINT", stopAndExit);
  process.on("SIGTERM", stopAndExit);
  try {
    await waitForBackend(session);
    // The backend answering is not quite the same as the backend being idle:
    // the dev session that started it is pushing functions at the same time,
    // and a write that lands mid-push comes back as an OCC failure. That is
    // exactly the transient the retry is for.
    await withRetries(SITE_URL_ATTEMPTS, () =>
      convex(["env", "set", "SITE_URL", origin], { capture: true }),
    );
    done(`SITE_URL=${origin}`);
  } finally {
    stop();
    process.off("exit", stop);
    process.off("SIGINT", stopAndExit);
    process.off("SIGTERM", stopAndExit);
  }
}

async function main() {
  const target = ensureDeployment();
  const port = await ensurePinnedPort();
  if (target === "foreign") {
    warn(
      `Stopping after pinning port ${port}: SITE_URL was not set, so a magic`,
      `link from this worktree would not open this worktree's app.`,
    );
    process.exitCode = 1;
    return;
  }
  await setSiteUrl(`http://localhost:${port}`, target);
  console.log(
    `\nThis worktree is ready. \`npm run dev\` serves it on http://localhost:${port}.`,
  );
}

await main();
