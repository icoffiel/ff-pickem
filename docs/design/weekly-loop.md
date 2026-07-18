# The weekly loop — NFL Pick'em

**Status:** Design (Wayfinder ticket [Design: the weekly loop](https://github.com/icoffiel/ff-pickem/issues/10)). Builds directly on the [data model](./data-model.md) (#7) and the default rule-set (#5). This is a *design* artifact — the build phase lifts it into Convex functions and `crons.ts`. Terminology is in [`CONTEXT.md`](../../CONTEXT.md).

The loop is the heart of the app: for one league, one week, the lifecycle **slate → pick → lock → sync/grade → standings**, repeated every week of the season. The design leans on the data model's two load-bearing ideas — *store facts, derive interpretations* and *games are global, scoring is per-league* — so most of the loop is derivation, not stored state.

## 1. The active week (derived, never stored)

There is **no `currentWeek` pointer**. The week a league is currently picking is derived: the **earliest week whose lock time is still in the future**. As soon as a week locks (its first slate game kicks off), the next week becomes active automatically — the clock plus the `games` table already contain the answer, so a stored pointer would only be a thing that can go stale.

- The make-picks screen **defaults** to the active week.
- Members may **pick ahead** into any not-yet-locked future week whose schedule has loaded. The write-time lock protects each week independently, so pick-ahead costs nothing.

## 2. Slate generation

A week's **slate** is the set of games that count, selected from the global `games` table per the league's rule-set:

```
slate(league, week) =
  games where season == league.season
          and week   == week
          and gameType matches rules.seasonScope   (default REG)
          and weekday ∈ rules.slate set             (default {Sat, Sun, Mon})
```

Convex-wise: walk `games.by_season_week`, filter in TypeScript.

- **Default slate = Saturday + Sunday + Monday.** (Revises #5's Sun+Mon.) Thursday and Friday games — including the Week 13 Black Friday game — are **excluded**.
- **Non-slate games do not exist for scoring.** They are not shown on the make-picks screen and generate no pick rows. A member never "misses" a Thursday game; it simply isn't in their week.
- Consequence to keep in mind: with the default slate, a late-season **Saturday game counts**, and a **Thursday/Friday game never does**.

## 3. Pick window & lock

The week's **lock** is the moment picks and the tiebreaker guess freeze. Under the default `weekly` lock rule:

```
lock(league, week) = min(kickoffAt) over slate(league, week)
```

- **Derived, live, never stored.** The lock is recomputed from the *current* `kickoffAt` values, so it **tracks schedule changes** (NFL flex scheduling moves kickoffs and occasionally days). The sync updates `kickoffAt`; the lock moves with it. The one accepted edge: a game flexed *earlier* can pull the lock in sooner than a member expected.
- **Enforced at write time.** The pick and tiebreaker-guess mutations compute the lock and **reject any write once `now >= lock`**. No cron flips a flag.
- **Covers picks *and* the tiebreaker guess** — one deadline for the whole week's submission.
- Late-season weeks that include a Saturday game therefore lock on **Saturday**.
- Only the `weekly` rule is built for the first loop. `rules.lock`'s `perGame` literal stays a schema stub (design-for / build-one).

## 4. Sync & grading

Two Convex cron jobs keep `games` current. Grading is not a separate step — it **collapses into sync**, because `pick.result` is derived (§6).

### `scheduleSync` — nflverse, every 6 hours

Owns the **schedule**. Upserts `games` from nflverse's `games` dataset keyed by external `gameId`: teams, `season`, `week`, `weekday`, `kickoffAt`, `gameType`. Low frequency is plenty — it maintains upcoming weeks and catches flex changes (announced days ahead) and postponements (rescheduled → new `kickoffAt`). nflverse is also the **canonical backstop**: it corrects any score ESPN got wrong.

### `liveSync` — ESPN, every 15 minutes, self-gating

Owns **live status + scores** during game windows. Each run first does a cheap `games` query: *is any non-final game's kickoff within the last ~5 hours?* If not, it **returns immediately without calling ESPN** — so it is a no-op outside game windows and outside the season, with no season-aware scheduling needed. When games are live it calls ESPN's scoreboard and, matching each event to its `games` row on `(season, week, home, away)`:

- Maps ESPN's explicit `state` → our `status`: `pre → scheduled`, `in → in_progress`, `post → final`. We use ESPN's flag rather than inferring "final" from nflverse's NA-until-final `result` column.
- Writes `homeScore` / `awayScore`.
- Once `state == post`, computes `outcome`: `home > away → home`, `away > home → away`, equal → `tie`.

Standings then trail a game's final whistle by up to ~15 minutes — invisible at family-league scale.

> **Free-tier caveat for build:** a 15-minute cron runs 96×/day year-round even when most runs self-gate to no-ops. Confirm this fits Convex's free-tier function-invocation limit; the cheap fallback if not is to restrict `liveSync` to in-season months (Sep–Feb) with a cron expression.

## 5. Per-league result overrides

`games` is a **global** table shared by every league, so a correction written onto a game row would move the result for *every* league picking it. Corrections are therefore **per-league**, in a `resultOverrides` table keyed by `(leagueId, gameId)`. This also means sync and overrides write to **different places** and can never fight — `games` stays pure synced truth, with no clobber guard.

The **effective outcome** of a game *for a league* is:

```
effectiveOutcome(league, game) = override(league, game).outcome   if an override exists
                                 else game.outcome
```

All grading and standings derive from the effective outcome, not the raw `game.outcome`. An override outcome may be `home | away | tie | void`, where **`void`** (a cancelled / no-contest game) scores as a **push** for everyone — the clean remedy for a truly cancelled game like Bills–Bengals 2022.

- **Postponements** need no override — they ride `scheduleSync` (new `kickoffAt`, finals later).
- **Cancellations** — the commissioner writes a `void` override; every pick on that game becomes a push.
- The override *authority and UI* belong to [commissioner admin powers](https://github.com/icoffiel/ff-pickem/issues/12) (#12); this ticket fixes only **where the override lives and how grading reads it**.

## 6. Grading a pick (derived, per-league)

A pick stores only `selection`. Its **result** is derived at read time against the effective outcome:

| effective outcome | result |
|---|---|
| not yet final (no outcome) | **pending** — contributes 0, not yet counted |
| `tie` or `void` | **push** — excluded from scoring |
| `home` / `away`, matches `selection` | **correct** — 1 point |
| `home` / `away`, differs from `selection` | **incorrect** — 0 points |
| no pick row for a slate game | **absent** — 0 points (`absentPickScoring = zero`) |

No stored `result`, no separate grading write. When an `outcome` or override changes, Convex reactivity re-derives every dependent view.

## 7. Standings (compute-on-read)

No standings table. Weekly and season standings are hand-walked in TypeScript; scale is tiny (a handful of members, ~272 REG games/season), so compute-on-read is cheap and always consistent.

### Weekly standings

Walk `picks.by_league_week` for the week, load the week's slate games and the league's overrides into maps, derive each pick's result (§6), and fold per membership:

- **Weekly points** = count of `correct` picks. `push` excluded; `pending`/`incorrect`/`absent` contribute 0.
- **Ties broken by the Monday-night tiebreaker** (rule-set default `mondayTotalPoints`):
  - The **designated tiebreaker game** = the **latest-kickoff Monday game** in the slate (handles Week 1's Monday doubleheader → the nightcap). It is deterministic from the schedule, so the UI can show members which game they're guessing.
  - **Week 18 fallback:** no Monday game exists → the **week's latest-kickoff game overall** (the late Sunday game).
  - **Proximity** = `|guess − actualCombinedTotal|` (home + away final of the designated game). Smallest wins.
  - **Unresolved:** if the designated game isn't final yet, tied members stay **provisionally co-ranked**; the tiebreaker settles reactively when it finals.
  - **Genuine deadlock** (identical proximity, or no member in the tied group guessed): stay **co-ranked**. A member with **no guess** loses to anyone who guessed (treat missing guess as infinitely far).
- The tiebreaker settles the **weekly winner only** — it does **not** change point totals and does **not** cascade into the season.

### Season standings

- **Season points = Σ weekly correct-pick counts** across all played weeks — cumulative raw correct picks, not a sum of weekly placements. Pushes stay excluded throughout.
- **Ties → co-champions** (default `seasonTiebreaker = coChampions`): genuinely tied members share the title, with no further tiebreaker. The weekly MNF tiebreaker never feeds the season.
- **Mid-season joiners** under `absentPickScoring = zero`: a member who joins in Week 6 scores **0** for weeks 1–5 (no pick rows), so they are behind by every missed week and effectively can't win the season. This is the honest meaning of the `zero` default (the `countSinceJoin` option exists for leagues that want otherwise, but the first loop ships `zero`). The standings screen should present missed weeks as **zero-scoring**, not as losses.
- **Live:** standings count only **finaled** games; pending picks contribute nothing and update reactively as each game finals. No projected/provisional scoring of in-flight games.

### Edge cases that need no special logic

- **Partial picks:** a member may pick any subset of the slate; unpicked games are `absent` (0). No "must pick all" validation.
- **Optional tiebreaker guess:** picks may be submitted without a guess; the cost is forfeiting weekly tiebreakers.
- **Team byes:** a team on bye is in no game that week, so it never appears as a pick. Zero scoring impact.
- **Empty slate:** cannot occur under the default REG Sat/Sun/Mon slate (every week has games). If it ever did, the week has no pickable games, no derivable lock, and contributes 0 to everyone — it degrades gracefully.

## Notes for the build phase

- **Lock enforcement** lives in the pick / tiebreaker mutations — compute `lock(league, week)` and reject writes past it. No cron.
- **Effective outcome** is the single grading input: always layer per-league overrides over `game.outcome` before deriving a result. Never read raw `game.outcome` for scoring.
- **Grading = sync**: writing `game.outcome` (or an override row) is the whole job; there is no grading write.
- **Uniqueness** (one pick per membership+game, one guess per membership+week, one override per league+game) is enforced in mutations via the corresponding index — Convex has no unique constraints.
- **ESPN ↔ nflverse matching** on `(season, week, home, away)` is a build detail; confirm team-abbreviation alignment between the two sources.
- **Validators to confirm at build** against the installed Convex version (per the verify-the-API rule): the `crons.ts` interval/cron API surface used by `scheduleSync` / `liveSync`.
