import { getAuthUserId } from "@convex-dev/auth/server";

import { query } from "./_generated/server";

/**
 * The signed-in caller's own identity, or `null` when nobody is signed in.
 *
 * The browser's signed-in view (#39) needs the user's email, which the auth
 * session alone does not carry — `useConvexAuth` reports only *whether* a
 * session exists. Kept lean (email only) because that is all a `users` row
 * holds; a person's display name is the per-league `membership.teamName`.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      return null;
    }
    return { email: user.email };
  },
});
