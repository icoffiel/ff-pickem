// Pure interpretation of the nflverse `games` dataset — the schedule source of
// record (docs/research/nfl-data-source.md). Nothing here touches the network or
// the database: the action in `sync.ts` fetches, this file interprets, and
// `games.ts` writes. Keeping the three apart is what makes the interpretation
// testable against literal captured rows.

/**
 * The published CSV. A plain static file: no key, no quota, no auth flow, and it
 * carries the whole season months before it starts.
 */
export const NFLVERSE_GAMES_CSV_URL = "https://nflgamedata.com/games.csv";

/** One nflverse row, reduced to the fields a `games` row is built from. */
export type ScheduledGame = {
  gameId: string;
  season: number;
  week: number;
  gameType: string;
  weekday: string;
  kickoffAt: number;
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
};

/** The columns we read. Anything else in the file is ignored, and any of these
 * going missing is a loud failure rather than a silently undefined field. */
const REQUIRED_COLUMNS = [
  "game_id",
  "season",
  "game_type",
  "week",
  "gameday",
  "weekday",
  "gametime",
  "away_team",
  "away_score",
  "home_team",
  "home_score",
] as const;

type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

/** The only game type this app plays. Playoffs are a later milestone. */
const REGULAR_SEASON = "REG";

/**
 * Splits one CSV row, honouring RFC 4180 quoting.
 *
 * `split(",")` is wrong twice over on this file. The dataset writes empty values
 * in some columns as `""`, which a naive split hands back with the quote
 * characters still attached; and a comma inside a quoted field — a stadium name
 * with a city on it, say — would add a column, shifting every later value by one.
 * We resolve columns by name rather than by position, but only a correct split
 * makes those positions mean anything in the first place.
 */
export function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (row[i + 1] === '"') {
        field += '"'; // an escaped quote, written as a doubled one
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);

  return fields;
}

/** Formats an instant as the Eastern wall clock, in fixed-width numeric parts. */
const EASTERN_WALL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * The Eastern offset at `instant`, in ms — negative, and either −4h or −5h.
 * Derived by reading the wall clock `Intl` reports and re-encoding it as if it
 * were UTC, so the tz database stays the single authority on when DST flips.
 */
function easternOffsetAt(instant: number): number {
  const parts = new Map(
    EASTERN_WALL_CLOCK.formatToParts(new Date(instant)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  const wallClockAsUtc = Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second")),
  );
  return wallClockAsUtc - instant;
}

/**
 * The UTC instant for an Eastern wall-clock date and time, as nflverse states
 * kickoffs (`gameday` + `gametime`, both Eastern, per the dataset's DATASETS.md).
 *
 * Resolved through `Intl`, never a fixed offset: Eastern is −4 in September and
 * −5 in January, so a constant would put every early-season or January kickoff an
 * hour wrong — and a lock derived from it an hour wrong with it.
 *
 * The wall clock is not a total function of the instant, so both DST edges get an
 * explicit answer: an hour that fall-back *repeats* resolves to its first
 * occurrence, and an hour that spring-forward *skips* resolves forward, past the
 * gap. Neither can occur for a real kickoff; defining them keeps a malformed or
 * changed upstream time from producing a silently absurd instant.
 */
export function easternToUtcMs(gameday: string, gametime: string): number {
  const [year, month, day] = gameday.split("-").map(Number);
  const [hour, minute] = gametime.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    // `Intl` would throw `RangeError: Invalid time value` a few lines down, which
    // names neither the input nor this function. Say what could not be read.
    throw new Error(
      `nflverse gameday/gametime "${gameday} ${gametime}" is not a readable Eastern date and time`,
    );
  }
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);

  // Solve `instant + offset(instant) === wallClock` by substitution: seed with
  // the offset at the wall clock read as UTC, then re-read it at that instant.
  const seed = wallClock - easternOffsetAt(wallClock);
  const instant = wallClock - easternOffsetAt(seed);

  // If the refined instant does not read back as the requested wall clock, that
  // reading does not exist — a spring-forward gap. The seed is the instant one
  // pre-transition offset later, which is the first moment past the gap.
  return easternOffsetAt(instant) + instant === wallClock ? instant : seed;
}

/** Column name → position, built from the header of this particular response. */
function resolveColumns(header: string): Record<RequiredColumn, number> {
  // Strip a byte-order mark before matching. Without this, a BOM makes column 0
  // read as "﻿game_id" and the loop below reports `game_id` as *missing* —
  // a true statement about the string and a thoroughly misleading one about the
  // dataset, on a sync that would then fail identically every six hours.
  const positions = splitCsvRow(stripRowEnding(header).replace(/^﻿/, ""));
  const columns = {} as Record<RequiredColumn, number>;

  for (const name of REQUIRED_COLUMNS) {
    const index = positions.indexOf(name);
    if (index === -1) {
      // Naming the column is the whole point: an upstream rename should read as
      // "the file changed", not as a row of undefined fields written to `games`.
      throw new Error(
        `nflverse games.csv is missing the "${name}" column — the dataset's shape has changed`,
      );
    }
    columns[name] = index;
  }

  return columns;
}

/**
 * The file is published with `\n` today, but a `\r\n` switch upstream would
 * append a stray `\r` to each row's last field — harmless only for as long as
 * the last column stays one we don't read.
 */
function stripRowEnding(row: string): string {
  return row.endsWith("\r") ? row.slice(0, -1) : row;
}

/**
 * A blank score means "not published yet", which is not the same as zero.
 *
 * Anything else must be a number. `Number("PPD")` is `NaN`, and a `NaN` score is
 * the worst possible failure this file could produce: it is not `undefined`, so
 * the merge rule counts the game as scored and finals it, and every comparison
 * against `NaN` is false, so the outcome comes out a **tie** — silently grading a
 * postponed game as a push in every league. Refuse it out loud instead.
 */
function optionalScore(
  value: string,
  column: string,
  gameId: string,
): number | undefined {
  if (value === "") {
    return undefined;
  }
  const score = Number(value);
  if (!Number.isFinite(score)) {
    throw new Error(
      `nflverse games.csv row "${gameId}" has a non-numeric "${column}" of "${value}"`,
    );
  }
  return score;
}

/** What one pass over the dataset found. */
export type ParsedSchedule = {
  games: ScheduledGame[];
  /**
   * The `game_id`s of rows upstream has not given a kickoff time yet. Reported
   * rather than thrown, and reported rather than dropped in silence — see
   * `parseSchedule`.
   */
  withoutKickoffTime: string[];
};

/**
 * Every regular-season game of one season, as `games` rows.
 *
 * Columns are resolved by name rather than by position so an upstream column
 * *insertion* cannot silently shift our reads, and an upstream *rename* fails
 * loudly instead. Home and away come off `home_team`/`away_team` — never out of
 * the `game_id`, which is away-team-first (`2026_01_NE_SEA` is NE at SEA).
 *
 * **A row with no kickoff time is skipped and reported, not thrown.** A blank
 * `gametime` is a shape nflverse really publishes — every 1999 row has one — so
 * it means "not scheduled yet", not "corrupt". Killing the sync over it would
 * strand the other 271 games on a stale schedule every six hours, and inventing
 * a kickoff for it would be worse still: `kickoffAt` is what M4 derives the lock
 * from. It is named in the return value so it cannot vanish quietly.
 *
 * **Anything else unreadable throws**, naming the row and the column. A
 * truncated row or a non-numeric score is corruption, not a state, and writing a
 * half-read game is how a week ends up grading against nonsense.
 */
export function parseSchedule(csv: string, season: number): ParsedSchedule {
  const [header, ...rows] = csv.split("\n");
  const columns = resolveColumns(header);
  const games: ScheduledGame[] = [];
  const withoutKickoffTime: string[] = [];

  for (const row of rows) {
    if (row.trim() === "") {
      continue;
    }
    const fields = splitCsvRow(stripRowEnding(row));
    if (
      Number(fields[columns.season]) !== season ||
      fields[columns.game_type] !== REGULAR_SEASON
    ) {
      continue;
    }

    // Named before it is validated, so a truncated row can still say which row.
    const gameId = fields[columns.game_id] ?? "";

    /** A column a game cannot be built without. Blank or absent is fatal. */
    const required = (name: RequiredColumn): string => {
      const value = fields[columns[name]];
      if (value === undefined || value === "") {
        throw new Error(
          `nflverse games.csv row "${gameId}" has no "${name}" — the row cannot be read as a game`,
        );
      }
      return value;
    };

    if (fields[columns.gameday] === "" || fields[columns.gametime] === "") {
      withoutKickoffTime.push(gameId);
      continue;
    }

    const week = Number(required("week"));
    if (!Number.isInteger(week)) {
      throw new Error(
        `nflverse games.csv row "${gameId}" has a non-numeric "week" of "${required("week")}"`,
      );
    }

    games.push({
      gameId: required("game_id"),
      season,
      week,
      gameType: required("game_type"),
      weekday: required("weekday"),
      kickoffAt: easternToUtcMs(required("gameday"), required("gametime")),
      homeTeam: required("home_team"),
      awayTeam: required("away_team"),
      homeScore: optionalScore(
        fields[columns.home_score] ?? "",
        "home_score",
        gameId,
      ),
      awayScore: optionalScore(
        fields[columns.away_score] ?? "",
        "away_score",
        gameId,
      ),
    });
  }

  return { games, withoutKickoffTime };
}
