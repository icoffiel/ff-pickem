import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";

// ADR 0001 rules 1-3, in one place: derive identity server-side, membership-gate
// every league read/write, and role-gate commissioner actions for *that* league.
// Spelled longhand at each call site these rules drift — every new league
// function is another chance to write the guard slightly wrong — so the guard
// lives here and the call sites say which one they need.

/** Why a caller was turned away. Stable across the wire; the UI names each. */
export type MembershipRefusal = "NotSignedIn" | "NotMember" | "NotCommissioner";

function refusal(code: MembershipRefusal) {
  return new ConvexError({ code });
}

/**
 * The membership row for one (league, user), or `null`.
 *
 * A **lookup, not a guard** — the tell is that a guard throws and a lookup
 * returns. It derives no identity and enforces nothing, which is what makes it
 * right in the two places a guard would be wrong: asking whether *someone else*
 * is already a member, and finding a row in order to insert or un-remove it.
 * Never use it to decide whether the caller may proceed — that is
 * `requireMembership`, and only `requireMembership`.
 */
export async function findMembership(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  userId: Id<"users">,
): Promise<Doc<"memberships"> | null> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_league_user", (q) =>
      q.eq("leagueId", leagueId).eq("userId", userId),
    )
    .unique();
}

/**
 * The caller's own active membership in this league, or a refusal.
 *
 * Rules 1 and 2 in a single call: identity comes from the session via
 * `getAuthUserId` and the membership is looked up from it, never taken as an
 * argument — so a caller cannot act as someone else, and a valid `leagueId`
 * alone grants nothing. A `removed` membership is refused exactly like a
 * missing one: a commissioner who takes someone out has taken them out of the
 * competition, and they stop being able to read or submit anything (#12).
 */
export async function requireMembership(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"memberships">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw refusal("NotSignedIn");
  }

  const membership = await findMembership(ctx, leagueId, userId);
  if (membership === null || membership.status !== "active") {
    throw refusal("NotMember");
  }
  return membership;
}

/**
 * The league behind a membership the caller has already been granted.
 *
 * Every league function needs the row — for its `season` and its rule-set — and
 * every one of them has already passed `requireMembership`, so a missing league
 * here is not a lookup failure but an impossibility. It refuses as `NotMember`
 * rather than throwing something new, because from outside there is no
 * difference between a league that never existed and one the caller is not in,
 * and the refusal should not teach them which.
 */
export async function leagueOf(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"leagues">> {
  const league = await ctx.db.get(leagueId);
  if (league === null) {
    throw refusal("NotMember");
  }
  return league;
}

/**
 * The caller's own active **commissioner** membership in this league.
 *
 * Rule 3 layered on rule 2: the role is read off the caller's row in *this*
 * league, so holding the gavel in another league is worth nothing here. The
 * three refusals stay distinct on purpose — signed out, not in the league, in
 * the league without the role — and none of them discloses anything the caller
 * did not already know about their own standing.
 */
export async function requireCommissioner(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"memberships">> {
  const membership = await requireMembership(ctx, leagueId);
  if (membership.role !== "commissioner") {
    throw refusal("NotCommissioner");
  }
  return membership;
}
