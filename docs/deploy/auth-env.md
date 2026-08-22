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
| **dev** (local) | `http://localhost:3000` | `hidden-reindeer-734` (shared) or a per-worktree local deployment | the worktree's Next dev origin | `npx convex env set` (per deployment; the other four come from project defaults) |
| **prod** | `https://ff-pickem.vercel.app` | `majestic-dalmatian-467` | `https://ff-pickem.vercel.app` | `npx convex env set --prod` (static; prod URL is stable) |
| **preview** (per branch) | `https://ff-pickem-git-<branch>-icoffiels-projects.vercel.app` | per-branch `*.convex.cloud` | dynamic per branch | **deferred** — see below |

## `SITE_URL` strategy

`SITE_URL` must equal the origin the browser actually visits, because the magic
link is built from it. Prod's URL is stable, so a single static value works and
is set directly on the prod deployment. Preview URLs are dynamic per branch, so
a static value cannot work there — that case is deferred (below).

**It must be the *assigned* production domain (`ff-pickem.vercel.app`), not the
*generated* project alias (`ff-pickem-icoffiels-projects.vercel.app`).** Under
Vercel's Standard Protection the generated alias is gated behind Vercel SSO
while the assigned domain is public (see below), so pointing `SITE_URL` at the
alias would send every invitee's magic link to a login wall they can't pass.

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

**Prod has its own keypair; all dev deployments share one.** Prod's key is never
reused for dev, and vice versa. Within dev the same pair is reused across every
deployment — it is a project default (below) — because dev session tokens are
low-value and per-deployment generation only adds a bootstrap step.

The pair is generated in the exact shape `@convex-dev/auth@0.0.94` produces
(`bin.cjs`: PKCS8 PEM with newlines replaced by spaces for `JWT_PRIVATE_KEY`;
`{"keys":[{"use":"sig",…publicJWK}]}` for `JWKS` — RSA-2048, `e=65537`), then
set with `--from-file` so the secret never lands in shell history. Equivalent
one-shot for a single deployment: `npx @convex-dev/auth` (interactive).

The dev keypair was **rotated on 2026-08-21** (#73): the previous one had been
printed into an agent session log, so a fresh pair was generated, seeded as the
dev project default, and written over the shared dev deployment. Prod was
untouched — it never held the leaked pair.

## Project env var defaults — dev (#73)

A brand-new dev deployment must be able to complete a sign-in without anyone
hand-seeding it. Convex supports **project-level default environment variables
per deployment type**, and the four Convex-side auth vars that are the same for
every dev deployment are set there:

| Default | Value |
| --- | --- |
| `JWT_PRIVATE_KEY` | shared dev private key (secret) |
| `JWKS` | matching public JWK set |
| `AUTH_EMAIL_TRANSPORT` | `console` |
| `AUTH_EMAIL_FROM` | `onboarding@resend.dev` |

```sh
npx convex env default list --type dev              # inspect
npx convex env default set NAME --from-file f.txt   # write a secret
```

They can also be edited under Project Settings in the Convex dashboard.

Two behaviours worth knowing, both verified against the CLI (`convex@1.42.3`)
rather than inferred from docs:

- Defaults apply to **local** deployments too, not only cloud ones. Creating one
  prints `Importing default env vars…` / `Imported 4 environment variables from
  default environment variables: …`.
- Defaults apply only to **newly created** deployments and are **not kept in
  sync** afterwards. Changing a default leaves existing deployments alone; they
  need `npx convex env set` (which is how the 2026-08-21 rotation reached the
  shared dev deployment).

**`SITE_URL` is deliberately not a default.** It must equal the origin the
browser actually visits, which differs per worktree/port, so a single project
value would be wrong for most deployments. It stays a per-deployment setting —
the one auth var a new dev deployment still has to be told about.

## Preview-deployment auth — deferred

Preview auth is **explicitly deferred**, to be bundled with CI/CD work (relates
to #30, the L3 CI gate). Captured plan for when it is picked up:

- Bridge Vercel's per-branch URL into a Convex env var inside the build command,
  e.g. `npx convex env set SITE_URL "https://$VERCEL_BRANCH_URL" && npx convex deploy --cmd 'npm run build'`. Vercel exposes `VERCEL_URL` / `VERCEL_BRANCH_URL`
  / `VERCEL_PROJECT_PRODUCTION_URL` as system env vars; they are **not** visible
  to the Convex runtime, so they must be written into Convex explicitly.
- `SITE_URL` is read at sign-in (runtime), so setting it after `convex deploy`
  is functionally fine.
- **Open question to verify first:** does `npx convex env set` during a Vercel
  build with a **preview** `CONVEX_DEPLOY_KEY` reliably target the correct
  per-branch deployment?
- **How the keys reach a preview is now answered** by the dev work in #73:
  `npx convex env default --type preview` seeds `JWT_PRIVATE_KEY`/`JWKS`/
  `AUTH_EMAIL_TRANSPORT`/`AUTH_EMAIL_FROM` into every newly created preview
  deployment, exactly as it does for dev. Only `SITE_URL` remains dynamic, which
  is what the build-command bridge above is for.

## Vercel Deployment Protection — which URLs are gated

The project has Vercel **Standard Protection** enabled. Verified anonymously
(no cookies) on 2026-07-21:

| URL | Type | Anonymous result |
| --- | --- | --- |
| `https://ff-pickem.vercel.app` | **assigned production domain** | **200 — public** |
| `https://ff-pickem-icoffiels-projects.vercel.app` | generated project alias | 302 → `vercel.com/sso-api` (gated) |
| `https://ff-pickem-git-<branch>-…vercel.app` | generated git/preview alias | 302 → gated |

Standard Protection gates the *generated* deployment URLs but leaves the
*assigned* production domain public — so the app **is** shareable via
`ff-pickem.vercel.app`, and previews stay protected (which is the desired
default). The practical rule this imposes: **`SITE_URL` and any shared link must
use `ff-pickem.vercel.app`, never the generated alias**, or the recipient hits
the SSO wall. Signed-in-to-Vercel operators pass the alias gate transparently,
which is why the gate is invisible when the owner tests the alias in their own
browser.

## Verifying prod auth (backend, no frontend needed)

The Convex side can be verified without the Vercel-gated frontend by invoking
the `signIn` action directly while tailing prod logs:

```
npx convex logs --prod            # in one shell
npx convex run --prod 'auth:signIn' '{"provider":"email","params":{"email":"you@example.com"}}'
```

A correctly configured deployment logs
`[auth] magic link for you@example.com: https://ff-pickem.vercel.app/?code=…`
— the public prod origin proves `SITE_URL`, the log line proves `console` transport,
and reaching the transport at all proves `AUTH_EMAIL_FROM` is set. A
misconfigured deployment instead throws `Missing environment variable SITE_URL`
at the `signIn` action. (This creates only a short-lived verification code, not
a `users` row — no cleanup needed as long as the link is not followed.)
