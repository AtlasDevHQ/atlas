Run the same checks CI runs. This must pass before opening a PR.

`/ci` is the pre-PR gate, not an iteration loop. For iteration use
`cd packages/api && bun run scripts/test-isolated.ts --affected` (only tests
whose source graph your branch touched — typically 10–60s vs the full suite).

## How to run it (token-aware, hang-proof)

All gates run through one wrapper: **`bash scripts/ci-local.sh`**. It runs every
gate, redirects each one's output to `.ci-local/<gate>.log`, and prints only a
compact PASS/FAIL table plus the tail of any *failed* gate — one small result
instead of ~26 verbose ones. Exit code is 0 (all green) or 1 (something failed).

The wrapper also leaves machine-readable run state under `.ci-local/`, so
completion is observable **from disk**, independent of any agent hand-off:

| File | Meaning |
|------|---------|
| `.ci-local/PID` | The run's pid — `kill -0 "$(cat .ci-local/PID)"` = still running |
| `.ci-local/STATUS` | Last stage transition (install / stage 0 / 1 / 2) |
| `.ci-local/RESULT` | The full compact report, written **atomically at the very end**. Existence = run finished; contents = the report |

### Launch, then actively watch — never passively wait

Historic failure mode: `/ci` was delegated to a background subagent and the
main thread ended its turn "waiting for the report". When that completion
hand-off was lost (subagent died or its reply never arrived), the calling loop
(`/ship-issue`) sat idle until a human poked it. The fix is a protocol, not a
hope: **whoever kicks off the run owns a watchdog loop, and `.ci-local/RESULT`
on disk — not any agent's reply — is the completion signal.**

1. **Launch** `bash scripts/ci-local.sh` from the repo root as a background
   Bash task (`run_in_background: true`). Its printed output is already
   compact — that is the wrapper's whole purpose — so no subagent wrapper is
   needed. (If you do wrap it in a subagent, prefer a synchronous run; a
   background subagent changes nothing below — the disk artifacts stay the
   ground truth, never the agent's reply.)
2. **Arm a backstop before doing anything else.** If your harness has a
   scheduled self check-in (`send_later`, `ScheduleWakeup`, or similar),
   schedule one ~10 min out that says "check .ci-local/RESULT for the /ci run
   and act on it" — so even a lost completion notification can't strand the
   session. Cancel or ignore it if the result arrives first.
3. **Watch on a loop.** Do NOT end your turn to wait for a completion
   notification. Check roughly every 1–2 minutes (`sleep 90` between checks
   where foreground sleep is allowed; otherwise your harness's Monitor /
   until-loop / background-task polling). Each check is one cheap tri-state:
   ```bash
   if [ -f .ci-local/RESULT ]; then cat .ci-local/RESULT
   elif kill -0 "$(cat .ci-local/PID 2>/dev/null)" 2>/dev/null; then
     echo "RUNNING: $(cat .ci-local/STATUS 2>/dev/null) — $(ls .ci-local/*.exit 2>/dev/null | wc -l) gates done"
   else echo "DEAD without RESULT — the wrapper crashed"; fi
   ```
4. **Resolve** on the first check that isn't RUNNING:
   - **`RESULT` exists** → that output IS the report; act on it (green →
     remote checks; failures → fix). If a subagent/notification reports too,
     fine — but never *require* it.
   - **Still RUNNING past ~20 min** (a normal run is ~4–6 min; the full test
     suite is the long pole) → treat as hung: note `.ci-local/STATUS` and which
     gates have no `.exit` file yet, kill the run, relaunch once. Hung twice →
     STOP and report the stuck gate to the human.
   - **DEAD without `RESULT`** → the wrapper crashed: read the tail of the
     newest `.ci-local/*.log`, relaunch once. Crashed twice → STOP and report.

Once local gates are green, run the two commands in "Remote checks" below
yourself (they're short, compact `gh` calls) and fold them into the report.
You (main thread) apply any fixes — fixing needs the conversation context.

After fixing a gate, re-verify just that one cheaply — e.g.
`bash scripts/check-schema-drift.sh` or `bun run test path/to/file.test.ts` —
rather than re-running the whole wrapper. Re-run the full `bash scripts/ci-local.sh`
once at the end (same launch-and-watch protocol) to confirm a clean green.

**Env toggles** (pass to the wrapper): `CI_LOCAL_NO_TEST=1` skips the test suite
for a fast gates-only pass (RESULT is flagged "tests skipped" — never a clean
pass); `CI_LOCAL_NO_NET=1` skips the two npm-registry gates for offline runs;
`CI_LOCAL_JOBS=N` sets Stage-1 concurrency (default 6).

## What the wrapper covers

It is a **superset of the historic /ci list** — it adds the drift gates real CI
runs that the old /ci skipped (so you stop discovering them only after a push):
`type`, `lint`, `lint-type-aware` (oxlint `--type-aware` via tsgolint — the
promoted type-aware rules at `error`; permanent `warn` residuals don't fail it),
`syncpack`, `dockerfile-bun-pins`, `dockerfile-workspace`,
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
| `lint-type-aware` | a promoted type-aware rule (e.g. `no-floating-promises`, `await-thenable`, `no-redundant-type-constituents`) regressed. Fix the code — never demote the rule back to `warn` (ADR-0031). Reproduce with `bun run lint:type-aware` |
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
- Never end a turn "waiting for the CI report". `.ci-local/RESULT` on disk is the completion signal — poll it on the watch loop above. A lost subagent reply or notification must cost you one poll interval, not a stalled session.
- Never skip a gate or mark it "probably fine". The wrapper runs them all; don't second-guess a FAIL without reading the log.
- If a gate fails on code you didn't write (pre-existing), still fix it — CI won't distinguish. The one exception is local-only cruft (see `plugin-count` above), which you remove, not fix.
- If a test is flaky (passes on retry), note it but don't ignore it. The test suite runs isolated in Stage 2 specifically to reduce WSL2 flakiness — a failure there is more likely real.
- Railway deployments are as important as CI — green CI with a failed staging deploy means `main` is broken on staging, which blocks the next `/release` to prod.
