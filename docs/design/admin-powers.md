# Commissioner admin powers — NFL Pick'em

**Status:** Design (Wayfinder ticket [Design: commissioner admin powers](https://github.com/icoffiel/ff-pickem/issues/12)). Builds on the [data model](./data-model.md) (#7), the default [rule-set](https://github.com/icoffiel/ff-pickem/issues/5) (#5), and the [weekly loop](./weekly-loop.md) (#10). This is a *design* artifact — the build phase lifts it into Convex mutations/queries and UI. Terminology is in [`CONTEXT.md`](../../CONTEXT.md).

The commissioner is the one member who can change the shape of a league mid-flight. This ticket fixes **which powers exist in the first loop, and what they do to the data** — deliberately asymmetric in depth: the result override is the load-bearing safety valve and gets a full design; member removal is a well-defined go-forward escape hatch; settings editing is trimmed to the smallest thing that isn't a footgun.

## Authorization & surface

- Every power below gates on `membership.role === "commissioner"` — checked in the mutation, never trusted from the client. Exactly one commissioner per league (the creator); commissioner **transfer is deferred** (#6).
- All powers live **inline behind the gear** in the unified player view (chosen at [#11](https://github.com/icoffiel/ff-pickem/issues/11)) — there is no separate admin area. The override rides on game rows in the week's results view; roster and settings open from the gear.

## 1. Manual result override *(load-bearing)*

The whole app runs on free/hybrid NFL data ([#2](https://github.com/icoffiel/ff-pickem/issues/2)) that can be late, wrong, or stuck non-final. The override is the recovery path so one bad datum can't silently poison standings. The data model already fixes **where** the correction lives (`resultOverrides`, keyed `(leagueId, gameId)`) and **how** grading reads it (the *effective outcome* — override if present, else `game.outcome`; see [weekly-loop §5](./weekly-loop.md)). This ticket fixes the commissioner-facing surface.

### Outcome-only, not score

An override sets the **effective outcome** to `home | away | tie | void` (+ optional `note`). It carries **no score**. This cleanly solves the load-bearing cases — wrong winner, stuck game, cancellation-as-`void` — which are the ones that actually break standings.

- **Known, accepted limitation:** the weekly tiebreaker reads the Monday game's *combined points total* from the synced `games` row ([weekly-loop §7](./weekly-loop.md)), which an outcome-only override never touches. An override corrects *who won*, not the points total the tiebreaker reads. The only case this bites is a weekly tie decided by a Monday game whose *score* (not winner) came in wrong — an edge of an edge. The honest fallback is the league sorting it out among themselves. Adding a corrected score would mean the override layer shadows `homeScore`/`awayScore` too and the effective-outcome abstraction stops being a single enum — real complexity for a rare payoff. Deferred.

### Sticky lifecycle & sync divergence

Sync only ever writes the `games` row; the override only ever lives in `resultOverrides`. They **cannot overwrite each other** — but they can **diverge** (commissioner overrides a stuck game, then sync later finals it to a different outcome). The policy:

- **Sticky:** an override persists until the commissioner clears it. Sync **never** reconciles automatically. (Auto-expiring the override the moment sync finals would silently restore the value the commissioner distrusted — the worst outcome, invisibly. Rejected.)
- **Visible divergence:** when the synced `game.outcome` disagrees with a standing override, the results view shows an **"Overridden"** badge on that game and displays the **synced outcome alongside** the override, so disagreement between "what I set" and "what sync now says" is impossible to miss.
- **Explicit revert:** a one-tap **"Revert to synced result"** deletes the override row → the effective outcome falls back to `game.outcome`.

### Surface & mutation

- Affordance: a **gear on each _slate_-game row** in the week's results view (the same games shown on make-picks/standings). Non-slate games (Thu/Fri) generate no picks and score nothing, so they are not overridable; a cancelled non-slate game is simply irrelevant.
- Control: set **Home win / Away win / Tie / Void** (+ optional `note`) → **confirm** ("This changes standings for every member") → standings recompute reactively. Revert shows the same control with "Overridden — synced says X" and the same confirm.
- Mutation: **upsert** on `(leagueId, gameId)` via `by_league_game` (create or edit are one path); **revert = delete**. `createdBy` = the commissioner's `membershipId`; `week` denormalized from the game for the standings walk. Convex has no unique constraint, so the upsert enforces one override per league+game in the mutation.
- **No separate prototype** — the gear-inline pattern from #11 covers the interaction shape; this spec is enough for the build.

## 2. Member management *(go-forward escape hatch)*

Real leagues get a wrong redemption, a duplicate, or a dropout. Removal is a **reversible, go-forward** operation that **preserves completed weeks** — a week already decided stays decided.

### Soft-remove, preserve history

- `memberships` gains **`status: "active" | "removed"`** and **`removedAt` (timestamp)**. Nothing is ever deleted — the member's pick and tiebreaker-guess rows stay as inert data.
- **Participation is per-week, by lock time.** A removed member counts in **every week that had already locked when they were removed** (`lock(week) < removedAt`) and drops out of weeks that lock afterward. Because the standings walk already computes `lock(week)` ([weekly-loop §7](./weekly-loop.md)), this is a cheap comparison.
  - Consequence: past weekly **winners and positions are frozen exactly** — removing someone in week 10 never rewrites week 4.
  - Their **season total freezes** at what they earned through their last participating week.
- **Going forward:** the pick and tiebreaker-guess mutations **reject a `removed` membership** — a removed member cannot pick, and vanishes from weeks that lock after removal.
- **Season leaderboard:** a removed member stays **listed with a "left" badge** and their frozen total, **ineligible for the season title**. (This maximizes the historical-record value: you can still see where they stood.)
- **Reversible:** un-remove clears `status`/`removedAt`; because nothing was deleted, they resume with full history.

> **Asymmetry with joiners (by design):** a mid-season joiner is padded with 0s for pre-join weeks (present, but behind — [weekly-loop §7](./weekly-loop.md)); a removed member is **absent** from post-removal weeks (gone, not shown as 0). A late joiner is *here*; a removed member has *left*.

### Constraints & re-add

- Only the **commissioner** removes, and only **members** — never the commissioner (a self-remove would orphan the league; transfer is deferred, #6). No timing gate.
- **Re-add:** un-remove reactivates in one click. Invite redemption checks for **any** existing membership for that `(user, league)`: if it finds a `removed` one it **reactivates** it, and if it finds an `active` one it is a no-op — so both the gear's "un-remove" and an accidental re-invite converge on the **same single membership, never a duplicate**.

### Invite revocation

Half of a not-yet-full league is pending invites, so managing the roster includes cancelling one (typo'd email, changed mind).

- `invites.status` gains a new terminal **`revoked`** state (distinct from `expired`, which is time-based, and `superseded`, which means re-invited). A revoked invite's magic link stops working at redemption.
- The commissioner's roster view lists **active members and outstanding pending invites**, with a **revoke** action on each pending invite.

## 3. Settings editing *(trimmed)*

Build-one reality: only the **default** value of each of the 8 `rules` is implemented; the other literals are schema stubs (design-for / build-one). A rules *editor* would offer choices the engine can't honor.

- **`name`** — editable by the commissioner **anytime** (cosmetic, zero scoring impact).
- **`season`** — **immutable.** A league *is* a single season; changing it would invalidate every game and pick.
- **`rules`** (the 8 settings) — **displayed read-only** as a "How this league scores" panel so members understand their league. **No editor** in the first loop.
- **Design-for intent (not built now):** when a rules editor is eventually built, the natural **freeze point is week 1's lock** (the season's first counted kickoff) — rules editable up to then, frozen once real picks start scoring against them.

## Schema deltas (fold into [`data-model.md`](./data-model.md) / [#7](https://github.com/icoffiel/ff-pickem/issues/7))

- `memberships` += **`status: "active" | "removed"`** and **`removedAt: v.optional(v.number())`**.
- `invites.status` union += **`v.literal("revoked")`**.
- **Standings walk** filters per-week participation by `lock(week)` vs `removedAt`, and marks removed members "left" (frozen total, title-ineligible) on the season board.
- **Pick / tiebreaker-guess mutations** reject a `removed` membership.
- **Invite redemption** reactivates an existing (removed) membership rather than creating a duplicate.
- (`resultOverrides` already exists from #10 — no new table; this ticket adds only its authority + UI.)

## Out of scope (parked as future efforts)

- **Historical / multi-season stats & visualizations** — week-by-week position graphs, past-year leaderboards. Beyond this single-season map's destination; a future effort.
- **Score-level override** (correcting `homeScore`/`awayScore`, and with it the tiebreaker total) — deferred; see the outcome-only limitation above.
- **Commissioner transfer** — deferred at #6; keeps the commissioner non-removable for now.
- **A rules editor** — the settings are first-class in the schema (buildable later with no migration), but editing is out of the first loop.
