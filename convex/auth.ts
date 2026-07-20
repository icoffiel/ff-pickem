// Named export, despite the package's own doc comment showing a default
// import — verified against the installed 0.0.94 build.
import { Email } from "@convex-dev/auth/providers/Email";
import { convexAuth } from "@convex-dev/auth/server";
import { resolveTransport, senderAddress } from "./emailTransport";

// Magic-link auth (#16). Delivery goes through the transport seam (#33) so
// development needs no verified sending domain (#22).

/** Default transport. `console` is the safe default: an unconfigured
 * deployment writes links to the log rather than making unintended real
 * sends. Production must set AUTH_EMAIL_TRANSPORT=resend explicitly. */
const DEFAULT_TRANSPORT = "console";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Email({
      // Magic-link behavior: the token alone is sufficient. Without this key
      // being *explicitly present*, the provider defaults to OTP semantics and
      // requires a matching `email` at verification — which breaks opening the
      // link in a different browser from the one that started sign-in, i.e.
      // exactly the copy-link-from-the-log workflow the console transport
      // exists for. The library merges `options` over its defaults with a
      // `for...in`, so a present-but-undefined key clears it; omitting the key
      // does not.
      authorize: undefined,

      sendVerificationRequest: async ({ identifier, url }) => {
        // Read at send time, not module load: an unset AUTH_EMAIL_FROM should
        // fail the send with a named error, not break every function in the
        // deployment at import.
        const transport = resolveTransport(
          process.env.AUTH_EMAIL_TRANSPORT ?? DEFAULT_TRANSPORT,
          process.env.RESEND_API_KEY,
        );
        await transport({
          to: identifier,
          from: senderAddress(process.env),
          url,
        });
      },
    }),
  ],
});
