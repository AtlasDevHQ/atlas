## Part A: Gate Checks (Must Pass)

### A0. GitHub Actions CI Status

Check whether CI is passing on main before running local checks:

```bash
gh run list -R AtlasDevHQ/atlas --branch main --limit 5 --json status,conclusion,name,createdAt,databaseId
```

If CI is **failing on main**, get failure details:
```bash
gh run view <run_id> -R AtlasDevHQ/atlas --log-failed 2>&1 | tail -30
```

| Check | What to Look For |
|-------|------------------|
| Latest CI on main | Must be `success`. If failing, report as **CRITICAL** — main is broken |
| Failure pattern | Is it a new regression or a pre-existing issue? Check when it started failing |
| Sync Starters | Separate workflow that syncs monorepo source → `atlas-starter-{vercel,railway,docker}` repos. Triggers on changes to `packages/api/src/`, `packages/web/src/ui/`, `create-atlas/`, `examples/`, `docs/guides/deploy.md`. Must be green — failures mean starter repos are out of sync |
| Template drift | CI runs `scripts/check-template-drift.sh` — verifies `create-atlas/templates/` matches monorepo source. If this step fails, run `bash create-atlas/scripts/prepare-templates.sh` locally to regenerate |

### A1. Lint, Type Check, Tests & Dependency Sync

Run all CI gates locally. If any fail, stop and report — the codebase is broken.

```bash
bun run lint           # oxlint — 0 errors (warnings allowed)
bun run type           # TypeScript strict mode via tsgo — 0 errors
bun run test           # Full suite — @atlas/api + all other workspace packages (isolated per-file)
bun x syncpack lint    # Workspace dependency versions consistent
bash scripts/check-railway-watch.sh  # Railway watchPatterns vs Dockerfile COPY sources
```

| Check | What to Look For |
|-------|------------------|
| Lint warnings | Any output = FAIL |
| Type errors | Any output = FAIL |
| Test failures | Any `FAIL` = FAIL |
| Version drift | syncpack lint errors = FAIL (fix with `bun run deps:fix`) |

**If any gate fails, stop and report the failures before proceeding.**

---
