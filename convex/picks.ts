import { ConvexError, v } from "convex/values";

import { Doc, Id } from "./_generated/dataModel";
import { mutation, MutationCtx, query, QueryCtx } from "./_generated/server";
import { effectiveOutcome, gradePick } from "./grading";
import { requireMembership } from "./membership";
import { activeWeek, lock, slate, tiebreakerGame } from "./week";

// The pick / lock / grade core's Convex seam. The rules themselves live in
// `week.ts` and `grading.ts`, pure and separately tested; what only exists here
// is the part that needs a database and a clock — whether the week is still
// open, and one row per (membership, game). Who may write is `membership.ts`:
// `requireMembership` is ADR 0001 rules 1 and 2, so nobody picks as someone
// else and a removed member submits nothing (#12).

/** The league behind a membership the caller has already been granted. */
async function leagueOf(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"leagues">> {
  const league = await ctx.db.get(leagueId);
  if (league === null) {
    throw new ConvexError({ code: "NotMember" });
  }
  return league;
}

/** One week's counted games, in kickoff order off the index. */
async function weekSlate(
  ctx: QueryCtx,
  league: Doc<"leagues">,
  week: number,
): Promise<Doc<"games">[]> {
  const games = await ctx.db
    .query("games")
    .withIndex("by_season_week", (q) =>
      q.eq("season", league.season).eq("week", week),
    )
    .collect();
  return slate(games, league.rules);
}

/**
 * Refuse the write if the week's picks have frozen.
 *
 * The lock is recomputed here from the slate's *current* kickoffs, so a flexed
 * game moves the deadline with it, and `Date.now()` is read **inside the
 * mutation** — the server clock is the authority for a state transition, never a
 * caller's argument and never a flag some cron flipped a minute ago
 * (ADR 0002 rule 1). Millisecond-exact, and identical for picks and for the
 * tiebreaker guess: one deadline covers the whole week's submission.
 */
function refuseIfLocked(slate: readonly Doc<"games">[]): void {
  const locksAt = lock(slate);
  if (locksAt === undefined) {
    throw new ConvexError({ code: "NoSlate" });
  }
  if (Date.now() >= locksAt) {
    throw new ConvexError({ code: "WeekLocked" });
  }
}

/**
 * Pick the winner of one slate game, or change a pick already made.
 *
 * Members pick any subset of the slate they like — there is no "pick them all"
 * rule, and a game left alone simply grades as absent. Uniqueness is enforced
 * right here, by reading `by_membership_game` before writing: Convex has no
 * unique constraint, so re-picking a game has to find the existing row and
 * update it rather than laying down a second one.
 */
export const makePick = mutation({
  args: {
    leagueId: v.id("leagues"),
    gameId: v.id("games"),
    selection: v.union(v.literal("home"), v.literal("away")),
  },
  handler: async (ctx: MutationCtx, args) => {
    const membership = await requireMembership(ctx, args.leagueId);
    const league = await leagueOf(ctx, args.leagueId);

    const game = await ctx.db.get(args.gameId);
    if (game === null || game.season !== league.season) {
      throw new ConvexError({ code: "NotOnSlate" });
    }

    // The slate is the authority on what is pickable: a game the rule-set drops
    // is not shown, has no pick row, and cannot be reached by a hand-made call.
    const counted = await weekSlate(ctx, league, game.week);
    if (!counted.some((slateGame) => slateGame._id === game._id)) {
      throw new ConvexError({ code: "NotOnSlate" });
    }
    refuseIfLocked(counted);

    const existing = await ctx.db
      .query("picks")
      .withIndex("by_membership_game", (q) =>
        q.eq("membershipId", membership._id).eq("gameId", game._id),
      )
      .unique();

    const now = Date.now();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        selection: args.selection,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("picks", {
      membershipId: membership._id,
      gameId: game._id,
      leagueId: args.leagueId,
      // Denormalized from the game, and immutable for it: a game never changes
      // week, so the standings walk can index by (league, week) without a hop.
      week: game.week,
      selection: args.selection,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Submit or revise this week's combined-points tiebreaker guess.
 *
 * The guess is bound to the **week**, not to a game: which game it is measured
 * against is the tiebreaker policy's call at standings time, so pinning a
 * `gameId` here would be wrong. It is optional — a member who never guesses
 * simply forfeits weekly tiebreakers — and it freezes on the same deadline as
 * the picks, because one lock covers the whole week's submission.
 */
export const setTiebreakerGuess = mutation({
  args: {
    leagueId: v.id("leagues"),
    week: v.number(),
    points: v.number(),
  },
  handler: async (ctx: MutationCtx, args) => {
    const membership = await requireMembership(ctx, args.leagueId);
    const league = await leagueOf(ctx, args.leagueId);

    // A combined score: whole points, never negative. `v.number()` is a float
    // on the wire, so this is the only thing standing between the standings
    // walk and a proximity comparison against 41.5 or NaN.
    if (!Number.isInteger(args.points) || args.points < 0) {
      throw new ConvexError({ code: "InvalidGuess" });
    }

    refuseIfLocked(await weekSlate(ctx, league, args.week));

    const existing = await ctx.db
      .query("tiebreakerGuesses")
      .withIndex("by_membership_week", (q) =>
        q.eq("membershipId", membership._id).eq("week", args.week),
      )
      .unique();

    const now = Date.now();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { points: args.points, updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("tiebreakerGuesses", {
      membershipId: membership._id,
      leagueId: args.leagueId,
      week: args.week,
      points: args.points,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Everything the make-picks screen shows for one week, in a single read.
 *
 * **`now` is the caller's**, floored to the minute (`app/currentMinute.ts`).
 * A Convex query may not read the wall clock — it is re-run when its data
 * changes, never because time passed — and this read *narrows*: as the clock
 * advances a week stops being editable. A caller who lies about the time only
 * mis-renders their own screen, because `makePick` re-checks the deadline
 * against the server clock and refuses (ADR 0002 rule 3).
 *
 * Only the caller's **own** picks are here. Nobody's picks are visible to anyone
 * else in M4, so there is no `pickVisibility` reveal to time and no materialized
 * lock state to keep — the whole of the lock stays derived.
 */
export const pickSheet = query({
  args: {
    leagueId: v.id("leagues"),
    /** Omitted means the active week; a later week is picking ahead. */
    week: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx: QueryCtx, args) => {
    const membership = await requireMembership(ctx, args.leagueId);
    const league = await leagueOf(ctx, args.leagueId);

    // One walk of the league's season: a season is ~272 rows, and the active
    // week is a question about all of them.
    const seasonGames = await ctx.db
      .query("games")
      .withIndex("by_season_week", (q) => q.eq("season", league.season))
      .collect();
    const counted = slate(seasonGames, league.rules);
    const weeks = [...new Set(counted.map((game) => game.week))].sort(
      (a, b) => a - b,
    );

    const active = activeWeek(seasonGames, league.rules, args.now);
    // Once every week has locked there is no active week, so the screen settles
    // on the last week that had a slate rather than going blank.
    const week = args.week ?? active ?? weeks[weeks.length - 1] ?? 1;

    // The index orders by (season, week), not by kickoff, so a week's games come
    // back in insertion order and the screen has to be sorted deliberately.
    const thisWeeksSlate = counted
      .filter((game) => game.week === week)
      .sort((a, b) => a.kickoffAt - b.kickoffAt);
    const locksAt = lock(thisWeeksSlate);

    const picks = await ctx.db
      .query("picks")
      .withIndex("by_membership_week", (q) =>
        q.eq("membershipId", membership._id).eq("week", week),
      )
      .collect();
    const selectionByGame = new Map(
      picks.map((pick) => [pick.gameId, pick.selection]),
    );

    const overrides = await ctx.db
      .query("resultOverrides")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", args.leagueId).eq("week", week),
      )
      .collect();
    const overrideByGame = new Map(
      overrides.map((override) => [override.gameId, override]),
    );

    const guess = await ctx.db
      .query("tiebreakerGuesses")
      .withIndex("by_membership_week", (q) =>
        q.eq("membershipId", membership._id).eq("week", week),
      )
      .unique();

    return {
      week,
      weeks,
      activeWeek: active ?? null,
      lockAt: locksAt ?? null,
      // A week with no derivable deadline has nothing to pick, so it reads as
      // shut rather than as permanently open.
      locked: locksAt === undefined || args.now >= locksAt,
      tiebreakerGameId: tiebreakerGame(thisWeeksSlate)?._id ?? null,
      tiebreakerGuess: guess?.points ?? null,
      games: thisWeeksSlate.map((game) => {
        const selection = selectionByGame.get(game._id);
        return {
          gameId: game._id,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
          kickoffAt: game.kickoffAt,
          weekday: game.weekday,
          status: game.status,
          homeScore: game.homeScore ?? null,
          awayScore: game.awayScore ?? null,
          selection: selection ?? null,
          result: gradePick(
            selection,
            effectiveOutcome(game, overrideByGame.get(game._id)),
          ),
        };
      }),
    };
  },
});
