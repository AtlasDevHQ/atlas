Run the same checks CI runs. This must pass before opening a PR.

**Run all gates in parallel:**

```bash
bun run lint           # ESLint — 0 errors, 0 warnings
bun run type           # TypeScript strict mode (tsgo) — 0 errors
bun run test           # FULL suite — @atlas/api + test:others (isolated per-file)
bun x syncpack lint    # Workspace dependency versions consistent
SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh  # Template drift
bash scripts/check-railway-watch.sh  # Railway watchPatterns cover Dockerfile COPY sources
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

**If any gate fails:**

1. Fix the issue directly — these are almost always small:
   - Lint: type annotations, unused vars, unsafe types
   - Type: missing types, interface mismatches
   - Syncpack: run `bun x syncpack fix` then verify
   - Template drift: run `bash create-atlas/scripts/prepare-templates.sh` then verify
   - Tests: read the failure, fix the code or test

2. After fixing, re-run only the failed gate to verify, then run all gates once more.

**If all gates pass:**

Report: `CI gates: lint, type, test, syncpack, drift, railway-watch — all pass.`

---

**After local gates pass, check remote CI and deployments:**

```bash
# GitHub Actions CI + Sync Starters (last 5 runs on main)
gh run list -R AtlasDevHQ/atlas --branch main --limit 5 --json status,conclusion,name,createdAt,databaseId

# Railway deployment status (all 5 services — uses commit statuses, not check-runs)
gh api repos/AtlasDevHQ/atlas/commits/main/statuses --jq '[.[] | {context, state, description}] | unique_by(.context) | .[] | "\(.context)\t\(.state)\t\(.description)"'
```

| Check | What to look for |
|-------|------------------|
| `CI` (GitHub Actions) | Must be `success` |
| `Sync Starters` (GitHub Actions) | Must be `success` |
| `satisfied-creation - api` | Must be `Success`. If `Deployment failed`, check Railway dashboard for build/startup errors |
| `satisfied-creation - web` | Must be `Success` |
| `satisfied-creation - docs` | Must be `Success` |
| `satisfied-creation - www` | `No deployment needed` is fine (only deploys on `apps/www/` changes) |
| `satisfied-creation - sidecar` | `No deployment needed` is fine (only deploys on sandbox changes) |

**If a Railway deployment fails:**
1. Check which service failed (api, web, docs)
2. Common causes:
   - **Build failure**: new dependency not in `serverExternalPackages`, TypeScript error in production build
   - **Startup crash**: missing env var on Railway, DB migration error, new table requires `DATABASE_URL`
   - **Health check timeout**: new middleware blocking startup, new route panicking
3. Railway logs are NOT accessible via `gh` — check the Railway dashboard or ask the user to check
4. If the failure is from code you just shipped, fix it. If pre-existing, file an issue

**If all checks pass:**

Report: `CI gates: lint, type, test, syncpack, drift, railway-watch — all pass. Remote: CI, Sync Starters, Railway (api/web/docs) — all green.`

---

**Rules:**
- Never skip a gate or mark it as "probably fine"
- If a gate fails on code you didn't write (pre-existing), still fix it — CI won't distinguish
- If a test is flaky (passes on retry), note it but don't ignore it
- Railway deployments are as important as CI — a green CI with a failed deploy means main is broken in production
