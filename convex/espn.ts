// Pure interpretation of ESPN's unofficial NFL scoreboard — the live-status
// source (docs/research/nfl-data-source.md). Nothing here touches the network or
// the database: the action in `sync.ts` fetches, this file interprets, and
// `games.ts` writes. Keeping the three apart is what makes the interpretation
// testable against literal captured payloads.

/**
 * The scoreboard endpoint. Unofficial and undocumented — no key, no quota, and
 * no stability guarantee either, which is why `parseScoreboard` is defensive and
 * why nflverse remains the source of record for everything but live status.
 */
export const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

/** `seasontype=2` is the regular season. Playoffs (3) are a later milestone. */
const REGULAR_SEASON = "2";

/**
 * The scoreboard for one week of one season.
 *
 * **The season goes in `dates`, not `year`.** The endpoint accepts a `year`
 * parameter and silently ignores it: `?year=2025&week=1` returns the *current*
 * season's week 1, which looks exactly like correct data — right shape, right
 * week count, wrong year. Verified 2026-08-21 by fetching both spellings of
 * 2025 week 1 and comparing: `dates=2025` returned DAL @ PHI on 2025-09-05,
 * `year=2025` returned NE @ SEA on 2026-09-10.
 */
export function scoreboardUrl(season: number, week: number): string {
  const url = new URL(ESPN_SCOREBOARD_URL);
  url.searchParams.set("dates", String(season));
  url.searchParams.set("seasontype", REGULAR_SEASON);
  url.searchParams.set("week", String(week));
  return url.toString();
}

/**
 * ESPN's abbreviation for a club, in nflverse's spelling.
 *
 * The two feeds agree on 30 of 32 clubs and disagree on the Rams (`LAR` vs
 * `LA`) and the Commanders (`WSH` vs `WAS`). Verified 2026-08-21 by diffing
 * ESPN's teams endpoint against nflverse's 2026 `home_team`/`away_team` columns:
 * that diff is exactly these two, both ways.
 *
 * Matching is on `(season, week, home, away)`, so without this map those two
 * games a week would find no row and silently never sync — never scoring, never
 * grading, and never erroring.
 */
const NFLVERSE_SPELLING: Record<string, string> = {
  LAR: "LA",
  WSH: "WAS",
};

export function normalizeTeam(abbreviation: string): string {
  return NFLVERSE_SPELLING[abbreviation] ?? abbreviation;
}

/** The `games.status` column's three values. */
export type GameStatus = "scheduled" | "in_progress" | "final";

/**
 * ESPN's `status.type.state` as a `games.status`.
 *
 * `pre` and `post` were read off live NFL responses on 2026-08-21; `in` off
 * ESPN's shared scoreboard schema the same day (`STATUS_IN_PROGRESS`,
 * `STATUS_HALFTIME` and `STATUS_FIRST_HALF` all report `state: "in"`), since no
 * NFL game was in progress at capture time.
 *
 * **An unrecognized state throws.** This endpoint is undocumented, so a fourth
 * state is upstream's to add without telling anyone — and the tempting guesses
 * are both wrong. Defaulting to `scheduled` would un-final a graded game;
 * defaulting to `final` would grade a week off whatever score was showing. A
 * loud failure on one week's fetch is the cheapest of the three.
 */
export function statusFromState(state: string): GameStatus {
  switch (state) {
    case "pre":
      return "scheduled";
    case "in":
      return "in_progress";
    case "post":
      return "final";
    default:
      throw new Error(
        `ESPN scoreboard reported an unknown game state "${state}" — the endpoint's shape has changed`,
      );
  }
}

/** One scoreboard event, reduced to what a `games` row is updated from. The
 * season and week live on the scoreboard, not on each event. */
export type ScoreboardEvent = {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: GameStatus;
};

/** What one pass over a scoreboard payload found. */
export type Scoreboard = {
  season: number;
  week: number;
  events: ScoreboardEvent[];
  /**
   * The names of events that could not be read as a game. Reported rather than
   * thrown — see `parseScoreboard`.
   */
  unreadable: string[];
};

/** A JSON object, before anything is known about its shape. */
type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

/** A required number that ESPN may spell as a string, as `score` is. */
function scoreOf(value: unknown): number {
  const score = Number(value);
  if (typeof value !== "string" || !Number.isFinite(score)) {
    throw new Error(`unreadable score ${JSON.stringify(value)}`);
  }
  return score;
}

/** One event's two sides, or a throw naming what was wrong with it. */
function competitorsOf(event: Json): { home: Json; away: Json } {
  const competition = Array.isArray(event.competitions)
    ? event.competitions[0]
    : undefined;
  const competitors = isObject(competition) ? competition.competitors : [];
  if (!Array.isArray(competitors)) {
    throw new Error("no competitors");
  }

  const sideOf = (homeAway: string) =>
    competitors.find(
      (competitor) => isObject(competitor) && competitor.homeAway === homeAway,
    );
  const home = sideOf("home");
  const away = sideOf("away");
  if (!isObject(home) || !isObject(away)) {
    throw new Error("missing a home or away competitor");
  }
  return { home, away };
}

/** A competitor's club, in nflverse's spelling. */
function teamOf(competitor: Json): string {
  const team = competitor.team;
  const abbreviation = isObject(team) ? team.abbreviation : undefined;
  if (typeof abbreviation !== "string" || abbreviation === "") {
    throw new Error("a competitor has no team abbreviation");
  }
  return normalizeTeam(abbreviation);
}

/**
 * One week's scoreboard, as `games` updates.
 *
 * **The season and week are read off the payload**, never assumed from the
 * request that produced it — the `year` trap in `scoreboardUrl` is exactly a
 * request that comes back describing a different season, and the payload's own
 * `season.year` is what catches it.
 *
 * **An event that cannot be read is reported, not thrown.** One weird event
 * should not stop the other fifteen games of a Sunday from syncing. It is named
 * in the return value so it cannot vanish quietly: a skipped event is a whole
 * game that never grades.
 *
 * **A payload that is not a scoreboard at all does throw.** An error body, an
 * HTML interstitial or a shape change would otherwise parse as "no events",
 * which is indistinguishable from a quiet Sunday — and would keep looking like
 * one every fifteen minutes.
 */
export function parseScoreboard(payload: unknown): Scoreboard {
  if (!isObject(payload)) {
    throw new Error("ESPN scoreboard response was not a JSON object");
  }

  const season = isObject(payload.season) ? payload.season.year : undefined;
  const week = isObject(payload.week) ? payload.week.number : undefined;
  if (
    typeof season !== "number" ||
    typeof week !== "number" ||
    !Array.isArray(payload.events)
  ) {
    throw new Error(
      "ESPN response is not a scoreboard — it carries no season, week and events",
    );
  }

  const events: ScoreboardEvent[] = [];
  const unreadable: string[] = [];

  for (const [index, event] of payload.events.entries()) {
    // Named before it is read, so an unreadable event can still say which one.
    const name = isObject(event)
      ? ((event.shortName ?? event.id) as string)
      : `event ${index}`;
    try {
      if (!isObject(event)) {
        throw new Error("not an object");
      }
      const state =
        isObject(event.status) && isObject(event.status.type)
          ? event.status.type.state
          : undefined;
      const { home, away } = competitorsOf(event);

      events.push({
        homeTeam: teamOf(home),
        awayTeam: teamOf(away),
        homeScore: scoreOf(home.score),
        awayScore: scoreOf(away.score),
        status: statusFromState(String(state)),
      });
    } catch (cause) {
      console.warn(
        `ESPN scoreboard event "${name}" could not be read as a game, skipped: ${cause}`,
      );
      unreadable.push(String(name));
    }
  }

  return { season, week, events, unreadable };
}
