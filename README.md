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
- A Convex account with access to the `iain-coffield/ff-pickem` project, logged
  in on this machine (`npx convex login`). `npm run setup:worktree` registers
  this worktree's deployment with that project.

## Setup & running

```bash
npm install

# Gives this checkout its own isolated Convex backend: provisions a local
# deployment, pins a Next dev port, and sets SITE_URL to match. Non-interactive
# and safe to re-run.
npm run setup:worktree

# Boots the Next.js app and the Convex backend in parallel.
npm run dev
```

Open the URL `npm run setup:worktree` printed (http://localhost:3000 in the first
checkout) — the landing page shows **`pong`** fetched live from the `ping` Convex
query, proving the round-trip.

Run `npm run setup:worktree` **once per checkout or git worktree**. Each one gets
its own backend, so two branches can run at the same time without sharing a
schema or a row — copying `.env.local` across from another checkout is exactly
what it exists to avoid.
[`docs/deploy/worktree-backends.md`](./docs/deploy/worktree-backends.md) covers
the rest: why local is the default and its beta limits, when to reach for a cloud
dev deployment instead, and how to tear a worktree's backend down.

`npm run dev` runs `next dev` and `convex dev` together (via `npm-run-all2`).
`.env.local` is written by Convex and by the setup command, and is git-ignored;
see [`.env.example`](./.env.example) for the variables.

## Orca worktrees

[`orca.yaml`](./orca.yaml) at the repo root declares the setup command as a
worktree hook:

```yaml
scripts:
  setup: npm run setup # npm install, then setup:worktree
```

Orca runs that inside each newly created worktree, so a worktree made through
Orca arrives with dependencies installed and a Convex backend of its own. The
file is committed, so it travels with the repo and works on any machine for
anyone, rather than living in one person's Orca settings.

**One switch, once per machine.** Orca's per-repo `commandSourcePolicy` decides
where the setup command comes from, and a repo that was configured with a
*local* setup command before `orca.yaml` existed keeps using that one and
ignores this file entirely. Changing it is UI-only — no `orca` CLI command
writes this setting:

> Sidebar → hover the repo → ⋯ → **Project Settings** → **Worktree Hooks** →
> **Command source** → `orca.yaml only`, then clear the local **Setup Script**
> box.

Read the setting back rather than trusting the UI selection:

```sh
orca repo list --json   # this repo's entry should show "commandSourcePolicy": "shared-only"
```

A repo Orca has never been given a local setup command for needs none of this:
it defaults to `shared-only` and picks up `orca.yaml` on its own.
[`docs/deploy/worktree-backends.md`](./docs/deploy/worktree-backends.md#running-it-automatically-orca)
covers the rest, including the 2-minute hook timeout and what to do when the
first worktree on a new machine overruns it.

Outside Orca — a plain `git clone` or `git worktree add` — nothing runs the hook
for you; that is what [Setup & running](#setup--running) is for.

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | `npm install` + `setup:worktree`. One command for a fresh checkout. |
| `npm run setup:worktree` | Provisions this worktree's own Convex backend. Run once per checkout. |
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

- **Resend** (issue #22) — **deferred to go-live by decision.** A sending
  domain is not worth registering for an app that may never carry real users,
  so #22 is a go-live step under M6 (#21) rather than setup work.
  Without a verified domain, Resend's shared `onboarding@resend.dev` sender
  returns a 403 for any recipient other than the Resend account holder's own
  address ([Resend error reference](https://resend.com/docs/api-reference/errors)).
  A `.vercel.app` subdomain cannot be verified — SPF/DKIM require writing
  records into a DNS zone, and that zone belongs to Vercel.
  What this blocks is **narrow**: delivering real email to real third parties.
  It is not a milestone blocker. The development path is the console transport
  (#33, shipped) — the magic link is written to the server console instead of
  sent, so any address (`alice@example.com`) can sign in locally:

  ```sh
  npx convex env set AUTH_EMAIL_TRANSPORT console
  npx convex env set AUTH_EMAIL_FROM onboarding@resend.dev
  ```

  On a **dev** deployment you do not have to run those: both, plus
  `JWT_PRIVATE_KEY` and `JWKS`, are the project's default environment variables
  for the `dev` deployment type (#73), so a newly created dev deployment —
  cloud or local — imports them and can sign in immediately. `SITE_URL` is the
  one auth var still set per deployment. See `docs/deploy/auth-env.md`.

  Start sign-in, then copy the `[auth] magic link for …` line out of the
  `convex dev` output and open it. `console` is also the default when
  `AUTH_EMAIL_TRANSPORT` is unset — **production must set `resend`
  explicitly**, or links go to the deployment log instead of to users.
  - **M1 (auth) is unblocked**: develop against the console transport; the
    Resend transport is verified once against your own address on `resend.dev`.
  - **M2 (invites) is unblocked too**: the send boundary is stubbed in tests
    (see #17), so invite creation, supersession, email-binding, expiry and the
    reactivate-not-duplicate branch are all buildable and testable without a
    domain. M2's flows are driven end to end using the console transport.
  - **A domain is needed only at go-live** — the first time a real league
    member must receive a real invite in a real inbox. That is the point to
    register one and complete #22; allow for DNS propagation lead time. Until
    then no milestone waits on it.
  - Untested shortcut worth five minutes when the Resend account is created:
    whether plus-addressing (`you+alice@gmail.com`) satisfies Resend's
    own-address check. If it does, real multi-recipient inbox testing is
    available on the free tier with no domain at all. Confirm before relying
    on it.
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
