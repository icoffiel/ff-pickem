# M3 — NFL data sync

**Issue:** [#18](https://github.com/icoffiel/ff-pickem/issues/18)
**Slices:** [#68](https://github.com/icoffiel/ff-pickem/issues/68) (M3a — nflverse schedule sync) · [#69](https://github.com/icoffiel/ff-pickem/issues/69) (M3b — ESPN live status)
**Date:** 2026-08-21

## Status

M3a ([#68](https://github.com/icoffiel/ff-pickem/issues/68)) is tasks 1 and 3, plus the
`scheduleSync` half of 6 and 7. Everything else is M3b
([#69](https://github.com/icoffiel/ff-pickem/issues/69)). **All tasks complete.**

- [x] **Task 1** — `convex/nflverse.ts`: Eastern→UTC, quote-aware CSV split,
      `parseSchedule`. Includes the `CONTEXT.md` note on the away-first `game_id`.
- [x] **Task 2** — `convex/espn.ts`: scoreboard interpretation — the URL builder, team
      normalization, `state` → `status`, and a defensive `parseScoreboard`. The finality
      signal turned out to be `status.type.state === "post"` rather than the `completed`
      flag beside it; they agree, and the state is the one value the parser already reads.
- [x] **Task 3** — `convex/games.ts`: the schedule upsert — a pure merge rule plus the
      `applySchedule` internal mutation, reporting moved kickoffs.
- [x] **Task 4** — `convex/games.ts`: the live-result write — `applyLiveEvents`, matching
      on `(season, week, home, away)` and writing `outcome` on `post`.
- [x] **Task 5** — the live sync's self-gate: `games.weeksInPlay` over a new
      `by_status_kickoff` index, window `[kickoff − 15 min, kickoff + 5 h]`.
- [x] **Task 6a** — `convex/sync.ts`: the `scheduleSync` action (fetch → parse → upsert).
- [x] **Task 6b** — `convex/sync.ts`: the `liveSync` action (gate → fetch → parse → write).
- [x] **Task 7a** — `convex/crons.ts`: `scheduleSync` on a 6-hour interval.
- [x] **Task 7b** — `convex/crons.ts`: `liveSync` every 15 minutes, **year-round** — the
      self-gate makes an in-season cron expression unnecessary (see the build spec's gates).

## Why two sources

`docs/research/nfl-data-source.md` settled this: nflverse is the schedule and grading
source of record (no key, no quota, published months ahead), and ESPN's unofficial
scoreboard is the live-status cross-check (an explicit `state`, seconds of
latency). Neither alone is enough — nflverse has no "this game is over" column, and
ESPN is undocumented and could vanish.

The split of responsibility is therefore:

| Question | Answered by |
| --- | --- |
| Which games exist, when do they kick off | nflverse (M3a) |
| What is the score, right now | ESPN (M3b), nflverse as backstop |
| Is this game over | ESPN's `state: "post"` (M3b); nflverse + a 6-hour age guard (M3a) |

## Shape

```
convex/nflverse.ts   pure payload interpretation — no ctx, no I/O          (task 1)
convex/espn.ts       (M3b) the same, for the scoreboard JSON               (task 2)
convex/games.ts      the `games` write layer — a pure merge rule and the
                     internal mutations that apply it                    (tasks 3, 4)
convex/sync.ts       the actions — fetch, hand the payload to a parser, hand the
                     result to a mutation. No interpretation lives here.   (task 6)
convex/crons.ts      registration only                                     (task 7)
```

The seam that matters is that **no file does two of those three jobs**. Parsing is
pure and testable without a database; the merge rule is pure and testable without a
network; the action is thin enough that its only real test is "does the wiring hold".

## Decisions carried into M3a

Recorded in full on [#68](https://github.com/icoffiel/ff-pickem/issues/68). The five
that shaped the code:

1. **Eastern→UTC through `Intl`, never a fixed offset.** The offset is −4 or −5 by
   date; a constant breaks September and January.
2. **`game_id` is away-team-first** (`2026_01_NE_SEA` is NE at SEA). Teams are read
   off the `home_team`/`away_team` columns, never parsed out of the id.
3. **A blank score means "no news", never "erase what live sync wrote."** And a row
   is promoted to `final` only once kickoff is more than six hours past, so nflverse's
   mid-game score columns can never grade an in-progress line.
4. **A row with no kickoff time is skipped and reported; anything else unreadable
   throws.** A blank `gametime` is a shape nflverse really publishes — every 1999 row
   has one, though no 2026 row does — so it means "not scheduled yet", not "corrupt".
   Throwing would strand the other 271 games on a stale schedule every six hours;
   inventing a time would poison the lock M4 derives from it. A truncated row or a
   non-numeric score is corruption and does throw, naming the row and the column.
5. **The upsert reports moved kickoffs.** [ADR 0002](../../adr/0002-time-authority.md)
   requires it: M4 schedules its pick-visibility flip at kickoff, and a flex change
   that left a stale flip queued would reveal picks at the old time. No scheduled-
   function id is stored yet — M4's flip does not exist, and a dead column for a
   milestone is worse than the small retrofit.

## Decisions carried into M3b

Recorded in full on [#69](https://github.com/icoffiel/ff-pickem/issues/69). The five
that shaped the code:

1. **`liveSync` self-gates before spending a fetch.** Out of season every one of the
   96 daily runs is a no-op, which is what makes a year-round 15-minute cron
   affordable — ~2,900 scheduled executions a month against a 1M free tier. The
   in-season cron expression the build spec held in reserve was therefore not built.
2. **The window is `[kickoff − 15 min, kickoff + 5 h]`.** Opening early keeps a game
   from reading `scheduled` for a full cron interval after the snap; the trailing edge
   stays inside M3a's six-hour age guard so the two sources hand off rather than
   overlap.
3. **ESPN abbreviations are normalized before matching.** `LAR` → `LA`, `WSH` → `WAS`;
   the other 30 clubs agree. Without it, two games a week would match no row and
   silently never grade.
4. **The season goes in `dates`, not `year`.** `year` is accepted and ignored, so a
   request for a past season returns the current one's slate. Everything is keyed off
   the season and week the *payload* states.
5. **`post` always wins; nothing else may downgrade a `final`, and a `pre` reading
   writes nothing at all.** Un-finaling a graded game would un-grade the week for every
   league; and ESPN's placeholder `0`–`0` pre-kickoff scores, if stored, would make
   M3a's age guard final the game as a tie six hours later.

## Testing

Fixtures are literal copies of real nflverse rows and trimmed copies of real ESPN
scoreboard events, captured 2026-08-21 and pinned in `tests/fixtures/` — outside
`convex/`, so they are never bundled into a deployment. The one hand-edited value is
ESPN's `in` state, since no NFL game was in progress at capture time; the state string
itself was read live off the same shared schema on a sport that had one running.
**No test hits either live source**: both are unofficial, and a suite that depends on
them fails for reasons unrelated to our code.

The action's fetch boundary is stubbed with `vi.stubGlobal("fetch", …)` rather than
an injected `fetchImpl`, so the test drives the real registered function through
`convex-test`. That pattern is the prior art for every later external integration.
