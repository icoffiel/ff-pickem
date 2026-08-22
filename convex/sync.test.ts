/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FINAL_AWAY_WIN_PIT_AT_NYJ,
  FINAL_HOME_WIN_HOU_AT_LAR,
  FINAL_HOME_WIN_NYG_AT_WSH,
  FINAL_TIE_GB_AT_DAL,
  inProgress,
  scoreboardOf,
} from "../tests/fixtures/espn-scoreboard";
import {
  csvOf,
  PLAYED_2025_WILD_CARD,
  WEEK_1_OPENER,
  WEEK_1_SUNDAY,
  WEEK_8_DST_END_DAY,
} from "../tests/fixtures/nflverse-games";
import { internal } from "./_generated/api";
import { CURRENT_SEASON } from "./config";
import { scoreboardUrl } from "./espn";
import { NFLVERSE_GAMES_CSV_URL } from "./nflverse";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A `convexTest` handle that still knows our schema — `ReturnType<typeof
 * convexTest>` alone drops the generic and leaves `db.query` untyped. */
type TestConvex = ReturnType<typeof convexTest<typeof schema.tables>>;

/**
 * The fetch boundary, stubbed.
 *
 * No test hits nflverse: it is an unofficial community file, and a suite that
 * depends on it fails for reasons unrelated to our code. Stubbing the global
 * rather than injecting a `fetchImpl` keeps the action's signature honest — the
 * test drives the real registered function, wiring and all. This is the pattern
 * for every later external integration.
 */
function stubFetch(respond: (url: string) => Response) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    requested.push(url);
    return Promise.resolve(respond(url));
  });
  return requested;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Pin the server clock. `liveSync`'s gate reads it, so a test that did not fix
 * it would pass or fail depending on the calendar. `shouldAdvanceTime` keeps
 * convex-test's own scheduling working while the clock is frozen.
 */
function atTime(instant: number) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(instant);
}

describe("scheduleSync", () => {
  test("loads the current season's regular-season schedule into games", async () => {
    const t = convexTest(schema, modules);
    const requested = stubFetch(
      () =>
        new Response(
          csvOf(
            WEEK_1_OPENER,
            WEEK_1_SUNDAY,
            WEEK_8_DST_END_DAY,
            PLAYED_2025_WILD_CARD,
          ),
        ),
    );

    const result = await t.action(internal.sync.scheduleSync, {});

    expect(requested).toEqual([NFLVERSE_GAMES_CSV_URL]);
    expect(result).toMatchObject({ inserted: 3, updated: 0 });

    const games = await t.run((ctx) => ctx.db.query("games").collect());
    expect(games.map((g) => g.gameId).sort()).toEqual([
      "2026_01_CHI_CAR",
      "2026_01_NE_SEA",
      "2026_08_BAL_BUF",
    ]);
    expect(games.every((g) => g.season === CURRENT_SEASON)).toBe(true);
    expect(games.every((g) => g.gameType === "REG")).toBe(true);
  });

  test("upserts rather than duplicating when the cron runs again", async () => {
    const t = convexTest(schema, modules);
    stubFetch(() => new Response(csvOf(WEEK_1_OPENER, WEEK_1_SUNDAY)));

    await t.action(internal.sync.scheduleSync, {});
    const second = await t.action(internal.sync.scheduleSync, {});

    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await t.run((ctx) => ctx.db.query("games").collect())).toHaveLength(
      2,
    );
  });

  test("reports a game upstream has not scheduled instead of writing a timeless row", async () => {
    const t = convexTest(schema, modules);
    const unscheduled = WEEK_1_SUNDAY.replace(",Sunday,13:00,", ",Sunday,,");
    stubFetch(() => new Response(csvOf(unscheduled, WEEK_1_OPENER)));

    const result = await t.action(internal.sync.scheduleSync, {});

    expect(result.withoutKickoffTime).toEqual(["2026_01_CHI_CAR"]);
    const games = await t.run((ctx) => ctx.db.query("games").collect());
    expect(games.map((g) => g.gameId)).toEqual(["2026_01_NE_SEA"]);
  });

  test("fails loudly on a non-OK response rather than writing nothing quietly", async () => {
    const t = convexTest(schema, modules);
    stubFetch(() => new Response("not found", { status: 404 }));

    await expect(t.action(internal.sync.scheduleSync, {})).rejects.toThrow(
      /404/,
    );
    expect(await t.run((ctx) => ctx.db.query("games").collect())).toEqual([]);
  });
});

describe("liveSync", () => {
  const KICKOFF = Date.parse("2026-09-13T17:00Z");

  /** This season's week 1, as the schedule sync would have left it. */
  async function withWeek(
    matchups: Array<{ away: string; home: string } & { week?: number }>,
  ) {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const { away, home, week = 1 } of matchups) {
        await ctx.db.insert("games", {
          gameId: `${CURRENT_SEASON}_0${week}_${away}_${home}`,
          season: CURRENT_SEASON,
          week,
          gameType: "REG",
          weekday: "Sunday",
          kickoffAt: KICKOFF,
          homeTeam: home,
          awayTeam: away,
          status: "scheduled",
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

  test("makes no ESPN request at all when no game is near", async () => {
    const t = await withWeek([{ away: "CHI", home: "CAR" }]);
    const requested = stubFetch(() => new Response("should not be fetched"));
    atTime(KICKOFF - 3 * 24 * 60 * 60 * 1000);

    const result = await t.action(internal.sync.liveSync, {});

    expect(requested).toEqual([]);
    expect(result).toEqual({
      polled: [],
      updated: 0,
      unchanged: 0,
      unmatched: [],
      unreadable: [],
    });
    expect(await gameNamed(t, "2026_01_CHI_CAR")).toMatchObject({
      status: "scheduled",
    });
  });

  test("fetches only the weeks that have a game in window", async () => {
    const t = await withWeek([
      { away: "CHI", home: "CAR" },
      { away: "NE", home: "SEA", week: 2 },
    ]);
    await t.run(async (ctx) => {
      const away = await ctx.db
        .query("games")
        .withIndex("by_gameId", (q) => q.eq("gameId", "2026_02_NE_SEA"))
        .unique();
      await ctx.db.patch(away!._id, {
        kickoffAt: KICKOFF + 7 * 24 * 60 * 60 * 1000,
      });
    });
    const requested = stubFetch(
      () => new Response(JSON.stringify(scoreboardOf(CURRENT_SEASON, 1))),
    );
    atTime(KICKOFF);

    await t.action(internal.sync.liveSync, {});

    expect(requested).toEqual([scoreboardUrl(CURRENT_SEASON, 1)]);
  });

  test("advances a week through in_progress to final, grading as it goes", async () => {
    const t = await withWeek([
      { away: "NYG", home: "WAS" },
      { away: "HOU", home: "LA" },
      { away: "PIT", home: "NYJ" },
    ]);
    atTime(KICKOFF);

    // Mid-game: scores move, nothing is graded yet.
    stubFetch(
      () =>
        new Response(
          JSON.stringify(
            scoreboardOf(
              CURRENT_SEASON,
              1,
              inProgress(FINAL_HOME_WIN_NYG_AT_WSH, 14, 6),
              inProgress(FINAL_HOME_WIN_HOU_AT_LAR, 7, 9),
              inProgress(FINAL_AWAY_WIN_PIT_AT_NYJ, 25, 31),
            ),
          ),
        ),
    );
    await t.action(internal.sync.liveSync, {});

    // The Commanders row only matches because ESPN's `WSH` became `WAS`.
    const commanders = await gameNamed(t, "2026_01_NYG_WAS");
    expect(commanders).toMatchObject({
      status: "in_progress",
      homeScore: 14,
      awayScore: 6,
    });
    expect(commanders?.outcome).toBeUndefined();
    // And the Rams row only because `LAR` became `LA`.
    expect(await gameNamed(t, "2026_01_HOU_LA")).toMatchObject({
      status: "in_progress",
      homeScore: 7,
    });

    // Final: the same week, now graded.
    stubFetch(
      () =>
        new Response(
          JSON.stringify(
            scoreboardOf(
              CURRENT_SEASON,
              1,
              FINAL_HOME_WIN_NYG_AT_WSH,
              FINAL_HOME_WIN_HOU_AT_LAR,
              FINAL_AWAY_WIN_PIT_AT_NYJ,
            ),
          ),
        ),
    );
    await t.action(internal.sync.liveSync, {});

    expect(await gameNamed(t, "2026_01_NYG_WAS")).toMatchObject({
      status: "final",
      homeScore: 21,
      awayScore: 6,
      outcome: "home",
    });
    expect(await gameNamed(t, "2026_01_HOU_LA")).toMatchObject({
      status: "final",
      outcome: "home",
    });
    expect(await gameNamed(t, "2026_01_PIT_NYJ")).toMatchObject({
      status: "final",
      homeScore: 32,
      awayScore: 34,
      outcome: "away",
    });
  });

  test("stops asking about a week once every game in it is final", async () => {
    const t = await withWeek([{ away: "GB", home: "DAL" }]);
    atTime(KICKOFF);
    stubFetch(
      () =>
        new Response(
          JSON.stringify(scoreboardOf(CURRENT_SEASON, 1, FINAL_TIE_GB_AT_DAL)),
        ),
    );

    await t.action(internal.sync.liveSync, {});
    expect(await gameNamed(t, "2026_01_GB_DAL")).toMatchObject({
      status: "final",
      outcome: "tie",
    });

    const requested = stubFetch(() => new Response("should not be fetched"));
    expect(await t.action(internal.sync.liveSync, {})).toMatchObject({
      polled: [],
    });
    expect(requested).toEqual([]);
  });

  test("fails loudly on a non-OK response rather than writing nothing quietly", async () => {
    const t = await withWeek([{ away: "CHI", home: "CAR" }]);
    atTime(KICKOFF);
    stubFetch(() => new Response("service unavailable", { status: 503 }));

    await expect(t.action(internal.sync.liveSync, {})).rejects.toThrow(/503/);
  });
});
