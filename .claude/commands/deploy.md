# Deploy Status

Check deployment health across all Railway services — staging and production. Diagnose issues, tail logs, and trigger redeploys.

**Deploy model (dual-trigger):** merges to `main` auto-deploy to **staging** (`api-staging` / `web-staging`); `docs` **and `www`** deploy direct-from-`main` to their prod services (both static `output: "export"` exports, no runtime to gate). **Production** (`api` / `api-eu` / `api-apac` / `web`) is gated — it deploys only when `/release` advances the `prod` branch to a `v*.*.*` tag. See [release-process.md § Mental model](../../docs/development/release-process.md#mental-model).

**Run this** after a merge to verify **staging** landed, after `/release` to verify the **prod** promote landed, or anytime you're investigating a live issue.

---

**Step 1: Check deploy status for all services**

Run these in parallel:

1. Recent deploys (all services):
   ```
   railway status --json 2>/dev/null || echo "Not linked — will check services individually"
   ```

2. Service health — hit each public endpoint:
   ```bash
   # --- Production (deployed via /release → prod branch) ---
   # API health check (most detailed — shows datasource, auth, semantic layer status)
   curl -sf https://api.useatlas.dev/api/health | jq .
   # Web (Next.js) — just check it responds
   curl -sf -o /dev/null -w "%{http_code}\n" https://app.useatlas.dev
   # Landing page
   curl -sf -o /dev/null -w "%{http_code}\n" https://www.useatlas.dev
   # Docs site (direct-from-main, not tag-gated)
   curl -sf -o /dev/null -w "%{http_code}\n" https://docs.useatlas.dev

   # --- Staging (auto-deployed on every merge to main) ---
   # (www has no staging twin — it deploys direct from main to prod, like docs)
   curl -sf https://api.staging.useatlas.dev/api/health | jq '{status, region}'   # region should be "staging"
   curl -sf -o /dev/null -w "%{http_code}\n" https://app.staging.useatlas.dev
   ```

3. CI status (merges to `main` deploy to **staging**; prod deploys are gated by `/release` tags advancing the `prod` branch):
   ```
   gh run list -R AtlasDevHQ/atlas --branch main --limit 3 --json status,conclusion,name,createdAt,databaseId
   ```

4. Railway deploy statuses (catches per-service deploy failures that live health checks miss — Railway keeps the previous deployment running when a new build fails):
   ```bash
   # Railway reports via commit statuses API (not check runs). Dedupe to latest per service.
   # A plain main commit shows the staging services (api-staging/web-staging) + docs + www;
   # prod-service statuses (api/api-eu/api-apac/web) live on the SHA the `prod` branch points at.
   echo "main HEAD ($(git rev-parse --short HEAD)):"
   gh api repos/AtlasDevHQ/atlas/commits/$(git rev-parse HEAD)/statuses --jq '[.[] | {context, state, description}] | group_by(.context) | map(.[0]) | .[] | "\(.context): \(.state) — \(.description)"' 2>/dev/null

   # Prod-branch deploy statuses (what customers actually run):
   echo "prod branch:"
   gh api repos/AtlasDevHQ/atlas/commits/prod/statuses --jq '[.[] | {context, state, description}] | group_by(.context) | map(.[0]) | .[] | "\(.context): \(.state) — \(.description)"' 2>/dev/null
   ```

5. Recent commits on main (correlate with staging deploys) + where prod sits:
   ```
   git log --oneline -10 --format="%h %s (%cr)"
   git fetch origin prod --quiet 2>/dev/null; echo "prod branch at: $(git rev-parse --short origin/prod 2>/dev/null || echo 'unknown')"
   ```

6. **Authoritative — is each prod service running the expected commit?** Health (`ok`) and a green check only prove a service is *up*, not *which build* it's on: the API health endpoint exposes no git SHA, and Railway keeps the previous deployment serving when a new build fails. Confirm the commit hash of each prod service's active deployment via the Railway MCP `list_deployments` (project `08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241`, env `production` = `a0a5532e-8e2a-416f-bd24-ae8d2088b330`):

   | Service | service_id |
   |---------|-----------|
   | api | `0ec88244-06d9-47cc-8874-0884eea6548b` |
   | api-eu | `5de4ea32-0d74-4ce5-907d-67d0d785bcd4` |
   | api-apac | `4b47dffe-aa4d-4eb0-bb5b-009de2735e05` |
   | web | `9c00bb31-808a-40d5-92d4-184a03a10bdc` |

   Returns `id | status | timestamp | commit-hash`. **Pass:** latest deployment is `SUCCESS` with commit-hash == `git rev-parse origin/prod`, prior deployment `REMOVED`. **Legit skip:** a service unchanged by the diff stays `SUCCESS` on the old SHA with note `No deployment needed - watched paths not modified` (e.g. `web` for an api-only release). **Fail:** latest `FAILED`/`CRASHED`/stuck `WAITING`, or `SUCCESS` still on an older SHA with no skip reason — the endpoint may still look healthy on the old build. `docs` and `www` track `main` (not `prod`), so they won't match the tag SHA — verify `docs` at `docs.useatlas.dev` and `www` at `www.useatlas.dev`. (Railway MCP logged out → `Unauthorized`; reconnect via `/mcp` or read the source commit from the dashboard.)

**Step 2: Diagnose any failures**

If any health check fails:

For a **staging** service, suffix the service name with `-staging` (e.g. `--service api-staging`). Regional prod API instances are `api-eu` / `api-apac`.

### API down
```bash
# Check API logs (requires railway CLI linked to project)
railway service logs --service api --limit 50          # prod (us); also api-eu / api-apac
railway service logs --service api-staging --limit 50  # staging

# Common causes:
# - Missing env var (check startup.ts validation)
# - Database connection failed (check ATLAS_DATASOURCE_URL, DATABASE_URL)
# - Provider API key expired
# - Sidecar unreachable (check sidecar health)
```

### Web/Docs/WWW down
```bash
railway service logs --service web --limit 50          # also web-staging
railway service logs --service docs --limit 50         # direct-from-main, no staging variant
railway service logs --service www --limit 50          # direct-from-main, no staging variant

# Common causes:
# - Build failure (check Railway build logs)
# - Next.js config error
# - API URL misconfigured (NEXT_PUBLIC_ATLAS_API_URL — staging points at api.staging.useatlas.dev)
```

### Sidecar down
```bash
railway service logs --service sidecar --limit 50

# The sidecar has no public domain — it's internal only
# Check via API health: the "explore" capability in /api/health should show sidecar status
```

**Step 3: Report status**

Output a summary table:

```
## Deploy Status

### Production (gated — tracks the `prod` branch, last advanced by `/release <tag>`)
| Service | URL | Status | Last Deploy |
|---------|-----|--------|-------------|
| API (US) | api.useatlas.dev | ✓ healthy / ✗ down | <time> |
| API (EU) | api-eu.useatlas.dev | ✓ healthy / ✗ down | <time> |
| API (APAC) | api-apac.useatlas.dev | ✓ healthy / ✗ down | <time> |
| Web | app.useatlas.dev | ✓ 200 / ✗ <code> | <time> |
| WWW | www.useatlas.dev | ✓ 200 / ✗ <code> | <time> | (direct-from-main)
| Docs | docs.useatlas.dev | ✓ 200 / ✗ <code> | <time> | (direct-from-main)
| Sidecar | (internal) | ✓ via API / ✗ down | <time> |

### Staging (auto — tracks `main`)
| Service | URL | Status | Last Deploy |
|---------|-----|--------|-------------|
| API | api.staging.useatlas.dev | ✓ healthy / ✗ down | <time> |
| Web | app.staging.useatlas.dev | ✓ 200 / ✗ <code> | <time> |

CI: last run <status> (<time>)
Last push to main: <commit hash> <message> (<time>) → deploys staging
prod branch at: <tag> / <sha>
```

**IMPORTANT:** A service can show "healthy" via curl (live endpoint) but be running **stale or failed-over code** — Railway keeps the previous deployment serving when a new build/deploy fails, and the health endpoint carries no git SHA to give it away. Health `ok` ≠ "latest code is live." The definitive cross-reference is the **active deployment's commit hash** (Step 1, item 6): only when it equals `origin/prod`'s SHA (or the service legitimately skipped with "watched paths not modified") is the latest code actually deployed. The commit check runs are a secondary signal — a `conclusion: "failure"` there also means the latest code is NOT deployed even if the endpoint is up.

If everything is healthy AND all commit checks passed, stop here.

If anything is unhealthy or a commit check failed, include:
- Error details from logs or check run status
- Likely root cause
- Suggested fix

**Step 4: Actions (only if requested or clearly needed)**

Don't redeploy automatically — ask the user first. Offer these options:

```bash
# Redeploy a specific service
railway service redeploy --service <name>

# Check env vars (non-secret values only)
railway variable list --service <name> --kv 2>/dev/null | grep -v -i "secret\|password\|key\|token"

# Tail live logs
railway service logs --service <name> --follow
```

---

**Railway reference:**

| Service | Public URL | Config dir | Deploy trigger |
|---------|-----------|------------|----------------|
| api | api.useatlas.dev / mcp.useatlas.dev | deploy/api/ | `prod` branch (tag) |
| api-eu | api-eu.useatlas.dev | deploy/api-eu/ | `prod` branch (tag) |
| api-apac | api-apac.useatlas.dev | deploy/api-apac/ | `prod` branch (tag) |
| web | app.useatlas.dev | deploy/web/ | `prod` branch (tag) |
| www | www.useatlas.dev | deploy/www/ | `main` (direct) |
| docs | docs.useatlas.dev | deploy/docs/ | `main` (direct) |
| sidecar | (internal) | deploy/sidecar/ | sandbox changes |
| api-staging | api.staging.useatlas.dev | shared `deploy/api/` config, `ATLAS_API_REGION=staging` (separate config retired #3958) | `main` (auto) |
| web-staging | app.staging.useatlas.dev | deploy/web/ | `main` (auto) |

**Project:** `satisfied-creation` (08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241)

**Rules:**
- Never expose secrets, tokens, or connection strings in output
- Don't redeploy without asking — a bad redeploy can make things worse
- If Railway CLI isn't linked, fall back to curl health checks + CI status (still useful)
- The API health endpoint is the most informative — it checks all subsystems
- Sidecar has no public URL — check its status via the API health response
- If CI is failing on main, fix that first — a red `main` breaks the **staging** deploy, and a broken staging soak blocks the next `/release`
- A merge to main **does not** reach customers on its own — prod only moves when `/release` advances the `prod` branch. Don't expect prod URLs to reflect a just-merged PR
