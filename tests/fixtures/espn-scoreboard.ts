/**
 * Trimmed events from ESPN's unofficial scoreboard
 * (https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard),
 * captured 2026-08-21. Every value below is verbatim; the only editing is the
 * removal of fields `parseScoreboard` does not read (logos, odds, broadcasts,
 * records, venue, links), which run to ~12KB per event.
 *
 * Pinned outside `convex/` on purpose: files under `convex/` are bundled into
 * the deployment, and fixtures have no business shipping to production.
 *
 * No test hits the live endpoint. It is undocumented and unversioned — a suite
 * that depends on it fails for reasons that have nothing to do with our code.
 */

/** One competitor, as far down as the parser reads. */
type Competitor = {
  homeAway: string;
  score: string;
  team: { abbreviation: string; displayName: string };
};

/** One scoreboard event, trimmed to the fields the parser reads. */
export type ScoreboardEventFixture = {
  id: string;
  date: string;
  shortName: string;
  status: {
    type: {
      id: string;
      name: string;
      state: string;
      completed: boolean;
      description: string;
    };
  };
  competitions: [{ id: string; competitors: Competitor[] }];
};

/** 2026 week 1's opener, months out. ESPN publishes placeholder `"0"` scores
 * for a game that has not kicked off — the reason a `pre` event is never
 * written to a `games` row. */
export const SCHEDULED_NE_AT_SEA: ScoreboardEventFixture = {
  id: "401872656",
  date: "2026-09-10T00:20Z",
  shortName: "NE @ SEA",
  status: {
    type: {
      id: "1",
      name: "STATUS_SCHEDULED",
      state: "pre",
      completed: false,
      description: "Scheduled",
    },
  },
  competitions: [
    {
      id: "401872656",
      competitors: [
        {
          homeAway: "home",
          score: "0",
          team: { abbreviation: "SEA", displayName: "Seattle Seahawks" },
        },
        {
          homeAway: "away",
          score: "0",
          team: { abbreviation: "NE", displayName: "New England Patriots" },
        },
      ],
    },
  ],
};

/** A home win — and one of the two games a week that only matches a `games`
 * row once ESPN's `WSH` is rewritten to nflverse's `WAS`. */
export const FINAL_HOME_WIN_NYG_AT_WSH: ScoreboardEventFixture = {
  id: "401772827",
  date: "2025-09-07T17:00Z",
  shortName: "NYG @ WSH",
  status: {
    type: {
      id: "3",
      name: "STATUS_FINAL",
      state: "post",
      completed: true,
      description: "Final",
    },
  },
  competitions: [
    {
      id: "401772827",
      competitors: [
        {
          homeAway: "home",
          score: "21",
          team: { abbreviation: "WSH", displayName: "Washington Commanders" },
        },
        {
          homeAway: "away",
          score: "6",
          team: { abbreviation: "NYG", displayName: "New York Giants" },
        },
      ],
    },
  ],
};

/** The other renamed club: ESPN's `LAR` against nflverse's `LA`. */
export const FINAL_HOME_WIN_HOU_AT_LAR: ScoreboardEventFixture = {
  id: "401772723",
  date: "2025-09-07T20:25Z",
  shortName: "HOU @ LAR",
  status: {
    type: {
      id: "3",
      name: "STATUS_FINAL",
      state: "post",
      completed: true,
      description: "Final",
    },
  },
  competitions: [
    {
      id: "401772723",
      competitors: [
        {
          homeAway: "home",
          score: "14",
          team: { abbreviation: "LAR", displayName: "Los Angeles Rams" },
        },
        {
          homeAway: "away",
          score: "9",
          team: { abbreviation: "HOU", displayName: "Houston Texans" },
        },
      ],
    },
  ],
};

/** An away win. Note ESPN lists the home competitor first regardless. */
export const FINAL_AWAY_WIN_PIT_AT_NYJ: ScoreboardEventFixture = {
  id: "401772721",
  date: "2025-09-07T17:00Z",
  shortName: "PIT @ NYJ",
  status: {
    type: {
      id: "3",
      name: "STATUS_FINAL",
      state: "post",
      completed: true,
      description: "Final",
    },
  },
  competitions: [
    {
      id: "401772721",
      competitors: [
        {
          homeAway: "home",
          score: "32",
          team: { abbreviation: "NYJ", displayName: "New York Jets" },
        },
        {
          homeAway: "away",
          score: "34",
          team: { abbreviation: "PIT", displayName: "Pittsburgh Steelers" },
        },
      ],
    },
  ],
};

/** A real tie — 2025 week 4, the only one of that season. Ties are rare enough
 * that a synthetic one would be the easy option and the wrong one: this is the
 * shape ESPN actually publishes for a level final. */
export const FINAL_TIE_GB_AT_DAL: ScoreboardEventFixture = {
  id: "401772921",
  date: "2025-09-29T00:20Z",
  shortName: "GB @ DAL",
  status: {
    type: {
      id: "3",
      name: "STATUS_FINAL",
      state: "post",
      completed: true,
      description: "Final",
    },
  },
  competitions: [
    {
      id: "401772921",
      competitors: [
        {
          homeAway: "home",
          score: "40",
          team: { abbreviation: "DAL", displayName: "Dallas Cowboys" },
        },
        {
          homeAway: "away",
          score: "40",
          team: { abbreviation: "GB", displayName: "Green Bay Packers" },
        },
      ],
    },
  ],
};

/**
 * The same event, mid-game.
 *
 * No NFL game was in progress at capture time, so the `in` state is set by hand
 * onto a real event rather than copied. The state string itself is not invented:
 * `STATUS_IN_PROGRESS` → `state: "in"` was read live from ESPN's scoreboard on
 * the same day, on the same shared schema (`soccer/all`), alongside
 * `STATUS_HALFTIME` and `STATUS_FIRST_HALF` — all three `state: "in"`.
 */
export function inProgress(
  event: ScoreboardEventFixture,
  homeScore: number,
  awayScore: number,
): ScoreboardEventFixture {
  return {
    ...event,
    status: {
      type: {
        id: "2",
        name: "STATUS_IN_PROGRESS",
        state: "in",
        completed: false,
        description: "In Progress",
      },
    },
    competitions: [
      {
        ...event.competitions[0],
        competitors: event.competitions[0].competitors.map((competitor) => ({
          ...competitor,
          score: String(competitor.homeAway === "home" ? homeScore : awayScore),
        })),
      },
    ],
  };
}

/** A whole scoreboard payload, as the fetch would return it. The season and
 * week wrappers are ESPN's own, verbatim from the captured responses. */
export function scoreboardOf(
  season: number,
  week: number,
  ...events: ScoreboardEventFixture[]
) {
  return {
    season: { type: 2, year: season },
    week: { number: week },
    events,
  };
}
