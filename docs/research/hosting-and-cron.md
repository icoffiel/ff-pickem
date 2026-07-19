# Research: free-tier hosting + Postgres + scheduled grading job

**Issue:** [#4](https://github.com/icoffiel/ff-pickem/issues/4) — Research: free hosting + scheduled jobs for Next.js + Postgres
**Question:** What free-tier setup hosts a Next.js app + Postgres and runs a scheduled job (needed to auto-grade picks after NFL games finish)?

## Recommendation

**Vercel (Hobby) + Neon (Free) + GitHub Actions scheduled workflow.**

- **Host:** Vercel Hobby plan — deploys the Next.js app, free, generous function/build allowances ([vercel.com/docs/plans/hobby](https://vercel.com/docs/plans/hobby)).
- **Database:** Neon Free plan (via the Vercel Marketplace integration or standalone) — free Postgres with auto-suspend that wakes automatically in well under a second on the next query, even after long idle periods ([neon.com/pricing](https://neon.com/pricing), [neon.com/docs/introduction/scale-to-zero](https://neon.com/docs/introduction/scale-to-zero)).
- **Cron:** a **GitHub Actions scheduled workflow** (`schedule:` trigger, 5-minute minimum interval) that calls a protected Vercel API route (e.g. `POST /api/grade` guarded by a shared secret) to run the grading job — **not** Vercel's own Hobby-plan Cron Jobs feature, which is capped at once per day with up to ±59 minutes of jitter and therefore can't poll for final scores through a game day ([vercel.com/docs/cron-jobs/usage-and-pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), [docs.github.com — schedule event](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)).

Why this combination over the alternatives: Vercel's Hobby tier is the most generous Next.js-native free host (1M function invocations, 300s max function duration); Neon's free tier auto-wakes on connection (no manual step), unlike Supabase, which requires a **manual** dashboard/API restore once a project is paused; and GitHub Actions gives 5-minute-granularity, reliable-enough scheduling for free, which the app's own host cannot do on its free plan. Render and Railway were evaluated and rejected as the primary recommendation — see gotchas below.

## Next.js hosting — free tier comparison

### Vercel (Hobby plan)

Source: [vercel.com/docs/plans/hobby](https://vercel.com/docs/plans/hobby), [vercel.com/docs/functions/usage-and-pricing](https://vercel.com/docs/functions/usage-and-pricing)

- Free, but restricted to **non-commercial personal use** per Vercel's fair-use guidelines.
- Function limits: 4 Active-CPU-hours/month, 360 GB-hrs provisioned memory, **1,000,000 function invocations/month** included.
- **Vercel Function maximum duration: 300s (5 minutes)** on Hobby.
- Build: 2 build vCPUs, 8GB build memory, 32GB build disk.
- 100 deployments/day, 200 projects, up to 50 domains/project.
- Runtime logs retained only **1 hour** on Hobby (vs 1 day on Pro).
- Exceeding a usage limit generally locks that feature for up to 30 days (no overage billing without upgrading).

### Postgres hosting on Vercel

Vercel Postgres (the first-party product) is **discontinued**. Any existing Vercel Postgres databases were automatically migrated to Neon in December 2024; new projects must install a Postgres integration (Neon, Supabase, etc.) from the Vercel Marketplace. Source: [vercel.com/docs/postgres](https://vercel.com/docs/postgres) ("Vercel Postgres is no longer available... we automatically moved it to Neon in December 2024").

### Alternatives considered

**Netlify** — Free ("Starter") plan supports Scheduled Functions on all plans, including free, via the `schedule` config, using the same cron syntax down to hourly granularity out of the box; **scheduled functions have a hard 30-second execution limit** (background functions needed for longer jobs). Source: [docs.netlify.com/build/functions/scheduled-functions](https://docs.netlify.com/build/functions/scheduled-functions/). Netlify has no first-party Postgres offering, so a DB provider (Neon/Supabase) would still be needed regardless.

**Render** — Free web services **spin down after 15 minutes of no inbound traffic** and take about a minute to cold-start back up, which is disruptive for a user-facing app; 750 free instance-hours/month shared across the workspace. Source: [render.com/docs/free](https://render.com/docs/free). Render's own free Postgres is a bigger problem — see Postgres section below.

**Railway** — The "Free" tier is actually a **one-time $5 trial credit that expires after 30 days**; after that it reverts to a paid plan with just **$1/month of free credit**, which will not cover a persistent Postgres instance plus an always-on app. Source: [docs.railway.com/pricing/free-trial](https://docs.railway.com/pricing/free-trial). Not a durable free tier — ruled out.

## Postgres — free tier comparison

### Neon (recommended)

Source: [neon.com/pricing](https://neon.com/pricing), [neon.com/docs/introduction/scale-to-zero](https://neon.com/docs/introduction/scale-to-zero)

- Storage: 0.5 GB/project. Compute: 100 CU-hours/project/month (≈400 hrs at 0.25 CU).
- Autosuspend after **5 minutes** of inactivity, cannot be disabled on the Free plan.
- Reactivation is **automatic on the next connection/query** — typically well under 1 second (Neon states cold starts are commonly under 500ms), even after long idle periods; no manual "unpause" step is required. This matters directly for a scheduled grading job: a GitHub Actions run hitting the API on a Sunday will transparently wake the DB.
- Up to 100 projects/org, 10 branches/project, 6-hour point-in-time restore window (1GB cap), 5GB public egress/month, 1 manual snapshot.
- No credit card required; the free plan does not expire.

### Supabase

Source: [supabase.com/pricing](https://supabase.com/pricing), [supabase.com/docs/guides/platform/going-into-prod](https://supabase.com/docs/guides/platform/going-into-prod)

- 500MB database storage, 1GB file storage, 50,000 MAU, unlimited API requests, 5GB egress.
- Limited to **2 active free projects** per organization.
- **Free projects pause after 7 days of inactivity — and resuming requires a manual restore from the Supabase dashboard** (or API); there is no documented automatic wake-on-request. This is a real risk for a weekly pick'em app that may see low traffic mid-week: the DB could be paused and require a human to log in and click "restore" before the grading job or the app can run. This is the main reason Neon is preferred over Supabase for this project.

### Render Postgres

Source: [render.com/docs/free](https://render.com/docs/free), [render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90)

- Free Postgres is capped at 1GB storage and, critically, **expires 30 days after creation** (recently shortened from 90 days). There's a 14-day grace period to upgrade to a paid instance before Render deletes the database and all its data.
- No backups on the free tier.
- This makes Render Postgres unsuitable as a persistent free database for a season-long pick'em app without recurring manual renewal — ruled out.

## Scheduled jobs / cron — options compared

| Option | Minimum interval | Free? | Notes |
|---|---|---|---|
| **Vercel Cron Jobs (Hobby)** | **Once per day** (more frequent expressions fail at deploy time) | Yes, included | Timing has up to **±59 minutes of jitter** ("no assured timely invocation"); up to 100 cron jobs/project. Insufficient for polling live/finishing NFL games. Source: [vercel.com/docs/cron-jobs/usage-and-pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) |
| **GitHub Actions `schedule` trigger** (recommended) | 5 minutes (`*/5 * * * *`) | Yes — free for public repos; 2,000 min/month free for private repos on the Free plan | Can be delayed under GitHub-wide high load (esp. top-of-hour); **scheduled workflows auto-disable after 60 days with no repo activity** (re-enable manually). Calls out to a Vercel API route to trigger grading. Source: [docs.github.com — schedule event](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule), [docs.github.com — Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| **cron-job.org** (fallback) | 1 minute | Yes, donation-funded, no stated hard limits on job count | No formal SLA/uptime guarantee, but has run "millions of cronjobs/day" for 15+ years. Good fallback if the GitHub Actions 60-day auto-disable becomes an issue for a low-activity repo, or if finer-than-5-minute polling is ever needed. Source: [cron-job.org](https://cron-job.org/en/) |
| **Netlify Scheduled Functions** | Hourly cron presets out of the box (custom cron possible) | Yes, all plans | Hard **30-second execution limit** per invocation — workable for a lightweight "check scores and grade" call, but only if hosting is also moved to Netlify; not chosen since it doesn't improve on the Vercel+GitHub Actions combo. Source: [docs.netlify.com/build/functions/scheduled-functions](https://docs.netlify.com/build/functions/scheduled-functions/) |
| **Render Cron Jobs** | Sub-hourly expressions supported | **No** — cron jobs are a paid service type on Render; free instances are only available for static sites, web services, Postgres, and Key Value. Minimum $1/month per cron job. | Ruled out for a free-tier design. Source: [render.com/docs/cronjobs](https://render.com/docs/cronjobs) |

**Chosen cron approach:** GitHub Actions scheduled workflow, `*/15 * * * *` (or similar) during the NFL window, calling a secret-guarded Vercel API route (e.g. `POST /api/cron/grade` with a bearer token checked against an env var) that queries for newly-final games and grades picks. This is free, gives real minute-level granularity (vs. Vercel Hobby's daily-only cron), and keeps the trigger logic in the same repo as the app code.

## Gotchas a weekly-loop design must respect

1. **Vercel Hobby cron cannot poll intra-day.** Once-per-day only, with up to ~1 hour of jitter — don't rely on it for "check every N minutes on game day." Use the GitHub Actions trigger instead, and treat Vercel Cron (if used at all) only for a once-daily catch-all/cleanup job. ([source](https://vercel.com/docs/cron-jobs/usage-and-pricing))
2. **Vercel Function timeout is 300s (5 min) on Hobby.** Any single grading invocation (e.g., a full-league re-grade) must complete inside that window; chunk work if needed. ([source](https://vercel.com/docs/functions/usage-and-pricing))
3. **Neon free compute suspends after 5 minutes idle.** The first request after idle time pays a sub-second wake cost — negligible for a cron-triggered grading job, but worth knowing if timing SLAs ever get tight. ([source](https://neon.com/docs/introduction/scale-to-zero))
4. **GitHub Actions schedules silently disable after 60 days of no repository activity** (commits/PRs) on the default branch — if the app goes dormant in the off-season, the cron will stop firing and needs a manual "re-enable" click when the season restarts. Plan for an off-season checklist item. ([source](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule))
5. **GitHub Actions cron timing isn't exact**, especially at the top of the hour when GitHub-wide load is highest; avoid scheduling exactly on `:00` and stagger minutes instead. ([source](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule))
6. **Do not use Supabase or Render for the database** in this design: Supabase free projects pause after 7 days of inactivity and need a **manual** dashboard restore (no auto-wake), and Render's free Postgres **expires outright after 30 days**. Either would silently break a weekly grading loop during a bye week or slow stretch of the season. ([Supabase source](https://supabase.com/docs/guides/platform/going-into-prod), [Render source](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90))
7. **Vercel Hobby plan terms restrict use to non-commercial personal projects.** Fine for a friends-league pick'em app; worth flagging if this ever monetizes. ([source](https://vercel.com/docs/plans/hobby))
8. **Secure the cron trigger endpoint.** Since the grading job is invoked over a public HTTPS API route (from GitHub Actions rather than Vercel's own authenticated cron mechanism), the route must check a shared secret/bearer token — it's an unauthenticated-by-default public URL otherwise.
