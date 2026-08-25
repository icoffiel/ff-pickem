import { Doc, Id } from "./_generated/dataModel";
import { RuleSet } from "./config";
import { effectiveOutcome, gradePick, Selection } from "./grading";
import { lock, slate, SlateGame, tiebreakerGame } from "./week";

// Standings, folded. A board is the ranked answer to "who won the week" and
// "who is leading the season", derived on every read from the picks, the games
// and the league's corrections — there is no standings table, nothing to
// backfill and nothing that can drift (`data-model.md`, Standings — no table).
//
// Nothing here touches Convex I/O: the folds take rows in and return ranked
// rows out, so every rule below — the removed-member folding especially — is
// exercisable against a hand-computed fixture. `standings.ts` is the thin
// Convex seam that reads the rows and hands them here.

/** What a fold needs to know about a membership. */
export type StandingsMembership = {
  _id: Id<"memberships">;
  teamName: string;
  status: Doc<"memberships">["status"];
  removedAt?: number;
};

/** A slate game, plus what scoring and the tiebreaker read off it. */
export type BoardGame = SlateGame & {
  _id: Id<"games">;
  status: Doc<"games">["status"];
  outcome?: Doc<"games">["outcome"];
  homeScore?: number;
  awayScore?: number;
};

/** One member's pick on one game. */
export type BoardPick = {
  membershipId: Id<"memberships">;
  gameId: Id<"games">;
  selection: Selection;
};

/** A league's correction to a game's result. */
export type BoardOverride = {
  gameId: Id<"games">;
  outcome: Doc<"resultOverrides">["outcome"];
};

/** One member's combined-points guess for the week. */
export type BoardGuess = {
  membershipId: Id<"memberships">;
  points: number;
};

/** One member's line on a weekly board. */
export type WeeklyRow = {
  membershipId: Id<"memberships">;
  teamName: string;
  /** Correct picks. Pushes are excluded; pending and absent are worth 0. */
  correct: number;
  /** 1-based, ties sharing a rank (1, 1, 3). */
  rank: number;
  /**
   * The member's combined-points guess, and how far it landed from the truth —
   * both `null` until the designated game finals. Withholding them until then
   * is what keeps the board from publishing a live guess: the designated game
   * is on the slate, so it cannot have finished before the week locked.
   */
  guess: number | null;
  proximity: number | null;
};

/**
 * How far the weekly tiebreaker got.
 *
 * `unneeded` — nobody was tied for the lead. `provisional` — the leaders are
 * tied and the designated game has not finished, so the week stays co-led and
 * settles itself when it does. `deadlocked` — the guesses could not separate
 * the leaders (identical proximity, or none of them guessed), which is a real
 * shared win. `settled` — one member guessed closest and won the week.
 */
export type WeeklyTiebreakerState =
  "unneeded" | "provisional" | "deadlocked" | "settled";

export type WeeklyBoard = {
  rows: WeeklyRow[];
  tiebreaker: {
    /** The designated game, so a member can see what they were guessing at. */
    gameId: Id<"games"> | null;
    /** Its combined final score — `null` until it finals. */
    total: number | null;
    state: WeeklyTiebreakerState;
  };
};

/**
 * Whether a membership competes in a week that locks at `locksAt`.
 *
 * Removal is **go-forward**: a removed member counts in every week that had
 * already locked when they were removed and drops out of every week that locks
 * afterwards (`admin-powers.md` §2). That one comparison is what makes a
 * decided week immutable — removing someone in week 10 cannot reach back into
 * week 4, whose lock is months past — and it is also what makes their pick rows
 * for a week they picked ahead into go inert rather than count.
 *
 * A week with no derivable lock has no evidence of having been contested at
 * all, so a removed member is dropped from it.
 */
function participates(
  membership: StandingsMembership,
  locksAt: number | undefined,
): boolean {
  if (membership.status === "active") return true;
  return (
    membership.removedAt !== undefined &&
    locksAt !== undefined &&
    locksAt < membership.removedAt
  );
}

/** The rows every membership starts a week with, before any pick is counted. */
function emptyRows(memberships: readonly StandingsMembership[]) {
  return new Map(
    memberships.map((membership) => [
      membership._id,
      {
        membershipId: membership._id,
        teamName: membership.teamName,
        correct: 0,
        rank: 0,
        guess: null as number | null,
        proximity: null as number | null,
      },
    ]),
  );
}

/**
 * The combined final score of the designated game, or `undefined` while the
 * tiebreaker is still unresolved.
 *
 * `status` is what makes a score trustworthy: the live sync writes scores as a
 * game runs, so a half-time total would otherwise settle the week early. The
 * score is read off the game itself and never off an override — a correction
 * changes who won, not what the scoreboard said.
 */
function combinedTotal(game: BoardGame | undefined): number | undefined {
  if (game === undefined || game.status !== "final") return undefined;
  if (game.homeScore === undefined || game.awayScore === undefined) {
    return undefined;
  }
  return game.homeScore + game.awayScore;
}

/**
 * Number rows already in board order, sharing a rank between rows the sort
 * could not separate.
 *
 * Standard competition ranking: tied members share a rank and the next member
 * takes the place they would have had (1, 1, 3). `separator` is what the
 * tiebreaker managed to prise apart — equal separators are still a tie.
 */
function assignRanks(
  ordered: WeeklyRow[],
  separator: (row: WeeklyRow) => number,
): WeeklyRow[] {
  ordered.forEach((row, index) => {
    const previous = ordered[index - 1];
    row.rank =
      previous !== undefined &&
      previous.correct === row.correct &&
      separator(previous) === separator(row)
        ? previous.rank
        : index + 1;
  });
  return ordered;
}

/**
 * How far a member's guess landed from the truth, for ordering.
 *
 * A member who never guessed is infinitely far, which is exactly the rule: a
 * missing guess loses to any guess at all, however wild, so guessing is always
 * worth something (`weekly-loop.md` §7).
 */
function distance(row: WeeklyRow): number {
  return row.proximity ?? Number.POSITIVE_INFINITY;
}

/**
 * What the Monday-night guesses did to a tie for the lead.
 *
 * The tiebreaker only ever orders the board — it is deliberately given no way
 * to touch `correct`, so a week's points are the same number whether or not
 * anyone guessed, and the season (which sums those points) can never feel it.
 */
function breakTie(
  leaders: readonly WeeklyRow[],
  resolved: boolean,
): WeeklyTiebreakerState {
  if (leaders.length <= 1) return "unneeded";
  if (!resolved) return "provisional";

  const closest = Math.min(...leaders.map(distance));
  const winners = leaders.filter((row) => distance(row) === closest);
  return winners.length === 1 ? "settled" : "deadlocked";
}

/**
 * One week's ranked board.
 *
 * `games` is the week's games as the database holds them; the league's slate
 * rule is applied here, so a game the rule-set drops scores for nobody.
 */
export function weeklyBoard(input: {
  memberships: readonly StandingsMembership[];
  games: readonly BoardGame[];
  picks: readonly BoardPick[];
  overrides?: readonly BoardOverride[];
  guesses?: readonly BoardGuess[];
  rules: RuleSet;
}): WeeklyBoard {
  const counted = slate(input.games, input.rules);
  const overrideByGame = new Map(
    (input.overrides ?? []).map((override) => [override.gameId, override]),
  );
  const outcomeByGame = new Map(
    counted.map((game) => [
      game._id,
      effectiveOutcome(game, overrideByGame.get(game._id)),
    ]),
  );

  const locksAt = lock(counted);
  const rows = emptyRows(
    input.memberships.filter((membership) => participates(membership, locksAt)),
  );
  for (const pick of input.picks) {
    const row = rows.get(pick.membershipId);
    if (row === undefined || !outcomeByGame.has(pick.gameId)) continue;
    if (
      gradePick(pick.selection, outcomeByGame.get(pick.gameId)) === "correct"
    ) {
      row.correct += 1;
    }
  }

  const ordered = [...rows.values()].sort((a, b) => b.correct - a.correct);

  const designated = tiebreakerGame(counted);
  const total = combinedTotal(designated);
  if (total !== undefined) {
    for (const guess of input.guesses ?? []) {
      const row = rows.get(guess.membershipId);
      if (row === undefined) continue;
      row.guess = guess.points;
      row.proximity = Math.abs(guess.points - total);
    }
  }

  // Only the members tied for the lead are in play: the tiebreaker settles the
  // weekly *winner*, so equal correct counts further down the board stay equal
  // placings (`weekly-loop.md` §7).
  const leaders = ordered.filter((row) => row.correct === ordered[0]?.correct);
  const state = breakTie(leaders, total !== undefined);
  const tiebroken = state === "settled" || state === "deadlocked";
  if (tiebroken) {
    leaders.sort((a, b) => distance(a) - distance(b));
    ordered.splice(0, leaders.length, ...leaders);
  }

  const leaderIds = new Set(leaders.map((row) => row.membershipId));
  return {
    rows: assignRanks(ordered, (row) =>
      tiebroken && leaderIds.has(row.membershipId) ? distance(row) : 0,
    ),
    tiebreaker: {
      gameId: designated?._id ?? null,
      total: total ?? null,
      state,
    },
  };
}

/** A season-wide row carries the week it belongs to, off its index. */
export type SeasonGame = BoardGame & { week: number };
export type SeasonPick = BoardPick & { week: number };
export type SeasonOverride = BoardOverride & { week: number };

/** One member's line on the season board. */
export type SeasonRow = {
  membershipId: Id<"memberships">;
  teamName: string;
  /** The sum of every week's correct picks. */
  points: number;
  /** 1-based, ties sharing a rank — a tied season is a shared one. */
  rank: number;
  /** The commissioner removed them: the total above is frozen where it stood. */
  left: boolean;
  /** A member who left cannot win the season they walked out of. */
  titleEligible: boolean;
};

export type SeasonBoard = {
  rows: SeasonRow[];
  /**
   * The title-eligible members on the most points — the season's co-champions
   * once it is over, and who is leading while it is not.
   */
  leaders: Id<"memberships">[];
};

/** Group rows carrying a `week` by the week they belong to. */
function byWeek<Row extends { week: number }>(
  rows: readonly Row[],
): Map<number, Row[]> {
  const grouped = new Map<number, Row[]>();
  for (const row of rows) {
    const existing = grouped.get(row.week);
    if (existing === undefined) grouped.set(row.week, [row]);
    else existing.push(row);
  }
  return grouped;
}

/**
 * The season's ranked board.
 *
 * Season points are the **raw sum of weekly correct picks**, never a sum of
 * weekly placements — consistency is what wins a season, and a member who came
 * second every week beats one who won twice and vanished. Which is also why no
 * guesses are read here: the Monday-night tiebreaker orders a single week and
 * is given no path into this total (`weekly-loop.md` §7).
 *
 * Each week is folded by `weeklyBoard`, so the slate rule, the effective
 * outcome and the removed-member folding are the same ones the weekly board
 * shows — the season cannot disagree with the weeks it is made of.
 */
export function seasonBoard(input: {
  memberships: readonly StandingsMembership[];
  games: readonly SeasonGame[];
  picks: readonly SeasonPick[];
  overrides?: readonly SeasonOverride[];
  rules: RuleSet;
}): SeasonBoard {
  const picksByWeek = byWeek(input.picks);
  const overridesByWeek = byWeek(input.overrides ?? []);

  const points = new Map(
    input.memberships.map((membership) => [membership._id, 0]),
  );
  for (const [week, games] of byWeek(input.games)) {
    const board = weeklyBoard({
      memberships: input.memberships,
      games,
      picks: picksByWeek.get(week) ?? [],
      overrides: overridesByWeek.get(week) ?? [],
      rules: input.rules,
    });
    // A week a member did not compete in has no row here at all, which is what
    // freezes a removed member's total and zero-pads a joiner's earlier weeks.
    for (const row of board.rows) {
      points.set(
        row.membershipId,
        (points.get(row.membershipId) ?? 0) + row.correct,
      );
    }
  }

  const rows = input.memberships.map((membership) => ({
    membershipId: membership._id,
    teamName: membership.teamName,
    points: points.get(membership._id) ?? 0,
    rank: 0,
    left: membership.status === "removed",
    titleEligible: membership.status !== "removed",
  }));

  const ordered = [...rows].sort((a, b) => b.points - a.points);
  ordered.forEach((row, index) => {
    const previous = ordered[index - 1];
    row.rank =
      previous !== undefined && previous.points === row.points
        ? previous.rank
        : index + 1;
  });

  const contenders = ordered.filter((row) => row.titleEligible);
  const best = contenders[0]?.points;
  return {
    rows: ordered,
    leaders: contenders
      .filter((row) => row.points === best)
      .map((row) => row.membershipId),
  };
}
