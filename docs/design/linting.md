# Linting & formatting — design

**Status:** Agreed design (via a `/grill-me` session, 2026-07-19). Tooling effort, M0-adjacent: it hardens the skeleton before feature milestones (M1+) start generating volume. Not part of the build-spec map (#1) — a standalone tooling track.

This doc records the *decisions* and their rationale so an execution session can build the setup without re-deriving them. It packages decisions; it does not carry the build. The build sequence at the end maps to the tickets.

## Purpose

Catch real bugs **and** kill formatting churn, tuned for a codebase that is largely **agent-authored**. Two framings, in priority order:

1. **Correctness is the payload.** `tsc --noEmit` already gates types. A linter earns its keep only on the layer *above* types — and the highest-value rule for this app is **`no-floating-promises`**: an un-awaited Convex mutation (`ctx.db.insert`, a scheduler call) silently no-ops, which in this domain means picks that don't save or locks that don't enforce. That bug class is invisible to the type-checker and to a passing test that never awaits.
2. **Formatting is the cheap bonus.** Consistent layout stops churn in agent-generated diffs and ends style debates. Low value per unit, but near-free once the tooling is present.

## The stack decision

**Two tools: ESLint 9 (flat config) + Prettier.** Chosen over Biome (one fast Rust tool, lint+format) specifically to keep **Next.js-specific lint rules** (`eslint-config-next` / core-web-vitals), which Biome has no official plugin for. The trade accepted: heavier setup and a Prettier↔ESLint boundary to manage, in exchange for Next coverage + the mature `typescript-eslint` type-aware ruleset.

> Next.js 16 context: `next lint` **was removed** in v16 and **linting no longer runs during `next build`**. There is nothing to migrate, and — critically — ESLint only runs if *we* invoke it. That makes enforcement (below) load-bearing, not optional. (Verified against `eslint-config-next` v16 docs.)

## Config decisions

### ESLint

- **Base presets:** `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`, spread into `defineConfig` (ESLint 9 native flat config, no `FlatCompat`).
- **Add hand-picked type-aware async rules** on top (the payload):
  - `@typescript-eslint/no-floating-promises`
  - `@typescript-eslint/no-misused-promises`
  - `@typescript-eslint/await-thenable`
  - Enabled via `typescript-eslint` with `languageOptions.parserOptions.projectService: true`.
- **Deliberately NOT** `recommendedTypeChecked` (the full type-checked set). Its `no-unsafe-*` family fires constantly against Convex's `_generated` types and `any`-ish surfaces — turning it on would mean fighting the linter through M1 instead of writing schema. We take only the high-signal async rules that guard grade/lock correctness and leave `no-unsafe-*` off. (Revisit as a later escalation if a real gap appears.)

### Scope

- **Lint `app/` + `convex/` source.** The payload rule (`no-floating-promises`) lives overwhelmingly in `convex/` mutations, so linting only the frontend would aim it at the wrong half of the codebase.
- **`projectService: true`** auto-maps each file to its nearest tsconfig — `app/*` → root `tsconfig.json`, `convex/*` → `convex/tsconfig.json` — with no manual `project` array.
- **Ignore** (`globalIgnores`): `convex/_generated/**` (generated, gitignored — also keeps it from being double-claimed by the root tsconfig's `**/*` include), plus `eslint-config-next`'s defaults (`.next/**`, `out/**`, `build/**`, `next-env.d.ts`).

### Prettier

- **Stock defaults.** `.prettierrc` ≈ `{}`. For an agent-authored solo project the fastest path to zero style debate is adopting Prettier's defaults wholesale rather than encoding personal taste the agent then has to remember. Preferences can be added later; defaults mean every future contributor (human or agent) already knows the rules.
- **Boundary:** `eslint-config-prettier` spread **last** in the flat config — it disables every ESLint rule Prettier owns, so **ESLint judges code, Prettier judges layout**, no overlap. NOT `eslint-plugin-prettier` (running Prettier as a lint rule is slower and floods lint output with formatting errors).

### Scripts

Add to `package.json` (the tool must be runnable — nothing invokes it otherwise):

- `lint` — `eslint .`
- `lint:fix` — `eslint . --fix`
- `format` — `prettier --write .`
- `format:check` — `prettier --check .`

## Enforcement

The Next 16 removal of build-time linting means a config nobody invokes is theater. Enforcement must reach **both** audiences — the AI agent and any human contributor.

- **Backstop: a git pre-commit hook via Husky + lint-staged.** One mechanism covers both audiences, because the agent commits through `git` exactly as a human does. lint-staged runs Prettier (instant) + ESLint on **staged files only**; Husky auto-installs on `npm install` via a `prepare` script, so a fresh human clone is covered with no "remember to set up hooks" step. Accepted cost: the type-aware `no-floating-promises` rule spins up the TS program, adding a couple of seconds to commits that touch `.ts` files — fine for this project's cadence.
- **Proactive: a one-line rule in the project `CLAUDE.md`** — the agent runs `npm run lint` / `npm run format` *during* work, not just discovering failures at the commit wall.
- **NOT a Claude Code Stop hook** — it's agent-only (doesn't help humans) and running type-aware lint every turn is noisy/slow. The git hook at the commit boundary is the cleaner single mechanism.
- **CI gate: deferred to its own later effort.** There is no `.github/workflows` yet. When CI is stood up, a job runs `lint` + `typecheck` + `test` on every PR into `main` — the *real* backstop, since a local hook can be bypassed with `--no-verify` and doesn't run on the machine that decides a merge.

## Build-time verification gates

Per the project's verify-the-API rule (`CLAUDE.md`), confirm each against the **installed** version before relying on it:

- `eslint-config-next` v16 flat exports — the `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript` import paths.
- `typescript-eslint` flat-config surface — the helper for adding single type-aware rules with `parserOptions.projectService: true` (and whether the `@typescript-eslint` plugin bundled by `eslint-config-next` can be reused, or `typescript-eslint` must be installed alongside).
- Husky v9 init flow + the `prepare` script convention; `lint-staged` config shape.

## Build sequence (→ tickets)

Three tickets, ordered by dependency:

1. **L1 — ESLint + Prettier config & scripts** (foundational; no blocker). Installs deps, writes the flat config (presets + async rules + ignores), `.prettierrc`, `eslint-config-prettier` boundary, and the four npm scripts. **Verify:** `npm run lint` and `npm run format:check` both run clean on the current tree; a deliberately un-awaited Convex promise makes `lint` fail.
2. **L2 — Pre-commit enforcement + agent instruction** (blocked by L1). Husky + lint-staged pre-commit hook; the `CLAUDE.md` line. **Verify:** a staged file with a format/lint violation is blocked (or auto-fixed) by the commit; a clean commit passes.
3. **L3 — CI gate: lint + typecheck + test on PRs** (blocked by L1; **deferred** — do when CI is first stood up). A `.github/workflows` job gating PRs into `main`. **Verify:** a PR with a lint failure shows a red required check.

## Out of scope (parked)

- Biome (reconsider only if the ESLint setup proves too heavy).
- `recommendedTypeChecked` / the `no-unsafe-*` family (escalation if a real gap appears).
- Editor-integration config (`.vscode/`), import-sorting plugins, and any house Prettier overrides — add lazily if wanted.
