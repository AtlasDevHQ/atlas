# Deploy Status

Check production deployment health across all Railway services. Diagnose issues, tail logs, and trigger redeploys.

**Run after pushing to main** to verify deploys landed, or when investigating production issues.

---

**Step 1: Check deploy status for all services**

Run these in parallel:

1. Recent deploys (all services):
   ```
   railway status --json 2>/dev/null || echo "Not linked — will check services individually"
   ```

2. Service health — hit each public endpoint:
   ```bash
   # API health check (most detailed — shows datasource, auth, semantic layer status)
   curl -sf https://api.useatlas.dev/api/health | jq .

   # Web (Next.js) — just check it responds
   curl -sf -o /dev/null -w "%{http_code}" https://app.useatlas.dev

   # Docs site
   curl -sf -o /dev/null -w "%{http_code}" https://docs.useatlas.dev

   # Landing page
   curl -sf -o /dev/null -w "%{http_code}" https://useatlas.dev
   ```

3. CI status (deploys are triggered by pushes to main):
   ```
   gh run list -R AtlasDevHQ/atlas --branch main --limit 3 --json status,conclusion,name,createdAt,databaseId
   ```

4. Railway deploy statuses on the latest commit (catches per-service deploy failures that live health checks miss — Railway keeps the previous deployment running when a new build fails):
   ```bash
   # Railway reports via commit statuses API (not check runs). Dedupe to latest per service:
   gh api repos/AtlasDevHQ/atlas/commits/$(git rev-parse HEAD)/statuses --jq '[.[] | {context, state, description}] | group_by(.context) | map(.[0]) | .[] | "\(.context): \(.state) — \(.description)"' 2>/dev/null
   ```

5. Recent commits on main (to correlate with deploys):
   ```
   git log --oneline -10 --format="%h %s (%cr)"
   ```

**Step 2: Diagnose any failures**

If any health check fails:

### API down
```bash
# Check API logs (requires railway CLI linked to project)
railway service logs --service api --limit 50

# Common causes:
# - Missing env var (check startup.ts validation)
# - Database connection failed (check ATLAS_DATASOURCE_URL, DATABASE_URL)
# - Provider API key expired
# - Sidecar unreachable (check sidecar health)
```

### Web/Docs/WWW down
```bash
railway service logs --service web --limit 50
railway service logs --service docs --limit 50
railway service logs --service www --limit 50

# Common causes:
# - Build failure (check Railway build logs)
# - Next.js config error
# - API URL misconfigured (NEXT_PUBLIC_ATLAS_API_URL)
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
## Production Status

| Service | URL | Status | Last Deploy |
|---------|-----|--------|-------------|
| API | api.useatlas.dev | ✓ healthy / ✗ down | <time> |
| Web | app.useatlas.dev | ✓ 200 / ✗ <code> | <time> |
| Docs | docs.useatlas.dev | ✓ 200 / ✗ <code> | <time> |
| WWW | useatlas.dev | ✓ 200 / ✗ <code> | <time> |
| Sidecar | (internal) | ✓ via API / ✗ down | <time> |

CI: last run <status> (<time>)
Last push: <commit hash> <message> (<time>)
```

**IMPORTANT:** A service can show "healthy" via curl (live endpoint) but have a **failed deploy** in the commit check runs. This happens because Railway keeps the previous deployment running when a new build/deploy fails. Always cross-reference the commit check runs — if a check shows `conclusion: "failure"`, the latest code is NOT deployed even if the endpoint is up.

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

| Service | Internal domain | Config dir |
|---------|----------------|------------|
| api | api.railway.internal | deploy/api/ |
| web | web.railway.internal | deploy/web/ |
| www | www.railway.internal | deploy/www/ |
| docs | docs.railway.internal | deploy/docs/ |
| sidecar | sidecar.railway.internal:8080 | deploy/sidecar/ |

**Project:** `satisfied-creation` (08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241)

**Rules:**
- Never expose secrets, tokens, or connection strings in output
- Don't redeploy without asking — a bad redeploy can make things worse
- If Railway CLI isn't linked, fall back to curl health checks + CI status (still useful)
- The API health endpoint is the most informative — it checks all subsystems
- Sidecar has no public URL — check its status via the API health response
- If CI is failing on main, fix that first (broken CI = broken deploys)
