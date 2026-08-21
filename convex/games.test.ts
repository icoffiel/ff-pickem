/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { mergeScheduledGame } from "./games";
import { ScheduledGame } from "./nflverse";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
