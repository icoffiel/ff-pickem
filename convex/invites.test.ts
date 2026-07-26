/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
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

/** Insert a membership directly — the redeem path (M2c) does not exist yet. */
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

test("leagueRoster rejects a caller who is not a member of the league", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await withLeague(t);
  const outsider = await signedIn(t, "outsider@example.com");

  await expect(
    outsider.as.query(api.invites.leagueRoster, { leagueId }),
  ).rejects.toThrow(/NotMember/);
});

test("leagueRoster returns the member roster to a member", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await withLeague(t);
  const memberId = await addMember(t, leagueId, "member@example.com");
  const asMember = t.withIdentity({ subject: `${memberId}|session` });

  const roster = await asMember.query(api.invites.leagueRoster, { leagueId });

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

  const roster = await asMember.query(api.invites.leagueRoster, { leagueId });

  expect(roster.pendingInvites).toBeUndefined();
});

test("leagueRoster returns pending invites to the commissioner", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await withLeague(t);
  await as.mutation(api.invites.createInvite, {
    leagueId,
    email: "sister@example.com",
  });

  const roster = await as.query(api.invites.leagueRoster, { leagueId });

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

  const roster = await as.query(api.invites.leagueRoster, { leagueId });

  expect(roster.pendingInvites).toEqual([]);
});
