# M2 — League creation & the invite→membership flow (design)

**Status:** Design approved 2026-07-25. Spec for milestone **M2** ([#17](https://github.com/icoffiel/ff-pickem/issues/17)); depends on M1 (#16, closed). Authoritative domain sources: [`CONTEXT.md`](../../../CONTEXT.md), [`data-model.md`](../../design/data-model.md), [build-spec §"Auth & invite flow" + §M2](../../design/build-spec.md).

## Problem

A person can sign in (M1), but there is no league to play in and no way to bring others in. A commissioner needs to create their league and invite family members by email; an invited person needs to accept, choose a team name, and become a competing member — without duplicates, without joining a league they weren't invited to, and without a "pending member" limbo.

## Guiding decision: auth and invite are decoupled

**Auth stays 100% standard Convex Auth.** A person signs *themselves* in with *their own* email — the exact magic-link flow M1 built. We never send a magic link to another person's address and never trigger `signIn` server-side.

**Our server owns "may this person join this league?"** as ordinary domain logic. The invite is an app-level `invites` grant (own token + 14-day expiry), delivered as a **plain link** to `/invite/<token>` via our existing email transport seam (`resolveTransport`/`senderAddress`) — not the auth email.

**The email binding is the security boundary, not the token.** Redemption authorizes on `signed-in email == invite.targetEmail`. A leaked or forwarded token is therefore useless to anyone but the invited address; the token is only a convenient deep-link to the accept screen.

**Why this shape:** M1's lesson is that `convex-test` cannot drive real sign-in, so auth regressions are manual-only. By keeping the join/authorization logic *out* of the auth path, all of M2's business rules (`createInvite`, `redeem`, and their invariants) become pure server logic fully covered by `convex-test` via `t.withIdentity(...)`. The only thing that stays manual is the browser sign-in click-through — which was already manual.

**Consequence accepted on purpose:** a brand-new invitee takes two steps — click the invite link, then sign themselves in (a second email) — rather than one magic tap. For a private family league that is a fine, once-per-person cost.

## Architecture

No schema changes — M1 already shipped `leagues`/`memberships`/`invites`. M2 adds Convex functions and minimal, unstyled UI (visual pass is M6).

### Convex backend

| File | Exports | Responsibility |
|------|---------|----------------|
| `convex/config.ts` | `CURRENT_SEASON` (const), default `rules` const | Single-sourced constants. `CURRENT_SEASON = 2026` now; a one-line change or later promotion to a `createLeague` arg / admin setting is the only work to make season configurable. |
| `convex/leagues.ts` | `createLeague` (mutation), `myLeagues` (query) | League creation + the signed-in user's league list |
| `convex/invites.ts` | `createInvite` (mutation), `redeem` (mutation), `myPendingInvites` (query), `leagueRoster` (query) | Invite lifecycle + roster reads |
| `convex/inviteEmail.ts` | `sendInviteEmail` (**internalAction**) | Builds `SITE_URL/invite/<token>` and sends via the existing transport seam. Not client-exposed. |

`createInvite` is a **mutation** that transactionally writes the invite row, then `ctx.scheduler.runAfter(0, internal.inviteEmail.sendInviteEmail, {...})`. Invariant enforcement stays in the pure, testable mutation; the un-testable email I/O is isolated in the scheduled internal action.

### Frontend (Next.js App Router, unstyled like `SignInForm`)

| Route | Content |
|-------|---------|
| `app/page.tsx` (home) | Signed-in shell: "My leagues" list, "Create league" form, and pending-invite banners ("You're invited to X — Join") |
| `app/invite/[token]/page.tsx` | Accept screen: signed out → prompt normal sign-in with `redirectTo` back here; signed in → show league + team-name field → `redeem` |
| `app/leagues/[id]/page.tsx` | Roster: members + (commissioner-only) pending invites; commissioner sees the invite-by-email form |

## Auth contract (per function)

Every function resolves the caller via `getAuthUserId(ctx)` first.

| Function | Authn | Authz (beyond signed-in) | On failure |
|----------|-------|--------------------------|------------|
| `createLeague` | Required | none — any signed-in user may create | throw if not signed in |
| `myLeagues` (query) | Required | returns only leagues where caller has a membership | `[]` if signed out |
| `createInvite` | Required | caller must be an **active `commissioner`** of the target league | throw `NotCommissioner` |
| `myPendingInvites` (query) | Required | returns only `pending`, unexpired invites whose `targetEmail == ` caller's email | `[]` if signed out |
| `leagueRoster` (query) | Required | caller must be a **member** of the league; the pending-invites section returns only to a `commissioner` | throw / omit section |
| `redeem` | Required | caller's email must `==` `invite.targetEmail` | throw `EmailMismatch` |
| `sendInviteEmail` | n/a | `internalAction`, not client-exposed | — |

**Email normalization:** `targetEmail` is normalized (lowercase + trim) on write and the caller's email is normalized the same way on compare — our own boundary guard, consistent with the `@auth/core` homoglyph concern in the security backlog (#50).

## Flows

### Create league — `createLeague({ name, teamName })`
Signed-in check → insert `leagues` (name, `season` from `config`, embedded default `rules`, `createdAt`) → insert `memberships` (`role: "commissioner"`, `status: "active"`, `teamName`, `joinedAt`) → return `leagueId`. One atomic mutation realizes "the commissioner is the creator."

### Create invite — `createInvite({ leagueId, email })`
Authz commissioner → normalize email → if the email is already an **active** member, return `{ status: "alreadyMember" }` (no row written) → else walk `by_league_email`: mark any existing `pending` invite `superseded`, then insert a new `pending` invite (`token` via `crypto.randomUUID()`, `expiresAt = now + 14 days`, `createdAt`) → schedule `sendInviteEmail` → return `{ status: "invited", token }`.

### Redeem — `redeem({ token, teamName })`
Signed-in → load invite `by_token` → reject if not `pending`, or `now > expiresAt` (**lazy expiry** — redeem/reads are the enforcement point; no cron flips status) → assert caller's normalized email `==` `invite.targetEmail` → look up existing `(user, league)` via `by_league_user`:
- `removed` membership → reactivate (`status: "active"`, clear `removedAt`, update `teamName`);
- `active` membership → no-op (idempotent, story 18);
- none → insert born-active `member` membership.

Then mark the invite `accepted` → return `leagueId` for redirect.

### Home & roster
`app/page.tsx` composes `myLeagues` + `myPendingInvites`. `app/leagues/[id]/page.tsx` uses `leagueRoster`.

## Invariants & error handling

Enforced by hand in mutations (Convex has no unique constraints); each is a test case:

- **One live invite per (email, league):** `createInvite` supersedes any existing `pending` via `by_league_email` before inserting. Roster tolerates a rare race by showing the newest.
- **Reactivate, never duplicate:** `redeem` keys on `by_league_user`; there is never a second membership for the same `(user, league)`.
- **Email-binding:** redeem authorizes on normalized-email equality; a leaked token cannot be redeemed by another address.
- **Terminal states refuse clearly:** redeeming an `expired`/`superseded`/`revoked`/already-`accepted` invite throws a distinct named error the accept page renders as a friendly message. (`revoked` is *set* in M6; redeem *handles* it now.)
- **Role consistency:** only `createLeague` mints a `commissioner`; every redeemed membership is a `member`.

Mutations throw `ConvexError` with a stable `code` (`NotCommissioner`, `EmailMismatch`, `InviteExpired`, `InviteNotFound`, `AlreadyMember`) so the UI branches on code, not message text.

## Testing strategy

Test-first (TDD), all against `convex-test`, using `t.withIdentity(...)` to simulate signed-in callers:

- **`createLeague`:** creator becomes active commissioner; embedded rules equal the default; unauthenticated call rejected.
- **`createInvite`:** commissioner-only (member/outsider rejected); supersede leaves exactly one `pending`; `alreadyMember` short-circuit; token + 14-day expiry set; email send is *scheduled* (assert via the scheduler / mocked transport, not real delivery).
- **`redeem`:** happy path creates a born-active member with team name; email-mismatch rejected; expired/superseded/revoked/accepted each rejected with the right `code`; reactivate-removed and no-op-active each leave exactly one membership.
- **Queries:** `myLeagues`/`myPendingInvites`/`leagueRoster` scoping — you see only your own; pending invites hidden from non-commissioners.

**Stays manual (documented, not automated):** the end-to-end browser click-through — real sign-in → land on `/invite/<token>` → redeem → appear as an active member — because sign-in is the one seam `convex-test` can't drive. This mirrors the issue's own "verify" step. The email transport itself is already unit-tested from M1.

## Out of scope (later milestones)

- Invite **revocation** UI/action and member removal/un-remove — M6 (#21); `redeem` already handles the `revoked` state.
- Any picks / games / standings — M3–M5.
- Visual design, palette, typography — M6.
- Commissioner **transfer** — deferred; every invited person joins as `member`.
- Making `season` user-configurable — a deliberate seam is left, but M2 ships the fixed constant.

## Verify (milestone destination, from #17)

A second real email receives an invite, redeems it, and shows up as an active member with a team name; uniqueness + email-binding enforced in the mutations.
