# M3 — NFL data sync

**Issue:** [#18](https://github.com/icoffiel/ff-pickem/issues/18)
**Slices:** [#68](https://github.com/icoffiel/ff-pickem/issues/68) (M3a — nflverse schedule sync) · [#69](https://github.com/icoffiel/ff-pickem/issues/69) (M3b — ESPN live status)
**Date:** 2026-08-21

## Status

M3a ([#68](https://github.com/icoffiel/ff-pickem/issues/68)) is tasks 1 and 3, plus the
`scheduleSync` half of 6 and 7. Everything else is M3b
([#69](https://github.com/icoffiel/ff-pickem/issues/69)).

- [x] **Task 1** — `convex/nflverse.ts`: Eastern→UTC, quote-aware CSV split,
      `parseSchedule`. Includes the `CONTEXT.md` note on the away-first `game_id`.
- [ ] **Task 2** — `convex/espn.ts`: scoreboard interpretation — live status, scores,
      and the explicit `completed` flag.
- [x] **Task 3** — `convex/games.ts`: the schedule upsert — a pure merge rule plus the
      `applySchedule` internal mutation, reporting moved kickoffs.
- [ ] **Task 4** — `convex/games.ts`: the live-result write — `in_progress`, and
      `outcome` written from ESPN's `completed`.
- [ ] **Task 5** — the live sync's self-gate: only poll while a game is actually
      running, so the cron is quiet six days a week.
- [x] **Task 6a** — `convex/sync.ts`: the `scheduleSync` action (fetch → parse → upsert).
- [ ] **Task 6b** — `convex/sync.ts`: the `liveSync` action.
- [x] **Task 7a** — `convex/crons.ts`: `scheduleSync` on a 6-hour interval.
- [ ] **Task 7b** — `convex/crons.ts`: `liveSync` on its in-season cadence.

## Why two sources

`docs/research/nfl-data-source.md` settled this: nflverse is the schedule and grading
source of record (no key, no quota, published months ahead), and ESPN's unofficial
scoreboard is the live-status cross-check (an explicit `completed` flag, seconds of
latency). Neither alone is enough — nflverse has no "this game is over" column, and
ESPN is undocumented and could vanish.

The split of responsibility is therefore:

| Question | Answered by |
| --- | --- |
| Which games exist, when do they kick off | nflverse (M3a) |
| What is the score, right now | ESPN (M3b), nflverse as backstop |
| Is this game over | ESPN's `completed` (M3b); nflverse + a 6-hour age guard (M3a) |

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

## Testing

Fixtures are literal copies of real nflverse rows, captured 2026-08-21 and pinned in
`tests/fixtures/` — outside `convex/`, so they are never bundled into a deployment.
**No test hits the live dataset**: it is unofficial, and a suite that depends on it
fails for reasons unrelated to our code.

The action's fetch boundary is stubbed with `vi.stubGlobal("fetch", …)` rather than
an injected `fetchImpl`, so the test drives the real registered function through
`convex-test`. That pattern is the prior art for every later external integration.
