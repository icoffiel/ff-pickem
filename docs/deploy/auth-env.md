# Auth environment configuration per deployment

How Convex Auth (#16/#39) is configured across the three deployment tiers, why
each value is what it is, and how to reproduce it. Resolves #42.

Convex Auth reads five backend env vars. They are **Convex** env vars (set with
`npx convex env set`), not Vercel/Next env vars, because they are read by Convex
functions at runtime:

| Var | Purpose | Secret |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` | RS256 private key Convex Auth signs session JWTs with (PKCS8 PEM, newlines→spaces) | yes |
| `JWKS` | Public JWK set the backend validates those JWTs against | no (public key) |
| `SITE_URL` | Origin the magic link points at — the link is built as `${SITE_URL}/?code=…` and opened in the browser to exchange the code for a session | no |
| `AUTH_EMAIL_TRANSPORT` | `console` (link → server log) or `resend` (real email) | no |
| `AUTH_EMAIL_FROM` | Magic-link sender address. Required even under `console` (our `auth.ts` reads it before dispatching) | no |

`auth.config.ts` additionally declares the JWT issuer via the auto-set
`CONVEX_SITE_URL` — it is committed and needs no per-deployment config.

## The three tiers

| Tier | Browser URL | Convex deployment | `SITE_URL` value | How `SITE_URL` is set |
| --- | --- | --- | --- | --- |
| **dev** (local) | `http://localhost:3000` | `hidden-reindeer-734` | `http://localhost:3000` | `npx convex env set` (once) |
| **prod** | `https://ff-pickem-icoffiels-projects.vercel.app` | `majestic-dalmatian-467` | `https://ff-pickem-icoffiels-projects.vercel.app` | `npx convex env set --prod` (static; prod URL is stable) |
| **preview** (per branch) | `https://ff-pickem-git-<branch>-icoffiels-projects.vercel.app` | per-branch `*.convex.cloud` | dynamic per branch | **deferred** — see below |

## `SITE_URL` strategy

`SITE_URL` must equal the origin the browser actually visits, because the magic
link is built from it. Prod's URL is stable, so a single static value works and
is set directly on the prod deployment. Preview URLs are dynamic per branch, so
a static value cannot work there — that case is deferred (below).

## Delivery (transport) decision

- **dev:** `console`. Any address signs in; the link is read from the local
  `convex dev` log (the e2e suite tails it — `e2e/magic-link.ts`).
- **prod:** `console` (chosen 2026-07-21). Zero real sends; the link is written
  to the **prod Convex dashboard logs**. Proves sign-in works end-to-end and
  keeps prod from emailing before a sending domain exists. `AUTH_EMAIL_FROM` is
  set to `onboarding@resend.dev` as a required-but-unused placeholder; no
  `RESEND_API_KEY` is needed under `console`.
  - **Flip to `resend` once #22 verifies a sending domain** — then invited
    family members (M2) receive real email instead of an operator reading logs.
    That is a two-var change (`AUTH_EMAIL_TRANSPORT=resend`, plus
    `RESEND_API_KEY`) and a `AUTH_EMAIL_FROM=noreply@<domain>` swap, no code.

## JWT keypair

Each deployment gets its **own fresh** RS256 keypair — dev's key is never reused
for prod. The pair is generated in the exact shape `@convex-dev/auth@0.0.94`
produces (`bin.cjs`: PKCS8 PEM with newlines replaced by spaces for
`JWT_PRIVATE_KEY`; `{"keys":[{"use":"sig",…publicJWK}]}` for `JWKS`), then set
via `npx convex env set --prod --from-file` so the secret never lands in shell
history. Equivalent one-shot: `npx @convex-dev/auth --prod` (interactive).

## Preview-deployment auth — deferred

Preview auth is **explicitly deferred**, to be bundled with CI/CD work (relates
to #30, the L3 CI gate). Captured plan for when it is picked up:

- Bridge Vercel's per-branch URL into a Convex env var inside the build command,
  e.g. `npx convex env set SITE_URL "https://$VERCEL_BRANCH_URL" && npx convex deploy --cmd 'npm run build'`. Vercel exposes `VERCEL_URL` / `VERCEL_BRANCH_URL`
  / `VERCEL_PROJECT_PRODUCTION_URL` as system env vars; they are **not** visible
  to the Convex runtime, so they must be written into Convex explicitly.
- `SITE_URL` is read at sign-in (runtime), so setting it after `convex deploy`
  is functionally fine.
- **Open questions to verify first:** (1) does `npx convex env set` during a
  Vercel build with a **preview** `CONVEX_DEPLOY_KEY` reliably target the correct
  per-branch deployment? (2) key strategy for ephemeral previews — shared
  keypair vs per-deployment, and how `JWT_PRIVATE_KEY`/`JWKS` reach them (Convex
  dashboard "Preview default environment variables"?).

## Known blocker: Vercel Deployment Protection

As of 2026-07-21 the prod URL 302-redirects to `vercel.com/sso-api?url=…`, i.e.
**Vercel Authentication (Deployment Protection) is enabled** on the project. The
app is therefore **not reachable — or shareable — without a Vercel login**, and
a real browser sign-in cannot complete until it is disabled.

The Convex auth backend is fully configured and verified independent of this
gate (see below); turning the protection off is a Vercel dashboard setting
(Project → Settings → Deployment Protection) owned by the project owner.

## Verifying prod auth (backend, no frontend needed)

The Convex side can be verified without the Vercel-gated frontend by invoking
the `signIn` action directly while tailing prod logs:

```
npx convex logs --prod            # in one shell
npx convex run --prod 'auth:signIn' '{"provider":"email","params":{"email":"you@example.com"}}'
```

A correctly configured deployment logs
`[auth] magic link for you@example.com: https://ff-pickem-icoffiels-projects.vercel.app/?code=…`
— the prod origin proves `SITE_URL`, the log line proves `console` transport,
and reaching the transport at all proves `AUTH_EMAIL_FROM` is set. A
misconfigured deployment instead throws `Missing environment variable SITE_URL`
at the `signIn` action. (This creates only a short-lived verification code, not
a `users` row — no cleanup needed as long as the link is not followed.)
