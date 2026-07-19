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

- **Convex** — **done.** Project `iain-coffield/ff-pickem`, with a deployment per
  environment:

  | Deployment | Reference | Backend | Used by |
  |---|---|---|---|
  | Development | `dev/iain` | `hidden-reindeer-734` | `npm run dev` (selected in `.env.local`) |
  | Production | default prod | `majestic-dalmatian-467` | `ff-pickem.vercel.app` |
  | Preview | `preview/<git-branch>` | created per branch | Vercel preview builds |

  Preview deployments are created automatically, **one per git branch**, named
  after the branch. Pushing again to the same branch reuses its backend, so data
  survives across pushes. They **expire after 5 days** on the Free/Starter plan
  ([docs](https://docs.convex.dev/production/multiple-deployments)) — merging or
  deleting a branch does not remove them immediately.

  Each preview starts with an **empty database and no environment variables**.
  From M1 onward, anything auth needs (`AUTH_EMAIL_FROM`,
  `AUTH_EMAIL_TRANSPORT`) must reach previews too, or auth will not work there.
  Convex supports **default environment variables for preview deployments**, and
  a `--preview-run <functionName>` flag to seed initial data
  ([docs](https://docs.convex.dev/production/hosting/vercel)) — both are for M1+,
  neither is configured yet.

  > An earlier **local** deployment (`.convex/local`) predates the cloud project
  > and is no longer selected. It was orphaned — the CLI could not resolve its
  > project — so commands failed until `--deployment` was passed explicitly.

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
  - The **only** variable configured in Vercel is `CONVEX_DEPLOY_KEY`, set once
    per environment (encrypted):
    - **Production** — a production deploy key, created with
      `npx convex deployment token create <name> --deployment <ref>`.
    - **Preview** — a *preview* deploy key. The CLI has no flag for these
      (as of `convex` 1.42.3); generate one from the Convex dashboard's
      **project** settings.

      > A deploy key generated from a **deployment's** settings page is scoped to
      > *that* deployment, so preview builds would push into it instead of
      > creating per-branch backends. Verify by checking a preview build log for
      > `[Preview] …:preview/<branch>` — a green build alone does not prove the
      > key is the right type.

  Preview URLs are gated by Vercel Deployment Protection (they return 302 to a
  login) — open them while signed in to the Vercel team.
  - `icoffiel/ff-pickem` is **connected** via the Vercel GitHub App: pushes to
    `main` deploy to production, and pull requests get preview deployments.
  - The build command lives in `vercel.json`, **not** in the Vercel dashboard
    (which still shows the `next build` default). Vercel reads `vercel.json`
    from the commit being built, so any branch missing that file would build
    without `convex deploy` — and would ship a frontend with no Convex URL.
