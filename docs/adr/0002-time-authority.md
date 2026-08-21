# ADR 0002 — Time authority: the server clock decides writes; widening reads read stored state

**Status:** Accepted (2026-07-26)

## Context

Convex queries must not call `Date.now()`. A query is re-run only when the data
it reads changes — never merely because time passed — so a clock read inside one
silently goes stale, and it churns the query cache besides
([Convex best practices](https://docs.convex.dev/understanding/best-practices/#date-in-queries)).

That leaves two ways for a query to know the time: take it as an **argument from
the caller**, or read **state materialized in the database** by something that
ran earlier. The first is the cheap default the Convex docs recommend, floored to
the minute so callers within a minute share a cache entry. But an argument is
client-controlled, and this app has time-gated secrets — a week's Picks are
hidden until Lock — so "the client tells us what time it is" is not universally
safe.

M2c ([#60](https://github.com/icoffiel/ff-pickem/issues/60)) forced the question
for invite expiry, and the answer generalizes. M4
([#19](https://github.com/icoffiel/ff-pickem/issues/19)) is where getting it
wrong becomes exploitable rather than cosmetic.

The distinction that matters is **which way a time-dependent read moves**:

- A read that **narrows** as time passes hides things that went stale. Feeding it
  a false clock only re-shows the caller something they were already entitled to
  see. Self-harm at worst.
- A read that **widens** as time passes reveals more. Feeding it a false clock is
  a genuine leak: a clock set forward reads other people's Picks before kickoff.

## Decision

Three rules, applied in order.

1. **A write — any state transition — reads `Date.now()` inside the mutation.**
   Never a client argument, never a stored flag. A mutation is not a
   subscription, so the staleness objection does not apply and the server clock
   is available and authoritative.
2. **A read that widens over time reads state materialized in the database**,
   flipped by a scheduled function. Never a client-supplied time.
3. **A read that narrows over time takes `now` as an argument**, floored to the
   minute by the caller (`app/currentMinute.ts`).

### Applied

| Case | Mechanism | Rule |
| --- | --- | --- |
| Invite expiry at redemption (`invites.redeem`) | Server `Date.now()` in the mutation | 1 |
| Invite lists (`myPendingInvites`, `leagueRoster`) | Client `now` argument | 3 |
| Pick lock — refusing a late Pick (M4) | Server `Date.now()` vs the Game's `kickoffAt`, in the pick mutation | 1 |
| `hiddenUntilLock` Pick visibility (M4) | Materialized locked state, flipped by `ctx.scheduler.runAt(kickoffAt, …)` | 2 |

**The Lock must not be implemented as a cron-flipped boolean that gates the
write.** It is weaker than the server-clock comparison, not stronger: a cron
flips on an interval, so between kickoff and the next tick the flag is still
false and Picks are still accepted. A one-minute interval leaves a ~60s window in
which an ordinary fast click lands a Pick after the opening snap — no clock
tampering required. Scheduling is a **reactivity** mechanism, never a security
one; security always comes from a mutation reading the server clock.

Prefer `ctx.scheduler.runAt(kickoffAt, …)` over `crons.interval` for the
visibility flip — it fires at the moment rather than polling, so the projection
is correct within seconds instead of up to an interval late. (Verified present in
the installed convex 1.42.3: `convex/dist/esm-types/server/scheduler.d.ts:109`.)

### Tension with the glossary — Lock stays derived

`CONTEXT.md` defines **Lock** as "a derived point in time, **not a stored
flag**", and **Active week** as "derived, never stored". Rule 2 requires storing
something. These are reconciled by what the stored value *is*:

- The **authority** for Lock remains the counted Games' `kickoffAt` — derived,
  never edited, exactly as the glossary says. Every write gate recomputes it.
- The stored value is a **projection** of that derivation, existing only so a
  query can react to time passing. It is never an independent source of truth,
  is never set by hand, and is always recomputable from `kickoffAt`.
- Where the two disagree, `kickoffAt` wins and the projection is repaired.

The projection may therefore lag the true Lock by seconds, but **must never lead
it** — flipping early would reveal Picks before the week has actually locked.
Lagging is safe: Picks are refused (rule 1, exact) slightly before others' Picks
become visible.

### Relationship to ADR 0001

This sharpens rule 5 of [ADR 0001](0001-convex-authorization-policy.md)
("Enforce `pickVisibility` in the query"). Filtering server-side is necessary but
not sufficient: if the server-side filter's *time input* comes from the caller,
the filter is client-controlled and the enforcement is theatre. Rule 2 above is
what closes that.

## Consequences

- **M3 ([#18](https://github.com/icoffiel/ff-pickem/issues/18)) inherits a
  re-scheduling obligation.** Kickoff times move — flex scheduling and
  postponements are M3 stories 2 and 3 — so when `scheduleSync` changes a Game's
  `kickoffAt` it must cancel that Game's pending flip and schedule a new one. A
  stale flip left queued would reveal Picks at the *old* time, which is the early
  reveal this ADR exists to prevent. `ctx.scheduler.cancel` needs the scheduled
  function's id, so M3's schema has to retain it.
- A low-frequency reconciling cron is worth having as a backstop, re-asserting
  that every non-final future Game has exactly one pending flip at its current
  `kickoffAt`.
- **Client-supplied `now` is accepted as display-only authority.** A caller
  passing a stale `now` to `myPendingInvites` or `leagueRoster` can make an
  expired Invite look live on their own screen; `redeem` refuses it. Reviewers
  should confirm any new `now` argument feeds a narrowing read only.
- **`CONTEXT.md`'s Lock entry may want a sentence** noting that a stored
  projection of the Lock is an implementation detail and not the Lock itself, so
  a future reader doesn't take the M4 flag as contradicting the glossary.
- Reviewers of any time-dependent function should ask the three questions in
  order: is this a write; does this read widen; does it narrow.
