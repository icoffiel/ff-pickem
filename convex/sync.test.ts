/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  csvOf,
  PLAYED_2025_WILD_CARD,
  WEEK_1_OPENER,
  WEEK_1_SUNDAY,
  WEEK_8_DST_END_DAY,
} from "../tests/fixtures/nflverse-games";
import { internal } from "./_generated/api";
import { CURRENT_SEASON } from "./config";
import { NFLVERSE_GAMES_CSV_URL } from "./nflverse";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
});

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
