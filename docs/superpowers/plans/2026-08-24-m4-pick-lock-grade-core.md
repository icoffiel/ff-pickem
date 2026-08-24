# M4 — The pick / lock / grade core

**Issue:** [#19](https://github.com/icoffiel/ff-pickem/issues/19)
**Date:** 2026-08-24

## Status

**All tasks complete.**

- [x] **Task 1** — `convex/week.ts`: the week's derived shape — `slate`, `lock`,
      `activeWeek`, `tiebreakerGame`. Pure, no `ctx`.
- [x] **Task 2** — `convex/grading.ts`: `effectiveOutcome` + `gradePick`. Pure.
- [x] **Task 3** — `convex/picks.ts`: `makePick` and `setTiebreakerGuess`
      mutations (server-clock lock gate, removed-membership guard, upsert), and
      the `pickSheet` query the make-picks screen reads.
- [x] **Task 4** — `app/leagues/[id]/picks/page.tsx`: the make-picks screen,
      linked from the league page.

## Shape

```
convex/week.ts      slate / lock / activeWeek / tiebreakerGame — pure   (task 1)
convex/grading.ts   effectiveOutcome / gradePick — pure                 (task 2)
convex/picks.ts     the Convex seam: two mutations + one query          (task 3)
app/leagues/[id]/picks/page.tsx   the screen                            (task 4)
```

Almost all of M4 is derivation, so the pure modules carry the logic and
`picks.ts` is thin: read the rows, call the derivations, authorize, write.

## Load-bearing decisions

**The lock is derived live, never stored.** `lock(slate) = min(kickoffAt)`, so a
flexed kickoff moves the deadline with it (`weekly-loop.md` §3). Only the
`weekly` rule is built; `perGame` stays a schema stub.

**The lock gate is a server-clock read inside the mutation** — ADR 0002 rule 1.
Not a client argument, not a cron-flipped flag: a cron leaves a window between
kickoff and the next tick in which an honest fast click still lands.

**The `pickSheet` query takes `now` as an argument** — ADR 0002 rule 3. The read
narrows (a locked week stops being editable), and a caller lying about the clock
only mis-renders their own screen; `makePick` still refuses the write. There is
no widening read in M4 — nobody sees another member's picks yet, so M4 needs no
materialized flag and no scheduling.

**No stored `result`.** A pick's grade is derived against the *effective*
outcome (`resultOverrides` layered over `game.outcome`) every time it is read, so
a commissioner's M6 correction flows through with no M4 change.

**Uniqueness lives in the mutation.** Convex has no unique constraints, so
`by_membership_game` / `by_membership_week` are read first and the write is an
upsert.

## Seams under test

Pre-agreed in the issue's Testing Decisions:

- **Pure-function seam** — the combinatorial edges, cheaply: the `gradePick`
  truth table, the Sat/Sun/Mon slate filter, `lock` moving with a flex, and
  `activeWeek` advancing across a lock boundary.
- **Convex-function seam** (`convex-test`) — what only exists at the mutation:
  accepted before lock / rejected after, pick-ahead into a not-yet-locked week,
  the removed-membership guard, and upsert-not-duplicate.
