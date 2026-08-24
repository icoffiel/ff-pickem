import { describe, expect, test } from "vitest";

import { DEFAULT_RULES, RuleSet } from "./config";
import {
  activeWeek,
  lock,
  slate,
  SlateGame,
  tiebreakerGame,
  WeekGame,
} from "./week";

/**
 * A realistic Week 13 — the one week that puts a game on every day the slate
 * rule has an opinion about, because it carries the Black Friday game.
 * Kickoffs are the real 2026 slots, so the ordering assertions below are about
 * a schedule someone could actually be looking at.
 */
const WEEK_13 = [
  game("Thursday", "2026-11-26T17:30Z"), // Thanksgiving early
  game("Thursday", "2026-11-26T21:30Z"), // Thanksgiving late
  game("Friday", "2026-11-27T20:00Z"), // Black Friday
  game("Saturday", "2026-11-28T21:00Z"),
  game("Sunday", "2026-11-29T18:00Z"),
  game("Sunday", "2026-11-29T21:25Z"),
  game("Monday", "2026-11-30T01:20Z"),
];

/** One game as the derivations see it: a weekday, a kind, and a kickoff. */
function game(
  weekday: string,
  kickoff: string,
  overrides: Partial<SlateGame> = {},
): SlateGame {
  return {
    gameType: "REG",
    weekday,
    kickoffAt: Date.parse(kickoff),
    ...overrides,
  };
}

/** The weekdays a derived slate kept, in the order it returned them. */
function weekdays(games: readonly SlateGame[]): string[] {
  return games.map((g) => g.weekday);
}

/** A game in a named week, for the whole-season derivations. */
function weekGame(week: number, weekday: string, kickoff: string): WeekGame {
  return { week, ...game(weekday, kickoff) };
}

function withRules(overrides: Partial<RuleSet>): RuleSet {
  return { ...DEFAULT_RULES, ...overrides };
}

describe("slate", () => {
  test("keeps Saturday, Sunday and Monday and drops Thursday and Friday", () => {
    expect(weekdays(slate(WEEK_13, DEFAULT_RULES))).toEqual([
      "Saturday",
      "Sunday",
      "Sunday",
      "Monday",
    ]);
  });

  test("excludes the Week 13 Black Friday game", () => {
    expect(weekdays(slate(WEEK_13, DEFAULT_RULES))).not.toContain("Friday");
  });

  test("drops Saturday under the Sunday+Monday rule", () => {
    const rules = withRules({ slate: "sundayMonday" });

    expect(weekdays(slate(WEEK_13, rules))).toEqual([
      "Sunday",
      "Sunday",
      "Monday",
    ]);
  });

  test("keeps every weekday under the all-games rule", () => {
    const rules = withRules({ slate: "all" });

    expect(slate(WEEK_13, rules)).toHaveLength(WEEK_13.length);
  });

  test("drops a playoff game under the regular-season scope", () => {
    const games = [
      game("Sunday", "2027-01-10T18:00Z", { gameType: "WC" }),
      game("Sunday", "2026-11-29T18:00Z"),
    ];

    expect(slate(games, DEFAULT_RULES)).toEqual([games[1]]);
  });

  test("keeps a playoff game when the scope includes the playoffs", () => {
    const games = [game("Sunday", "2027-01-10T18:00Z", { gameType: "WC" })];
    const rules = withRules({ seasonScope: "regularPlusPlayoffs" });

    expect(slate(games, rules)).toEqual(games);
  });

  test("never counts a preseason game, whatever the scope", () => {
    const games = [game("Sunday", "2026-08-16T18:00Z", { gameType: "PRE" })];
    const rules = withRules({ seasonScope: "regularPlusPlayoffs" });

    expect(slate(games, rules)).toEqual([]);
  });
});

describe("lock", () => {
  test("is the first counted kickoff, not the week's first kickoff", () => {
    // Thursday and Friday kick off first, and neither may set the deadline.
    expect(lock(slate(WEEK_13, DEFAULT_RULES))).toBe(
      Date.parse("2026-11-28T21:00Z"),
    );
  });

  test("moves earlier when the first counted game is flexed earlier", () => {
    const flexed = WEEK_13.map((g) =>
      g.weekday === "Saturday" ? game("Saturday", "2026-11-28T18:00Z") : g,
    );

    expect(lock(slate(flexed, DEFAULT_RULES))).toBe(
      Date.parse("2026-11-28T18:00Z"),
    );
  });

  test("moves later when the whole slate is postponed", () => {
    const postponed = slate(WEEK_13, DEFAULT_RULES).map((g) => ({
      ...g,
      kickoffAt: g.kickoffAt + 7 * 24 * 60 * 60 * 1000,
    }));

    expect(lock(postponed)).toBe(Date.parse("2026-12-05T21:00Z"));
  });

  test("is undefined for a week with no counted games", () => {
    expect(lock([])).toBeUndefined();
  });
});

describe("activeWeek", () => {
  /** Three weeks that lock on successive Sundays, in scrambled row order. */
  const SEASON = [
    weekGame(2, "Sunday", "2026-09-20T17:00Z"),
    weekGame(1, "Sunday", "2026-09-13T17:00Z"),
    weekGame(3, "Sunday", "2026-09-27T17:00Z"),
    weekGame(1, "Monday", "2026-09-15T00:15Z"),
    // A Thursday opener: it kicks off first but must not lock the week.
    weekGame(2, "Thursday", "2026-09-17T00:15Z"),
  ];

  test("is the earliest week whose lock is still ahead", () => {
    const beforeWeekOne = Date.parse("2026-09-10T12:00Z");

    expect(activeWeek(SEASON, DEFAULT_RULES, beforeWeekOne)).toBe(1);
  });

  test("advances the moment a week locks", () => {
    const weekOneLock = Date.parse("2026-09-13T17:00Z");

    expect(activeWeek(SEASON, DEFAULT_RULES, weekOneLock - 1)).toBe(1);
    expect(activeWeek(SEASON, DEFAULT_RULES, weekOneLock)).toBe(2);
  });

  test("is unmoved by a week's Thursday game kicking off", () => {
    const afterWeekTwoThursday = Date.parse("2026-09-17T02:00Z");

    expect(activeWeek(SEASON, DEFAULT_RULES, afterWeekTwoThursday)).toBe(2);
  });

  test("is undefined once every week has locked", () => {
    const afterTheSeason = Date.parse("2027-02-01T00:00Z");

    expect(activeWeek(SEASON, DEFAULT_RULES, afterTheSeason)).toBeUndefined();
  });

  test("skips a week whose only games the slate drops", () => {
    const thursdayOnlyWeekOne = [
      weekGame(1, "Thursday", "2026-09-11T00:15Z"),
      weekGame(2, "Sunday", "2026-09-20T17:00Z"),
    ];
    const beforeEverything = Date.parse("2026-09-01T00:00Z");

    expect(
      activeWeek(thursdayOnlyWeekOne, DEFAULT_RULES, beforeEverything),
    ).toBe(2);
  });
});

describe("tiebreakerGame", () => {
  test("is the Monday game, not the last Sunday game", () => {
    const designated = tiebreakerGame(slate(WEEK_13, DEFAULT_RULES));

    expect(designated?.weekday).toBe("Monday");
  });

  test("is the nightcap of a Monday doubleheader", () => {
    const doubleheader = [
      game("Sunday", "2026-09-13T17:00Z"),
      game("Monday", "2026-09-15T00:15Z"),
      game("Monday", "2026-09-15T03:15Z"),
    ];

    expect(tiebreakerGame(doubleheader)?.kickoffAt).toBe(
      Date.parse("2026-09-15T03:15Z"),
    );
  });

  test("falls back to the week's latest game when no Monday game counts", () => {
    // Week 18 is played entirely on Saturday and Sunday.
    const weekEighteen = [
      game("Saturday", "2027-01-02T21:00Z"),
      game("Sunday", "2027-01-03T18:00Z"),
      game("Sunday", "2027-01-03T21:25Z"),
    ];

    expect(tiebreakerGame(weekEighteen)?.kickoffAt).toBe(
      Date.parse("2027-01-03T21:25Z"),
    );
  });

  test("is undefined for a week with no counted games", () => {
    expect(tiebreakerGame([])).toBeUndefined();
  });
});
