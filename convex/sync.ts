import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { CURRENT_SEASON } from "./config";
import { parseScoreboard, scoreboardUrl, UnreadableEvent } from "./espn";
import { LiveUpsert, ScheduleUpsert, WeekInPlay } from "./games";
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

/** What one `liveSync` run did: the weeks it polled and what they changed.
 * Named so the action can annotate its own return type — inferring it would run
 * through the generated `api` this action is part of. */
type LiveSyncResult = LiveUpsert & {
  /** The weeks actually fetched. Empty is the no-op the gate exists to produce. */
  polled: WeekInPlay[];
  /** Scoreboard events that could not be read as a game, and why. */
  unreadable: UnreadableEvent[];
};

/**
 * Pull ESPN's scoreboard for every week that has a game in play, and apply it.
 * Registered on a 15-minute interval in `crons.ts`.
 *
 * **The run gates itself before spending a fetch.** It first asks the database
 * whether any unfinished game is inside its kickoff window; when the answer is
 * no it returns without calling ESPN at all. That is what makes a 15-minute
 * cron affordable year-round with no season-aware scheduling: out of season,
 * every one of the 96 daily runs is this no-op — ~2,900 function calls a month
 * against Convex's free-tier 1,000,000, about 0.3%.
 *
 * The clock read is the action's, not a caller's. An action is not a
 * subscription, so `Date.now()` here is authoritative (ADR 0002); the gate takes
 * it as an argument only because a *query* may not read it.
 */
export const liveSync = internalAction({
  args: {},
  handler: async (ctx): Promise<LiveSyncResult> => {
    const polled = await ctx.runQuery(internal.games.weeksInPlay, {
      now: Date.now(),
    });

    const result: LiveSyncResult = {
      polled,
      updated: 0,
      unchanged: 0,
      unmatched: [],
      unreadable: [],
    };

    for (const week of polled) {
      const response = await fetch(scoreboardUrl(week.season, week.week));
      if (!response.ok) {
        // A quiet no-op here would look exactly like the out-of-season path, so
        // a dead endpoint could leave a whole season ungraded and silent.
        throw new Error(
          `ESPN scoreboard fetch for ${week.season} week ${week.week} failed (${response.status} ${response.statusText})`,
        );
      }

      const scoreboard = parseScoreboard(await response.json());
      // The payload's own season and week, never the ones we asked for: the
      // endpoint will happily answer a request for one season with another.
      const applied = await ctx.runMutation(internal.games.applyLiveEvents, {
        season: scoreboard.season,
        week: scoreboard.week,
        events: scoreboard.events,
      });

      result.updated += applied.updated;
      result.unchanged += applied.unchanged;
      result.unmatched.push(...applied.unmatched);
      result.unreadable.push(...scoreboard.unreadable);
    }

    // Neither of these is fatal — the rest of the Sunday still syncs — but both
    // are loud, because a game that is skipped or unmatched is a game that will
    // never grade, and an absence is not something anyone notices in time.
    if (result.unreadable.length > 0) {
      console.warn(
        `ESPN published ${result.unreadable.length} event(s) that could not be read as a game, skipped: ${result.unreadable
          .map(({ event, reason }) => `${event} (${reason})`)
          .join("; ")}`,
      );
    }
    if (result.unmatched.length > 0) {
      console.warn(
        `ESPN reported ${result.unmatched.length} game(s) with no matching row: ${result.unmatched.join(", ")}`,
      );
    }

    return result;
  },
});
