# ADR 0001 — Server-side authorization for all Convex functions

**Status:** Accepted (2026-07-24)

## Context

We decided to make the repository **public** (to unlock free GitHub branch
protection / rulesets so the CI gate — [#30](https://github.com/icoffiel/ff-pickem/issues/30) —
can be a _required_ status check). Before flipping, we ran a security review of
the `convex/` backend to confirm nothing grants unauthorized data access, since
public code removes security-by-obscurity.

### Review findings (2026-07-24)

Audited every file under `convex/` (excluding `_generated/` and tests).

- **The entire client-callable data surface today is one function: `users.me`.**
  There are no mutations, no queries over the domain tables
  (`leagues`, `memberships`, `invites`, `picks`, `games`,
  `tiebreakerGuesses`, `resultOverrides`), no Next.js route handlers, and no
  server actions. The app is auth-only (M0/M1); the domain tables exist in the
  schema but nothing reads or writes them yet.
- **`users.me` is correctly gated.** It derives identity from the session via
  `getAuthUserId(ctx)` (never from a caller argument), returns `null` when
  unauthenticated, and discloses only the caller's own `email`. No IDOR, no
  anonymous data, minimal disclosure.
- **Auth wiring is standard Convex Auth.** RS256 session JWTs validated via
  `auth.config.ts` (issuer = `CONVEX_SITE_URL`, audience `convex`).
  Magic-link uses `authorize: undefined` (token-alone sign-in, by design for
  the cross-browser copy-link flow) — the link _is_ the credential.
- **No secret values are committed** in the working tree or anywhere in git
  history (verified by pattern + high-entropy scan). Only variable _names_ and
  placeholders appear; the `-----BEGIN PRIVATE KEY-----` in the auth tests is
  generated at runtime by `crypto.subtle.generateKey`, not a real key.

**Conclusion:** there is no present unauthorized-access vector. The security of
this app is a _forward-code_ problem: every future data function must authorize,
or the "anyone can access" risk becomes real once features ship.

## Decision

1. **The repository is public.** The security review found no committed secrets
   and no data-leaking function.
2. **Every Convex function that touches a domain table MUST authorize
   server-side.** The following rules are mandatory for all new functions and
   are the acceptance bar for reviewing M1+ backend work:

   1. **Derive identity server-side.** Use `getAuthUserId(ctx)`. Never trust a
      `userId` / `membershipId` argument as proof of who the caller is.
   2. **Membership-gate every league read/write.** Look up the caller's
      `memberships` row via the `by_league_user` index and reject when it is
      absent or `status: "removed"`. A valid `leagueId` alone must never grant
      access.
   3. **Role-gate commissioner actions** (`resultOverrides`, invites, member
      removal). Check `role === "commissioner"` for _that_ league, not globally.
   4. **Validate cross-references.** A `pick` must belong to the caller's own
      membership; an `invite` token check must be single-use and constant-effort.
   5. **Enforce `pickVisibility` in the query.** `hiddenUntilLock` /
      `alwaysHidden` must be filtered server-side, never merely hidden in the UI.

3. **Production email transport must be `resend`, never `console`.**
   `AUTH_EMAIL_TRANSPORT` defaults to `console`, which writes the magic link to
   the server log instead of emailing it — in prod that would let anyone with
   log access sign in as any address. Prod is configured to `resend`; keep it
   that way.

## Consequences

- The CI gate (#30) can now be a **required** status check on `main`
  (branch protection), closing the "a failing PR cannot merge" acceptance
  criteria.
- All code, docs, and GitHub Issues/PRDs are now world-readable. Deployment
  identifiers already shipped in the client bundle (`NEXT_PUBLIC_CONVEX_URL`,
  the `.convex.site` origin) are public by design and are not secrets; access is
  gated by auth tokens, not URL secrecy.
- Reviewers of any M1+ PR that adds a mutation or a domain-table query should
  treat the five authorization rules above as a checklist and block on gaps.
- Re-run a security review at the end of the first milestone that ships
  mutations, when there is a real authorization surface to test.
