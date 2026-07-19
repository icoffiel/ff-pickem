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

- **Convex** — done automatically by `npx convex dev` (currently a **local**
  beta deployment). A **cloud** deployment is needed before deploying to Vercel
  (M0d) — run `npx convex deploy` / configure a cloud dev deployment then.
- **Resend** (M0a, issue #22) — create the account, add a sending domain,
  publish SPF/DKIM DNS records, record the API key as a Convex env var. **Start
  first** (DNS propagation lead time). Wired into auth in M1.
- **Vercel Hobby** (M0d, issue #25) — create the project, connect the repo, set
  `NEXT_PUBLIC_CONVEX_URL` + Convex env vars, deploy the skeleton.
