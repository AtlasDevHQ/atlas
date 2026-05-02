# Production Readiness Audit

Cross-reference the running-system surface against code reality, deployed config, and observed runtime behaviour to find graceful-degradation gaps, observability blind spots, boot-time guards that aren't there yet, and migration/rollback risks. Run before scaling rollouts, after large infra changes, or as a periodic sweep on hosted SaaS deployments.

**Mode:** Read-only audit — generate a report with findings. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps.

**Why this is its own command:** /docs-audit covers code-vs-docs accuracy. /www-audit covers marketing-and-legal accuracy. Neither asks "is the running system actually configured for prod scale, resilience, and observability." That's this command. Its source-of-truth anchors are different: deploy configs, env defaults, OTel instrumentation, settings registry, encryption-key derivation, scheduled tasks, abuse thresholds, plus the live-fetch endpoints that operators consult during incidents.

The audit is most valuable when **Atlas Cloud** is the deployment under review — every finding maps to "could this misroute a customer's data, drop their mail, miss an abuse signal, or hide a P1 from on-call." Self-hosted operators benefit too — the audit doubles as a "is your Atlas instance prod-ready" checklist.

---

## Execution Strategy

Run 4 agents in parallel, one per audit domain. Each agent reads the relevant code and cross-references against the production source of truth (settings registry, env defaults, OTel instrumentation, deployed health endpoints).

The deployed surface as of writing: `api.useatlas.dev`, `api-eu.useatlas.dev`, `api-apac.useatlas.dev`, `app.useatlas.dev`, `docs.useatlas.dev`, `www.useatlas.dev`, plus the sandbox sidecar service (internal). Discover from `memory/railway.md` and `apps/www/src/app/sla/page.tsx` — don't trust this list.

---

## Part A: Observability (HIGH)

**Code surface:** `packages/api/src/lib/effect/` (Effect Layers, especially Telemetry), `packages/api/src/lib/logger.ts`, `packages/api/src/lib/security/abuse.ts` (counter wiring), every route handler under `packages/api/src/api/routes/`, scheduler instrumentation under `packages/api/src/lib/scheduler/`.
**Source of truth:**
- OTel exporter env vars (`OTEL_*` per docs reference)
- Pino logger configuration
- The set of routes that DO carry `requestId` in 500 responses (per CLAUDE.md error-handling rules)

### Steps

1. **OTel coverage** — grep `Effect.tracing` / `Effect.span` / `withSpan` / `Tracer.span` calls across `packages/api/src/`. Build the inventory of instrumented operations. Cross-reference against the agent loop, SQL execution, plugin lifecycle, scheduler ticks, and chat streaming. Flag any high-traffic path with no span.
2. **Structured logs** — every `console.log` / `console.warn` / `console.error` in `packages/api/src/` outside of explicitly-allowed dev paths is a finding (the convention is `pino` via `createLogger("namespace")`). Grep:
   ```bash
   grep -rEn 'console\.(log|warn|error|debug)' packages/api/src/ --include='*.ts' | grep -v __tests__ | grep -v __mocks__
   ```
3. **`requestId` on 500s** — every `c.json({ ..., requestId }, 500)` should match every 500 response. Find unmatched ones:
   ```bash
   grep -rEn '\.json\(\s*\{[^}]*\}\s*,\s*500\b' packages/api/src/ --include='*.ts' | grep -v requestId
   ```
4. **Scheduler instrumentation** — does each scheduled task type emit a span / metric / log when it fires, succeeds, fails? Read `packages/api/src/lib/scheduler/` end-to-end.
5. **Abuse counter wiring** — `packages/api/src/lib/security/abuse.ts` increments counters; do those counters export to a telemetry sink (OTel metrics? a dashboard endpoint?) or are they purely in-memory? In-memory-only is a finding.
6. **Plugin health surface** — each plugin can register a health check. Grep for plugins that don't, or whose health endpoint doesn't surface to the admin console / OTel.

### Findings to flag

| Severity | Pattern |
|---|---|
| HIGH | High-traffic route with no OTel span (chat, query, executeSQL, scheduler tick) |
| HIGH | 500 response without `requestId` |
| MEDIUM | `console.log` outside of dev-only paths |
| MEDIUM | In-memory counter with no export sink |
| MEDIUM | Plugin without a registered health check |
| LOW | OTel span name drift (inconsistent naming convention across services) |

---

## Part B: Graceful Degradation (HIGH)

**Code surface:** `packages/api/src/lib/agent.ts`, `packages/api/src/lib/db/connection.ts`, `packages/api/src/lib/effect/sql.ts`, `packages/api/src/lib/db/internal.ts`, every external-call site (LLM provider, plugin sandbox, email transport, OAuth providers).
**Source of truth:** Run-the-failure-mode mentally — when the LLM provider is unreachable, what does the user see? When the analytics DB is locked, what does `executeSQL` return? When the internal DB is down, does auth break or graceful-degrade?

### Steps

For each upstream dependency, walk the failure path top-to-bottom and document what surfaces to the user. Critical anchors:

1. **LLM provider down** (Anthropic/OpenAI/Bedrock 503/timeout):
   - Does the agent loop retry with backoff or fail immediately?
   - Does the user see a structured `provider_unreachable` / `provider_timeout` error code (per `packages/types/src/errors.ts`) or a stream-end with no signal?
   - Is `retryAfterSeconds` populated on 503 with `Retry-After` header?
2. **Analytics datasource down** (`ATLAS_DATASOURCE_URL` unreachable):
   - Does `executeSQL` surface a clear error to the agent?
   - Does the agent fall through to "I don't have data to answer this" or loop infinitely?
   - Connection-pool exhaustion behavior — what's the error class?
3. **Internal DB down** (`DATABASE_URL` unreachable):
   - Does auth fail open or fail closed? (Should fail closed.)
   - Does the conversation history endpoint return cached/empty or 503?
   - Health check endpoint behavior (must not 200 if internal DB is down for SaaS).
4. **Sandbox sidecar unreachable**:
   - `sandbox.priority` fallback chain per CLAUDE.md (plugin > Vercel > nsjail > sidecar > nsjail auto-detect > just-bash). Does the chain actually fall through, or does the first failure abort?
5. **Email transport down** (Resend 503):
   - Does `sendEmail` retry?
   - Does it queue?
   - Does it surface a structured error to the caller?
   - Critical for `/forgot-password` — a silent drop is a security issue.
6. **OpenStatus / OTel exporter unreachable**:
   - Does the API server boot if the exporter is down? (Telemetry should be best-effort, not block startup.)
7. **Plugin lifecycle failures**:
   - Does a plugin that fails its health check route around or break the request?
   - Does plugin init failure block server boot or warn-and-continue?

### Findings to flag

| Severity | Pattern |
|---|---|
| CRITICAL | Auth fails open on internal-DB outage |
| CRITICAL | Email send silently drops on transport failure (no retry, no queue, no error to caller) |
| HIGH | LLM provider failure surfaces as ambiguous stream-end instead of structured error code |
| HIGH | Sandbox priority fallback chain breaks on first backend's failure (doesn't actually fall through) |
| HIGH | Health endpoint 200s when internal DB is down |
| MEDIUM | Connection-pool exhaustion surfaces as 500 with no `requestId` |
| MEDIUM | OTel exporter outage blocks API boot |

---

## Part C: Config Hygiene & Boot-Time Guards (HIGH)

**Code surface:** `packages/api/src/lib/config.ts`, `packages/api/src/lib/settings.ts`, `packages/api/src/lib/effect/layers.ts` (`buildAppLayer` and the boot Layer DAG), `packages/api/src/lib/startup.ts`, `packages/api/src/lib/email/dpa-guard.ts` (the precedent shape).
**Source of truth:**
- `.env.example` (declared env contract)
- `packages/api/src/lib/settings.ts` (settings registry — what's hot-reloadable, what's startup-only)
- `apps/docs/content/docs/reference/environment-variables.mdx` (just freshly backfilled by /docs-audit)
- Real Railway env values (operator confirms or memory:railway.md hints)

### Steps

1. **Existing boot guards inventory.** Find every boot-time assertion:
   - Encryption-key derivation (`ATLAS_ENCRYPTION_KEYS` versioned keyset, F-47, in `lib/encryption/` or `startup.ts`)
   - SaaS DPA email guard (`lib/email/dpa-guard.ts`, #1969 / win #45)
   - Settings registry validation (corrupt settings → fail boot?)
   - Required-but-unset env vars (`ATLAS_DATASOURCE_URL`, `ATLAS_PROVIDER`, etc. — what fails boot vs warns?)
2. **Missing boot guards** — for each high-risk config setting, ask: would a boot guard have caught it? Candidates:
   - `ATLAS_DEPLOY_MODE=saas` without enterprise enabled (CLAUDE.md says it always resolves to `self-hosted` — should this be a startup warning, not silent?)
   - Region-routing assertions: deployment claims region X (`ATLAS_REGION`?) — does any code verify the matching residency tables exist?
   - Plugin schema validity at boot (vs lazy validation when first invoked)
   - OpenStatus monitor IDs vs deployed monitor inventory (memory: `reference_openstatus.md`)
3. **Default-value safety** — for each numeric config (rate limits, timeouts, pool sizes), is the default appropriate for **prod scale** or for **dev convenience**? Compare:
   - `ATLAS_AGENT_MAX_STEPS` default 25 — fine for prod
   - `ATLAS_QUERY_TIMEOUT` default 30s — fine
   - `ATLAS_ROW_LIMIT` default 1000 — fine
   - Connection pool `pool.perOrg.*` defaults (5 / 30000 / 50 / 2 / 5) — fine for trial-tier, undersized for Business?
   - `ATLAS_RATE_LIMIT_RPM_CHAT` (memory: F-74 separate-bucket chat ceiling) — what's the actual production value vs default?
   - `ATLAS_CONVERSATION_STEP_CAP` default 500 — fine
4. **Hot-reloadable vs startup-only correctness** — settings that affect security-critical paths (DPA email vendor, encryption keys, deploy mode, plan-tier enforcement) should be startup-only OR have a hot-reload path that re-runs the relevant guards. Mismatch is a finding.
5. **Required-but-undocumented env vars** — `/docs-audit` Part A handles this for the docs site, but cross-check that `.env.example` and the docs page agree with what the **deployed** API actually reads in prod paths (vs dev/test-only).

### Findings to flag

| Severity | Pattern |
|---|---|
| CRITICAL | Security-critical setting is hot-reloadable but no path re-runs its boot guard |
| HIGH | Required env var unset in a SaaS region — silent default vs explicit fail |
| HIGH | Numeric default safe for dev but undersized for prod scale |
| MEDIUM | Missing boot guard for a known-risky setting (region/residency/plugin schema) |
| MEDIUM | Settings-registry hot-reload introduces a setting that should be startup-only |

---

## Part D: Migration Safety & Operational Resilience (MEDIUM-HIGH)

**Code surface:** `packages/api/src/lib/db/migrate.ts`, Drizzle migration files (`packages/api/migrations/`), the demo-data seed flow, scheduled tasks, plugin install lifecycle, region-migration paths (`packages/api/src/lib/residency/` if exists, or grep for `region_migrations`).
**Source of truth:**
- Drizzle Kit migration framework (shipped 0.9.6, #978)
- The 3-region cross-region migration shipped in 1.0.0 (#1154)
- Scheduled task lifecycle per `0.6.0` action timeout / rollback work
- Plugin install/uninstall paths

### Steps

1. **Drizzle migrations** — run through every migration file. For each:
   - Is it backward-compatible with one-version-old API instances? (Mid-deploy state where N-1 and N pods both run.)
   - Does it have a rollback path? (Drizzle doesn't auto-generate; check for explicit rollback scripts.)
   - Are there any DDL operations on tables that the running API writes to during migration (e.g. ALTER COLUMN with active inserts)?
2. **Demo-data seeding flow** — fresh signup → onboarding wizard → save → demo connection → first query. Walk the path: any step that's idempotent under retry? Any that races with another user creating the same demo workspace?
3. **Region migration path** — `region_migrations` table per #1154. Walk a customer move: source region marks workspace migrating, destination region writes, source region archives. What happens if step 2 fails mid-flight? What's the rollback?
4. **Scheduled task rollback** — `0.6.0` shipped action timeout + rollback. Confirm scheduled tasks that fail mid-operation actually unwind (not just stop). Read `packages/api/src/lib/scheduler/` and the action-rollback code.
5. **Plugin lifecycle** — install/uninstall path for plugins from the marketplace. Does uninstall correctly tear down DB rows, registered routes, scheduled-task schedules?
6. **Backup integrity** — `0.9.0` shipped automated backups. Is there a verification path (restore-and-diff) or is success measured solely by "the backup script exited 0"?

### Findings to flag

| Severity | Pattern |
|---|---|
| CRITICAL | Migration with no backward-compat path (mid-deploy state would crash N-1 pods) |
| HIGH | Region migration has no documented rollback for partial-failure mid-move |
| HIGH | Scheduled task fails but doesn't unwind (orphaned state) |
| HIGH | Backup is exit-code-success only; no integrity verification path |
| MEDIUM | Demo seed flow races on concurrent signups |
| MEDIUM | Plugin uninstall leaves orphaned DB rows or scheduled tasks |

---

## Part E: Live Surface Cross-Check (LOW-MEDIUM)

**Code surface:** Whatever the audit agents reference + `apps/www/src/app/sla/page.tsx`, `memory/reference_openstatus.md`.
**Source of truth:** Real curl commands.

### Steps

This is the "are we lying about what's deployed" sanity check. Spot-curl each documented endpoint:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.useatlas.dev/api/health
curl -s https://api.useatlas.dev/api/health | jq '.region'
curl -s https://api-eu.useatlas.dev/api/health | jq '.region'
curl -s https://api-apac.useatlas.dev/api/health | jq '.region'
curl -s -o /dev/null -w "%{http_code}\n" https://app.useatlas.dev/login
curl -s -o /dev/null -w "%{http_code}\n" https://docs.useatlas.dev/
curl -s -o /dev/null -w "%{http_code}\n" https://www.useatlas.dev/
curl -s -o /dev/null -w "%{http_code}\n" https://www.useatlas.dev/.well-known/security.txt
curl -s -o /dev/null -w "%{http_code}\n" https://www.useatlas.dev/sitemap.xml
curl -sI https://api.useatlas.dev/api/health | grep -i 'strict-transport\|x-frame\|content-security\|x-content-type'
```

Expected: 200/307 from each landing target, regional /api/health returns the matching region, security headers present.

Bonus: spot-check that `Atlas Cloud's actual platform email vendor` matches the DPA — if you have admin credentials, check the live `ATLAS_EMAIL_PROVIDER` setting via the admin console; otherwise note as "operator should verify."

### Findings to flag

| Severity | Pattern |
|---|---|
| CRITICAL | Documented endpoint 404s or 500s |
| HIGH | Region-routing returns wrong region (api-eu serving us-east traffic) |
| HIGH | Missing security header (HSTS, X-Frame-Options, CSP) |
| MEDIUM | TLS cert near expiry / missing |
| MEDIUM | sitemap.xml returns the OLD hand-maintained file (stale cache or build state) |

---

## Output Format

```markdown
## Summary
- Total checks: X
- PASS: X | DRIFT: X | MISSING: X | STALE: X

## Critical (Must Fix Before Scaling / Could Lose Customer Data)
| Section | Path | Issue | Source |
|---|---|---|---|

## High (Fix This Sprint)
| Section | Path | Issue | Source |
|---|---|---|---|

## Medium (Should Fix)
| Section | Path | Issue | Source |
|---|---|---|---|

## Low (Can Defer)
| Section | Path | Issue | Source |
|---|---|---|---|

## Verified Accurate
- [section]: X items verified
```

---

## Execution

Run 4 agents in parallel:

1. **Observability** (Part A) — OTel coverage, structured-log conformance, requestId on 500s, scheduler instrumentation, abuse counter sinks
2. **Graceful degradation** (Part B) — failure-mode walks for LLM provider, analytics DB, internal DB, sandbox sidecar, email transport, OTel exporter, plugin lifecycle
3. **Config & boot guards** (Part C) — boot-guard inventory, missing-guard candidates, default-value prod-safety, hot-reload-vs-startup correctness, env-var contract drift
4. **Migration & live surface** (Parts D + E) — Drizzle migration backward-compat, region-migration rollback, scheduled-task unwind, backup verification, plugin lifecycle, plus the live-curl spot checks

Each agent should:
- Read the relevant code paths
- Read or curl the source-of-truth surfaces
- Perform the cross-reference checks
- Report findings with severity

After agents complete, compile into the output format above. Fix trivial issues (< 5 lines) directly with a branch + PR. File GH issues for larger gaps:

```bash
gh issue create -R AtlasDevHQ/atlas --title "prod: <description>" --body "<details>" --label "<type>,area: <area>"
```

Use:
- `area: api` for backend / Effect Layer / boot-guard / observability findings
- `area: deploy` for Railway / region / migration / OpenStatus findings
- `area: web` for frontend graceful-degradation findings
- `area: testing` for missing-test findings
- `area: docs` only when the fix is in `apps/docs/`
