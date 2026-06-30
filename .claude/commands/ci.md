Run the same checks CI runs. This must pass before opening a PR.

`/ci` is the pre-PR gate, not an iteration loop. For iteration use
`cd packages/api && bun run scripts/test-isolated.ts --affected` (only tests
whose source graph your branch touched — typically 10–60s vs the full suite).

## How to run it (token-aware)

All gates run through one wrapper: **`bash scripts/ci-local.sh`**. It runs every
gate, redirects each one's output to `.ci-local/<gate>.log`, and prints only a
compact PASS/FAIL table plus the tail of any *failed* gate — one small result
instead of ~26 verbose ones. Exit code is 0 (all green) or 1 (something failed).

**Delegate the run to a subagent** so even that stays out of the main thread.
Spawn ONE `general-purpose` agent with this prompt:

> Run `bash scripts/ci-local.sh` from the repo root (it takes ~4–6 min — the
> full test suite is the long pole; wait for it). Then, only if it exited 0,
> run the two remote-status commands in the "Remote checks" section of
> `.claude/commands/ci.md` and summarize them. Do NOT fix anything — you are
> reporting only. Return: (1) the gate table verbatim if anything failed, or
> just "local: all N gates green" if not; (2) for each failed gate, its name,
> a one-line root cause from its `.ci-local/<gate>.log`, and the file:line to
> fix; (3) the remote-status summary. Keep the whole reply under ~40 lines —
> do not paste full logs.

The subagent burns the verbose output in its own context and hands you back a
short report. You (main thread) then apply any fixes — fixing needs the
conversation context, so it stays here, not in the subagent.

After fixing a gate, re-verify just that one cheaply — e.g.
`bash scripts/check-schema-drift.sh` or `bun run test path/to/file.test.ts` —
rather than re-running the whole wrapper. Re-run the full `bash scripts/ci-local.sh`
once at the end to confirm a clean green.

**Env toggles** (pass to the wrapper): `CI_LOCAL_NO_TEST=1` skips the test suite
for a fast gates-only pass (RESULT is flagged "tests skipped" — never a clean
pass); `CI_LOCAL_NO_NET=1` skips the two npm-registry gates for offline runs;
`CI_LOCAL_JOBS=N` sets Stage-1 concurrency (default 6).

## What the wrapper covers

It is a **superset of the historic /ci list** — it adds the drift gates real CI
runs that the old /ci skipped (so you stop discovering them only after a push):
`type`, `lint`, `syncpack`, `dockerfile-bun-pins`, `dockerfile-workspace`,
`railway-watch`, `template-drift`, `security-headers-drift`, `pricing-parity`,
`plugin-count`, `enforcement-parity`, `schema-drift`, `migration-rename`,
`oauth-helper-drift`, `ee-imports`, `twenty-resolver`, `no-admin-plugin`,
`no-legacy-connections`, `test-discipline`, `settings-readers`, `saas-env-doc`,
`auth-md-parity`, `openapi-drift`, `gate-fixtures` (the adversarial
`scripts/__tests__/*.test.sh` suites), `published-symbols`, `unpublished-versions`,
and the full `test` suite.

It does **not** run the GitHub-only required checks (Deploy Validation,
`Analyze (javascript-typescript)` / CodeQL, Symlink Stub Build) or the heavy
`bun run build` web build — those run remotely (see "Remote checks").

Schedule is deliberately race- and flake-safe, not max-parallel: Stage 0 runs
`bun run type` alone (the only gate that writes SDK `dist/`); Stage 1 fans out
all read-only gates; Stage 2 runs the full test suite **isolated** (it flakes
under CPU contention on WSL2).

**Real-Postgres tests (`*-pg.test.ts`) are SILENTLY SKIPPED without a database.**
They run only when `TEST_DATABASE_URL` is set (the wrapper prints whether it is).
Locally unset, `bun run test` passes without exercising them; CI's
`api-tests (1/4)`–`(4/4)` shards always run them against a real Postgres. Any
change to a DB-reader SELECT (e.g. `getWorkspaceDetails`) or a migration must
update the hand-built table fixtures inside the `-pg` tests too, or CI fails with
`column "X" does not exist` even though local gates were green (how #3481 first
failed CI). To exercise them locally:
`bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas && bash scripts/ci-local.sh`.

## Fixing failures

Failures are almost always small. The wrapper prints the failed gate's name + log
tail; read `.ci-local/<gate>.log` for the rest. Common fixes by gate:

| Gate | Fix |
|------|-----|
| `lint` | type annotations, unused vars, unsafe types |
| `type` | missing types, interface mismatches. **Fix this first** — a `type` failure leaves SDK `dist/` incomplete and can cascade into `openapi-drift`/`test` |
| `test` | read the tail / full log, fix the code or test |
| `syncpack` | `bun x syncpack fix` then re-verify |
| `template-drift` | `bash create-atlas/scripts/prepare-templates.sh` then re-verify |
| `schema-drift` | a migration created/altered a table without a matching definition in `packages/api/src/lib/db/schema.ts`. Add the drizzle table (mirror SQL types, PK, indexes, CHECK constraints) |
| `openapi-drift` | a route's request/response schema changed (new field/enum/status). Local `type`/`test` do NOT catch this. Fix: `bun run --filter '@atlas/api' openapi:extract && bun run --filter '@atlas/docs' generate:api`, then commit `apps/docs/openapi.json` + `apps/docs/content/docs/api-reference` (#3480, #3481 both failed CI here) |
| `saas-env-doc` | added/renamed a SaaS boot-contract var. `bun scripts/generate-saas-env-doc.ts`, commit the MDX |
| `settings-readers` | a new `settings.ts` key has no runtime reader. Add the reader, or allowlist with a justification comment in the script |
| `published-symbols` | used a new `@useatlas/*` export before publishing. Publish the package first, bump the template ref in a follow-up (version-bump-ordering rule) |
| `plugin-count` | a surface's plugin count drifted from `plugins/`. **If it fails on a clean tree, suspect stale local cruft** — an untracked `plugins/<name>/` left over from an old checkout (check `git ls-files plugins/<name>/`; if 0, `rm -rf` it). CI is green because a fresh checkout doesn't have it |

After fixing, re-run only the failed gate to verify, then run the full wrapper
once more before reporting green.

## Remote checks

After local gates are green, check remote CI + deployments. A merge to `main`
deploys to **staging** (`api-staging` / `web-staging`) plus the `docs` and `www`
prod services (both direct-from-main). Production (`api` / `api-eu` / `api-apac`
/ `web`) is gated behind `/release` advancing the `prod` branch — so the `main`
deploy statuses below are about **staging health** (plus direct-from-main
`docs`/`www`), not the gated prod set. See
[release-process.md § Mental model](../../docs/development/release-process.md#mental-model).

```bash
# GitHub Actions CI + Sync Starters (last 5 runs on main)
gh run list -R AtlasDevHQ/atlas --branch main --limit 5 --json status,conclusion,name,createdAt,databaseId

# Railway deployment status on main (staging services + docs + www — commit statuses, not check-runs)
gh api repos/AtlasDevHQ/atlas/commits/main/statuses --jq '[.[] | {context, state, description}] | unique_by(.context) | .[] | "\(.context)\t\(.state)\t\(.description)"'
```

| Check | What to look for |
|-------|------------------|
| `CI` (GitHub Actions) | Must be `success` |
| `Sync Starters` (GitHub Actions) | Must be `success` |
| `satisfied-creation - api-staging` | Must be `Success`. If `Deployment failed`, check Railway dashboard for build/startup errors |
| `satisfied-creation - web-staging` | Must be `Success` |
| `satisfied-creation - www` | Direct-from-main: `Success` when `apps/www/` changed; `No deployment needed` otherwise |
| `satisfied-creation - docs` | Must be `Success` (deploys direct-from-main) |
| `satisfied-creation - sidecar` | `No deployment needed` is fine (only deploys on sandbox changes) |
| `satisfied-creation - api` / `web` | Prod — only updates when `/release` advances `prod`; stale vs `main` is expected |

**If a Railway deployment fails:**
1. Identify the failed service (api-staging, web-staging, docs, www).
2. Common causes: **build failure** (new dependency not in `serverExternalPackages`,
   TypeScript error in production build); **startup crash** (missing env var on
   Railway, DB migration error, new table requires `DATABASE_URL`); **health-check
   timeout** (new middleware blocking startup, new route panicking).
3. Railway logs are NOT accessible via `gh` — check the Railway dashboard or ask the user.
4. If the failure is from code you just shipped, fix it. If pre-existing, file an issue.

## Reporting

**All green:**
`CI gates (scripts/ci-local.sh): all pass. Remote: CI, Sync Starters, Railway staging (api-staging/web-staging/docs) — all green.`

## Rules
- Never skip a gate or mark it "probably fine". The wrapper runs them all; don't second-guess a FAIL without reading the log.
- If a gate fails on code you didn't write (pre-existing), still fix it — CI won't distinguish. The one exception is local-only cruft (see `plugin-count` above), which you remove, not fix.
- If a test is flaky (passes on retry), note it but don't ignore it. The test suite runs isolated in Stage 2 specifically to reduce WSL2 flakiness — a failure there is more likely real.
- Railway deployments are as important as CI — green CI with a failed staging deploy means `main` is broken on staging, which blocks the next `/release` to prod.
