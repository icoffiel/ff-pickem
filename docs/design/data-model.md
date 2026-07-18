# Data model — NFL Pick'em

**Status:** Design (Wayfinder ticket [Design: core data model / schema](https://github.com/icoffiel/ff-pickem/issues/7)). This is the keystone the build hangs on. It is a *design* artifact — the build phase lifts the schema below into `convex/schema.ts`. Terminology is defined in [`CONTEXT.md`](../../CONTEXT.md).

Backend is **Convex** (decided at [#9](https://github.com/icoffiel/ff-pickem/issues/9)): a document datastore. Tables reference each other by `Id<>`, queries walk **indexes** in TypeScript — there is no SQL and no `GROUP BY`. Standings are computed by hand-walking indexes.

## Principles

- **A League is a single season.** `league.season` fixes the scope; everything under a league lives in that season, so keys never need a season discriminator beyond the one on `games`.
- **Store facts, derive interpretations.** A pick's `result`, a pick's lock state, and all standings are *derived*, never stored — so a score correction propagates for free and nothing can go stale. Convex query reactivity re-renders derived views automatically when an underlying `game.outcome` (or a per-league override) changes.
- **Games are global; scoring is per-league.** The `games` table is the league-agnostic NFL fact (including a `tie` outcome). The *push* (a tie's scoring consequence) lives on the pick, computed at read time — never on the game. Because games are global, a commissioner's manual correction is **per-league** (`resultOverrides`), never written onto the shared game row.
- **Effective outcome.** All grading and standings read a game's *effective outcome for a league* — the league's `resultOverrides` row if one exists, else `game.outcome` — never the raw `game.outcome` directly. This layers per-league corrections without cloning the global game.
- **Denormalize only to enable an index walk.** `picks` carry `leagueId` and `week` (copied from the game, both immutable for a given game) purely so standings and the make-picks screen can index by `(leagueId, week)` without extra hops.

## Tables

### `users` — Convex Auth

Provided by Convex Auth's `authTables`; spread in unchanged. Lean: email + auth identity only, **no `name`** — a person's display name is the per-league `membership.teamName`.

### `leagues`

One season's competition. The 8-setting **RuleSet** ([#5](https://github.com/icoffiel/ff-pickem/issues/5)) is an embedded, first-class `rules` object — 1:1 with the league, loaded and changed atomically with it. The first loop ships one default rule-set; the fields exist so the menu is buildable without a schema change.

### `memberships`

The user-in-a-league link. `role` (`"commissioner" | "member"`) is the single source of truth for authority — the league stores no commissioner pointer. The creator is born `commissioner` in `createLeague`; everyone else is born `member` at invite redemption. `teamName` is per-league identity.

### `invites`

An app-level grant ([#6](https://github.com/icoffiel/ff-pickem/issues/6)), separate from auth. Carries no role (every invite makes a `member`) and no team name (captured onto the membership at redemption). The invariant **one live `pending` invite per (email, league)** is enforced in the mutation via `by_league_email`, not structurally (Convex has no partial-unique constraint).

### `games`

Global NFL games, upserted from **nflverse** by external `gameId` ([#2](https://github.com/icoffiel/ff-pickem/issues/2)); ESPN provides the reliable final signal. Because nflverse has no explicit "final" flag, we compute an explicit **`status`** (`scheduled | in_progress | final`) and, once final, an **`outcome`** (`home | away | tie`) on each sync, so readers never re-derive them from raw scores. The row stays **pure synced truth** — commissioner corrections live in `resultOverrides` ([#10](https://github.com/icoffiel/ff-pickem/issues/10)), never here, so sync and overrides never fight.

### `picks`

A membership's prediction for one game. Stores only `selection` (`home | away`) plus links and the denormalized `week`. **No `result`** — derived from `selection` + the game's *effective outcome* (`tie`/`void → push`, no outcome yet → `pending`, `selection == outcome → correct`, else `incorrect`). **No `locked`** — derived from the week's lock time and enforced at write time (mutations reject edits once `now >= lock`). The full lifecycle is in [`weekly-loop.md`](./weekly-loop.md) ([#10](https://github.com/icoffiel/ff-pickem/issues/10)).

### `tiebreakerGuesses`

A membership's predicted combined point total for a week (weekly-tiebreaker default, [#5](https://github.com/icoffiel/ff-pickem/issues/5)). Bound to a **week**, not a game — the tiebreaker game is chosen by policy at standings time (the week's Monday game; for wk 18, the week's last game by kickoff), so pinning a `gameId` here would be wrong.

### `resultOverrides`

A commissioner's per-league correction to a game's result ([#10](https://github.com/icoffiel/ff-pickem/issues/10)), keyed by `(leagueId, gameId)`. Because `games` is global, the correction cannot live on the game row without moving every league's scores — so it lives here, scoped to one league. `outcome` may be `home | away | tie | void`; **`void`** marks a cancelled / no-contest game, which scores as a **push** for everyone. `week` is denormalized from the game so the standings walk can load a week's overrides by `by_league_week` alongside its picks. The override *authority and UI* belong to [#12](https://github.com/icoffiel/ff-pickem/issues/12); this table fixes only where the correction lives and how grading reads it (via the *effective outcome*).

### Standings — no table

Weekly and season standings are computed on read by a query that walks `picks.by_league_week`, loads the week's games **and the league's `resultOverrides`** into maps, derives each pick's result against the *effective outcome*, and folds. Season = Σ weekly correct picks; ties break by MNF-guess closeness (weekly, winner-only — no points change) or co-champions (season), per the rule-set. Scale is tiny (a league is a handful of people, ~272 REG games/season), so compute-on-read is cheap and always consistent; a materialized leaderboard is a later additive change if ever needed. Full algorithm and edge cases: [`weekly-loop.md`](./weekly-loop.md).

## Schema (`convex/schema.ts`)

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// The 8 first-class league settings (#5). First loop ships one default each.
const rules = v.object({
  lock: v.union(v.literal("weekly"), v.literal("perGame")),
  slate: v.union(
    v.literal("saturdaySundayMonday"), // default
    v.literal("sundayMonday"),
    v.literal("all"),
  ),
  seasonScope: v.union(v.literal("regular"), v.literal("regularPlusPlayoffs")),
  scoring: v.union(v.literal("flat"), v.literal("confidence")),
  weeklyTiebreaker: v.union(
    v.literal("mondayTotalPoints"),
    v.literal("none"),
    v.literal("countBack"),
  ),
  seasonTiebreaker: v.union(
    v.literal("coChampions"),
    v.literal("mostWeeklyWins"),
    v.literal("cumulativeProximity"),
  ),
  pickVisibility: v.union(
    v.literal("hiddenUntilLock"),
    v.literal("alwaysHidden"),
    v.literal("alwaysVisible"),
  ),
  absentPickScoring: v.union(
    v.literal("zero"),
    v.literal("rosterLock"),
    v.literal("countSinceJoin"),
  ),
});

export default defineSchema({
  ...authTables, // users (email + auth identity only)

  leagues: defineTable({
    name: v.string(),
    season: v.number(), // e.g. 2026 — a league is a single season
    rules,
    createdAt: v.number(),
  }),

  memberships: defineTable({
    userId: v.id("users"),
    leagueId: v.id("leagues"),
    role: v.union(v.literal("commissioner"), v.literal("member")),
    teamName: v.string(),
    joinedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_user", ["userId"])
    .index("by_league_user", ["leagueId", "userId"]),

  invites: defineTable({
    token: v.string(),
    targetEmail: v.string(),
    leagueId: v.id("leagues"),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("expired"),
      v.literal("superseded"),
    ),
    expiresAt: v.number(), // 14-day
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_league_email", ["leagueId", "targetEmail"]),

  games: defineTable({
    gameId: v.string(), // external nflverse id, e.g. "2026_01_KC_BAL"
    season: v.number(),
    week: v.number(),
    gameType: v.string(), // "REG"
    weekday: v.string(), // for the Sun+Mon slate filter
    kickoffAt: v.number(), // UTC ms, from nflverse gameday+gametime (ET)
    homeTeam: v.string(),
    awayTeam: v.string(),
    homeScore: v.optional(v.number()),
    awayScore: v.optional(v.number()),
    status: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("final"),
    ),
    outcome: v.optional(
      v.union(v.literal("home"), v.literal("away"), v.literal("tie")),
    ),
  })
    .index("by_gameId", ["gameId"])
    .index("by_season_week", ["season", "week"]),

  picks: defineTable({
    membershipId: v.id("memberships"),
    gameId: v.id("games"),
    leagueId: v.id("leagues"), // denormalized for the standings walk
    week: v.number(), // denormalized from the game (immutable)
    selection: v.union(v.literal("home"), v.literal("away")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league_week", ["leagueId", "week"])
    .index("by_membership_game", ["membershipId", "gameId"])
    .index("by_membership_week", ["membershipId", "week"]),

  tiebreakerGuesses: defineTable({
    membershipId: v.id("memberships"),
    leagueId: v.id("leagues"),
    week: v.number(),
    points: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league_week", ["leagueId", "week"])
    .index("by_membership_week", ["membershipId", "week"]),

  // Per-league commissioner correction to a global game's result (#10).
  // Grading reads the *effective outcome*: this override if present, else game.outcome.
  resultOverrides: defineTable({
    leagueId: v.id("leagues"),
    gameId: v.id("games"),
    week: v.number(), // denormalized from the game, for the standings walk
    outcome: v.union(
      v.literal("home"),
      v.literal("away"),
      v.literal("tie"),
      v.literal("void"), // cancelled / no-contest → push for everyone
    ),
    note: v.optional(v.string()),
    createdBy: v.id("memberships"), // the commissioner
    createdAt: v.number(),
  })
    .index("by_league_week", ["leagueId", "week"])
    .index("by_league_game", ["leagueId", "gameId"]),
});
```

## Notes for the build phase

- **Lock enforcement** lives in the pick / tiebreaker mutations: compute the week's lock time from the rule-set (default = the week's first counted game's kickoff) and reject writes once past it. No cron flips a flag.
- **Grading collapses into sync**: updating `game.outcome` (or writing a `resultOverrides` row) is the whole job; there is no separate grading write, because `pick.result` is derived from the *effective outcome*.
- **Uniqueness** (one pick per membership+game, one guess per membership+week, one live invite per email+league) is enforced in mutations via the corresponding index — Convex has no unique constraints.
- **Validators to confirm at build** against the installed Convex + `@convex-dev/auth` versions (per the project's verify-the-API rule): the `authTables` import path and the `defineTable`/`v` surface used above.
