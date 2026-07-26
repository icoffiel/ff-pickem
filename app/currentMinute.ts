/**
 * The current time, floored to the minute, for queries that judge expiry.
 *
 * Convex queries must not read the wall clock: a query is only re-run when the
 * data it reads changes, so a `Date.now()` inside one goes stale, and it churns
 * the query cache besides. Time is passed in as an argument instead, floored so
 * that every request within the same minute shares one cache entry.
 *
 * https://docs.convex.dev/understanding/best-practices/#date-in-queries
 */
export function currentMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}
