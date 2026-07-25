/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * A caller acting as a freshly-inserted user. Mirrors how `getAuthUserId`
 * reads the userId out of `<userId>|<sessionId>` (see `users.test.ts`), so
 * these tests exercise the real auth path without driving magic-link sign-in.
 */
async function signedIn(
  t: ReturnType<typeof convexTest>,
  email = "commish@example.com",
) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
  return { as: t.withIdentity({ subject: `${userId}|session` }), userId };
}

test("createLeague makes the creator an active commissioner with their team name", async () => {
  const t = convexTest(schema, modules);
  const { as, userId } = await signedIn(t);

  const leagueId = await as.mutation(api.leagues.createLeague, {
    name: "Family League",
    teamName: "The Quifsters",
  });

  const memberships = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .collect(),
  );

  expect(memberships).toHaveLength(1);
  expect(memberships[0]).toMatchObject({
    userId,
    leagueId,
    role: "commissioner",
    status: "active",
    teamName: "The Quifsters",
  });
  expect(memberships[0].joinedAt).toBeTypeOf("number");
});

test("createLeague embeds the default rule-set and the configured season", async () => {
  const t = convexTest(schema, modules);
  const { as } = await signedIn(t);

  const leagueId = await as.mutation(api.leagues.createLeague, {
    name: "Family League",
    teamName: "The Quifsters",
  });

  const league = await t.run((ctx) => ctx.db.get(leagueId));

  expect(league).not.toBeNull();
  expect(league!.season).toBe(2026);
  expect(league!.rules).toEqual({
    lock: "weekly",
    slate: "saturdaySundayMonday",
    seasonScope: "regular",
    scoring: "flat",
    weeklyTiebreaker: "mondayTotalPoints",
    seasonTiebreaker: "coChampions",
    pickVisibility: "hiddenUntilLock",
    absentPickScoring: "zero",
  });
});

test("createLeague rejects an unauthenticated caller", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.mutation(api.leagues.createLeague, {
      name: "Family League",
      teamName: "The Quifsters",
    }),
  ).rejects.toThrow();

  const leagues = await t.run((ctx) => ctx.db.query("leagues").collect());
  expect(leagues).toHaveLength(0);
});

test("myLeagues returns only the leagues the caller belongs to", async () => {
  const t = convexTest(schema, modules);
  const alice = await signedIn(t, "alice@example.com");
  const bob = await signedIn(t, "bob@example.com");

  const aliceLeague = await alice.as.mutation(api.leagues.createLeague, {
    name: "Alice's League",
    teamName: "Team Alice",
  });
  await bob.as.mutation(api.leagues.createLeague, {
    name: "Bob's League",
    teamName: "Team Bob",
  });

  const aliceLeagues = await alice.as.query(api.leagues.myLeagues, {});

  expect(aliceLeagues).toHaveLength(1);
  expect(aliceLeagues[0]._id).toBe(aliceLeague);
  expect(aliceLeagues[0].name).toBe("Alice's League");
});

test("myLeagues returns an empty list for a signed-out caller", async () => {
  const t = convexTest(schema, modules);

  expect(await t.query(api.leagues.myLeagues, {})).toEqual([]);
});

test("createLeague trims surrounding whitespace from name and team name", async () => {
  const t = convexTest(schema, modules);
  const { as } = await signedIn(t);

  const leagueId = await as.mutation(api.leagues.createLeague, {
    name: "  Family League  ",
    teamName: "  The Quifsters  ",
  });

  const league = await t.run((ctx) => ctx.db.get(leagueId));
  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .unique(),
  );

  expect(league!.name).toBe("Family League");
  expect(membership!.teamName).toBe("The Quifsters");
});

test("createLeague rejects a blank name or team name", async () => {
  const t = convexTest(schema, modules);
  const { as } = await signedIn(t);

  await expect(
    as.mutation(api.leagues.createLeague, {
      name: "   ",
      teamName: "The Quifsters",
    }),
  ).rejects.toThrow();

  await expect(
    as.mutation(api.leagues.createLeague, {
      name: "Family League",
      teamName: "",
    }),
  ).rejects.toThrow();

  const leagues = await t.run((ctx) => ctx.db.query("leagues").collect());
  expect(leagues).toHaveLength(0);
});
