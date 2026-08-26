import { v } from "convex/values";

import { Id } from "./_generated/dataModel";
import { query, QueryCtx } from "./_generated/server";
import { seasonBoard, weeklyBoard } from "./board";
import { leagueOf, requireMembership } from "./membership";

// Standings' Convex seam. Everything here is I/O — read the league's rows,
// hand them to the folds in `board.ts`, return what comes back. There is no
// standings table and no scheduled recompute: a board is derived on every read,
// so a corrected result or a reactivated member re-renders it through query
// reactivity with nothing to invalidate (`weekly-loop.md` §7).
//
// Both queries are membership-gated (ADR 0001 rule 2) and neither takes a
// clock: nothing here widens or narrows with time, only with the games. What a
// board discloses is scores, never selections — and a member's tiebreaker guess
// is withheld until the designated game finals, which is necessarily after the
// week locked, so no board can leak a live guess (ADR 0001 rule 5).

/** Everything a league's boards are folded from, for one week or all of them. */
async function leagueRows(ctx: QueryCtx, leagueId: Id<"leagues">) {
  const league = await leagueOf(ctx, leagueId);
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .collect();
  return { league, memberships };
}

/**
 * One week's ranked board: who won it, and who is tied with whom.
 *
 * The week is an argument rather than "the current one" — a standings screen is
 * a thing you page back through, and the active week is the make-picks screen's
 * question, not this one's.
 */
export const weeklyStandings = query({
  args: { leagueId: v.id("leagues"), week: v.number() },
  handler: async (ctx: QueryCtx, args) => {
    await requireMembership(ctx, args.leagueId);
    const { league, memberships } = await leagueRows(ctx, args.leagueId);

    const games = await ctx.db
      .query("games")
      .withIndex("by_season_week", (q) =>
        q.eq("season", league.season).eq("week", args.week),
      )
      .collect();
    const picks = await ctx.db
      .query("picks")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", args.leagueId).eq("week", args.week),
      )
      .collect();
    const overrides = await ctx.db
      .query("resultOverrides")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", args.leagueId).eq("week", args.week),
      )
      .collect();
    const guesses = await ctx.db
      .query("tiebreakerGuesses")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", args.leagueId).eq("week", args.week),
      )
      .collect();

    return weeklyBoard({
      memberships,
      games,
      picks,
      overrides,
      guesses,
      rules: league.rules,
    });
  },
});

/**
 * The season's ranked board: cumulative correct picks, co-champions on a tie.
 *
 * Every read walks the whole season — a league's picks are a few thousand rows
 * at most and the games are ~272, so the walk is cheaper than any cache would
 * be to keep honest. Each index is read on its `leagueId` prefix alone, which
 * is one range read per table rather than one per week.
 *
 * No guesses are read: the weekly tiebreaker settles a week and is deliberately
 * given no path into a season total.
 */
export const seasonStandings = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx: QueryCtx, args) => {
    await requireMembership(ctx, args.leagueId);
    const { league, memberships } = await leagueRows(ctx, args.leagueId);

    const games = await ctx.db
      .query("games")
      .withIndex("by_season_week", (q) => q.eq("season", league.season))
      .collect();
    const picks = await ctx.db
      .query("picks")
      .withIndex("by_league_week", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const overrides = await ctx.db
      .query("resultOverrides")
      .withIndex("by_league_week", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return seasonBoard({
      memberships,
      games,
      picks,
      overrides,
      rules: league.rules,
    });
  },
});
