/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { isRedeemable } from "./invites";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A caller acting as a freshly-inserted user. Mirrors `leagues.test.ts` /
 * `users.test.ts`: `getAuthUserId` reads the userId out of `<userId>|<sessionId>`,
 * so these tests exercise the real auth path without driving magic-link sign-in.
 */
async function signedIn(
  t: ReturnType<typeof convexTest>,
  email = "commish@example.com",
) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
  return { as: t.withIdentity({ subject: `${userId}|session` }), userId };
}

/** A commissioner with a freshly-created league to invite into. */
async function withLeague(
  t: ReturnType<typeof convexTest>,
  email = "commish@example.com",
) {
  const commish = await signedIn(t, email);
  const leagueId = await commish.as.mutation(api.leagues.createLeague, {
    name: "Family League",
    teamName: "Thunder Llamas",
  });
  return { ...commish, leagueId };
}

/** Insert a membership directly, bypassing the redeem path under test. */
async function addMember(
  t: ReturnType<typeof convexTest>,
  leagueId: Id<"leagues">,
  email: string,
  status: "active" | "removed" = "active",
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("memberships", {
      userId,
      leagueId,
      role: "member",
      status,
      teamName: `Team ${email}`,
      joinedAt: Date.now(),
    });
    return userId;
  });
}

/** A league with a live invite out to `email`, plus that invitee signed in. */
async function withInvite(
  t: ReturnType<typeof convexTest>,
  email = "sister@example.com",
) {
  const commish = await withLeague(t);
  const { token } = (await commish.as.mutation(api.invites.createInvite, {
    leagueId: commish.leagueId,
    email,
  })) as { status: "invited"; token: string };
  const invitee = await signedIn(t, email);
  return { leagueId: commish.leagueId, token, commish, invitee };
}

/** The sole invite row, for tests that need to age or re-status it. */
async function patchOnlyInvite(
  t: ReturnType<typeof convexTest>,
  fields: Partial<Doc<"invites">>,
) {
  await t.run(async (ctx) => {
    const invite = await ctx.db.query("invites").unique();
    await ctx.db.patch(invite!._id, fields);
  });
}

test("redeem makes the invitee a born-active member with their chosen team name", async () => {
  const t = convexTest(schema, modules);
  const { leagueId, token, invitee } = await withInvite(t);

  const redeemedLeagueId = await invitee.as.mutation(api.invites.redeem, {
    token,
    teamName: "Gridiron Geese",
  });

  expect(redeemedLeagueId).toBe(leagueId);

  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", leagueId).eq("userId", invitee.userId),
      )
      .unique(),
  );
  expect(membership).toMatchObject({
    role: "member",
    status: "active",
    teamName: "Gridiron Geese",
  });
});

test("redeem marks the invite accepted so the link cannot be reused", async () => {
  const t = convexTest(schema, modules);
  const { token, invitee } = await withInvite(t);

  await invitee.as.mutation(api.invites.redeem, {
    token,
    teamName: "Gridiron Geese",
  });

  const invite = await t.run((ctx) => ctx.db.query("invites").unique());
  expect(invite!.status).toBe("accepted");
});

test("createInvite creates a pending invite with a token and a ~14-day expiry", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);

  const before = Date.now();
  const result = await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });
  const after = Date.now();

  expect(result).toEqual({ status: "invited", token: expect.any(String) });

  const invites = await t.run((ctx) =>
    ctx.db
      .query("invites")
      .withIndex("by_league_email", (q) =>
        q.eq("leagueId", leagueId).eq("targetEmail", "sister@example.com"),
      )
      .collect(),
  );

  expect(invites).toHaveLength(1);
  expect(invites[0]).toMatchObject({
    status: "pending",
    targetEmail: "sister@example.com",
    leagueId,
  });
  expect(invites[0].token).toBe(
    (result as { status: "invited"; token: string }).token,
  );
  expect(invites[0].expiresAt).toBeGreaterThanOrEqual(
    before + FOURTEEN_DAYS_MS,
  );
  expect(invites[0].expiresAt).toBeLessThanOrEqual(after + FOURTEEN_DAYS_MS);
});

test("createInvite normalizes the target email to lowercase and trimmed", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);

  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "  Sister@Example.COM  ",
  });

  const invite = await t.run((ctx) => ctx.db.query("invites").unique());
  expect(invite!.targetEmail).toBe("sister@example.com");
});

test("createInvite rejects a member who is not the commissioner", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await withLeague(t);
  const memberId = await addMember(t, leagueId, "member@example.com");
  const asMember = t.withIdentity({ subject: `${memberId}|session` });

  await expect(
    asMember.mutation(api.invites.createInvite, {
      leagueId,
      email: "sister@example.com",
    }),
  ).rejects.toThrow(/NotCommissioner/);

  const invites = await t.run((ctx) => ctx.db.query("invites").collect());
  expect(invites).toHaveLength(0);
});

test("createInvite rejects an outsider who is not a member of the league", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await withLeague(t);
  const outsider = await signedIn(t, "outsider@example.com");

  await expect(
    outsider.as.mutation(api.invites.createInvite, {
      leagueId,
      email: "sister@example.com",
    }),
  ).rejects.toThrow(/NotCommissioner/);
});

test("createInvite short-circuits with alreadyMember when the email is an active member", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);
  await addMember(t, leagueId, "sister@example.com");

  const result = await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "Sister@example.com",
  });

  expect(result).toEqual({ status: "alreadyMember" });

  const invites = await t.run((ctx) => ctx.db.query("invites").collect());
  expect(invites).toHaveLength(0);
});

test("re-inviting the same email supersedes the prior pending invite", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);

  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });
  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });

  const invites = await t.run((ctx) =>
    ctx.db
      .query("invites")
      .withIndex("by_league_email", (q) =>
        q.eq("leagueId", leagueId).eq("targetEmail", "sister@example.com"),
      )
      .collect(),
  );

  expect(invites).toHaveLength(2);
  const pending = invites.filter((i) => i.status === "pending");
  const superseded = invites.filter((i) => i.status === "superseded");
  expect(pending).toHaveLength(1);
  expect(superseded).toHaveLength(1);
});

test("createInvite schedules the invite email rather than sending inline", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);

  const { token } = (await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  })) as { status: "invited"; token: string };

  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );

  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].name).toContain("sendInviteEmail");
  expect(scheduled[0].args[0]).toMatchObject({
    token,
    targetEmail: "sister@example.com",
  });
});

test("redeem refuses a signed-in email that is not the invited one", async () => {
  const t = convexTest(schema, modules);
  const { leagueId, token } = await withInvite(t);
  const wrongPerson = await signedIn(t, "stranger@example.com");

  await expect(
    wrongPerson.as.mutation(api.invites.redeem, {
      token,
      teamName: "Interlopers",
    }),
  ).rejects.toThrow(/EmailMismatch/);

  const memberships = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .collect(),
  );
  expect(memberships).toHaveLength(1); // the commissioner, and no one else
});

test("redeem refuses a token that matches no invite", async () => {
  const t = convexTest(schema, modules);
  const { invitee } = await withInvite(t);

  await expect(
    invitee.as.mutation(api.invites.redeem, {
      token: "not-a-real-token",
      teamName: "Gridiron Geese",
    }),
  ).rejects.toThrow(/InviteNotFound/);
});

test("redeem refuses a signed-out caller", async () => {
  const t = convexTest(schema, modules);
  const { token } = await withInvite(t);

  await expect(
    t.mutation(api.invites.redeem, { token, teamName: "Gridiron Geese" }),
  ).rejects.toThrow(/NotSignedIn/);
});

test("redeem refuses an invite whose 14 days have run out", async () => {
  const t = convexTest(schema, modules);
  const { token, invitee } = await withInvite(t);
  await patchOnlyInvite(t, { expiresAt: Date.now() - 1 });

  await expect(
    invitee.as.mutation(api.invites.redeem, {
      token,
      teamName: "Gridiron Geese",
    }),
  ).rejects.toThrow(/InviteExpired/);
});

// A superseded, revoked or already-accepted link is dead for the same reason an
// expired one is — from the invitee's side there is nothing to distinguish, and
// the answer is always "ask for a fresh invite", so they share one code.
test.each(["superseded", "revoked", "accepted"] as const)(
  "redeem refuses a %s invite",
  async (status) => {
    const t = convexTest(schema, modules);
    const { token, invitee } = await withInvite(t);
    await patchOnlyInvite(t, { status });

    await expect(
      invitee.as.mutation(api.invites.redeem, {
        token,
        teamName: "Gridiron Geese",
      }),
    ).rejects.toThrow(/InviteExpired/);
  },
);

test("redeem restores a removed membership instead of duplicating it", async () => {
  const t = convexTest(schema, modules);
  const { leagueId, token, invitee } = await withInvite(t);
  const removedAt = Date.now() - 1000;
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: invitee.userId,
      leagueId,
      role: "member",
      status: "removed",
      teamName: "Old Name",
      joinedAt: removedAt - 1000,
      removedAt,
    }),
  );

  await invitee.as.mutation(api.invites.redeem, {
    token,
    teamName: "Gridiron Geese",
  });

  const memberships = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", leagueId).eq("userId", invitee.userId),
      )
      .collect(),
  );
  expect(memberships).toHaveLength(1);
  expect(memberships[0]).toMatchObject({
    status: "active",
    teamName: "Gridiron Geese",
  });
  expect(memberships[0].removedAt).toBeUndefined();
});

test("redeem is a harmless no-op for someone who is already an active member", async () => {
  const t = convexTest(schema, modules);
  const { leagueId, token, invitee } = await withInvite(t);
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: invitee.userId,
      leagueId,
      role: "member",
      status: "active",
      teamName: "Existing Name",
      joinedAt: Date.now() - 1000,
    }),
  );

  const redeemedLeagueId = await invitee.as.mutation(api.invites.redeem, {
    token,
    teamName: "Gridiron Geese",
  });

  expect(redeemedLeagueId).toBe(leagueId);
  const memberships = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", leagueId).eq("userId", invitee.userId),
      )
      .collect(),
  );
  expect(memberships).toHaveLength(1);
  expect(memberships[0].teamName).toBe("Existing Name");
});

test("redeem refuses an empty team name", async () => {
  const t = convexTest(schema, modules);
  const { token, invitee } = await withInvite(t);

  await expect(
    invitee.as.mutation(api.invites.redeem, { token, teamName: "   " }),
  ).rejects.toThrow(/EmptyField/);
});

// `isRedeemable` is the pure definition of "live invite" both readers share, so
// it is pinned directly over (status, expiresAt, now) rather than only through
// the mutation that persists the result.
const anInvite = (fields: Partial<Doc<"invites">>) =>
  ({ status: "pending", expiresAt: 1000, ...fields }) as Doc<"invites">;

test("isRedeemable accepts a pending invite before its expiry", () => {
  expect(isRedeemable(anInvite({}), 999)).toBe(true);
});

test("isRedeemable rejects a pending invite at and after its expiry", () => {
  expect(isRedeemable(anInvite({}), 1000)).toBe(false);
  expect(isRedeemable(anInvite({}), 1001)).toBe(false);
});

test.each(["accepted", "expired", "superseded", "revoked"] as const)(
  "isRedeemable rejects a %s invite even before its expiry",
  (status) => {
    expect(isRedeemable(anInvite({ status }), 999)).toBe(false);
  },
);

test("myPendingInvites surfaces the caller's live invite with its league name", async () => {
  const t = convexTest(schema, modules);
  const { leagueId, token, invitee } = await withInvite(t);

  const invites = await invitee.as.query(api.invites.myPendingInvites, {
    now: Date.now(),
  });

  expect(invites).toEqual([
    expect.objectContaining({ token, leagueId, leagueName: "Family League" }),
  ]);
});

test("myPendingInvites shows nothing to a different email", async () => {
  const t = convexTest(schema, modules);
  await withInvite(t);
  const bystander = await signedIn(t, "bystander@example.com");

  expect(
    await bystander.as.query(api.invites.myPendingInvites, { now: Date.now() }),
  ).toEqual([]);
});

test("myPendingInvites shows nothing to a signed-out visitor", async () => {
  const t = convexTest(schema, modules);
  await withInvite(t);

  expect(
    await t.query(api.invites.myPendingInvites, { now: Date.now() }),
  ).toEqual([]);
});

test("myPendingInvites drops an invite once it expires", async () => {
  const t = convexTest(schema, modules);
  const { invitee } = await withInvite(t);
  await patchOnlyInvite(t, { expiresAt: Date.now() - 1 });

  expect(
    await invitee.as.query(api.invites.myPendingInvites, { now: Date.now() }),
  ).toEqual([]);
});

// Time is an argument, not a wall-clock read, so the query is re-run when its
// data changes rather than going quietly stale
// (https://docs.convex.dev/understanding/best-practices/#date-in-queries).
// This pins that the passed time is what decides liveness.
test("myPendingInvites judges expiry against the time it is given", async () => {
  const t = convexTest(schema, modules);
  const { invitee } = await withInvite(t);
  const expiresAt = Date.now() - 60_000;
  await patchOnlyInvite(t, { expiresAt });

  expect(
    await invitee.as.query(api.invites.myPendingInvites, {
      now: expiresAt - 1,
    }),
  ).toHaveLength(1);
  expect(
    await invitee.as.query(api.invites.myPendingInvites, { now: expiresAt }),
  ).toEqual([]);
});

test("myPendingInvites drops an invite once it is redeemed", async () => {
  const t = convexTest(schema, modules);
  const { token, invitee } = await withInvite(t);
  await invitee.as.mutation(api.invites.redeem, {
    token,
    teamName: "Gridiron Geese",
  });

  expect(
    await invitee.as.query(api.invites.myPendingInvites, { now: Date.now() }),
  ).toEqual([]);
});

test("leagueRoster rejects a caller who is not a member of the league", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await withLeague(t);
  const outsider = await signedIn(t, "outsider@example.com");

  await expect(
    outsider.as.query(api.invites.leagueRoster, { leagueId, now: Date.now() }),
  ).rejects.toThrow(/NotMember/);
});

test("leagueRoster returns the member roster to a member", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await withLeague(t);
  const memberId = await addMember(t, leagueId, "member@example.com");
  const asMember = t.withIdentity({ subject: `${memberId}|session` });

  const roster = await asMember.query(api.invites.leagueRoster, {
    leagueId,
    now: Date.now(),
  });

  expect(roster.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        teamName: "Thunder Llamas",
        role: "commissioner",
      }),
      expect.objectContaining({
        teamName: "Team member@example.com",
        role: "member",
      }),
    ]),
  );
  expect(roster.members).toHaveLength(2);
});

test("leagueRoster hides pending invites from a non-commissioner member", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);
  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });
  const memberId = await addMember(t, leagueId, "member@example.com");
  const asMember = t.withIdentity({ subject: `${memberId}|session` });

  const roster = await asMember.query(api.invites.leagueRoster, {
    leagueId,
    now: Date.now(),
  });

  expect(roster.pendingInvites).toBeUndefined();
});

test("leagueRoster returns pending invites to the commissioner", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);
  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });

  const roster = await as.query(api.invites.leagueRoster, {
    leagueId,
    now: Date.now(),
  });

  expect(roster.pendingInvites).toEqual([
    expect.objectContaining({ targetEmail: "sister@example.com" }),
  ]);
});

test("leagueRoster omits expired pending invites from the commissioner's view", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);
  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });
  // Force the sole invite to be already expired.
  await t.run(async (ctx) => {
    const invite = await ctx.db.query("invites").unique();
    await ctx.db.patch(invite!._id, { expiresAt: Date.now() - 1 });
  });

  const roster = await as.query(api.invites.leagueRoster, {
    leagueId,
    now: Date.now(),
  });

  expect(roster.pendingInvites).toEqual([]);
});
