import { readFileSync } from "node:fs";

import { CONVEX_LOG } from "./paths";

// The console transport writes `[auth] magic link for <email>: <url>` to the
// server log (convex/emailTransport.ts). global-setup tees that log to a file;
// this reads the link back out for a given recipient.

/** Polls the captured server log for the newest magic link issued to `email`. */
export async function waitForMagicLink(
  email: string,
  timeoutMs = 30_000,
): Promise<string> {
  const marker = `magic link for ${email}:`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const line = readFileSync(CONVEX_LOG, "utf8")
      .split("\n")
      .reverse()
      .find((l) => l.includes(marker));
    if (line) {
      // The log wraps the message in quotes (`[LOG] '...url'`), so stop at the
      // first quote/whitespace rather than dragging the closing quote into the
      // code param.
      const url = line
        .slice(line.indexOf("http"))
        .match(/^https?:\/\/[^\s'"]+/);
      if (url) return url[0];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `No magic link for ${email} appeared in ${CONVEX_LOG} within ${timeoutMs}ms`,
  );
}
