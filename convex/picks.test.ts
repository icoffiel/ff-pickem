/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { ConvexError } from "convex/values";

import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { CURRENT_SEASON } from "./config";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type TestConvex = ReturnType<typeof convexTest<typeof schema.tables>>;

const HOUR_MS = 60 * 60 * 1000;

/** A caller acting as a freshly-inserted user (see `leagues.test.ts`). */
async function signedIn(t: TestConvex, email: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
  return t.withIdentity({ subject: `${userId}|session` });
}

/**
 * A league with its commissioner signed in — the caller every test picks as.
 * Built through `createLeague` so the membership and the default rule-set are
 * the real ones, not a fixture's guess at them.
 */
async function leagueWithCommissioner(t: TestConvex) {
  const as = await signedIn(t, "commish@example.com");
  const leagueId = await as.mutation(api.leagues.createLeague, {
    name: "Family League",
    teamName: "Thunder Llamas",
  });
  return { as, leagueId };
}

type GameFields = Omit<Doc<"games">, "_id" | "_creationTime">;

/**
 * One scheduled game, kicking off `hoursFromNow` from the moment the test runs.
 * Kickoffs are relative because the lock is derived live from them: a game an
 * hour out is a week still open, an hour past is a week already locked.
 */
async function insertGame(
  t: TestConvex,
  hoursFromNow: number,
  overrides: Partial<GameFields> = {},
) {
  const fields: GameFields = {
    gameId: `${CURRENT_SEASON}_01_CHI_CAR`,
    season: CURRENT_SEASON,
    week: 1,
    gameType: "REG",
    weekday: "Sunday",
    kickoffAt: Date.now() + hoursFromNow * HOUR_MS,
    homeTeam: "CAR",
    awayTeam: "CHI",
    status: "scheduled",
    ...overrides,
  };
  return t.run((ctx) => ctx.db.insert("games", fields));
}

/** The error code a rejected write threw, for asserting on the refusal. */
async function refusalCode(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error) {
    if (error instanceof ConvexError) {
      return (error.data as { code: string }).code;
    }
    throw error;
  }
  throw new Error("expected the write to be rejected, but it succeeded");
}

async function picksOf(t: TestConvex, leagueId: Id<"leagues">) {
  return t.run((ctx) =>
    ctx.db
      .query("picks")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", leagueId).eq("week", 1),
      )
      .collect(),
  );
}

test("a pick made before the lock is accepted", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, 1);

  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId,
    selection: "home",
  });

  const picks = await picksOf(t, leagueId);
  expect(picks).toHaveLength(1);
  expect(picks[0]).toMatchObject({
    gameId,
    leagueId,
    week: 1,
    selection: "home",
  });
});

test("a pick made after the lock is rejected", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, -1);

  const code = await refusalCode(
    as.mutation(api.picks.makePick, { leagueId, gameId, selection: "home" }),
  );

  expect(code).toBe("WeekLocked");
  expect(await picksOf(t, leagueId)).toHaveLength(0);
});

test("the lock is the first counted kickoff, so a Thursday game does not close the week", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, -1, {
    gameId: `${CURRENT_SEASON}_01_DAL_PHI`,
    weekday: "Thursday",
    homeTeam: "PHI",
    awayTeam: "DAL",
  });
  const sundayGame = await insertGame(t, 1);

  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: sundayGame,
    selection: "away",
  });

  expect(await picksOf(t, leagueId)).toHaveLength(1);
});

test("a game the slate drops cannot be picked at all", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const thursdayGame = await insertGame(t, 1, { weekday: "Thursday" });

  const code = await refusalCode(
    as.mutation(api.picks.makePick, {
      leagueId,
      gameId: thursdayGame,
      selection: "home",
    }),
  );

  expect(code).toBe("NotOnSlate");
});

test("changing a pick before the lock replaces it rather than adding a second", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, 1);

  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId,
    selection: "home",
  });
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId,
    selection: "away",
  });

  const picks = await picksOf(t, leagueId);
  expect(picks).toHaveLength(1);
  expect(picks[0].selection).toBe("away");
});

test("a pick can no longer be changed once the week has locked", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, 1);
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId,
    selection: "home",
  });

  // The game is flexed into the past — the lock is derived from the current
  // kickoff, so the week is now closed and the pick made under it stands.
  await t.run((ctx) =>
    ctx.db.patch(gameId, { kickoffAt: Date.now() - HOUR_MS }),
  );
  const code = await refusalCode(
    as.mutation(api.picks.makePick, { leagueId, gameId, selection: "away" }),
  );

  expect(code).toBe("WeekLocked");
  expect((await picksOf(t, leagueId))[0].selection).toBe("home");
});

test("a removed member cannot pick", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, 1);
  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .unique(),
  );
  await t.run((ctx) =>
    ctx.db.patch(membership!._id, { status: "removed", removedAt: Date.now() }),
  );

  const code = await refusalCode(
    as.mutation(api.picks.makePick, { leagueId, gameId, selection: "home" }),
  );

  expect(code).toBe("NotMember");
});

test("someone with no membership in the league cannot pick", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, 1);
  const stranger = await signedIn(t, "stranger@example.com");

  const code = await refusalCode(
    stranger.mutation(api.picks.makePick, {
      leagueId,
      gameId,
      selection: "home",
    }),
  );

  expect(code).toBe("NotMember");
});

test("a signed-out caller cannot pick", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await leagueWithCommissioner(t);
  const gameId = await insertGame(t, 1);

  const code = await refusalCode(
    t.mutation(api.picks.makePick, { leagueId, gameId, selection: "home" }),
  );

  expect(code).toBe("NotSignedIn");
});

test("picking ahead into a not-yet-locked week is accepted while this week is shut", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const thisWeek = await insertGame(t, -1);
  const nextWeek = await insertGame(t, 24 * 6, {
    gameId: `${CURRENT_SEASON}_02_CHI_CAR`,
    week: 2,
  });

  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: nextWeek,
    selection: "home",
  });
  const code = await refusalCode(
    as.mutation(api.picks.makePick, {
      leagueId,
      gameId: thisWeek,
      selection: "home",
    }),
  );

  expect(code).toBe("WeekLocked");
  const weekTwo = await t.run((ctx) =>
    ctx.db
      .query("picks")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", leagueId).eq("week", 2),
      )
      .collect(),
  );
  expect(weekTwo).toHaveLength(1);
});

async function guessesOf(t: TestConvex, leagueId: Id<"leagues">) {
  return t.run((ctx) =>
    ctx.db
      .query("tiebreakerGuesses")
      .withIndex("by_league_week", (q) =>
        q.eq("leagueId", leagueId).eq("week", 1),
      )
      .collect(),
  );
}

test("a tiebreaker guess made before the lock is accepted", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, 1);

  await as.mutation(api.picks.setTiebreakerGuess, {
    leagueId,
    week: 1,
    points: 47,
  });

  const guesses = await guessesOf(t, leagueId);
  expect(guesses).toHaveLength(1);
  expect(guesses[0]).toMatchObject({ leagueId, week: 1, points: 47 });
});

test("the tiebreaker guess shares the week's pick deadline", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, -1);

  const code = await refusalCode(
    as.mutation(api.picks.setTiebreakerGuess, {
      leagueId,
      week: 1,
      points: 47,
    }),
  );

  expect(code).toBe("WeekLocked");
  expect(await guessesOf(t, leagueId)).toHaveLength(0);
});

test("revising a guess replaces it rather than adding a second", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, 1);

  await as.mutation(api.picks.setTiebreakerGuess, {
    leagueId,
    week: 1,
    points: 47,
  });
  await as.mutation(api.picks.setTiebreakerGuess, {
    leagueId,
    week: 1,
    points: 52,
  });

  const guesses = await guessesOf(t, leagueId);
  expect(guesses).toHaveLength(1);
  expect(guesses[0].points).toBe(52);
});

test("a removed member cannot guess", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, 1);
  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .unique(),
  );
  await t.run((ctx) =>
    ctx.db.patch(membership!._id, { status: "removed", removedAt: Date.now() }),
  );

  const code = await refusalCode(
    as.mutation(api.picks.setTiebreakerGuess, {
      leagueId,
      week: 1,
      points: 47,
    }),
  );

  expect(code).toBe("NotMember");
});

test("a guess must be a whole, non-negative number of points", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, 1);

  for (const points of [-1, 41.5, Number.NaN]) {
    expect(
      await refusalCode(
        as.mutation(api.picks.setTiebreakerGuess, {
          leagueId,
          week: 1,
          points,
        }),
      ),
    ).toBe("InvalidGuess");
  }
  expect(await guessesOf(t, leagueId)).toHaveLength(0);
});

test("a week with no counted games has no deadline to guess under", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertGame(t, 1, { weekday: "Thursday" });

  const code = await refusalCode(
    as.mutation(api.picks.setTiebreakerGuess, {
      leagueId,
      week: 1,
      points: 47,
    }),
  );

  expect(code).toBe("NoSlate");
});

/** The three-game Week 1 the pick-sheet tests read, inserted out of order. */
async function insertWeekOne(t: TestConvex, hoursFromNow = 1) {
  const monday = await insertGame(t, hoursFromNow + 30, {
    gameId: `${CURRENT_SEASON}_01_NYJ_BUF`,
    weekday: "Monday",
    homeTeam: "BUF",
    awayTeam: "NYJ",
  });
  const sunday = await insertGame(t, hoursFromNow);
  const thursday = await insertGame(t, hoursFromNow - 3, {
    gameId: `${CURRENT_SEASON}_01_DAL_PHI`,
    weekday: "Thursday",
    homeTeam: "PHI",
    awayTeam: "DAL",
  });
  return { sunday, monday, thursday };
}

const NOW = () => Math.floor(Date.now() / 60_000) * 60_000;

test("the pick sheet opens on the active week and shows only counted games", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday, monday } = await insertWeekOne(t);
  await insertGame(t, 24 * 8, {
    gameId: `${CURRENT_SEASON}_02_CHI_CAR`,
    week: 2,
  });

  const sheet = await as.query(api.picks.pickSheet, { leagueId, now: NOW() });

  expect(sheet.week).toBe(1);
  expect(sheet.activeWeek).toBe(1);
  expect(sheet.weeks).toEqual([1, 2]);
  // Kickoff order, and no sign of the Thursday game.
  expect(sheet.games.map((g) => g.gameId)).toEqual([sunday, monday]);
  expect(sheet.locked).toBe(false);
});

test("the pick sheet names the week's deadline and its tiebreaker game", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday, monday } = await insertWeekOne(t);

  const sheet = await as.query(api.picks.pickSheet, { leagueId, now: NOW() });

  const sundayKickoff = await t.run(
    async (ctx) => (await ctx.db.get(sunday))!.kickoffAt,
  );
  expect(sheet.lockAt).toBe(sundayKickoff);
  expect(sheet.tiebreakerGameId).toBe(monday);
});

test("the pick sheet carries my own picks and my own guess", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday, monday } = await insertWeekOne(t);
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: sunday,
    selection: "away",
  });
  await as.mutation(api.picks.setTiebreakerGuess, {
    leagueId,
    week: 1,
    points: 47,
  });

  const sheet = await as.query(api.picks.pickSheet, { leagueId, now: NOW() });

  expect(sheet.tiebreakerGuess).toBe(47);
  expect(sheet.games).toMatchObject([
    { gameId: sunday, selection: "away", result: "pending" },
    { gameId: monday, selection: null, result: "absent" },
  ]);
});

test("the pick sheet never carries another member's picks", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday } = await insertWeekOne(t);
  const rival = await signedIn(t, "rival@example.com");
  const rivalUserId = await t.run(
    async (ctx) =>
      (await ctx.db.query("users").collect()).find(
        (u) => u.email === "rival@example.com",
      )!._id,
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: rivalUserId,
      leagueId,
      role: "member",
      status: "active",
      teamName: "Rivals",
      joinedAt: Date.now(),
    }),
  );
  await rival.mutation(api.picks.makePick, {
    leagueId,
    gameId: sunday,
    selection: "home",
  });

  const sheet = await as.query(api.picks.pickSheet, { leagueId, now: NOW() });

  expect(sheet.games.every((g) => g.selection === null)).toBe(true);
});

test("the pick sheet grades each pick against the game's result", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday, monday } = await insertWeekOne(t);
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: sunday,
    selection: "home",
  });
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: monday,
    selection: "home",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(sunday, {
      status: "final",
      homeScore: 24,
      awayScore: 17,
      outcome: "home",
    });
    await ctx.db.patch(monday, {
      status: "final",
      homeScore: 17,
      awayScore: 24,
      outcome: "away",
    });
  });

  const sheet = await as.query(api.picks.pickSheet, {
    leagueId,
    week: 1,
    now: NOW(),
  });

  expect(sheet.games.map((g) => g.result)).toEqual(["correct", "incorrect"]);
});

test("the pick sheet treats a tied game as a push", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday } = await insertWeekOne(t);
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: sunday,
    selection: "home",
  });
  await t.run((ctx) =>
    ctx.db.patch(sunday, {
      status: "final",
      homeScore: 20,
      awayScore: 20,
      outcome: "tie",
    }),
  );

  const sheet = await as.query(api.picks.pickSheet, {
    leagueId,
    week: 1,
    now: NOW(),
  });

  expect(sheet.games[0].result).toBe("push");
});

test("the pick sheet grades against a commissioner's correction when one exists", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  const { sunday } = await insertWeekOne(t);
  await as.mutation(api.picks.makePick, {
    leagueId,
    gameId: sunday,
    selection: "away",
  });
  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .unique(),
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(sunday, {
      status: "final",
      homeScore: 24,
      awayScore: 17,
      outcome: "home",
    });
    await ctx.db.insert("resultOverrides", {
      leagueId,
      gameId: sunday,
      week: 1,
      outcome: "away",
      createdBy: membership!._id,
      createdAt: Date.now(),
    });
  });

  const sheet = await as.query(api.picks.pickSheet, {
    leagueId,
    week: 1,
    now: NOW(),
  });

  expect(sheet.games[0].result).toBe("correct");
});

test("the pick sheet reports a past-deadline week as locked", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertWeekOne(t, -2);

  const sheet = await as.query(api.picks.pickSheet, {
    leagueId,
    week: 1,
    now: NOW(),
  });

  expect(sheet.locked).toBe(true);
  expect(sheet.activeWeek).toBeNull();
});

test("the pick sheet opens on a requested future week for picking ahead", async () => {
  const t = convexTest(schema, modules);
  const { as, leagueId } = await leagueWithCommissioner(t);
  await insertWeekOne(t);
  const nextWeek = await insertGame(t, 24 * 8, {
    gameId: `${CURRENT_SEASON}_02_CHI_CAR`,
    week: 2,
  });

  const sheet = await as.query(api.picks.pickSheet, {
    leagueId,
    week: 2,
    now: NOW(),
  });

  expect(sheet.week).toBe(2);
  expect(sheet.activeWeek).toBe(1);
  expect(sheet.games.map((g) => g.gameId)).toEqual([nextWeek]);
});

test("the pick sheet is refused to someone with no membership", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await leagueWithCommissioner(t);
  await insertWeekOne(t);
  const stranger = await signedIn(t, "stranger@example.com");

  const code = await refusalCode(
    stranger.query(api.picks.pickSheet, { leagueId, now: NOW() }),
  );

  expect(code).toBe("NotMember");
});
