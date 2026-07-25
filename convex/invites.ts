import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Our own boundary guard — mirror the normalization on write and on compare so
 * "Sister@Example.com " and "sister@example.com" are one address (see #50). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
 * The roster of a league: its active members, plus — for a commissioner only —
 * the outstanding pending invites. Any member may see who is playing; only the
 * commissioner sees who has been invited but not yet joined (#59). Pending
 * invites are filtered by lazy expiry: a past-`expiresAt` invite is treated as
 * expired at read time, with no cron flipping its status.
 */
export const leagueRoster = query({
  args: { leagueId: v.id("leagues") },
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

    const now = Date.now();
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_league_email", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const pendingInvites = invites
      .filter((i) => i.status === "pending" && i.expiresAt > now)
      .map((i) => ({ targetEmail: i.targetEmail, expiresAt: i.expiresAt }));

    return { members, pendingInvites };
  },
});
