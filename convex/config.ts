import { Infer } from "convex/values";

import { rules } from "./schema";

/**
 * The season every league created in this loop belongs to. A league is a
 * single season (see the schema), and M2 does not make this user-configurable
 * on purpose: this constant is the one deliberate seam — a one-line change here
 * (or a later promotion to a `createLeague` arg / admin setting) is all that is
 * needed to move seasons. See the M2 design spec.
 */
export const CURRENT_SEASON = 2026;

/**
 * The default rule-set embedded in every new league. The 8 first-class league
 * settings (#5) each ship one default this loop — the first literal of each
 * union, with `slate` explicitly defaulting to the Sat/Sun/Mon slate. Rules are
 * not yet editable (M6); single-sourcing them here keeps that future edit local.
 */
export const DEFAULT_RULES: Infer<typeof rules> = {
  lock: "weekly",
  slate: "saturdaySundayMonday",
  seasonScope: "regular",
  scoring: "flat",
  weeklyTiebreaker: "mondayTotalPoints",
  seasonTiebreaker: "coChampions",
  pickVisibility: "hiddenUntilLock",
  absentPickScoring: "zero",
};
