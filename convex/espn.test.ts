import { describe, expect, test } from "vitest";

import {
  FINAL_AWAY_WIN_PIT_AT_NYJ,
  FINAL_HOME_WIN_HOU_AT_LAR,
  FINAL_HOME_WIN_NYG_AT_WSH,
  inProgress,
  SCHEDULED_NE_AT_SEA,
  scoreboardOf,
  type ScoreboardEventFixture,
} from "../tests/fixtures/espn-scoreboard";
import {
  normalizeTeam,
  parseScoreboard,
  scoreboardUrl,
  statusFromState,
} from "./espn";

describe("scoreboardUrl", () => {
  test("pins the season with `dates`, and never sends `year`", () => {
    const url = new URL(scoreboardUrl(2025, 3));

    expect(url.searchParams.get("dates")).toBe("2025");
    expect(url.searchParams.get("week")).toBe("3");
    expect(url.searchParams.has("year")).toBe(false);
  });
});

describe("normalizeTeam", () => {
  test("rewrites the two clubs ESPN and nflverse spell differently", () => {
    expect(normalizeTeam("LAR")).toBe("LA");
    expect(normalizeTeam("WSH")).toBe("WAS");
  });

  test("passes the other 30 clubs through untouched", () => {
    // The full 2026 set, read off ESPN's teams endpoint 2026-08-21 and diffed
    // against nflverse's 2026 home/away columns: these 30 agree exactly.
    const agreed = [
      "ARI",
      "ATL",
      "BAL",
      "BUF",
      "CAR",
      "CHI",
      "CIN",
      "CLE",
      "DAL",
      "DEN",
      "DET",
      "GB",
      "HOU",
      "IND",
      "JAX",
      "KC",
      "LAC",
      "LV",
      "MIA",
      "MIN",
      "NE",
      "NO",
      "NYG",
      "NYJ",
      "PHI",
      "PIT",
      "SEA",
      "SF",
      "TB",
      "TEN",
    ];

    expect(agreed.map(normalizeTeam)).toEqual(agreed);
  });
});

describe("statusFromState", () => {
  test("maps every state ESPN publishes", () => {
    expect(statusFromState("pre")).toBe("scheduled");
    expect(statusFromState("in")).toBe("in_progress");
    expect(statusFromState("post")).toBe("final");
  });

  test("throws on a state it does not know rather than guessing one", () => {
    expect(() => statusFromState("postponed")).toThrow(/postponed/);
  });
});

describe("parseScoreboard", () => {
  test("reads the season and week off the payload, not off the request", () => {
    // The `year` trap makes this the only trustworthy source: a request for one
    // season can come back as another, and the payload says which it really is.
    const parsed = parseScoreboard(
      scoreboardOf(2025, 1, FINAL_AWAY_WIN_PIT_AT_NYJ),
    );

    expect(parsed.season).toBe(2025);
    expect(parsed.week).toBe(1);
  });

  test("parses ESPN's string scores as numbers, home and away the right way round", () => {
    const [event] = parseScoreboard(
      scoreboardOf(2025, 1, FINAL_AWAY_WIN_PIT_AT_NYJ),
    ).events;

    expect(event).toEqual({
      homeTeam: "NYJ",
      awayTeam: "PIT",
      homeScore: 32,
      awayScore: 34,
      status: "final",
    });
  });

  test("normalizes both renamed clubs to nflverse's spelling", () => {
    const parsed = parseScoreboard(
      scoreboardOf(
        2025,
        1,
        FINAL_HOME_WIN_NYG_AT_WSH,
        FINAL_HOME_WIN_HOU_AT_LAR,
      ),
    );

    expect(parsed.events.map((event) => event.homeTeam)).toEqual(["WAS", "LA"]);
  });

  test("carries the live state through as a status", () => {
    const parsed = parseScoreboard(
      scoreboardOf(
        2025,
        1,
        SCHEDULED_NE_AT_SEA,
        inProgress(FINAL_AWAY_WIN_PIT_AT_NYJ, 10, 7),
        FINAL_HOME_WIN_NYG_AT_WSH,
      ),
    );

    expect(parsed.events.map((event) => event.status)).toEqual([
      "scheduled",
      "in_progress",
      "final",
    ]);
  });

  test("reports an event missing a competitor instead of dropping the whole week", () => {
    const halfAnEvent: ScoreboardEventFixture = {
      ...FINAL_HOME_WIN_NYG_AT_WSH,
      competitions: [
        {
          id: FINAL_HOME_WIN_NYG_AT_WSH.id,
          competitors:
            FINAL_HOME_WIN_NYG_AT_WSH.competitions[0].competitors.slice(0, 1),
        },
      ],
    };

    const parsed = parseScoreboard(
      scoreboardOf(2025, 1, halfAnEvent, FINAL_AWAY_WIN_PIT_AT_NYJ),
    );

    expect(parsed.unreadable).toEqual(["NYG @ WSH"]);
    expect(parsed.events.map((event) => event.homeTeam)).toEqual(["NYJ"]);
  });

  test("rejects a payload that is not a scoreboard at all", () => {
    expect(() => parseScoreboard({ error: "not found" })).toThrow(/scoreboard/);
  });
});
