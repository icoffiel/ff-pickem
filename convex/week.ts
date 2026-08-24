import { RuleSet } from "./config";

// The derived shape of a league's week: which games count, when picks freeze,
// and which week the league is picking. All of it is derivation over the global
// `games` table plus the league's rule-set — nothing here is stored, and nothing
// here touches Convex, so every rule below is testable without a database.

/**
 * What the derivations need to know about a game. Structural rather than
 * `Doc<"games">` so the rules can be exercised against three-field literals;
 * every function below is generic over it, so a real row goes in and the same
 * row — not a copy — comes back out.
 */
export type SlateGame = {
  gameType: string;
  weekday: string;
  kickoffAt: number;
};

/** The weekdays each `rules.slate` literal counts. */
const SLATE_WEEKDAYS: Record<RuleSet["slate"], readonly string[] | "all"> = {
  saturdaySundayMonday: ["Saturday", "Sunday", "Monday"],
  sundayMonday: ["Sunday", "Monday"],
  all: "all",
};

/**
 * The `gameType` values each `rules.seasonScope` literal counts.
 *
 * nflverse spells the postseason rounds out — `WC`, `DIV`, `CON`, `SB` — so a
 * scope is an allow-list, never "anything that isn't `PRE`". Preseason games
 * are in the feed and count for no one under either scope.
 */
const SCOPE_GAME_TYPES: Record<RuleSet["seasonScope"], readonly string[]> = {
  regular: ["REG"],
  regularPlusPlayoffs: ["REG", "WC", "DIV", "CON", "SB"],
};

/**
 * The counted games of one week, per the league's rule-set — the **slate**.
 *
 * Callers pass a single week's games (a `games.by_season_week` walk); this
 * applies the two rule-set filters on top. A game the slate drops does not exist
 * for scoring: it is never shown and generates no pick row, so a member never
 * "misses" a Thursday game. The caller's order is preserved, which is index
 * order and *not* kickoff order — anything showing a slate sorts it itself.
 */
export function slate<Game extends SlateGame>(
  games: readonly Game[],
  rules: RuleSet,
): Game[] {
  const weekdays = SLATE_WEEKDAYS[rules.slate];
  const gameTypes = SCOPE_GAME_TYPES[rules.seasonScope];

  return games.filter(
    (game) =>
      gameTypes.includes(game.gameType) &&
      (weekdays === "all" || weekdays.includes(game.weekday)),
  );
}

/**
 * The moment a week's picks and tiebreaker guess freeze — the **lock**.
 *
 * Under the default `weekly` rule that is the first counted kickoff, so
 * Thursday and Friday games never set the deadline and a late-season Saturday
 * game locks the week on Saturday. Derived from the *current* `kickoffAt`
 * values on every call, never stored, so a flex change moves the deadline with
 * it — including the accepted edge where a game flexed earlier pulls the lock in
 * sooner than a member expected.
 *
 * `undefined` means a week with no counted games: no deadline is derivable, and
 * nothing is pickable. `perGame` is a schema stub this loop; only `weekly` is
 * built (`weekly-loop.md` §3).
 */
export function lock(slate: readonly SlateGame[]): number | undefined {
  let earliest: number | undefined;
  for (const game of slate) {
    if (earliest === undefined || game.kickoffAt < earliest) {
      earliest = game.kickoffAt;
    }
  }
  return earliest;
}

/** A game that also knows which week it belongs to. */
export type WeekGame = SlateGame & { week: number };

/**
 * The week a league is currently picking — the **active week**: the earliest
 * week whose lock is still in the future.
 *
 * Derived, never stored. There is no `currentWeek` pointer to go stale — the
 * clock plus the `games` table already contain the answer, so when a week locks
 * the next becomes active on its own. The make-picks screen defaults to this,
 * and members may pick ahead into any later week that has not locked.
 *
 * A week the slate empties has no derivable lock and is skipped. `undefined`
 * means every week has locked — the season is over, and there is nothing left to
 * pick.
 *
 * `now` is the caller's: this is a derivation, and its Convex caller is a query,
 * which may not read the wall clock (ADR 0002 rule 3).
 */
export function activeWeek(
  seasonGames: readonly WeekGame[],
  rules: RuleSet,
  now: number,
): number | undefined {
  const counted = slate(seasonGames, rules);

  const lockByWeek = new Map<number, number>();
  for (const game of counted) {
    const earliest = lockByWeek.get(game.week);
    if (earliest === undefined || game.kickoffAt < earliest) {
      lockByWeek.set(game.week, game.kickoffAt);
    }
  }

  let active: number | undefined;
  for (const [week, locksAt] of lockByWeek) {
    if (locksAt > now && (active === undefined || week < active)) {
      active = week;
    }
  }
  return active;
}

/** The latest-kickoff game of a set, or `undefined` if there are none. */
function latest<Game extends SlateGame>(games: readonly Game[]) {
  return games.reduce<Game | undefined>(
    (best, game) =>
      best === undefined || game.kickoffAt > best.kickoffAt ? game : best,
    undefined,
  );
}

/**
 * The game a week's tiebreaker guesses are measured against — the **designated
 * tiebreaker game** under the default `mondayTotalPoints` rule.
 *
 * It is the slate's **latest-kickoff Monday game**, which is what picks the
 * nightcap out of a Monday doubleheader. Week 18 has no Monday game at all, so
 * the fallback is the week's latest-kickoff game overall (the late Sunday one).
 *
 * A tiebreaker guess is bound to the week, not to this game — the policy chooses
 * the game at standings time (M5). It is derived here so the make-picks screen
 * can show a member which game they are guessing about (story 5).
 */
export function tiebreakerGame<Game extends SlateGame>(
  slate: readonly Game[],
): Game | undefined {
  const mondayNight = latest(slate.filter((game) => game.weekday === "Monday"));
  return mondayNight ?? latest(slate);
}
