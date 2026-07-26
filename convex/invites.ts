import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { mutation, query, QueryCtx } from "./_generated/server";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Our own boundary guard — mirror the normalization on write and on compare so
 * "Sister@Example.com " and "sister@example.com" are one address (see #50). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Time as a query argument, never a wall-clock read inside the query.
 *
 * A Convex query is only re-run when the data it reads changes, so a `Date.now()`
 * inside one silently goes stale, and it churns the query cache besides
 * (https://docs.convex.dev/understanding/best-practices/#date-in-queries).
 * Callers pass the time floored to the minute so every request within a minute
 * shares one cache entry.
 *
 * This is display-only authority: a caller who passes a stale `now` can make an
 * expired invite look live *on their own screen*, and `redeem` — a mutation,
 * where reading the clock is fine — still refuses it.
 */
const NOW_ARG = { now: v.number() };

/**
 * Whether an invite can still be walked through the door at `now`. Expiry is
 * lazy — checked at read time, with no cron flipping statuses — so this is the
 * one place "live invite" is defined, shared by every reader.
 */
export function isRedeemable(invite: Doc<"invites">, now: number): boolean {
  return invite.status === "pending" && invite.expiresAt > now;
}

/**
 * Invite a specific email into a league. Commissioner-only; the invite is an
 * app-level grant (own token + 14-day expiry) delivered as a plain link to
 * `/invite/<token>`, decoupled from auth. The mutation owns every invariant —
 * one live invite per (email, league), the already-a-member short-circuit — and
 * isolates the un-testable email I/O in a scheduled internal action.
 */
export const createInvite = mutation({
  args: { leagueId: v.id("leagues"), email: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NotCommissioner" });
    }

    // Authz: an active commissioner of *this* league, or nothing.
    const caller = await ctx.db
      .query("memberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", userId),
      )
      .unique();
    if (
      caller === null ||
      caller.role !== "commissioner" ||
      caller.status !== "active"
    ) {
      throw new ConvexError({ code: "NotCommissioner" });
    }

    const targetEmail = normalizeEmail(args.email);

    // Already an active member? No invite row — a harmless no-op (story 18).
    const usersWithEmail = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", targetEmail))
      .collect();
    for (const user of usersWithEmail) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_league_user", (q) =>
          q.eq("leagueId", args.leagueId).eq("userId", user._id),
        )
        .unique();
      if (membership !== null && membership.status === "active") {
        return { status: "alreadyMember" as const };
      }
    }

    // One live invite per (email, league): supersede any existing pending one.
    const existing = await ctx.db
      .query("invites")
      .withIndex("by_league_email", (q) =>
        q.eq("leagueId", args.leagueId).eq("targetEmail", targetEmail),
      )
      .collect();
    for (const invite of existing) {
      if (invite.status === "pending") {
        await ctx.db.patch(invite._id, { status: "superseded" });
      }
    }

    const now = Date.now();
    const token = crypto.randomUUID();
    await ctx.db.insert("invites", {
      token,
      targetEmail,
      leagueId: args.leagueId,
      status: "pending",
      expiresAt: now + FOURTEEN_DAYS_MS,
      createdAt: now,
    });

    // Email delivery is isolated in a scheduled internal action so this
    // invariant-enforcing mutation stays pure and fully testable.
    await ctx.scheduler.runAfter(0, internal.inviteEmail.sendInviteEmail, {
      token,
      targetEmail,
    });

    return { status: "invited" as const, token };
  },
});

/**
 * Redeem an invite: become an active, competing member of its league.
 *
 * The **email binding is the security boundary**, not the token: the token is
 * only a deep-link, so redemption requires the signed-in caller's email to be
 * the invited one. A dead link (expired, superseded, revoked, already accepted)
 * refuses with a single `InviteExpired` — the invitee's answer is "ask for a
 * fresh invite" in every one of those cases.
 */
export const redeem = mutation({
  args: { token: v.string(), teamName: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NotSignedIn" });
    }

    const teamName = args.teamName.trim();
    if (teamName === "") {
      throw new ConvexError({ code: "EmptyField" });
    }

    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (invite === null) {
      throw new ConvexError({ code: "InviteNotFound" });
    }
    // A mutation is not a subscription, so the server clock is the authority
    // here — this is the check that actually gates joining.
    if (!isRedeemable(invite, Date.now())) {
      throw new ConvexError({ code: "InviteExpired" });
    }

    const callerEmail = (await ctx.db.get(userId))?.email;
    if (
      callerEmail === undefined ||
      normalizeEmail(callerEmail) !== invite.targetEmail
    ) {
      throw new ConvexError({ code: "EmailMismatch" });
    }

    // One membership per (user, league) — Convex has no partial-unique
    // constraint, so this branch is what enforces it. It is also the single
    // convergence point for "un-remove" and "accidental re-invite".
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", invite.leagueId).eq("userId", userId),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("memberships", {
        userId,
        leagueId: invite.leagueId,
        role: "member",
        status: "active",
        teamName,
        joinedAt: Date.now(),
      });
    } else if (existing.status === "removed") {
      await ctx.db.patch(existing._id, {
        status: "active",
        removedAt: undefined,
        teamName,
      });
    }
    // An already-active membership is left untouched: a re-invite must never
    // rename the team someone is already playing under.

    await ctx.db.patch(invite._id, { status: "accepted" });

    return invite.leagueId;
  },
});

/**
 * The live invites waiting for the signed-in caller, across every league. Scoped
 * by the caller's own email — never by a token — so this is safe to render on
 * the home screen, and it is also what the accept page reads to name the league
 * behind a token. Returns `[]` for a signed-out caller.
 *
 * `now` comes from the caller (see `NOW_ARG`).
 */
export const myPendingInvites = query({
  args: NOW_ARG,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    const callerEmail = (await ctx.db.get(userId))?.email;
    if (callerEmail === undefined) {
      return [];
    }

    const invites = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) =>
        q.eq("targetEmail", normalizeEmail(callerEmail)),
      )
      .collect();

    const live = await Promise.all(
      invites.filter((i) => isRedeemable(i, args.now)).map(withLeagueName(ctx)),
    );
    return live.filter((invite) => invite !== null);
  },
});

/** An invite as the accept screen needs it — dropped if its league is gone. */
function withLeagueName(ctx: QueryCtx) {
  return async (invite: Doc<"invites">) => {
    const league = await ctx.db.get(invite.leagueId);
    return league === null
      ? null
      : {
          token: invite.token,
          leagueId: invite.leagueId,
          leagueName: league.name,
          expiresAt: invite.expiresAt,
        };
  };
}

/**
 * The roster of a league: its active members, plus — for a commissioner only —
 * the outstanding pending invites. Any member may see who is playing; only the
 * commissioner sees who has been invited but not yet joined (#59). Pending
 * invites are filtered by lazy expiry: a past-`expiresAt` invite is treated as
 * expired at read time, with no cron flipping its status.
 */
export const leagueRoster = query({
  args: { leagueId: v.id("leagues"), ...NOW_ARG },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NotMember" });
    }

    const caller = await ctx.db
      .query("memberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", userId),
      )
      .unique();
    if (caller === null || caller.status !== "active") {
      throw new ConvexError({ code: "NotMember" });
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const members = memberships
      .filter((m) => m.status === "active")
      .map((m) => ({ teamName: m.teamName, role: m.role }));

    if (caller.role !== "commissioner") {
      return { members };
    }

    const invites = await ctx.db
      .query("invites")
      .withIndex("by_league_email", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const pendingInvites = invites
      .filter((i) => isRedeemable(i, args.now))
      .map((i) => ({ targetEmail: i.targetEmail, expiresAt: i.expiresAt }));

    return { members, pendingInvites };
  },
});
