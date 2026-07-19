# NFL Pick'em

A private NFL pick'em league app. See [`CONTEXT.md`](./CONTEXT.md) for the domain
glossary and [`docs/design/build-spec.md`](./docs/design/build-spec.md) for the
build plan (milestones M0–M6).

This is **M0 — the project skeleton**: a Next.js (App Router) app wired to a
Convex backend, proving a full client↔backend round-trip via a throwaway `ping`
query. No schema, auth, or domain logic yet — those are M1+.

## Stack

| Layer | Choice | Installed version |
|---|---|---|
| Frontend | Next.js (App Router) | 16.2.10 |
| UI runtime | React | 19.2.7 |
| Backend + datastore | Convex | 1.42.3 |
| Language | TypeScript | 5.9.3 |
| Test runner | Vitest | 4.1.10 |
| Convex fn test seam | convex-test | 0.0.54 |

> **Version-pinning note (verify-the-API rule):** `typescript@latest` currently
> resolves to the 7.x native compiler, which Next 16's internal TypeScript
> integration does not yet support (the build reports TS as "not installed" and
> crashes). TypeScript is therefore pinned to `^5`. `@convex-dev/auth` is **not**
> installed yet — it arrives in M1; confirm its `authTables` import path and the
> Resend provider surface against the version installed then.

## Prerequisites

- Node.js 20+ and npm.
- A Convex account (the local dev flow below provisions a project on first run).

## Setup & running

```bash
npm install

# One command boots both the Next.js app and the Convex backend in parallel.
# On the very first run, Convex provisions a dev deployment and writes
# .env.local with NEXT_PUBLIC_CONVEX_URL — follow its prompts.
npm run dev
```

Open http://localhost:3000 — the landing page shows **`pong`** fetched live from
the `ping` Convex query, proving the round-trip.

`npm run dev` runs `next dev` and `convex dev` together (via `npm-run-all2`).
`.env.local` is written by Convex and is git-ignored; see
[`.env.example`](./.env.example) for the variables.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server + Convex backend, in parallel. |
| `npm test` | Runs Vitest (the `convex-test` suite). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | Production build. |

## Testing

Convex functions are tested through the **`convex-test`** seam — in-process, no
deployment, no browser (`convex/ping.test.ts`). Vitest runs on the
`edge-runtime` environment to match the Convex runtime (`vitest.config.ts`).
This is the pattern every later milestone (M2/M4/M5) reuses for its own
functions and pure derivations.

## Account provisioning status (M0)

M0 also provisions three external services. Code is service-agnostic; the
accounts are set up by a human:

- **Convex** — **done.** Local development still runs against the **local** beta
  deployment written into `.env.local` by `npx convex dev`. A separate **cloud
  production** deployment (`iain-coffield:ff-pickem:production`) backs the Vercel
  deploy; it is the default target of `npx convex deploy` and is not selected
  locally, so the two do not interfere.
- **Resend** (M0a, issue #22) — **deferred: no sending domain owned yet.**
  Without a verified domain, Resend's shared `onboarding@resend.dev` sender
  returns a 403 for any recipient other than the Resend account holder's own
  address ([Resend error reference](https://resend.com/docs/api-reference/errors)).
  A `.vercel.app` subdomain cannot be verified — SPF/DKIM require writing
  records into a DNS zone, and that zone belongs to Vercel.
  - **M1 (auth) is unblocked**: build and test the magic-link flow against your
    own email on `resend.dev`.
  - **M2 (invites) is blocked**: inviting real league members means emailing
    other people, which needs a verified domain. Buy one and complete this
    issue before M2 — allow for DNS propagation lead time.
- **Vercel Hobby** (M0d, issue #25) — project `icoffiels-projects/ff-pickem`,
  live at [ff-pickem.vercel.app](https://ff-pickem.vercel.app). No custom domain
  (deferred to go-live).
  - **Do not set `NEXT_PUBLIC_CONVEX_URL` in Vercel.** The build command in
    [`vercel.json`](./vercel.json) is `npx convex deploy --cmd 'npm run build'`,
    which sets that variable itself from the deploy key's target deployment,
    then runs the Next.js build, then pushes backend code
    ([Convex hosting docs](https://docs.convex.dev/production/hosting/vercel)).
    Hard-coding the URL would pin the build to a stale deployment.
  - The **only** variable configured in Vercel is `CONVEX_DEPLOY_KEY`
    (Production scope, encrypted), created via
    `npx convex deployment token create <name> --deployment <ref>`.
  - `icoffiel/ff-pickem` is **connected** via the Vercel GitHub App: pushes to
    `main` deploy to production, and pull requests get preview deployments.
  - The build command lives in `vercel.json`, **not** in the Vercel dashboard
    (which still shows the `next build` default). Vercel reads `vercel.json`
    from the commit being built, so any branch missing that file would build
    without `convex deploy` — and would ship a frontend with no Convex URL.
