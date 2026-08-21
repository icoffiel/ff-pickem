import { v } from "convex/values";

import { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { ScheduledGame } from "./nflverse";

// The `games` write layer. `games` is pure synced NFL truth — no per-league data,
// no commissioner data, no clobber guards. A commissioner's correction lives in
// `resultOverrides`, scoped to their league, and never touches a row here.

/**
 * How long past kickoff a game must be before a score can be trusted as final.
 *
 * nflverse has no "this game is over" column and its score columns populate
 * while a game is being played, so "has a score" alone would grade an
 * in-progress line. Six hours is well clear of any real game — a regular-season
 * broadcast runs a little over three, and overtime adds well under one — so past
 * that mark a populated score can only be the final one.
 */
export const FINAL_AFTER_KICKOFF_MS = 6 * 60 * 60 * 1000;

/** A `games` row without its system fields — what an insert or replace writes. */
type GameFields = Omit<Doc<"games">, "_id" | "_creationTime">;

/** A game whose kickoff moved, and where it moved from and to. */
export type MovedKickoff = {
  id: Id<"games">;
  gameId: string;
  previousKickoffAt: number;
  kickoffAt: number;
};

/** What one pass of `applySchedule` did. Named so `sync.ts` can annotate its
 * action's return type — without it, the action's type is inferred through the
 * generated `api`, which the action is itself part of, and TypeScript gives up. */
export type ScheduleUpsert = {
  inserted: number;
  updated: number;
  /** Rows the sync found already correct and left alone. Usually all of them. */
  unchanged: number;
  kickoffMoved: MovedKickoff[];
};

/** One parsed nflverse row, as `applySchedule` accepts it over the wire. */
const scheduledGame = v.object({
  gameId: v.string(),
  season: v.number(),
  week: v.number(),
  gameType: v.string(),
  weekday: v.string(),
  kickoffAt: v.number(),
  homeTeam: v.string(),
  awayTeam: v.string(),
  homeScore: v.optional(v.number()),
  awayScore: v.optional(v.number()),
});

/** Whether a stored row already says exactly what the merge rule decided. Every
 * value in `GameFields` is a primitive or `undefined`, so this compares fully. */
function alreadyMatches(existing: Doc<"games">, fields: GameFields): boolean {
  return (Object.keys(fields) as (keyof GameFields)[]).every(
    (field) => existing[field] === fields[field],
  );
}

/** Who won, from the two scores. A level game is a tie, not a home win. */
function outcomeOf(
  homeScore: number,
  awayScore: number,
): "home" | "away" | "tie" {
  if (homeScore > awayScore) return "home";
  if (awayScore > homeScore) return "away";
  return "tie";
}

/**
 * The row nflverse's view of a game should leave behind, given what we already
 * hold. Pure, so every rule below is testable without a database.
 *
 * Three rules do the work:
 *
 * - **A blank score is "no news", never "erase what live sync wrote."** nflverse
 *   refreshes every five minutes; the live feed (M3b) is seconds behind play, so
 *   a schedule sync landing mid-game must not blank the score on screen.
 * - **A score only becomes final once kickoff is well past** — see
 *   `FINAL_AFTER_KICKOFF_MS`. This is what lets nflverse back the live feed up:
 *   it backfills already-played weeks on a fresh deployment and covers an outage
 *   that spanned a game, without ever grading a game still being played.
 * - **A final game's outcome is recomputed from its scores.** A correction that
 *   flips the winner has to move the outcome with it, or grading keeps scoring
 *   the wrong team. A final game is never downgraded.
 */
export function mergeScheduledGame(
  existing: Doc<"games"> | null,
  incoming: ScheduledGame,
  now: number,
): GameFields {
  const homeScore = incoming.homeScore ?? existing?.homeScore;
  const awayScore = incoming.awayScore ?? existing?.awayScore;

  const scored = homeScore !== undefined && awayScore !== undefined;
  const longPast = now - incoming.kickoffAt > FINAL_AFTER_KICKOFF_MS;
  const status =
    existing?.status === "final" || (scored && longPast)
      ? "final"
      : (existing?.status ?? "scheduled");

  return {
    gameId: incoming.gameId,
    season: incoming.season,
    week: incoming.week,
    gameType: incoming.gameType,
    weekday: incoming.weekday,
    kickoffAt: incoming.kickoffAt,
    homeTeam: incoming.homeTeam,
    awayTeam: incoming.awayTeam,
    homeScore,
    awayScore,
    status,
    outcome:
      status === "final" && scored
        ? outcomeOf(homeScore, awayScore)
        : existing?.outcome,
  };
}

/**
 * Upsert one season's parsed schedule, keyed on the external `gameId`, and report
 * which games' kickoffs moved.
 *
 * Keying on `gameId` is what makes the cron safe to re-run: a second pass
 * corrects rows rather than duplicating them, so a flex change or a postponement
 * simply overwrites the old time.
 *
 * The moved-kickoff report is the seam ADR 0002 requires. M4 schedules a week's
 * pick-visibility flip at kickoff; a flex change that left the old flip queued
 * would reveal every member's picks at the *old* time. M4 cancels and
 * re-schedules off this return value. No scheduled-function id is stored here —
 * M4's flip does not exist yet, and a dead column for a milestone is worse than
 * the small retrofit.
 */
export const applySchedule = internalMutation({
  args: { season: v.number(), games: v.array(scheduledGame) },
  handler: async (ctx, args): Promise<ScheduleUpsert> => {
    // One indexed read for the whole season beats one per game: 272 rows is a
    // comfortable transaction, 272 round trips is needless work.
    const existingRows = await ctx.db
      .query("games")
      .withIndex("by_season_week", (q) => q.eq("season", args.season))
      .collect();
    const bySyncedId = new Map(existingRows.map((row) => [row.gameId, row]));

    // A mutation may read the server clock — it is not a subscription, so there
    // is nothing to go stale (ADR 0002 rule 1).
    const now = Date.now();
    const kickoffMoved: MovedKickoff[] = [];
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (const incoming of args.games) {
      const existing = bySyncedId.get(incoming.gameId) ?? null;
      const fields = mergeScheduledGame(existing, incoming, now);

      if (existing === null) {
        const id = await ctx.db.insert("games", fields);
        // Remember it, so a `gameId` duplicated inside one payload updates the
        // row we just wrote instead of inserting a second copy of the same game.
        bySyncedId.set(incoming.gameId, {
          ...fields,
          _id: id,
          _creationTime: 0,
        });
        inserted++;
        continue;
      }

      // Most rows are identical on most runs — the schedule is published months
      // ahead and this polls four times a day. Writing them anyway would wake
      // every subscription reading `games` on every tick, and would put all 272
      // rows in the write set of a transaction that M3b's live sync has to
      // interleave with during game windows.
      if (alreadyMatches(existing, fields)) {
        unchanged++;
        continue;
      }

      if (existing.kickoffAt !== incoming.kickoffAt) {
        kickoffMoved.push({
          id: existing._id,
          gameId: existing.gameId,
          previousKickoffAt: existing.kickoffAt,
          kickoffAt: incoming.kickoffAt,
        });
      }
      // `replace`, not `patch`: the merge rule already decided every field, and a
      // patch could not clear one the rule chose to drop.
      await ctx.db.replace(existing._id, fields);
      updated++;
    }

    return { inserted, updated, unchanged, kickoffMoved };
  },
});
