import { v } from "convex/values";

import { internalAction } from "./_generated/server";
import { resolveTransport, senderAddress } from "./emailTransport";

// The invite email (#59). Decoupled from auth: this is a plain app link to
// `/invite/<token>`, sent through the same transport seam as the magic link
// (#33) so dev needs no verified sending domain. Isolated in an internal action
// — scheduled by `createInvite` — so the mutation's invariants stay pure and
// testable and only this un-testable I/O lives outside `convex-test`.

/** Default transport. `console` is the safe default (mirrors `auth.ts`): an
 * unconfigured deployment logs the link rather than making unintended sends. */
const DEFAULT_TRANSPORT = "console";

export const sendInviteEmail = internalAction({
  args: { token: v.string(), targetEmail: v.string() },
  handler: async (_ctx, args) => {
    // SITE_URL is set by Convex Auth for every deployment; the invite link is a
    // plain deep-link into the app, not an auth URL.
    const siteUrl = process.env.SITE_URL;
    if (!siteUrl) {
      throw new Error(
        "SITE_URL is not set — required to build the invite link",
      );
    }
    const url = `${siteUrl.replace(/\/$/, "")}/invite/${args.token}`;

    // Read at send time, not module load, so an unset AUTH_EMAIL_FROM fails this
    // send with a named error rather than breaking every function at import.
    const transport = resolveTransport(
      process.env.AUTH_EMAIL_TRANSPORT ?? DEFAULT_TRANSPORT,
      process.env.RESEND_API_KEY,
    );
    await transport({
      to: args.targetEmail,
      from: senderAddress(process.env),
      url,
    });
  },
});
