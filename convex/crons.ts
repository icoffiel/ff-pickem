import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * The schedule refresh. Six hours, because the schedule is published months
 * ahead and the only things that move it — a flex change, a postponement — are
 * announced days in advance. Re-running is safe: `applySchedule` upserts on the
 * external `gameId`.
 *
 * This is a *reactivity* mechanism only. Nothing about the pick lock depends on
 * a cron having fired: ADR 0002 puts that on the server clock inside the pick
 * mutation, so a missed tick can never let a late pick through.
 */
crons.interval(
  "nflverse schedule sync",
  { hours: 6 },
  internal.sync.scheduleSync,
  {},
);

/**
 * The live-status poll. Fifteen minutes is fine-grained enough that a game
 * finals on screen within a quarter of an hour of the whistle, and coarse
 * enough to stay polite to an endpoint that is not ours.
 *
 * **Year-round, not in-season only.** `liveSync` asks the database whether any
 * game is in play before it spends a fetch, so out of season every run is a
 * no-op — 96 a day, ~2,900 a month against Convex's free-tier 1,000,000. The
 * in-season cron expression the build spec kept in reserve buys nothing and is
 * not built.
 *
 * Like the schedule refresh, this is a *reactivity* mechanism only. Grading is
 * a consequence of a game's stored outcome, and a missed tick delays it rather
 * than losing it: the next tick sees the same unfinished game in the same
 * window, and the schedule sync's six-hour age guard backstops anything ESPN
 * missed entirely.
 */
crons.interval("espn live sync", { minutes: 15 }, internal.sync.liveSync, {});

export default crons;
