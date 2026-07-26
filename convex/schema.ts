import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The 8 first-class league settings (#5). First loop ships one default each.
// Exported so `config.ts` can single-source the default rule-set's type.
export const rules = v.object({
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
    // Go-forward soft removal (#12). Removed members keep completed weeks;
    // the standings walk includes them for weeks with lock < removedAt.
    status: v.union(v.literal("active"), v.literal("removed")),
    removedAt: v.optional(v.number()),
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
      v.literal("revoked"), // commissioner-cancelled while pending (#12)
    ),
    expiresAt: v.number(), // 14-day
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_league_email", ["leagueId", "targetEmail"])
    // An invitee's own invites, across every league that has invited them.
    .index("by_email", ["targetEmail"]),

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
