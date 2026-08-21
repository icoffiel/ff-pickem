/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { mergeScheduledGame } from "./games";
import { ScheduledGame } from "./nflverse";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A `convexTest` handle that still knows our schema — `ReturnType<typeof
 * convexTest>` alone drops the generic and leaves `db.query` untyped. */
type TestConvex = ReturnType<typeof convexTest<typeof schema.tables>>;

const SEASON = 2026;
const KICKOFF = Date.parse("2026-09-13T17:00Z");
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** One parsed nflverse row, defaulting to an unplayed scheduled game. */
function scheduled(overrides: Partial<ScheduledGame> = {}): ScheduledGame {
  return {
    gameId: "2026_01_CHI_CAR",
    season: SEASON,
    week: 1,
    gameType: "REG",
    weekday: "Sunday",
    kickoffAt: KICKOFF,
    homeTeam: "CAR",
    awayTeam: "CHI",
    homeScore: undefined,
    awayScore: undefined,
    ...overrides,
  };
}

/** An existing `games` row, as the merge rule sees it. */
function stored(overrides: Partial<Doc<"games">> = {}): Doc<"games"> {
  return {
    _id: "stub" as Doc<"games">["_id"],
    _creationTime: 0,
    ...scheduled(),
    status: "scheduled",
    ...overrides,
  };
}

/** `now`, far enough past kickoff that no NFL game could still be in progress. */
const wellAfter = (kickoffAt: number) => kickoffAt + SIX_HOURS_MS + 1;

describe("mergeScheduledGame", () => {
  test("makes a first-seen game scheduled, with no outcome", () => {
    const merged = mergeScheduledGame(null, scheduled(), KICKOFF - 1000);

    expect(merged.status).toBe("scheduled");
    expect(merged.outcome).toBeUndefined();
    expect(merged.homeTeam).toBe("CAR");
    expect(merged.awayTeam).toBe("CHI");
  });

  test("takes the new kickoff when a game is flexed", () => {
    const flexed = KICKOFF + 3 * 60 * 60 * 1000;

    const merged = mergeScheduledGame(
      stored(),
      scheduled({ kickoffAt: flexed }),
      KICKOFF - 1000,
    );

    expect(merged.kickoffAt).toBe(flexed);
  });

  test("finals a long-past game from nflverse scores, and computes the outcome", () => {
    const merged = mergeScheduledGame(
      stored(),
      scheduled({ homeScore: 24, awayScore: 20 }),
      wellAfter(KICKOFF),
    );

    expect(merged.status).toBe("final");
    expect(merged.outcome).toBe("home");
  });

  test("computes an away win and a tie from the same scores", () => {
    const away = mergeScheduledGame(
      stored(),
      scheduled({ homeScore: 13, awayScore: 29 }),
      wellAfter(KICKOFF),
    );
    const tie = mergeScheduledGame(
      stored(),
      scheduled({ homeScore: 17, awayScore: 17 }),
      wellAfter(KICKOFF),
    );

    expect(away.outcome).toBe("away");
    expect(tie.outcome).toBe("tie");
  });

  test("does not final a game that could still be in progress", () => {
    // nflverse populates its score columns mid-game and has no final flag, so
    // "has a score" alone would grade a live line. Only the age guard settles it.
    const merged = mergeScheduledGame(
      stored(),
      scheduled({ homeScore: 14, awayScore: 10 }),
      KICKOFF + 2 * 60 * 60 * 1000,
    );

    expect(merged.status).toBe("scheduled");
    expect(merged.outcome).toBeUndefined();
    expect(merged.homeScore).toBe(14);
    expect(merged.awayScore).toBe(10);
  });

  test("holds the line exactly at six hours past kickoff", () => {
    const atTheBoundary = mergeScheduledGame(
      stored(),
      scheduled({ homeScore: 24, awayScore: 20 }),
      KICKOFF + SIX_HOURS_MS,
    );

    expect(atTheBoundary.status).toBe("scheduled");
  });

  test("corrects a score the live source got wrong, and moves the outcome with it", () => {
    const merged = mergeScheduledGame(
      stored({
        homeScore: 20,
        awayScore: 24,
        status: "final",
        outcome: "away",
      }),
      scheduled({ homeScore: 27, awayScore: 24 }),
      wellAfter(KICKOFF),
    );

    expect(merged.homeScore).toBe(27);
    expect(merged.outcome).toBe("home");
  });

  test("never clears a score the live source wrote", () => {
    // A blank nflverse score is "no news", not "erase what you have".
    const merged = mergeScheduledGame(
      stored({ homeScore: 21, awayScore: 17, status: "in_progress" }),
      scheduled(),
      KICKOFF + 1000,
    );

    expect(merged.homeScore).toBe(21);
    expect(merged.awayScore).toBe(17);
    expect(merged.status).toBe("in_progress");
  });

  test("never downgrades a final game", () => {
    const merged = mergeScheduledGame(
      stored({
        homeScore: 24,
        awayScore: 20,
        status: "final",
        outcome: "home",
      }),
      scheduled(),
      KICKOFF + 1000,
    );

    expect(merged.status).toBe("final");
    expect(merged.outcome).toBe("home");
  });
});

describe("applySchedule", () => {
  const apply = (
    t: ReturnType<typeof convexTest>,
    games: ScheduledGame[],
    season = SEASON,
  ) => t.mutation(internal.games.applySchedule, { season, games });

  const allGames = (t: ReturnType<typeof convexTest>) =>
    t.run((ctx) => ctx.db.query("games").collect());

  test("inserts a week as scheduled, with no outcome", async () => {
    const t = convexTest(schema, modules);

    await apply(t, [
      scheduled(),
      scheduled({ gameId: "2026_01_NE_SEA", homeTeam: "SEA", awayTeam: "NE" }),
    ]);

    const games = await allGames(t);
    expect(games).toHaveLength(2);
    expect(games.every((g) => g.status === "scheduled")).toBe(true);
    expect(games.every((g) => g.outcome === undefined)).toBe(true);
  });

  test("upserts rather than duplicating when the cron runs again", async () => {
    const t = convexTest(schema, modules);

    await apply(t, [scheduled()]);
    const second = await apply(t, [scheduled()]);

    expect(await allGames(t)).toHaveLength(1);
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  });

  test("leaves an unchanged row alone rather than rewriting it", async () => {
    // Four runs a day against a schedule published months ahead means almost
    // every row is identical almost every time. Rewriting them would wake every
    // subscription on `games` on every tick.
    const t = convexTest(schema, modules);

    await apply(t, [scheduled()]);
    const [before] = await allGames(t);
    await apply(t, [scheduled()]);
    const [after] = await allGames(t);

    expect(after._creationTime).toBe(before._creationTime);
    expect(after).toEqual(before);
  });

  test("inserts a gameId duplicated within one payload only once", async () => {
    const t = convexTest(schema, modules);
    const flexed = KICKOFF + 3 * 60 * 60 * 1000;

    const result = await apply(t, [
      scheduled(),
      scheduled({ kickoffAt: flexed }),
    ]);

    const games = await allGames(t);
    expect(games).toHaveLength(1);
    expect(games[0].kickoffAt).toBe(flexed);
    expect(result).toMatchObject({ inserted: 1, updated: 1 });
  });

  test("moves a flexed game and reports it, so M4 can re-schedule its lock flip", async () => {
    const t = convexTest(schema, modules);
    const flexed = KICKOFF + 3 * 60 * 60 * 1000;

    await apply(t, [scheduled()]);
    const result = await apply(t, [scheduled({ kickoffAt: flexed })]);

    const [game] = await allGames(t);
    expect(game.kickoffAt).toBe(flexed);
    expect(result.kickoffMoved).toEqual([
      {
        id: game._id,
        gameId: "2026_01_CHI_CAR",
        previousKickoffAt: KICKOFF,
        kickoffAt: flexed,
      },
    ]);
  });

  test("reports nothing when kickoffs are unchanged", async () => {
    const t = convexTest(schema, modules);

    await apply(t, [scheduled()]);
    const result = await apply(t, [scheduled()]);

    expect(result.kickoffMoved).toEqual([]);
  });

  test("carries a postponement's new weekday and date", async () => {
    const t = convexTest(schema, modules);
    const postponed = Date.parse("2026-09-15T00:15Z");

    await apply(t, [scheduled()]);
    await apply(t, [scheduled({ kickoffAt: postponed, weekday: "Monday" })]);

    const [game] = await allGames(t);
    expect(game.weekday).toBe("Monday");
    expect(game.kickoffAt).toBe(postponed);
  });

  test("finals a long-past game from nflverse scores and computes the outcome", async () => {
    // The mutation reads the server clock (ADR 0002 rule 1), so the age guard is
    // exercised by moving the clock rather than by passing a time in.
    vi.useFakeTimers();
    vi.setSystemTime(wellAfter(KICKOFF));
    try {
      const t = convexTest(schema, modules);

      await apply(t, [scheduled()]);
      await apply(t, [scheduled({ homeScore: 24, awayScore: 20 })]);

      const [game] = await allGames(t);
      expect(game.status).toBe("final");
      expect(game.outcome).toBe("home");
    } finally {
      vi.useRealTimers();
    }
  });

  test("scopes its existing-row lookup to the season being applied", async () => {
    const t = convexTest(schema, modules);

    await apply(
      t,
      [scheduled({ gameId: "2025_01_DAL_PHI", season: 2025 })],
      2025,
    );
    await apply(t, [scheduled()]);

    const games = await allGames(t);
    expect(games.map((g) => g.gameId).sort()).toEqual([
      "2025_01_DAL_PHI",
      "2026_01_CHI_CAR",
    ]);
  });
});

describe("weeksInPlay", () => {
  const KICKOFF_2026_W1 = Date.parse("2026-09-13T17:00Z");

  /** A `games` row as the schedule sync would have left it. */
  async function withGames(
    rows: Array<Partial<Doc<"games">> & { gameId: string }>,
  ) {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const row of rows) {
        await ctx.db.insert("games", {
          season: SEASON,
          week: 1,
          gameType: "REG",
          weekday: "Sunday",
          kickoffAt: KICKOFF_2026_W1,
          homeTeam: "CAR",
          awayTeam: "CHI",
          status: "scheduled",
          ...row,
        });
      }
    });
    return t;
  }

  test("finds nothing when the nearest game is days away", async () => {
    const t = await withGames([{ gameId: "2026_01_CHI_CAR" }]);

    const weeks = await t.query(internal.games.weeksInPlay, {
      now: KICKOFF_2026_W1 - 3 * 24 * 60 * 60 * 1000,
    });

    expect(weeks).toEqual([]);
  });

  test("opens shortly before kickoff, so no game reads scheduled after the snap", async () => {
    const t = await withGames([{ gameId: "2026_01_CHI_CAR" }]);

    expect(
      await t.query(internal.games.weeksInPlay, {
        now: KICKOFF_2026_W1 - 20 * 60 * 1000,
      }),
    ).toEqual([]);
    expect(
      await t.query(internal.games.weeksInPlay, {
        now: KICKOFF_2026_W1 - 10 * 60 * 1000,
      }),
    ).toEqual([{ season: SEASON, week: 1 }]);
  });

  test("closes five hours after kickoff", async () => {
    const t = await withGames([{ gameId: "2026_01_CHI_CAR" }]);

    expect(
      await t.query(internal.games.weeksInPlay, {
        now: KICKOFF_2026_W1 + 4 * 60 * 60 * 1000,
      }),
    ).toEqual([{ season: SEASON, week: 1 }]);
    expect(
      await t.query(internal.games.weeksInPlay, {
        now: KICKOFF_2026_W1 + 6 * 60 * 60 * 1000,
      }),
    ).toEqual([]);
  });

  test("ignores a game that has already finaled", async () => {
    const t = await withGames([
      { gameId: "2026_01_CHI_CAR", status: "final", outcome: "home" },
    ]);

    expect(
      await t.query(internal.games.weeksInPlay, { now: KICKOFF_2026_W1 }),
    ).toEqual([]);
  });

  test("reports a week once however many of its games are in window", async () => {
    const t = await withGames([
      { gameId: "2026_01_CHI_CAR" },
      { gameId: "2026_01_NE_SEA", homeTeam: "SEA", awayTeam: "NE" },
      {
        gameId: "2026_01_BUF_HOU",
        homeTeam: "HOU",
        awayTeam: "BUF",
        status: "in_progress",
      },
    ]);

    expect(
      await t.query(internal.games.weeksInPlay, { now: KICKOFF_2026_W1 }),
    ).toEqual([{ season: SEASON, week: 1 }]);
  });

  test("reports each week that has a game in window", async () => {
    const t = await withGames([
      { gameId: "2026_01_CHI_CAR" },
      { gameId: "2026_02_NE_SEA", week: 2, homeTeam: "SEA", awayTeam: "NE" },
    ]);

    expect(
      await t.query(internal.games.weeksInPlay, { now: KICKOFF_2026_W1 }),
    ).toEqual([
      { season: SEASON, week: 1 },
      { season: SEASON, week: 2 },
    ]);
  });
});

describe("applyLiveEvents", () => {
  const KICKOFF_2026_W1 = Date.parse("2026-09-13T17:00Z");

  /** One week's `games` rows, as the schedule sync would have left them. */
  async function withWeekOne(
    matchups: Array<{ away: string; home: string } & Partial<Doc<"games">>>,
  ) {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const { away, home, ...overrides } of matchups) {
        await ctx.db.insert("games", {
          gameId: `2026_01_${away}_${home}`,
          season: SEASON,
          week: 1,
          gameType: "REG",
          weekday: "Sunday",
          kickoffAt: KICKOFF_2026_W1,
          homeTeam: home,
          awayTeam: away,
          status: "scheduled",
          ...overrides,
        });
      }
    });
    return t;
  }

  const gameNamed = (t: TestConvex, gameId: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("games")
        .withIndex("by_gameId", (q) => q.eq("gameId", gameId))
        .unique(),
    );

  test("writes a live score without finaling the game", async () => {
    const t = await withWeekOne([{ away: "CHI", home: "CAR" }]);

    await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 7,
          awayScore: 10,
          status: "in_progress",
        },
      ],
    });

    const game = await gameNamed(t, "2026_01_CHI_CAR");
    expect(game).toMatchObject({
      status: "in_progress",
      homeScore: 7,
      awayScore: 10,
    });
    expect(game?.outcome).toBeUndefined();
  });

  test("grades a final game by writing its outcome", async () => {
    const t = await withWeekOne([
      { away: "CHI", home: "CAR" },
      { away: "NE", home: "SEA" },
      { away: "GB", home: "DAL" },
    ]);

    await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 24,
          awayScore: 20,
          status: "final",
        },
        {
          homeTeam: "SEA",
          awayTeam: "NE",
          homeScore: 13,
          awayScore: 17,
          status: "final",
        },
        {
          homeTeam: "DAL",
          awayTeam: "GB",
          homeScore: 40,
          awayScore: 40,
          status: "final",
        },
      ],
    });

    expect(await gameNamed(t, "2026_01_CHI_CAR")).toMatchObject({
      status: "final",
      outcome: "home",
    });
    expect(await gameNamed(t, "2026_01_NE_SEA")).toMatchObject({
      status: "final",
      outcome: "away",
    });
    expect(await gameNamed(t, "2026_01_GB_DAL")).toMatchObject({
      status: "final",
      outcome: "tie",
    });
  });

  test("lands an event only on the row with the same season, week, home and away", async () => {
    const t = await withWeekOne([
      { away: "CHI", home: "CAR" },
      // The same matchup, reversed — the away row must not take the home row's
      // score, or a whole week grades backwards.
      { away: "CAR", home: "CHI", gameId: "2026_09_CAR_CHI", week: 9 },
      { away: "NE", home: "SEA" },
    ]);

    await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 24,
          awayScore: 20,
          status: "final",
        },
      ],
    });

    expect(await gameNamed(t, "2026_01_CHI_CAR")).toMatchObject({
      status: "final",
      homeScore: 24,
    });
    const reversed = await gameNamed(t, "2026_09_CAR_CHI");
    expect(reversed).toMatchObject({ status: "scheduled" });
    expect(reversed?.homeScore).toBeUndefined();
    expect(await gameNamed(t, "2026_01_NE_SEA")).toMatchObject({
      status: "scheduled",
    });
  });

  test("reports an unmatched event instead of failing the batch", async () => {
    const t = await withWeekOne([{ away: "CHI", home: "CAR" }]);

    const result = await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "XXX",
          awayTeam: "YYY",
          homeScore: 3,
          awayScore: 0,
          status: "final",
        },
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 24,
          awayScore: 20,
          status: "final",
        },
      ],
    });

    expect(result.unmatched).toEqual(["YYY @ XXX"]);
    expect(result.updated).toBe(1);
    expect(await gameNamed(t, "2026_01_CHI_CAR")).toMatchObject({
      status: "final",
    });
  });

  test("never downgrades a game that has already finaled", async () => {
    const t = await withWeekOne([
      {
        away: "CHI",
        home: "CAR",
        status: "final",
        homeScore: 24,
        awayScore: 20,
        outcome: "home",
      },
    ]);

    await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 0,
          awayScore: 0,
          status: "in_progress",
        },
      ],
    });

    expect(await gameNamed(t, "2026_01_CHI_CAR")).toMatchObject({
      status: "final",
      homeScore: 24,
      awayScore: 20,
      outcome: "home",
    });
  });

  test("writes nothing for a game ESPN still calls scheduled", async () => {
    // ESPN publishes `"0"` scores for a game that has not kicked off. Storing
    // them would make the schedule sync's age guard read the game as scored,
    // and final it six hours later as a 0-0 tie.
    const t = await withWeekOne([{ away: "CHI", home: "CAR" }]);

    const result = await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 0,
          awayScore: 0,
          status: "scheduled",
        },
      ],
    });

    expect(result).toMatchObject({ updated: 0, unchanged: 1 });
    const untouched = await gameNamed(t, "2026_01_CHI_CAR");
    expect(untouched).toMatchObject({ status: "scheduled" });
    expect(untouched?.homeScore).toBeUndefined();
    expect(untouched?.awayScore).toBeUndefined();
  });

  test("leaves a row alone when the reading has not changed", async () => {
    const t = await withWeekOne([
      {
        away: "CHI",
        home: "CAR",
        status: "in_progress",
        homeScore: 7,
        awayScore: 10,
      },
    ]);

    const result = await t.mutation(internal.games.applyLiveEvents, {
      season: SEASON,
      week: 1,
      events: [
        {
          homeTeam: "CAR",
          awayTeam: "CHI",
          homeScore: 7,
          awayScore: 10,
          status: "in_progress",
        },
      ],
    });

    expect(result).toMatchObject({ updated: 0, unchanged: 1 });
  });
});
