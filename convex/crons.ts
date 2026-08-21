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

export default crons;
