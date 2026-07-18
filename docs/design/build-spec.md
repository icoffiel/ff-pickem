# Build spec — NFL Pick'em (hand-off plan)

**Status:** Hand-off (Wayfinder ticket [Assemble the build spec](https://github.com/icoffiel/ff-pickem/issues/13), the map's terminal step). This is the boundary where the [planning map](https://github.com/icoffiel/ff-pickem/issues/1) hands off to an execution phase. Every *decision* the build needs is resolved (#2–#12); this doc consolidates them so an execution session can start **without re-reading ten issues**. It packages decisions — it does not carry the build.

The deep detail lives in three design docs and the glossary; this spec is the **index + build sequence** over them, restating only the operative decisions and adding the one thing the design docs don't have: an **order to build in**.

## Destination

A real, private NFL pick'em **league** plays one full regular-season loop end-to-end, for a **single league**:

> A commissioner creates a league → invites members by magic link → everyone picks the winners of the week's slate → picks lock and grade automatically against real NFL results → weekly + season standings update — working start to finish.

"Done" = that loop runs against live NFL data for a real family league.

## Authoritative sources (read these for the deep detail)

| Area | Doc | Ticket |
|---|---|---|
| Domain language (ubiquitous terms) | [`CONTEXT.md`](../../CONTEXT.md) | #7 |
| Schema + table-by-table rationale | [`data-model.md`](./data-model.md) | #7 (ext. #10, #12) |
| Slate → pick → lock → sync/grade → standings | [`weekly-loop.md`](./weekly-loop.md) | #10 |
| Commissioner powers (override / removal / revoke / settings) | [`admin-powers.md`](./admin-powers.md) | #12 |
| UI direction + prototypes | branch `prototype/ui-flows` | #11 |

When this spec and a design doc ever disagree, the **design doc wins** — this is an index, and the detail lives in one place.

## The stack (decided at #9, #4, #2, #6, #3)

- **Backend + datastore:** **Convex** — document datastore + backend platform. Accepts vendor lock-in and hand-written standings aggregation to gain fewest moving parts, built-in realtime, built-in cron, and one TypeScript language top to bottom. (Survey #8 → decision #9.)
- **Frontend:** **Next.js** responsive web app, hosted on **Vercel Hobby** (the one surviving piece of #4 after the Convex decision).
- **Auth:** **Convex Auth** with the **Resend** magic-link provider (#6, #3). An invite *is* a magic link at the auth layer, but the app-level invite grant is a separate `invites` row (see Auth & invite below).
- **Email:** **Resend** free tier (3,000/mo · 100/day, 1 domain). Requires domain verification + SPF/DKIM at setup (#3).
- **Scheduled jobs:** Convex **`crons.ts`** (replaces the dropped GitHub Actions cron from #4).
- **NFL data:** hybrid, free-only (no paid-API budget) — **nflverse/nfldata `games` dataset** as the schedule + backstop source, **ESPN's unofficial scoreboard API** as the live-score / reliable-final fallback (#2).

## Consolidated decisions (the operative subset)

### Data model (#7, extended #10 + #12)

The full `convex/schema.ts` and per-table rationale is in [`data-model.md`](./data-model.md). Load-bearing principles the whole build rests on:

- **A League is a single season** — `league.season` fixes scope; no season discriminator below the league except on the global `games` rows.
- **Store facts, derive interpretations** — a pick's `result`, a pick's lock state, and **all standings** are derived, never stored. A score correction propagates for free; nothing goes stale; Convex reactivity re-renders derived views automatically.
- **Games are global; scoring is per-league** — `games` is league-agnostic NFL truth (incl. a `tie` outcome). A commissioner's correction lives in a per-league `resultOverrides` row, **never** on the shared game.
- **Effective outcome** — every grading/standings read uses `override(league, game) ?? game.outcome`, **never** raw `game.outcome`.

Tables: `users` (Convex Auth, lean — no name), `leagues` (season + embedded first-class `rules`), `memberships` (`role`, `teamName`, `status`/`removedAt`), `invites` (no role, `status` incl. `revoked`), `games` (global; computed `status` + `outcome`), `picks` (`selection` only), `tiebreakerGuesses` (per week), `resultOverrides` (per-league `(leagueId, gameId)`, `outcome` incl. `void`). No standings table.

### Weekly loop (#10)

Full algorithm + edge cases in [`weekly-loop.md`](./weekly-loop.md). Operative rules:

- **Active week is derived** — earliest week whose lock is still in the future. No `currentWeek` pointer. Pick-ahead into any not-yet-locked week is allowed (write-time lock protects each week independently).
- **Slate = Sat + Sun + Mon** (default). Thu/Fri games (incl. Week 13 Black Friday) are excluded — they generate no picks and don't exist for scoring.
- **Lock = min slate kickoff**, derived **live** (tracks flex scheduling), enforced at **write time** in the pick/tiebreaker mutations (`reject once now >= lock`). No cron flips a flag. One deadline covers picks + the tiebreaker guess.
- **Sync = two Convex crons:** `scheduleSync` (nflverse, every 6h — owns schedule, is the score backstop) + `liveSync` (ESPN, every 15 min, **self-gating** to a no-op outside game windows — owns live status/scores; maps ESPN `state` → our `status`).
- **Grading collapses into sync** — writing `game.outcome` (or a `resultOverrides` row) is the whole job; `pick.result` is derived, so there is no separate grading write.
- **Standings compute-on-read** — walk `picks.by_league_week`, load the week's games + league overrides into maps, derive each pick against the effective outcome, fold. Weekly points = correct picks (push excluded, absent = 0); weekly ties → MNF total-points proximity (**winner-only**, never changes totals or the season). Season points = Σ weekly correct; season ties → **co-champions**.

### Default rule-set (#5)

8 first-class settings; the first loop ships **one default each** (other literals are schema stubs — design-for / build-one):

| Setting | Default |
|---|---|
| lock | `weekly` (first slate kickoff) |
| slate | `saturdaySundayMonday` |
| seasonScope | `regular` (wk 1–18) |
| scoring | `flat` (1 pt/correct) |
| weeklyTiebreaker | `mondayTotalPoints` (wk-18 → week's last game) |
| seasonTiebreaker | `coChampions` |
| pickVisibility | `hiddenUntilLock` |
| absentPickScoring | `zero` (no pick = 0; tie game = push) |

### Auth & invite flow (#6)

- **Auth and invite are separate concerns.** Auth = Convex Auth Resend magic-link (proves email ownership, mints/looks-up a `User`). Invite = app-level `invites` row (own token/expiry/league, redeemed at `/invite/<token>` after sign-in via `redirectTo`).
- Redemption is **email-bound** (signed-in email must match the invite) and creates the `Membership` **born active** — no pending-membership rows. **Team name** is captured at redemption, stored only on `Membership`. `User` = email/auth only.
- **Role** = `"commissioner" | "member"` on `Membership`, single source of truth; the creator is born commissioner in `createLeague`. Transfer deferred.
- **Invite lifecycle:** `pending → accepted | expired | superseded | revoked`; **one live invite per (email, league)** (re-invite supersedes); **14-day expiry**.
- **Reactivate, never duplicate:** redemption checks for any existing membership for `(user, league)` — reactivates a `removed` one, no-ops an `active` one.

### UI direction (#11)

- **"Streaks" (prototype variant I)** — card-based, fully **responsive** app on the bold-card structure, tuned for the family league's **tween** audience: simple via clean hierarchy, sports-app-legit (not childish).
- **Unified player + commissioner view** — admin tools inline behind a **gear**, no separate admin area.
- The distinguishing layer is light + **motivational**: streak chip (🔥), rank-movement arrows (▲▼), "finish & keep your streak" framing, "you're #2 of 8" race context.
- **Palette + real typography are deferred to the build's visual pass** — prototypes used placeholder colors + system fonts. Screens prototyped: create · invite/join · home · make-picks (incl. MNF guess) · standings (season + weekly) · empty · error. Source: branch `prototype/ui-flows` (gens A/B/C, D/E/F, G/H/I).

### Commissioner admin powers (#12)

Full spec in [`admin-powers.md`](./admin-powers.md). Every power gates on `membership.role === "commissioner"`, checked in the mutation. Three powers, asymmetric in depth:

1. **Result override** (load-bearing): **outcome-only** (`home|away|tie|void` + note; corrected *score* is out of scope). **Sticky** (persists until cleared; sync never reconciles). **Visible divergence** ("Overridden" badge + synced value shown) + one-tap **revert** (= delete). Gear on each slate-game row; upsert on `(leagueId, gameId)`; confirm-gated.
2. **Member removal** (go-forward escape hatch): **soft** (`status`/`removedAt`). Counts in every week that locked **before** `removedAt` (past winners frozen), drops out after; can't pick once removed; season total freezes; stays on the season board with a **"left" badge**, title-ineligible. Only the commissioner removes, never self. Un-remove/redemption reactivate, never duplicate.
3. **Invite revocation:** terminal `invites.status: revoked` + a revoke action on each pending invite in the roster view.
4. **Settings (trimmed):** `name` editable; `season` immutable; the 8 `rules` **read-only** ("How this league scores" panel) — no editor in the first loop.

## Build sequence

Milestones are ordered so each one is independently verifiable and unblocks the next; the destination is reached at the end of M6. This is the *shape* of the build — the execution phase should turn each milestone into concrete tasks (via the writing-plans / TDD skills), not treat these bullets as a task list.

### M0 — Project skeleton & accounts
- Scaffold Next.js (App Router) + Convex; wire the Convex client/provider.
- Provision accounts: Convex project, Vercel Hobby, Resend (verify a domain + SPF/DKIM — this has DNS-propagation lead time, so **start it first**).
- **Verify:** app boots locally against a Convex dev deployment; a trivial Convex query round-trips to the browser.

### M1 — Schema & auth
- Lift `convex/schema.ts` from [`data-model.md`](./data-model.md) verbatim (confirm the `authTables` import + `v` surface against installed versions — see gates below).
- Stand up Convex Auth with the Resend magic-link provider; a user can sign in by email and a `users` row appears.
- **Verify:** magic-link sign-in works end-to-end against Resend; session persists.

### M2 — League creation & the invite→membership flow
- `createLeague` mutation (creator born `commissioner`, embeds the default `rules`); league-create screen.
- App-level `invites`: create (one-live-per-(email,league), 14-day expiry, supersede), email the link via Resend, and `/invite/<token>` redemption (email-bound, captures team name, born-active membership, reactivate-not-duplicate).
- **Verify:** a second real email receives an invite, redeems it, and shows up as an active member with a team name. Uniqueness + email-binding enforced in the mutations.

### M3 — NFL data sync
- `games` table + `scheduleSync` (nflverse, 6h upsert by external `gameId`) and `liveSync` (ESPN, 15 min, self-gating; `state`→`status`; compute `outcome` on final).
- ESPN↔nflverse matching on `(season, week, home, away)` — confirm team-abbreviation alignment.
- **Verify:** a real week's schedule loads; scores + `status`/`outcome` update through a live game window (or a replayed one out of season).

### M4 — The pick / lock / grade core
- Slate derivation (Sat/Sun/Mon REG filter), derived active week, `lock(league, week) = min slate kickoff`.
- Pick + tiebreaker-guess mutations with **write-time lock enforcement** and removed-membership rejection; make-picks screen (defaults to active week, pick-ahead, MNF guess).
- Derived `pick.result` against the **effective outcome**.
- **Verify:** picks accepted before lock, rejected after; a graded week shows correct/incorrect/push/absent correctly; pick-ahead into a future week works.

### M5 — Standings (compute-on-read)
- Weekly standings (correct-pick count, push excluded, MNF proximity tiebreak — winner-only, provisional-until-final) and season standings (Σ weekly correct, co-champions).
- Removed-member folding by `lock(week)` vs `removedAt`; "left" badge + frozen total on the season board; mid-season joiner zero-padding.
- **Verify:** weekly + season boards match a hand-computed expected result for a fixture league; removal in week N never rewrites week N−1.

### M6 — UI polish & commissioner powers → end-to-end loop
- Build out the "Streaks" card UI across all screens (home, standings, make-picks, empty/error) with the motivational layer; **visual pass** picks the real palette + typography (deferred from #11).
- Commissioner gear: result override (upsert/revert, Overridden badge + synced value), member removal + un-remove, invite revocation, read-only rules panel + editable name.
- **Verify (destination):** a real family league runs one full week end-to-end — create → invite → pick → lock → grade → standings — with a commissioner override exercised. Then it's ready for a full regular-season loop.

## Build-time verification gates

Per the project's verify-the-API rule (`CLAUDE.md`), confirm each against the **installed** dependency version before relying on it — the design docs flag these explicitly:

- `@convex-dev/auth` — the `authTables` import path and the Convex Auth + Resend provider setup surface.
- `convex/server` — the `defineTable` / `v` validator surface used in the schema.
- `convex/server` crons — the `crons.ts` interval/cron API used by `scheduleSync` / `liveSync`.
- **Resend free-tier limits** (3,000/mo · 100/day) and **Convex free-tier function-invocation limit** vs a 15-min year-round `liveSync` (96 runs/day even when self-gated). Cheap fallback if it doesn't fit: restrict `liveSync` to in-season months via a cron expression (see [`weekly-loop.md`](./weekly-loop.md) §4).
- **nflverse `games` dataset** field names + `gameday`/`gametime` (ET) → UTC `kickoffAt` conversion; **ESPN scoreboard** `state` values.

## Out of scope (parked as future efforts)

Ruled beyond this single-season destination — return only as fresh efforts:

- **Notifications / reminders**, **social features** (chat, trash-talk).
- **Historical / multi-season stats & visualizations** (position graphs, past-year leaderboards).
- **Multi-league override of a global game** beyond the per-league `resultOverrides` already built.
- **Score-level result override** (corrects only the winner, not the tiebreaker's points total — a documented limitation, #12).
- **Commissioner transfer** (keeps the commissioner non-removable for the first loop).
- **A rules editor** (the 8 settings are first-class in the schema — buildable later with no migration — but editing is out of the first loop; natural future freeze point = week-1 lock).

## Definition of done for the map

When M6's end-to-end verification passes, the destination is reached: nothing is left to *decide*, and the app runs a full regular-season loop for a single real league. This ticket (#13) resolves when this spec is merged; the map is then complete.
