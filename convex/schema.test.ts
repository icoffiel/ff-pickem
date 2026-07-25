/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import schema from "./schema";

// Schema-level tests (issue #16). These assert *our* validators — the embedded
// rule-set shape and the indexes the standings walk depends on — not Convex's
// framework guarantees. Reuses the convex-test seam established in #24.
const modules = import.meta.glob("./**/*.ts");

// The 8 first-class league settings (#5), all at their first-loop defaults.
const defaultRules = {
  lock: "weekly",
  slate: "saturdaySundayMonday",
  seasonScope: "regular",
  scoring: "flat",
  weeklyTiebreaker: "mondayTotalPoints",
  seasonTiebreaker: "coChampions",
  pickVisibility: "hiddenUntilLock",
  absentPickScoring: "zero",
} as const;

test("a league stores the full 8-setting rule-set as an embedded object", async () => {
  const t = convexTest(schema, modules);

  const league = await t.run(async (ctx) => {
    const id = await ctx.db.insert("leagues", {
      name: "The League",
      season: 2026,
      rules: defaultRules,
      createdAt: Date.now(),
    });
    return await ctx.db.get(id);
  });

  expect(league?.rules).toEqual(defaultRules);
});

test("a league rejects a rule value outside its allowed literals", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.run(async (ctx) => {
      await ctx.db.insert("leagues", {
        name: "The League",
        season: 2026,
        // "fortnightly" is not one of the two allowed `lock` values.
        rules: { ...defaultRules, lock: "fortnightly" } as never,
        createdAt: Date.now(),
      });
    }),
  ).rejects.toThrow();
});

test("picks.by_league_week returns only that league's picks for that week", async () => {
  const t = convexTest(schema, modules);

  const picks = await t.run(async (ctx) => {
    const league = await ctx.db.insert("leagues", {
      name: "Ours",
      season: 2026,
      rules: defaultRules,
      createdAt: Date.now(),
    });
    const other = await ctx.db.insert("leagues", {
      name: "Theirs",
      season: 2026,
      rules: defaultRules,
      createdAt: Date.now(),
    });
    const user = await ctx.db.insert("users", { email: "a@example.com" });
    const membership = await ctx.db.insert("memberships", {
      userId: user,
      leagueId: league,
      role: "commissioner",
      teamName: "Team A",
      joinedAt: Date.now(),
      status: "active",
    });
    const game = await ctx.db.insert("games", {
      gameId: "2026_01_KC_BAL",
      season: 2026,
      week: 1,
      gameType: "REG",
      weekday: "Sunday",
      kickoffAt: Date.now(),
      homeTeam: "BAL",
      awayTeam: "KC",
      status: "scheduled",
    });

    const base = {
      membershipId: membership,
      gameId: game,
      selection: "home" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Target row, plus two that the index must exclude: a later week in the
    // same league, and the same week in a different league.
    await ctx.db.insert("picks", { ...base, leagueId: league, week: 1 });
    await ctx.db.insert("picks", { ...base, leagueId: league, week: 2 });
    await ctx.db.insert("picks", { ...base, leagueId: other, week: 1 });

    return await ctx.db
      .query("picks")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", league).eq("week", 1),
      )
      .collect();
  });

  expect(picks).toHaveLength(1);
});

test("invites.by_league_email finds a league's invite for one address", async () => {
  const t = convexTest(schema, modules);

  const invites = await t.run(async (ctx) => {
    const league = await ctx.db.insert("leagues", {
      name: "Ours",
      season: 2026,
      rules: defaultRules,
      createdAt: Date.now(),
    });
    const base = {
      leagueId: league,
      status: "pending" as const,
      expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    };
    await ctx.db.insert("invites", {
      ...base,
      token: "tok-a",
      targetEmail: "a@example.com",
    });
    await ctx.db.insert("invites", {
      ...base,
      token: "tok-b",
      targetEmail: "b@example.com",
    });

    return await ctx.db
      .query("invites")
      .withIndex("by_league_email", (q) =>
        q.eq("leagueId", league).eq("targetEmail", "a@example.com"),
      )
      .collect();
  });

  expect(invites.map((i) => i.token)).toEqual(["tok-a"]);
});

test("resultOverrides.by_league_game finds one league's correction for a game", async () => {
  const t = convexTest(schema, modules);

  const override = await t.run(async (ctx) => {
    const league = await ctx.db.insert("leagues", {
      name: "Ours",
      season: 2026,
      rules: defaultRules,
      createdAt: Date.now(),
    });
    const user = await ctx.db.insert("users", { email: "c@example.com" });
    const membership = await ctx.db.insert("memberships", {
      userId: user,
      leagueId: league,
      role: "commissioner",
      teamName: "Team C",
      joinedAt: Date.now(),
      status: "active",
    });
    const game = await ctx.db.insert("games", {
      gameId: "2026_01_KC_BAL",
      season: 2026,
      week: 1,
      gameType: "REG",
      weekday: "Sunday",
      kickoffAt: Date.now(),
      homeTeam: "BAL",
      awayTeam: "KC",
      status: "final",
      outcome: "home",
    });
    // A cancelled game scores as a push for everyone in this league only.
    await ctx.db.insert("resultOverrides", {
      leagueId: league,
      gameId: game,
      week: 1,
      outcome: "void",
      createdBy: membership,
      createdAt: Date.now(),
    });

    return await ctx.db
      .query("resultOverrides")
      .withIndex("by_league_game", (q) =>
        q.eq("leagueId", league).eq("gameId", game),
      )
      .unique();
  });

  expect(override?.outcome).toBe("void");
});

test("tiebreakerGuesses.by_membership_week finds a member's guess for a week", async () => {
  const t = convexTest(schema, modules);

  const guess = await t.run(async (ctx) => {
    const league = await ctx.db.insert("leagues", {
      name: "Ours",
      season: 2026,
      rules: defaultRules,
      createdAt: Date.now(),
    });
    const user = await ctx.db.insert("users", { email: "d@example.com" });
    const membership = await ctx.db.insert("memberships", {
      userId: user,
      leagueId: league,
      role: "member",
      teamName: "Team D",
      joinedAt: Date.now(),
      status: "active",
    });
    const base = { membershipId: membership, leagueId: league, points: 0 };
    await ctx.db.insert("tiebreakerGuesses", {
      ...base,
      week: 1,
      points: 42,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("tiebreakerGuesses", {
      ...base,
      week: 2,
      points: 51,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return await ctx.db
      .query("tiebreakerGuesses")
      .withIndex("by_membership_week", (q) =>
        q.eq("membershipId", membership).eq("week", 1),
      )
      .unique();
  });

  expect(guess?.points).toBe(42);
});
