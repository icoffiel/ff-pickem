import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { CURRENT_SEASON } from "./config";
import { ScheduleUpsert } from "./games";
import { NFLVERSE_GAMES_CSV_URL, parseSchedule } from "./nflverse";

// The external-data actions. An action here does exactly three things: fetch,
// hand the payload to a parser, hand the parsed result to a mutation. No
// interpretation of a payload lives in this file — that keeps the parts that can
// be wrong (the interpretation and the merge rule) testable without a network,
// and leaves the untestable part small enough to read.

/** What one `scheduleSync` run did: the upsert's counts, plus any game upstream
 * has not scheduled yet. Named so the action can annotate its own return type —
 * inferring it would run through the generated `api` this action is part of. */
type ScheduleSyncResult = ScheduleUpsert & { withoutKickoffTime: string[] };

/**
 * Pull the published nflverse schedule and upsert this season's regular-season
 * games. Registered on a 6-hour interval in `crons.ts`.
 *
 * Six hours is ample even though this is the only source of kickoff times: flex
 * changes are announced days ahead, and a postponement arrives as a new kickoff
 * date rather than a same-hour edit.
 *
 * The season comes from `CURRENT_SEASON`, never a hardcoded year, so moving
 * seasons stays the one-line change `config.ts` promises.
 */
export const scheduleSync = internalAction({
  args: {},
  handler: async (ctx): Promise<ScheduleSyncResult> => {
    const response = await fetch(NFLVERSE_GAMES_CSV_URL);
    if (!response.ok) {
      // A quiet no-op here would look exactly like "no games have changed", and
      // an unnoticed dead sync means M4 locks against a stale schedule.
      throw new Error(
        `nflverse schedule fetch failed (${response.status} ${response.statusText})`,
      );
    }

    const { games, withoutKickoffTime } = parseSchedule(
      await response.text(),
      CURRENT_SEASON,
    );

    if (withoutKickoffTime.length > 0) {
      // Not fatal — upstream simply has no time for these yet — but a game the
      // app cannot show is worth saying out loud rather than leaving to be
      // noticed as an absence.
      console.warn(
        `nflverse has published no kickoff time for ${withoutKickoffTime.length} game(s), skipped: ${withoutKickoffTime.join(", ")}`,
      );
    }

    const upsert = await ctx.runMutation(internal.games.applySchedule, {
      season: CURRENT_SEASON,
      games,
    });
    return { ...upsert, withoutKickoffTime };
  },
});
