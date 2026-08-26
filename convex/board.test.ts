import { describe, expect, test } from "vitest";

import { Id } from "./_generated/dataModel";
import {
  BoardGame,
  BoardGuess,
  BoardOverride,
  BoardPick,
  seasonBoard,
  SeasonGame,
  SeasonPick,
  StandingsMembership,
  weeklyBoard,
} from "./board";
import { DEFAULT_RULES } from "./config";

/**
 * Fixtures name people and games, never ids — an id here is an opaque string
 * the folds only ever compare, so deriving one from the name keeps a fixture
 * readable as the league it describes.
 */
function memberId(name: string) {
  return `membership:${name}` as Id<"memberships">;
}

function gameId(matchup: string) {
  return `game:${matchup}` as Id<"games">;
}

function member(
  name: string,
  overrides: Partial<StandingsMembership> = {},
): StandingsMembership {
  return {
    _id: memberId(name),
    teamName: name,
    status: "active",
    ...overrides,
  };
}

function game(
  matchup: string,
  weekday: string,
  kickoff: string,
  overrides: Partial<BoardGame> = {},
): BoardGame {
  return {
    _id: gameId(matchup),
    gameType: "REG",
    weekday,
    kickoffAt: Date.parse(kickoff),
    status: "scheduled",
    ...overrides,
  };
}

/** A finaled game, with the score its tiebreaker proximity is measured from. */
function finaled(
  matchup: string,
  weekday: string,
  kickoff: string,
  outcome: "home" | "away" | "tie",
  homeScore: number,
  awayScore: number,
): BoardGame {
  return game(matchup, weekday, kickoff, {
    status: "final",
    outcome,
    homeScore,
    awayScore,
  });
}

function pick(
  name: string,
  matchup: string,
  selection: "home" | "away",
): BoardPick {
  return {
    membershipId: memberId(name),
    gameId: gameId(matchup),
    selection,
  };
}

function guess(name: string, points: number): BoardGuess {
  return { membershipId: memberId(name), points };
}

function override(
  matchup: string,
  outcome: BoardOverride["outcome"],
): BoardOverride {
  return { gameId: gameId(matchup), outcome };
}

/** Every member's points, keyed by name — what a tiebreaker must never move. */
function points(rows: readonly { teamName: string; correct: number }[]) {
  return Object.fromEntries(rows.map((row) => [row.teamName, row.correct]));
}

/** The three columns a member reads off a weekly board. */
function placings(
  rows: readonly { teamName: string; correct: number; rank: number }[],
) {
  return rows.map(({ rank, teamName, correct }) => ({
    rank,
    teamName,
    correct,
  }));
}

/**
 * A Week 5 slate with a game in every state that scores differently: two
 * decided games, a tie, and a Monday nightcap still to be played.
 */
const WEEK_5 = [
  finaled("SF-KC", "Sunday", "2026-10-04T17:00Z", "home", 24, 17),
  finaled("NYJ-BUF", "Sunday", "2026-10-04T17:00Z", "away", 13, 20),
  finaled("DAL-PHI", "Sunday", "2026-10-04T20:25Z", "tie", 27, 27),
  game("GB-CHI", "Monday", "2026-10-05T00:15Z"),
];

/** The same week once the nightcap has been played, 20-17 — a 37-point game. */
const WEEK_5_PLAYED = [
  ...WEEK_5.slice(0, 3),
  finaled("GB-CHI", "Monday", "2026-10-05T00:15Z", "home", 20, 17),
];

/**
 * Ash and Blake finish the played week tied on 2, a point clear of Cleo — the
 * fixture every tiebreaker test below varies only the guesses on.
 */
const TIED_AT_THE_TOP = [
  pick("Ash", "SF-KC", "home"), // correct
  pick("Ash", "NYJ-BUF", "away"), // correct
  pick("Ash", "DAL-PHI", "home"), // push
  pick("Ash", "GB-CHI", "away"), // incorrect
  pick("Blake", "SF-KC", "home"), // correct
  pick("Blake", "NYJ-BUF", "home"), // incorrect
  pick("Blake", "DAL-PHI", "away"), // push
  pick("Blake", "GB-CHI", "home"), // correct
  pick("Cleo", "SF-KC", "away"), // incorrect
  pick("Cleo", "NYJ-BUF", "away"), // correct
  pick("Cleo", "DAL-PHI", "home"), // push
  pick("Cleo", "GB-CHI", "away"), // incorrect
];

/** Ash and Blake tied on 2 with the nightcap still to come; Cleo on 0. */
const TIED_BEFORE_THE_NIGHTCAP = [
  pick("Ash", "SF-KC", "home"), // correct
  pick("Ash", "NYJ-BUF", "away"), // correct
  pick("Blake", "SF-KC", "home"), // correct
  pick("Blake", "NYJ-BUF", "away"), // correct
  pick("Cleo", "SF-KC", "away"), // incorrect
];

const EVERYONE = [member("Ash"), member("Blake"), member("Cleo")];

describe("weeklyBoard", () => {
  test("scores a member's correct picks, excluding pushes and undecided games", () => {
    const board = weeklyBoard({
      memberships: [member("Ash"), member("Blake"), member("Cleo")],
      games: WEEK_5,
      picks: [
        // Ash: correct, correct, push, pending.
        pick("Ash", "SF-KC", "home"),
        pick("Ash", "NYJ-BUF", "away"),
        pick("Ash", "DAL-PHI", "home"),
        pick("Ash", "GB-CHI", "home"),
        // Blake: correct, incorrect, push, and one game left unpicked.
        pick("Blake", "SF-KC", "home"),
        pick("Blake", "NYJ-BUF", "home"),
        pick("Blake", "DAL-PHI", "away"),
        // Cleo: incorrect, correct, push, pending.
        pick("Cleo", "SF-KC", "away"),
        pick("Cleo", "NYJ-BUF", "away"),
        pick("Cleo", "DAL-PHI", "home"),
        pick("Cleo", "GB-CHI", "away"),
      ],
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 2 },
      { rank: 2, teamName: "Blake", correct: 1 },
      { rank: 2, teamName: "Cleo", correct: 1 },
    ]);
  });

  test("a game the league's slate drops scores for nobody", () => {
    const board = weeklyBoard({
      memberships: [member("Ash")],
      games: [
        ...WEEK_5,
        finaled("DEN-LV", "Thursday", "2026-10-01T00:15Z", "home", 21, 14),
      ],
      picks: [pick("Ash", "DEN-LV", "home")],
      rules: DEFAULT_RULES,
    });

    expect(board.rows[0].correct).toBe(0);
  });

  test("a commissioner's correction flips the result the board scores", () => {
    const board = weeklyBoard({
      memberships: [member("Ash"), member("Blake")],
      games: WEEK_5,
      picks: [pick("Ash", "SF-KC", "home"), pick("Blake", "SF-KC", "away")],
      overrides: [override("SF-KC", "away")],
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Blake", correct: 1 },
      { rank: 2, teamName: "Ash", correct: 0 },
    ]);
  });

  test("a tie for the week goes to the closest Monday-night guess", () => {
    const board = weeklyBoard({
      memberships: EVERYONE,
      games: WEEK_5_PLAYED,
      picks: TIED_AT_THE_TOP,
      guesses: [guess("Ash", 38), guess("Blake", 45)],
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 2 },
      { rank: 2, teamName: "Blake", correct: 2 },
      { rank: 3, teamName: "Cleo", correct: 1 },
    ]);
    expect(board.tiebreaker).toEqual({
      gameId: gameId("GB-CHI"),
      total: 37,
      state: "settled",
    });
  });

  test("a member who never guessed loses the tiebreak to one who did", () => {
    const board = weeklyBoard({
      memberships: EVERYONE,
      games: WEEK_5_PLAYED,
      picks: TIED_AT_THE_TOP,
      guesses: [guess("Blake", 61)], // 24 points out, and still enough
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Blake", correct: 2 },
      { rank: 2, teamName: "Ash", correct: 2 },
      { rank: 3, teamName: "Cleo", correct: 1 },
    ]);
    expect(board.tiebreaker.state).toBe("settled");
  });

  test("leaders equally close to the total stay co-ranked", () => {
    const board = weeklyBoard({
      memberships: EVERYONE,
      games: WEEK_5_PLAYED,
      picks: TIED_AT_THE_TOP,
      guesses: [guess("Ash", 38), guess("Blake", 36)], // both one point out
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 2 },
      { rank: 1, teamName: "Blake", correct: 2 },
      { rank: 3, teamName: "Cleo", correct: 1 },
    ]);
    expect(board.tiebreaker.state).toBe("deadlocked");
  });

  test("leaders who all skipped the guess stay co-ranked", () => {
    const board = weeklyBoard({
      memberships: EVERYONE,
      games: WEEK_5_PLAYED,
      picks: TIED_AT_THE_TOP,
      guesses: [guess("Cleo", 37)], // exactly right, and a point behind
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 2 },
      { rank: 1, teamName: "Blake", correct: 2 },
      { rank: 3, teamName: "Cleo", correct: 1 },
    ]);
    expect(board.tiebreaker.state).toBe("deadlocked");
  });

  test("leaders stay provisionally co-ranked until the tiebreaker game finals", () => {
    const board = weeklyBoard({
      memberships: EVERYONE,
      games: WEEK_5,
      picks: TIED_BEFORE_THE_NIGHTCAP,
      guesses: [guess("Ash", 38), guess("Blake", 45)],
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 2 },
      { rank: 1, teamName: "Blake", correct: 2 },
      { rank: 3, teamName: "Cleo", correct: 0 },
    ]);
    expect(board.tiebreaker).toEqual({
      gameId: gameId("GB-CHI"),
      total: null,
      state: "provisional",
    });
  });

  test("an in-progress tiebreaker game does not settle the week early", () => {
    const halftime = [
      ...WEEK_5.slice(0, 3),
      game("GB-CHI", "Monday", "2026-10-05T00:15Z", {
        status: "in_progress",
        homeScore: 10,
        awayScore: 7,
      }),
    ];

    const board = weeklyBoard({
      memberships: EVERYONE,
      games: halftime,
      picks: TIED_BEFORE_THE_NIGHTCAP,
      guesses: [guess("Ash", 17), guess("Blake", 45)],
      rules: DEFAULT_RULES,
    });

    expect(board.tiebreaker.state).toBe("provisional");
    expect(board.rows.map((row) => row.rank)).toEqual([1, 1, 3]);
  });

  test("the tiebreaker reorders the leaders without touching anyone's points", () => {
    const week = {
      memberships: EVERYONE,
      games: WEEK_5_PLAYED,
      picks: TIED_AT_THE_TOP,
      rules: DEFAULT_RULES,
    };

    const untied = weeklyBoard(week);
    const tied = weeklyBoard({ ...week, guesses: [guess("Blake", 37)] });

    expect(points(tied.rows)).toEqual(points(untied.rows));
  });

  test("the tiebreaker leaves a tie below the lead alone", () => {
    const board = weeklyBoard({
      memberships: [member("Ash"), member("Blake"), member("Cleo")],
      games: WEEK_5_PLAYED,
      picks: [
        // Ash wins the week outright on 3.
        pick("Ash", "SF-KC", "home"),
        pick("Ash", "NYJ-BUF", "away"),
        pick("Ash", "GB-CHI", "home"),
        // Blake and Cleo tie on 1 behind her.
        pick("Blake", "SF-KC", "home"),
        pick("Cleo", "SF-KC", "home"),
      ],
      guesses: [guess("Cleo", 37), guess("Blake", 99)],
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 3 },
      { rank: 2, teamName: "Blake", correct: 1 },
      { rank: 2, teamName: "Cleo", correct: 1 },
    ]);
    expect(board.tiebreaker.state).toBe("unneeded");
  });

  test("the tiebreaker game is the Monday nightcap of a doubleheader", () => {
    const week1 = [
      finaled("SF-KC", "Sunday", "2026-09-13T17:00Z", "home", 24, 17),
      finaled("NYJ-BUF", "Monday", "2026-09-15T00:15Z", "home", 21, 20),
      finaled("GB-CHI", "Monday", "2026-09-15T03:15Z", "away", 14, 31),
    ];

    const board = weeklyBoard({
      memberships: [member("Ash")],
      games: week1,
      picks: [],
      rules: DEFAULT_RULES,
    });

    expect(board.tiebreaker.gameId).toBe(gameId("GB-CHI"));
    expect(board.tiebreaker.total).toBe(45);
  });

  test("a week with no Monday game falls back to its latest game", () => {
    const week18 = [
      finaled("SF-KC", "Sunday", "2026-01-03T18:00Z", "home", 24, 17),
      finaled("NYJ-BUF", "Sunday", "2026-01-03T21:25Z", "away", 13, 20),
    ];

    const board = weeklyBoard({
      memberships: [member("Ash")],
      games: week18,
      picks: [],
      rules: DEFAULT_RULES,
    });

    expect(board.tiebreaker.gameId).toBe(gameId("NYJ-BUF"));
    expect(board.tiebreaker.total).toBe(33);
  });

  test("a member removed after the week locked keeps the week", () => {
    const board = weeklyBoard({
      memberships: [
        member("Ash"),
        member("Blake", {
          status: "removed",
          removedAt: Date.parse("2026-10-06T12:00Z"), // the Tuesday after
        }),
        member("Cleo"),
      ],
      games: WEEK_5_PLAYED,
      picks: TIED_AT_THE_TOP,
      guesses: [guess("Blake", 37)],
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Blake", correct: 2 },
      { rank: 2, teamName: "Ash", correct: 2 },
      { rank: 3, teamName: "Cleo", correct: 1 },
    ]);
  });

  test("a member removed before the week locked is not on the board at all", () => {
    const board = weeklyBoard({
      memberships: [
        member("Ash"),
        member("Blake", {
          status: "removed",
          removedAt: Date.parse("2026-10-01T12:00Z"), // the Thursday before
        }),
        member("Cleo"),
      ],
      games: WEEK_5_PLAYED,
      // Blake had picked this week ahead of time; the rows are inert now.
      picks: TIED_AT_THE_TOP,
      rules: DEFAULT_RULES,
    });

    expect(placings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", correct: 2 },
      { rank: 2, teamName: "Cleo", correct: 1 },
    ]);
  });
});

/** A finaled Sunday game in a numbered week. */
function seasonGame(
  week: number,
  matchup: string,
  kickoff: string,
  outcome: "home" | "away" | "tie",
  homeScore = 21,
  awayScore = 17,
): SeasonGame {
  return {
    week,
    ...finaled(matchup, "Sunday", kickoff, outcome, homeScore, awayScore),
  };
}

function seasonPick(
  week: number,
  name: string,
  matchup: string,
  selection: "home" | "away",
): SeasonPick {
  return { week, ...pick(name, matchup, selection) };
}

/**
 * Three played weeks, two games each, every game decided — home in the early
 * slot, away in the late one, so a pick's worth is readable at a glance.
 */
const SEASON = [
  seasonGame(1, "wk1-early", "2026-09-13T17:00Z", "home"),
  seasonGame(1, "wk1-late", "2026-09-13T20:25Z", "away"),
  seasonGame(2, "wk2-early", "2026-09-20T17:00Z", "home"),
  seasonGame(2, "wk2-late", "2026-09-20T20:25Z", "away"),
  seasonGame(3, "wk3-early", "2026-09-27T17:00Z", "home"),
  seasonGame(3, "wk3-late", "2026-09-27T20:25Z", "away"),
];

/** Every game of the season picked right — a perfect 6. */
function perfect(name: string): SeasonPick[] {
  return SEASON.map((game) =>
    seasonPick(
      game.week,
      name,
      String(game._id).replace("game:", ""),
      game.outcome === "home" ? "home" : "away",
    ),
  );
}

/** The three columns a member reads off a season board. */
function standings(
  rows: readonly { teamName: string; points: number; rank: number }[],
) {
  return rows.map(({ rank, teamName, points }) => ({ rank, teamName, points }));
}

describe("seasonBoard", () => {
  test("season points are the sum of every week's correct picks", () => {
    const board = seasonBoard({
      memberships: EVERYONE,
      games: SEASON,
      picks: [
        ...perfect("Ash"),
        // Blake: a perfect week 1, half of week 2, nothing in week 3.
        seasonPick(1, "Blake", "wk1-early", "home"),
        seasonPick(1, "Blake", "wk1-late", "away"),
        seasonPick(2, "Blake", "wk2-early", "home"),
        seasonPick(2, "Blake", "wk2-late", "home"),
        seasonPick(3, "Blake", "wk3-early", "away"),
        // Cleo: one right in each of the three weeks.
        seasonPick(1, "Cleo", "wk1-early", "home"),
        seasonPick(2, "Cleo", "wk2-early", "home"),
        seasonPick(3, "Cleo", "wk3-early", "home"),
      ],
      rules: DEFAULT_RULES,
    });

    expect(standings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", points: 6 },
      { rank: 2, teamName: "Blake", points: 3 },
      { rank: 2, teamName: "Cleo", points: 3 },
    ]);
    expect(board.leaders).toEqual([memberId("Ash")]);
  });

  test("a tied season yields co-champions", () => {
    const board = seasonBoard({
      memberships: EVERYONE,
      games: SEASON,
      picks: [
        ...perfect("Ash"),
        ...perfect("Blake"),
        seasonPick(1, "Cleo", "wk1-early", "home"),
      ],
      rules: DEFAULT_RULES,
    });

    expect(standings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", points: 6 },
      { rank: 1, teamName: "Blake", points: 6 },
      { rank: 3, teamName: "Cleo", points: 1 },
    ]);
    expect(board.leaders).toEqual([memberId("Ash"), memberId("Blake")]);
  });

  test("a removed member keeps a frozen total, badged and out of the title", () => {
    const board = seasonBoard({
      memberships: [
        member("Ash"),
        member("Blake", {
          status: "removed",
          // After week 2 was played, before week 3 locked.
          removedAt: Date.parse("2026-09-24T12:00Z"),
        }),
      ],
      games: SEASON,
      // Blake picked the whole season perfectly, week 3 included — but those
      // week-3 rows went inert the moment they were removed.
      picks: [...perfect("Ash"), ...perfect("Blake")],
      rules: DEFAULT_RULES,
    });

    expect(board.rows).toMatchObject([
      { teamName: "Ash", points: 6, rank: 1, left: false, titleEligible: true },
      {
        teamName: "Blake",
        points: 4,
        rank: 2,
        left: true,
        titleEligible: false,
      },
    ]);
    expect(board.leaders).toEqual([memberId("Ash")]);
  });

  test("a removed member out in front still cannot take the title", () => {
    const board = seasonBoard({
      memberships: [
        member("Ash"),
        member("Blake", {
          status: "removed",
          removedAt: Date.parse("2026-09-24T12:00Z"),
        }),
      ],
      games: SEASON,
      picks: [
        // Ash misses the whole of week 3 and finishes on 4 — level with Blake.
        seasonPick(1, "Ash", "wk1-early", "home"),
        seasonPick(1, "Ash", "wk1-late", "away"),
        seasonPick(2, "Ash", "wk2-early", "home"),
        seasonPick(2, "Ash", "wk2-late", "away"),
        ...perfect("Blake"),
      ],
      rules: DEFAULT_RULES,
    });

    expect(standings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", points: 4 },
      { rank: 1, teamName: "Blake", points: 4 },
    ]);
    expect(board.leaders).toEqual([memberId("Ash")]);
  });

  test("a mid-season joiner is zero-padded, not missing, for the weeks before", () => {
    const board = seasonBoard({
      memberships: [member("Ash"), member("Cleo")],
      games: SEASON,
      picks: [
        ...perfect("Ash"),
        // Cleo joined for week 3 and won it outright.
        seasonPick(3, "Cleo", "wk3-early", "home"),
        seasonPick(3, "Cleo", "wk3-late", "away"),
      ],
      rules: DEFAULT_RULES,
    });

    expect(standings(board.rows)).toEqual([
      { rank: 1, teamName: "Ash", points: 6 },
      { rank: 2, teamName: "Cleo", points: 2 },
    ]);
  });

  test("a correction in one week flows through to the season total", () => {
    const league = {
      memberships: [member("Ash"), member("Blake")],
      games: SEASON,
      picks: [...perfect("Ash"), ...perfect("Blake")],
      rules: DEFAULT_RULES,
    };

    const corrected = seasonBoard({
      ...league,
      // Week 2's late game is reversed, so nobody's perfect any more.
      overrides: [{ week: 2, ...override("wk2-late", "home") }],
    });

    expect(standings(corrected.rows)).toEqual([
      { rank: 1, teamName: "Ash", points: 5 },
      { rank: 1, teamName: "Blake", points: 5 },
    ]);
  });
});

describe("a removal never rewrites a week that had already locked", () => {
  const WEEK_2 = SEASON.filter((game) => game.week === 2);
  const WEEK_2_PICKS = [
    pick("Ash", "wk2-early", "home"), // correct
    pick("Blake", "wk2-early", "home"), // correct
    pick("Blake", "wk2-late", "away"), // correct
  ];

  const beforeRemoval = weeklyBoard({
    memberships: [member("Ash"), member("Blake")],
    games: WEEK_2,
    picks: WEEK_2_PICKS,
    rules: DEFAULT_RULES,
  });

  test("week 2's board is byte-for-byte what it was", () => {
    const afterRemoval = weeklyBoard({
      memberships: [
        member("Ash"),
        member("Blake", {
          status: "removed",
          removedAt: Date.parse("2026-09-24T12:00Z"), // during week 3
        }),
      ],
      games: WEEK_2,
      picks: WEEK_2_PICKS,
      rules: DEFAULT_RULES,
    });

    expect(afterRemoval).toEqual(beforeRemoval);
  });

  test("week 2's winner is still the member who was later removed", () => {
    expect(beforeRemoval.rows[0]).toMatchObject({
      teamName: "Blake",
      correct: 2,
      rank: 1,
    });
  });
});
