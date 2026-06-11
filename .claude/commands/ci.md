Run the same checks CI runs. This must pass before opening a PR.

**Run all gates in parallel:**

```bash
bun run lint           # ESLint — 0 errors, 0 warnings
bun run type           # TypeScript strict mode (tsgo) — 0 errors
bun run test           # FULL suite — @atlas/api + test:others (isolated per-file)
bun x syncpack lint    # Workspace dependency versions consistent
SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh  # Template drift
bash scripts/check-security-headers-drift.sh  # Scaffold next.config.ts security-header parity
bash scripts/check-railway-watch.sh  # Railway watchPatterns cover Dockerfile COPY sources
bash scripts/check-schema-drift.sh   # Drizzle schema.ts ↔ migrations parity
bash scripts/check-oauth-helper-drift.sh  # plugins/mcp/src/_oauth-helper ↔ packages/oauth-helper/src parity
bash scripts/check-test-discipline.sh  # No new top-level env/chdir mutations in test files
bash scripts/check-twenty-resolver-imports.sh  # Twenty operator resolver confined to ee/saas-crm (#2850)
bash scripts/check-settings-readers.sh  # Every settings-registry key has a non-test runtime reader (#3382)
bun run scripts/check-published-symbols.ts  # @useatlas/* imports in scaffold-bound source ↔ pinned-published exports parity
```

Use the full `bun run test` here — `/ci` is the pre-PR check, not an iteration loop. For iteration, use `cd packages/api && bun run scripts/test-isolated.ts --affected` (only tests whose source graph your branch touched — typical 10–60s vs 225s full).

**Evaluate results:**

| Gate | Pass criteria |
|------|---------------|
| Lint | Zero output (no errors or warnings) |
| Type | No errors after build |
| Test | All packages pass, 0 failures |
| Syncpack | `No issues found` |
| Template drift | `Template drift check passed` |
| Railway watch | `all deploy Dockerfile COPY sources are covered` |
| Schema drift | `Schema drift check passed` (every migration table is in `packages/api/src/lib/db/schema.ts`) |
| OAuth helper drift | `vendored _oauth-helper matches canonical packages/oauth-helper/src` |
| Test discipline | `Test discipline check passed — env: N allowlisted, chdir: N allowlisted.` New offenders fail; new allowlist entries need justifying comment (see #2796). `mock.module()` is NOT gated — slice 5a verdict (#2801) proved bun's `--isolate` resets module mocks between files |
| Settings readers | `Settings reader check passed — …` Every key in `packages/api/src/lib/settings.ts` has a non-test runtime reader: a literal/const-indirected `getSetting`/`getSettingAuto`/`getSettingLive` call, or (platform-scoped keys only) a `process.env.<ENVVAR>` read. Fix by adding the reader, allowlisting with a justification comment in the script, or removing the setting (parity contract Rule 1, #3382) |
| Published symbols | `Published symbol check passed.` Diffs braced **value** imports from `@useatlas/*` packages in scaffold-bound source (`packages/{api,cli,web,schemas}/src`, `ee/src`, `examples/nextjs-standalone/src`, `create-atlas/overrides`) against the symbols exported by the version `npm view` resolves for the range pinned in `create-atlas/templates/*/package.json`. Type-only imports are skipped (they erase; the scaffold's `next build` runs with `ignoreBuildErrors: true`). Fix per the version-bump-ordering rule: publish the plugin first, then bump the template ref in a follow-up PR |

**If any gate fails:**

1. Fix the issue directly — these are almost always small:
   - Lint: type annotations, unused vars, unsafe types
   - Type: missing types, interface mismatches
   - Syncpack: run `bun x syncpack fix` then verify
   - Template drift: run `bash create-atlas/scripts/prepare-templates.sh` then verify
   - Tests: read the failure, fix the code or test

2. After fixing, re-run only the failed gate to verify, then run all gates once more.

   - **Schema drift**: a new migration created/altered a table without a matching definition in `packages/api/src/lib/db/schema.ts`. Add the drizzle table (mirror SQL types, PK, indexes, CHECK constraints) and re-run.

**If all gates pass:**

Report: `CI gates: lint, type, test, syncpack, drift, railway-watch, schema-drift — all pass.`

---

**After local gates pass, check remote CI and deployments:**

A merge to `main` deploys to **staging** (`api-staging` / `web-staging` / `www-staging`) plus the `docs` prod service (direct-from-main). Production (`api` / `api-eu` / `api-apac` / `web` / `www`) is gated behind `/release` advancing the `prod` branch — so the `main` deploy statuses below are about **staging health**, not prod. See [release-process.md § Mental model](../../docs/development/release-process.md#mental-model).

```bash
# GitHub Actions CI + Sync Starters (last 5 runs on main)
gh run list -R AtlasDevHQ/atlas --branch main --limit 5 --json status,conclusion,name,createdAt,databaseId

# Railway deployment status on main (staging services + docs — uses commit statuses, not check-runs)
gh api repos/AtlasDevHQ/atlas/commits/main/statuses --jq '[.[] | {context, state, description}] | unique_by(.context) | .[] | "\(.context)\t\(.state)\t\(.description)"'
```

| Check | What to look for |
|-------|------------------|
| `CI` (GitHub Actions) | Must be `success` |
| `Sync Starters` (GitHub Actions) | Must be `success` |
| `satisfied-creation - api-staging` | Must be `Success`. If `Deployment failed`, check Railway dashboard for build/startup errors |
| `satisfied-creation - web-staging` | Must be `Success` |
| `satisfied-creation - www-staging` | `No deployment needed` is fine (only deploys on `apps/www/` changes) |
| `satisfied-creation - docs` | Must be `Success` (deploys direct-from-main) |
| `satisfied-creation - sidecar` | `No deployment needed` is fine (only deploys on sandbox changes) |
| `satisfied-creation - api` / `web` / `www` | Prod — only updates when `/release` advances `prod`; stale relative to `main` is expected |

**If a Railway deployment fails:**
1. Check which service failed (api-staging, web-staging, docs)
2. Common causes:
   - **Build failure**: new dependency not in `serverExternalPackages`, TypeScript error in production build
   - **Startup crash**: missing env var on Railway, DB migration error, new table requires `DATABASE_URL`
   - **Health check timeout**: new middleware blocking startup, new route panicking
3. Railway logs are NOT accessible via `gh` — check the Railway dashboard or ask the user to check
4. If the failure is from code you just shipped, fix it. If pre-existing, file an issue

**If all checks pass:**

Report: `CI gates: lint, type, test, syncpack, drift, railway-watch, schema-drift — all pass. Remote: CI, Sync Starters, Railway staging (api-staging/web-staging/docs) — all green.`

---

**Rules:**
- Never skip a gate or mark it as "probably fine"
- If a gate fails on code you didn't write (pre-existing), still fix it — CI won't distinguish
- If a test is flaky (passes on retry), note it but don't ignore it
- Railway deployments are as important as CI — a green CI with a failed staging deploy means `main` is broken on staging, which blocks the next `/release` to prod
