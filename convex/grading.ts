import { Doc } from "./_generated/dataModel";

// Grading, per league, derived. A pick stores only its `selection`; what that
// selection was *worth* is computed every time it is read, so there is no
// grading write to run, nothing to backfill, and nothing that can drift from the
// game it grades against. When an outcome or an override changes, Convex
// reactivity re-derives every view that depended on it (`weekly-loop.md` §6).

/** Which side of a game a member picked. */
export type Selection = Doc<"picks">["selection"];

/**
 * The outcome a league actually scores a game by: its own correction if it has
 * written one, else the game's result. `void` — a cancelled or no-contest game —
 * exists only as a correction. `undefined` means "not settled yet".
 */
export type EffectiveOutcome = Doc<"resultOverrides">["outcome"] | undefined;

/** What one pick was worth, once graded. */
export type PickResult =
  "pending" | "push" | "correct" | "incorrect" | "absent";

/**
 * The outcome this league grades the game by.
 *
 * `games` is global — shared by every league — so a commissioner's correction
 * lives in their own `resultOverrides` row and never touches the game. That
 * makes this layering the only place the two meet, and **the only outcome any
 * scoring code may read**: taking `game.outcome` directly silently ignores every
 * correction. An override wins outright, including before the game itself has
 * finished, which is what lets a commissioner void a cancelled game up front.
 */
export function effectiveOutcome(
  game: { outcome?: Doc<"games">["outcome"] },
  override: { outcome: Doc<"resultOverrides">["outcome"] } | undefined | null,
): EffectiveOutcome {
  return override?.outcome ?? game.outcome;
}

/**
 * What a pick on one slate game is worth against the effective outcome.
 *
 * `selection` is `undefined` for a slate game the member never picked — under
 * the `zero` absent-pick rule that is **absent**, worth nothing, and never an
 * error: missing one pick costs a point, it does not break the week. A game with
 * no effective outcome is **pending** and contributes nothing *yet*; it grades
 * itself the moment the game finals. A tie or a void is a **push** — excluded
 * from scoring entirely, so no one gains or loses on it.
 */
export function gradePick(
  selection: Selection | undefined,
  outcome: EffectiveOutcome,
): PickResult {
  if (selection === undefined) return "absent";
  if (outcome === undefined) return "pending";
  if (outcome === "tie" || outcome === "void") return "push";
  return selection === outcome ? "correct" : "incorrect";
}
