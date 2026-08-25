/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { ConvexError } from "convex/values";

import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { CURRENT_SEASON } from "./config";
import schema from "./schema";

// The Convex seam over the folds in `board.ts`. The fold edges — tiebreaking,
// removed-member folding, the season sum — are hand-computed in
// `board.test.ts`; what these two tests confirm is the *wiring*: that each
// query reads the right rows for the league it was asked about and hands them
// to the fold, and that a non-member reads nothing at all.

const modules = import.meta.glob("./**/*.ts");

type TestConvex = ReturnType<typeof convexTest<typeof schema.tables>>;

const HOUR_MS = 60 * 60 * 1000;

async function signedIn(t: TestConvex, email: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
  return { as: t.withIdentity({ subject: `${userId}|session` }), userId };
}

/** A league with its commissioner signed in, built through the real mutation. */
async function leagueWithCommissioner(t: TestConvex) {
  const { as } = await signedIn(t, "ash@example.com");
  const leagueId = await as.mutation(api.leagues.createLeague, {
    name: "Family League",
    teamName: "Ash",
  });
  return { as, leagueId };
}

/** A second member, signed in and already in the league. */
async function memberOf(
  t: TestConvex,
  leagueId: Id<"leagues">,
  email: string,
  teamName: string,
) {
  const { as, userId } = await signedIn(t, email);
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      leagueId,
      role: "member",
      teamName,
      joinedAt: Date.now(),
      status: "active",
    }),
  );
  return as;
}

type GameFields = Omit<Doc<"games">, "_id" | "_creationTime">;

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

/** Play a scheduled game out, the way the sync would once it finals. */
async function playOut(
  t: TestConvex,
  gameId: Id<"games">,
  outcome: "home" | "away" | "tie",
  homeScore: number,
  awayScore: number,
) {
  await t.run((ctx) =>
    ctx.db.patch(gameId, { status: "final", outcome, homeScore, awayScore }),
  );
}

/**
 * A week both members have picked and guessed, then played out: they finish
 * level on 2 correct, and Ash's guess of 37 is exactly right.
 */
async function aContestedWeek(t: TestConvex) {
  const { as: ash, leagueId } = await leagueWithCommissioner(t);
  const blake = await memberOf(t, leagueId, "blake@example.com", "Blake");

  const early = await insertGame(t, 2, {
    gameId: `${CURRENT_SEASON}_01_SF_KC`,
  });
  const late = await insertGame(t, 3, {
    gameId: `${CURRENT_SEASON}_01_NYJ_BUF`,
  });
  const nightcap = await insertGame(t, 26, {
    gameId: `${CURRENT_SEASON}_01_GB_CHI`,
    weekday: "Monday",
  });

  for (const [who, selections] of [
    [ash, { early: "home", late: "home", nightcap: "home" }],
    [blake, { early: "home", late: "away", nightcap: "away" }],
  ] as const) {
    for (const [slot, gameId] of [
      ["early", early],
      ["late", late],
      ["nightcap", nightcap],
    ] as const) {
      await who.mutation(api.picks.makePick, {
        leagueId,
        gameId,
        selection: selections[slot],
      });
    }
  }
  await ash.mutation(api.picks.setTiebreakerGuess, {
    leagueId,
    week: 1,
    points: 37,
  });
  await blake.mutation(api.picks.setTiebreakerGuess, {
    leagueId,
    week: 1,
    points: 50,
  });

  await playOut(t, early, "home", 24, 17); // Ash right, Blake right
  await playOut(t, late, "away", 13, 20); // Ash wrong, Blake right
  await playOut(t, nightcap, "home", 20, 17); // Ash right, Blake wrong — 37

  return { ash, blake, leagueId, nightcap };
}

test("the weekly board ranks the week and settles it on the closest guess", async () => {
  const t = convexTest(schema, modules);
  const { ash, leagueId, nightcap } = await aContestedWeek(t);

  const board = await ash.query(api.standings.weeklyStandings, {
    leagueId,
    week: 1,
  });

  expect(board.rows).toMatchObject([
    { teamName: "Ash", correct: 2, rank: 1, guess: 37, proximity: 0 },
    { teamName: "Blake", correct: 2, rank: 2, guess: 50, proximity: 13 },
  ]);
  expect(board.tiebreaker).toEqual({
    gameId: nightcap,
    total: 37,
    state: "settled",
  });
});

test("the season board sums the weeks and leaves a tie as co-champions", async () => {
  const t = convexTest(schema, modules);
  const { ash, leagueId } = await aContestedWeek(t);

  const board = await ash.query(api.standings.seasonStandings, { leagueId });

  expect(board.rows).toMatchObject([
    { teamName: "Ash", points: 2, rank: 1, left: false, titleEligible: true },
    { teamName: "Blake", points: 2, rank: 1, left: false, titleEligible: true },
  ]);
  expect(board.leaders).toHaveLength(2);
});

test("someone outside the league reads no standings at all", async () => {
  const t = convexTest(schema, modules);
  const { leagueId } = await aContestedWeek(t);
  const { as: outsider } = await signedIn(t, "outsider@example.com");

  for (const read of [
    outsider.query(api.standings.weeklyStandings, { leagueId, week: 1 }),
    outsider.query(api.standings.seasonStandings, { leagueId }),
  ]) {
    await expect(read).rejects.toThrow(ConvexError);
  }
});
