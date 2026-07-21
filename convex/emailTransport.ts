// The email transport seam (#33).
//
// Auth logic is separated from email delivery so that development does not
// depend on inbox delivery, and so the eventual move to a verified sending
// domain (#22) is a configuration change rather than a refactor.
//
// This seam is not an optimization: `@convex-dev/auth`'s `Email` provider
// requires a `sendVerificationRequest` implementation, so delivery is our
// code either way.

/** A magic-link email, reduced to what any transport needs to deliver it. */
export type MagicLinkMessage = {
  to: string;
  from: string;
  url: string;
};

export type EmailTransport = (message: MagicLinkMessage) => Promise<void>;

/**
 * Writes the magic link to the server log instead of sending it.
 *
 * This is what makes local development possible without a verified domain:
 * any address can sign in because nothing is delivered.
 */
export const consoleTransport =
  (log: (line: string) => void = console.log): EmailTransport =>
  async ({ to, url }) => {
    log(`[auth] magic link for ${to}: ${url}`);
  };

/**
 * Sends the magic link through Resend's REST API.
 *
 * Uses `fetch` directly rather than the `resend` SDK: the request is a single
 * POST, and Convex functions run on an edge-like runtime where `fetch` is the
 * lowest-friction option. `fetchImpl` is injectable so the wiring is testable
 * without a network call.
 */
export const resendTransport =
  (apiKey: string, fetchImpl: typeof fetch = fetch): EmailTransport =>
  async ({ to, from, url }) => {
    // Trim at the header boundary: a value set via `npx convex env set` keeps a
    // trailing \r, and `Bearer re_...\r` is an unparseable header value (#40).
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: "Your sign-in link",
        text: `Sign in by opening this link:\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
      }),
    });

    if (!response.ok) {
      // Surface Resend's own message — a 403 here is the unverified-domain
      // case (#22), and a silent failure would look like a lost email.
      const detail = await response.text();
      throw new Error(`Resend send failed (${response.status}): ${detail}`);
    }
  };

/** Selects a transport by name. Unknown names fail loudly rather than
 * silently falling back to a transport the operator did not ask for. */
export function resolveTransport(
  name: string,
  apiKey?: string,
): EmailTransport {
  switch (name) {
    case "console":
      return consoleTransport();
    case "resend":
      // A whitespace-only key (e.g. a stray \r) is "not configured": fail with a
      // named error rather than handing `fetch` a `Bearer \r` header (#40).
      if (!apiKey?.trim()) {
        throw new Error(
          "RESEND_API_KEY is not set — required by the resend transport",
        );
      }
      return resendTransport(apiKey);
    default:
      throw new Error(
        `Unknown AUTH_EMAIL_TRANSPORT "${name}" (expected "console" or "resend")`,
      );
  }
}

/** The `from` address, always read from configuration — never hardcoded, so
 * the #22 domain swap is an env change. */
export function senderAddress(env: Record<string, string | undefined>): string {
  // Trim at the config-read boundary so no stray \r reaches the JSON body; an
  // all-whitespace value is treated the same as unset (#40).
  const from = env.AUTH_EMAIL_FROM?.trim();
  if (!from) {
    throw new Error(
      "AUTH_EMAIL_FROM is not set — the magic-link sender address must be configured",
    );
  }
  return from;
}
