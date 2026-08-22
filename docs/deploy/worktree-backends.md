# A Convex backend per worktree

A fresh git worktree has no Convex configuration at all. Both `.env.local` and
`.convex/` are git-ignored, so nothing carries across from the checkout you made
it from, and `npm run dev` has no backend to talk to.

The tempting fix — copying `.env.local` over from the main checkout — is the
wrong one. It points two branches at the same shared dev deployment, where
divergent schemas and data quietly stomp on each other: the branch that pushes
last owns the schema, and both branches read each other's rows.

## The one command

```sh
npm run setup:worktree
```

Non-interactive (no prompts, so an agent can run it) and safe to re-run: each
step checks for the state it would create before creating it. It does three
things.

| Step | What it does | Where it lands |
| --- | --- | --- |
| 1 | Creates a **local** deployment for this directory and selects it | `.convex/`, and `CONVEX_DEPLOYMENT` + the `NEXT_PUBLIC_*` URLs in `.env.local` |
| 2 | Pins a free Next dev port for this worktree | `PORT` in `.env.local` |
| 3 | Sets `SITE_URL` on the deployment to this worktree's dev origin | the deployment's environment variables |

Then `npm run dev` works end to end, magic-link sign-in included. Nothing it
writes is committed — see [Teardown](#teardown) for what to remove.

The other four Convex-side auth variables are not set here: `JWT_PRIVATE_KEY`,
`JWKS`, `AUTH_EMAIL_TRANSPORT` and `AUTH_EMAIL_FROM` are project **default
environment variables** for the `dev` deployment type, so a newly created
deployment imports them at creation. `SITE_URL` cannot be one of them, because
it differs per worktree. See [`auth-env.md`](./auth-env.md).

The command needs the team and project slugs, because a worktree with no
configuration has nothing to infer them from. They are baked in as
`iain-coffield` / `ff-pickem` and can be overridden with the `CONVEX_TEAM` and
`CONVEX_PROJECT` environment variables.

### Running it automatically (Orca)

`orca.yaml` at the repo root declares it as a worktree setup hook:

```yaml
scripts:
  setup: npm run setup # npm install, then setup:worktree
```

Orca runs that inside each newly created worktree, so a worktree made through
Orca arrives with dependencies installed and a backend of its own. The file is
committed, so it travels with the repo rather than living in one person's Orca
settings.

Two things to know if it does not fire:

- **A repo already configured with a local setup command wins.** Orca's
  per-repo `commandSourcePolicy` decides where the command comes from:
  `shared-only` (this file), `local-only` (the machine's own setting — this file
  is then ignored entirely), or `run-both`. A repo with no local setup command
  defaults to `shared-only` and picks this up on its own; one that was
  configured with a local command before this file existed keeps using it until
  the policy is changed in Orca's repo settings.
- **Hooks get 2 minutes.** Fine once Convex's local backend binary is cached for
  the machine; the very first worktree on a new machine also downloads it and
  can overrun, which kills the hook part-way. Re-running `npm run setup` by hand
  finishes it — every step is idempotent.

Outside Orca — a plain `git clone` or `git worktree add` — nothing runs it for
you; that is what the README's setup step is for.

## Why local is the default

A **local** deployment runs on your machine: the whole database is a SQLite file
under `.convex/local/default/`, inside the worktree.

- **It is free.** Function calls and database bandwidth on a local deployment do
  not count against the Convex plan's quotas
  ([docs](https://docs.convex.dev/cli/local-deployments)).
- **An idle worktree costs nothing.** The backend runs only as a subprocess of
  `convex dev`, so a worktree you are not developing in is not running anything
  — in particular its crons (`convex/crons.ts`: a six-hourly nflverse schedule
  sync and a fifteen-minute ESPN live sync) are not ticking in the background
  against someone else's endpoints.
- **Ports look after themselves.** The CLI probes upward from 3210 for a free
  pair on every start, persists what it picked, and derives the client URL from
  it — so several worktrees run concurrently with no port configuration. The
  second worktree lands on 3212/3213, the third on 3214/3215.
- **The state is genuinely per-worktree.** It lives in the worktree's own
  `.convex/`, not in a shared location keyed by project, so a schema change in
  one branch cannot reach another.

### The pinned Next port

Convex's ports take care of themselves; Next's do not. `SITE_URL` has to equal
the origin the browser actually visits, because the magic link is built as
`${SITE_URL}/?code=…` and opened there. If Next were left to its own devices the
second worktree would silently fall back from 3000 to 3001 while its `SITE_URL`
still said 3000, and its sign-in links would open the *other* worktree's app.

So the port is pinned once, at bootstrap, into `PORT` in `.env.local`. Next's
CLI reads `PORT` from the environment *before* it loads `.env.local`, so
`dev:frontend` goes through `dotenv -e .env.local -- next dev` to put it there
first. The Playwright config reads the same value, so `npm run test:e2e` visits
the origin its magic links point at.

Choosing the port asks two questions, not one. "Is anything listening?" only
finds the worktrees that happen to be running, and a pin has to hold while a
worktree is stopped — so the ports the *other* checkouts have already recorded
in their own `.env.local` are read first, with `git worktree list` naming them.
That is also what catches a copied `.env.local`: its `PORT` belongs to the
checkout it came from, so bootstrap replaces it instead of pinning a duplicate.

If that port is taken when you start `npm run dev` — something else grabbed it
since bootstrap — Next fails loudly rather than drifting to another port. Delete
the `PORT` line from `.env.local` and re-run `npm run setup:worktree` to pin a
new one.

### Beta limits worth knowing

Local deployments are a beta feature, and
[the docs](https://docs.convex.dev/cli/local-deployments) name three limits that
matter here:

- **No public URL.** A local deployment cannot receive external HTTP requests,
  and no browser other than one on this machine can reach it.
- **Node actions run directly on your computer**, with unrestricted filesystem
  access. Queries, mutations and Convex-runtime actions still run isolated.
- **Logs are cleared** every time `npx convex dev` restarts. The e2e suite works
  around this by teeing the `convex dev` output to a file (`e2e/global-setup.ts`).

## When you need a cloud dev deployment instead

Reach for a cloud dev deployment when the thing you are building needs something
local cannot give it:

- **Inbound public HTTP** — a webhook, or any third party that has to call your
  deployment back. Local has no public URL; a proxy such as ngrok is the other
  way around it.
- **Reachability from elsewhere** — another device, or someone else's browser,
  looking at your branch.
- **Uptime while your machine is off** — a local backend exists only while
  `convex dev` runs.

The Convex dashboard is *not* on that list: the hosted dashboard can open a
local deployment — the bootstrap output prints its URL, and
`npx convex dashboard --deployment local`
([docs](https://docs.convex.dev/cli/reference/dashboard)) opens it — as long as
the backend is running and the browser is on this machine.

Create one scoped to the worktree, with an expiration, and select it:

```sh
npx convex deployment create iain-coffield:ff-pickem:dev/<branch> \
  --type dev --expiration "in 7 days" --select
npm run setup:worktree -- --cloud   # pins the port, sets SITE_URL on that deployment
```

`--cloud` is required, and deliberately awkward. Without it, `setup:worktree`
refuses to configure an already-selected non-local deployment, because from
inside the worktree a cloud deployment you chose on purpose is indistinguishable
from one inherited in a copied `.env.local` — and writing `SITE_URL` to a
*shared* deployment would point everyone else's magic links at your machine. It
does not start a `convex dev` session for a cloud deployment either, so it will
not push your branch's functions as a side effect of configuring it.

The expiration is the point: every deployment counts against the team's
deployment limit ([docs](https://docs.convex.dev/production/multiple-deployments)),
so an expiry stops abandoned branches from accumulating deployments nobody
remembers creating. It accepts `"in 7 days"`, a UTC datetime, a Unix timestamp,
or `"none"`, and must be between 30 minutes and a year out. `--expiration` is
rejected when creating a *local* deployment.

Being a `dev`-type deployment, it imports the same four auth defaults at
creation, so only `SITE_URL` is left to set.

## Teardown

Removing a worktree does not remove its deployment. Teardown is two steps, and
only the first is local.

```sh
rm -rf .convex .env.local     # this worktree's backend state and its selection
```

That deletes the SQLite database, the admin key and the deployment selection.
The **deployment record stays registered with the project** and still counts
against the team's deployment limit, so delete it too:

- **Dashboard** — open the project's deployment settings and delete it by name
  (`local-iain_coffield-ff_pickem-<n>` for a local one). This is the practical
  route: `npx convex deployment` has `select`, `create` and `token`, and no
  delete.
- There is also a management API endpoint,
  `POST /deployments/:deployment_name/delete`
  ([docs](https://docs.convex.dev/management-api/delete-deployment)), if you ever
  need to script it. It is irreversible and takes the data with it.

A cloud dev deployment created with `--expiration` cleans itself up on schedule,
which is why it is worth setting one.
