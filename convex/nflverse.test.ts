import { describe, expect, test } from "vitest";

import {
  csvOf,
  NFLVERSE_HEADER,
  PLAYED_2025_REGULAR_SEASON,
  PLAYED_2025_WILD_CARD,
  SYNTHETIC_COMMA_INSIDE_QUOTED_FIELD,
  WEEK_1_NEUTRAL_SITE,
  WEEK_1_OPENER,
  WEEK_1_QUOTED_EMPTY_FIELD,
  WEEK_1_SUNDAY,
  WEEK_8_DST_END_DAY,
} from "../tests/fixtures/nflverse-games";
import { easternToUtcMs, parseSchedule, splitCsvRow } from "./nflverse";

// Pure interpretation of the nflverse `games` dataset. No test touches the live
// file — see the fixture module for why.

const utc = (iso: string) => Date.parse(iso);

describe("easternToUtcMs", () => {
  // Both expectations below are the same games' kickoff instants as published by
  // ESPN (`site.api.espn.com/.../scoreboard`), checked 2026-08-21 — an entirely
  // independent source from the ET wall clock nflverse states.
  test("resolves a summer kickoff at EDT (-4), rolling into the next UTC day", () => {
    expect(easternToUtcMs("2026-09-09", "20:20")).toBe(
      utc("2026-09-10T00:20Z"),
    );
  });

  test("resolves a kickoff on the day EDT ends at EST (-5)", () => {
    // 2026-11-01 is the fall-back day: the 02:00 transition is hours before a
    // 13:00 kickoff, so this game is EST even though the date is "in" the DST run.
    expect(easternToUtcMs("2026-11-01", "13:00")).toBe(
      utc("2026-11-01T18:00Z"),
    );
  });

  test("uses each date's own offset rather than one constant for the season", () => {
    const september = easternToUtcMs("2026-09-13", "13:00");
    const november = easternToUtcMs("2026-11-01", "13:00");

    expect(september).toBe(utc("2026-09-13T17:00Z"));
    expect(november).toBe(utc("2026-11-01T18:00Z"));
  });

  test("resolves the ambiguous hour that fall-back repeats to its first occurrence", () => {
    // 01:30 ET happens twice on 2026-11-01, once at -4 and again at -5.
    expect(easternToUtcMs("2026-11-01", "01:30")).toBe(
      utc("2026-11-01T05:30Z"),
    );
  });

  test("resolves a wall-clock time spring-forward skips to the instant past the gap", () => {
    // 2026-03-08 02:30 ET does not exist — the clock jumps 02:00 EST to 03:00 EDT.
    // The wall clock only moves forward, so the reading resolves forward too: the
    // returned instant reads as 03:30 EDT.
    expect(easternToUtcMs("2026-03-08", "02:30")).toBe(
      utc("2026-03-08T07:30Z"),
    );
  });
});

describe("splitCsvRow", () => {
  test("splits an unquoted row on its commas", () => {
    expect(splitCsvRow("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("reads a quoted empty field as an empty value, not as two quote characters", () => {
    expect(splitCsvRow('a,"",c')).toEqual(["a", "", "c"]);
  });

  test("keeps a comma inside a quoted field out of the split", () => {
    expect(splitCsvRow('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  });

  test("unescapes a doubled quote inside a quoted field", () => {
    expect(splitCsvRow('a,"say ""hi""",c')).toEqual(["a", 'say "hi"', "c"]);
  });

  test("keeps a trailing empty field", () => {
    expect(splitCsvRow("a,b,")).toEqual(["a", "b", ""]);
  });
});

describe("parseSchedule", () => {
  test("maps every column it consumes off a real row", () => {
    const [game] = parseSchedule(csvOf(WEEK_1_SUNDAY), 2026).games;

    expect(game).toEqual({
      gameId: "2026_01_CHI_CAR",
      season: 2026,
      week: 1,
      gameType: "REG",
      weekday: "Sunday",
      kickoffAt: utc("2026-09-13T17:00Z"),
      homeTeam: "CAR",
      awayTeam: "CHI",
      homeScore: undefined,
      awayScore: undefined,
    });
  });

  test("reads home and away off their own columns, not out of the game_id", () => {
    // `2026_01_NE_SEA` is away-team-first: NE travels to SEA. Parsing the id
    // left-to-right would land every score on the wrong team.
    const [game] = parseSchedule(csvOf(WEEK_1_OPENER), 2026).games;

    expect(game.gameId).toBe("2026_01_NE_SEA");
    expect(game.awayTeam).toBe("NE");
    expect(game.homeTeam).toBe("SEA");
  });

  test("keeps only the requested season", () => {
    const { games } = parseSchedule(
      csvOf(WEEK_1_SUNDAY, PLAYED_2025_REGULAR_SEASON),
      2026,
    );

    expect(games.map((g) => g.gameId)).toEqual(["2026_01_CHI_CAR"]);
  });

  test("keeps only REG games", () => {
    const { games } = parseSchedule(
      csvOf(PLAYED_2025_REGULAR_SEASON, PLAYED_2025_WILD_CARD),
      2025,
    );

    expect(games.map((g) => g.gameId)).toEqual(["2025_01_DAL_PHI"]);
  });

  test("survives the quoted fields the real dataset contains", () => {
    const { games } = parseSchedule(
      csvOf(WEEK_1_QUOTED_EMPTY_FIELD, SYNTHETIC_COMMA_INSIDE_QUOTED_FIELD),
      2026,
    );

    // Both rows quote a field *after* the columns we read, so a split that
    // mishandled quotes would still read these two correctly — except that the
    // synthetic row's embedded comma adds a column, which is what would shift a
    // by-position reader. Assert the late columns land where they belong.
    expect(games.map((g) => g.homeTeam)).toEqual(["HOU", "CAR"]);
    expect(games.map((g) => g.awayTeam)).toEqual(["BUF", "CHI"]);
  });

  test("leaves scores undefined until the dataset populates them", () => {
    const [scheduled] = parseSchedule(csvOf(WEEK_8_DST_END_DAY), 2026).games;
    const [played] = parseSchedule(
      csvOf(PLAYED_2025_REGULAR_SEASON),
      2025,
    ).games;

    expect(scheduled.homeScore).toBeUndefined();
    expect(scheduled.awayScore).toBeUndefined();
    expect(played.homeScore).toBe(24);
    expect(played.awayScore).toBe(20);
  });

  test("converts each row's kickoff on its own side of the DST boundary", () => {
    const { games } = parseSchedule(
      csvOf(WEEK_1_OPENER, WEEK_1_NEUTRAL_SITE, WEEK_8_DST_END_DAY),
      2026,
    );

    expect(games.map((g) => g.kickoffAt)).toEqual([
      utc("2026-09-10T00:20Z"),
      utc("2026-09-11T00:35Z"),
      utc("2026-11-01T18:00Z"),
    ]);
  });

  test("fails loudly, naming the column, if a consumed column disappears upstream", () => {
    const withoutHomeTeam = NFLVERSE_HEADER.replace(
      "home_team",
      "home_franchise",
    );
    const csv = [withoutHomeTeam, WEEK_1_SUNDAY, ""].join("\n");

    expect(() => parseSchedule(csv, 2026)).toThrow(/home_team/);
  });

  test("ignores blank lines, including the trailing newline", () => {
    const csv = `${NFLVERSE_HEADER}\n${WEEK_1_SUNDAY}\n\n`;

    expect(parseSchedule(csv, 2026).games).toHaveLength(1);
  });

  test("refuses a non-numeric score rather than grading the game a tie", () => {
    // `Number("PPD")` is NaN, which is not `undefined` — so the merge rule would
    // count the game as scored, final it, and compute a tie from two NaNs.
    const postponed = WEEK_1_SUNDAY.replace(
      ",CHI,,CAR,,Home,",
      ",CHI,PPD,CAR,PPD,Home,",
    );

    expect(() => parseSchedule(csvOf(postponed), 2026)).toThrow(
      /2026_01_CHI_CAR.*home_score.*PPD/,
    );
  });

  test("names the row and the column when a required value is blank", () => {
    const noWeekday = WEEK_1_SUNDAY.replace(
      ",2026-09-13,Sunday,",
      ",2026-09-13,,",
    );

    expect(() => parseSchedule(csvOf(noWeekday), 2026)).toThrow(
      /2026_01_CHI_CAR.*weekday/,
    );
  });

  test("skips and reports a game upstream has not given a kickoff time yet", () => {
    // A blank `gametime` is a shape nflverse really publishes (every 1999 row
    // has one). It means "not scheduled yet" — so it must not kill the sync for
    // the other 271 games, and must not be invented either: `kickoffAt` is what
    // M4 derives the lock from.
    const unscheduled = WEEK_1_SUNDAY.replace(",Sunday,13:00,", ",Sunday,,");

    const parsed = parseSchedule(csvOf(unscheduled, WEEK_1_OPENER), 2026);

    expect(parsed.games.map((g) => g.gameId)).toEqual(["2026_01_NE_SEA"]);
    expect(parsed.withoutKickoffTime).toEqual(["2026_01_CHI_CAR"]);
  });

  test("reports nothing when every game has a kickoff time", () => {
    expect(
      parseSchedule(csvOf(WEEK_1_SUNDAY), 2026).withoutKickoffTime,
    ).toEqual([]);
  });

  test("names the row when it is truncated short of the columns it needs", () => {
    const truncated = "2026_01_CHI_CAR,2026,REG,1,2026-09-13";

    expect(() => parseSchedule(csvOf(truncated), 2026)).toThrow(
      /2026_01_CHI_CAR/,
    );
  });

  test("reads a header that arrives with a byte-order mark", () => {
    // A BOM would otherwise make column 0 read as "﻿game_id", and the
    // missing-column error would blame `game_id` — true of the string, and
    // thoroughly misleading about the dataset.
    const csv = `﻿${NFLVERSE_HEADER}\n${WEEK_1_SUNDAY}\n`;

    expect(parseSchedule(csv, 2026).games[0].gameId).toBe("2026_01_CHI_CAR");
  });

  test("reads a file that arrives with CRLF line endings", () => {
    const csv = [NFLVERSE_HEADER, WEEK_1_SUNDAY, ""].join("\r\n");

    const [game] = parseSchedule(csv, 2026).games;
    expect(game.gameId).toBe("2026_01_CHI_CAR");
    expect(game.kickoffAt).toBe(utc("2026-09-13T17:00Z"));
  });
});

describe("easternToUtcMs, on input it cannot read", () => {
  test("names the value rather than throwing Intl's RangeError", () => {
    // Left to itself, `Intl` throws "Invalid time value", which names neither
    // the input nor this function — on a cron that would then fail identically
    // every six hours with nothing to go on.
    expect(() => easternToUtcMs("", "13:00")).toThrow(/not a readable Eastern/);
    expect(() => easternToUtcMs("2026-09-13", "TBD")).toThrow(/TBD/);
  });
});
