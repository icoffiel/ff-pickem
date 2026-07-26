import { readFileSync } from "node:fs";

import { CONVEX_LOG } from "./paths";

// The console transport writes `[auth] magic link for <email>: <url>` to the
// server log (convex/emailTransport.ts). global-setup tees that log to a file;
// this reads links back out for a given recipient.
//
// Invite emails (convex/inviteEmail.ts) go through the same transport, so both
// kinds of link reach the log under the same marker. `wanted` is what tells a
// sign-in link apart from an `/invite/<token>` deep-link for one address.

// A sign-in link carries the verification `code`; an invite deep-link does not.
// Path is not the discriminator — signing in from `/invite/<token>` passes that
// path as `redirectTo`, so the sign-in link is itself an `/invite/<token>?code=`
// URL (observed in the Convex dev log).
const isSignInLink = (url: string) => new URL(url).searchParams.has("code");

/** Polls the captured server log for the newest wanted link issued to `email`. */
async function waitForLink(
  email: string,
  wanted: (url: string) => boolean,
  description: string,
  timeoutMs: number,
): Promise<string> {
  const marker = `magic link for ${email}:`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = readFileSync(CONVEX_LOG, "utf8")
      .split("\n")
      .reverse()
      .filter((line) => line.includes(marker))
      // The log wraps the message in quotes (`[LOG] '...url'`), so stop at the
      // first quote/whitespace rather than dragging the closing quote into the
      // code param.
      .map(
        (line) =>
          line.slice(line.indexOf("http")).match(/^https?:\/\/[^\s'"]+/)?.[0],
      )
      .find((candidate) => candidate !== undefined && wanted(candidate));
    if (url) return url;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `No ${description} for ${email} appeared in ${CONVEX_LOG} within ${timeoutMs}ms`,
  );
}

/** The newest sign-in link issued to `email`. */
export function waitForMagicLink(email: string, timeoutMs = 30_000) {
  return waitForLink(email, isSignInLink, "sign-in link", timeoutMs);
}

/** The newest `/invite/<token>` deep-link issued to `email`. */
export function waitForInviteLink(email: string, timeoutMs = 30_000) {
  return waitForLink(
    email,
    (url) => url.includes("/invite/") && !isSignInLink(url),
    "invite link",
    timeoutMs,
  );
}
