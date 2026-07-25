import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { CURRENT_SEASON, DEFAULT_RULES } from "./config";

/**
 * Create a single-season league and be born its commissioner.
 *
 * One atomic mutation realizes "the commissioner is the creator": the league
 * row and the creator's active-commissioner membership are written together, so
 * a league can never exist without exactly one commissioner. Season and rules
 * come from `config` — not the caller — because they are fixed this loop.
 */
export const createLeague = mutation({
  args: { name: v.string(), teamName: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NotSignedIn" });
    }

    const name = args.name.trim();
    const teamName = args.teamName.trim();
    if (name === "" || teamName === "") {
      throw new ConvexError({ code: "EmptyField" });
    }

    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name,
      season: CURRENT_SEASON,
      rules: DEFAULT_RULES,
      createdAt: now,
    });
    await ctx.db.insert("memberships", {
      userId,
      leagueId,
      role: "commissioner",
      status: "active",
      teamName,
      joinedAt: now,
    });

    return leagueId;
  },
});

/**
 * The leagues the signed-in caller belongs to, via their memberships. Returns
 * `[]` for a signed-out caller — the home screen renders the same empty shell
 * either way. Scoped by walking `memberships.by_user`, so a caller never sees a
 * league they have no membership in.
 */
export const myLeagues = query({
  args: {},
  handler: async (ctx): Promise<Doc<"leagues">[]> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const leagues = await Promise.all(
      memberships.map((m) => ctx.db.get(m.leagueId)),
    );
    return leagues.filter(
      (league): league is Doc<"leagues"> => league !== null,
    );
  },
});
