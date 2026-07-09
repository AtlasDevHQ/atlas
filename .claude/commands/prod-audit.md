# Production Readiness Audit

Cross-reference the running-system surface against code reality, deployed config, and observed runtime behaviour to find graceful-degradation gaps, observability blind spots, boot-time guards that aren't there yet, and migration/rollback risks. Run before scaling rollouts, after large infra changes, or as a periodic sweep on hosted SaaS deployments.

**Mode:** Read-only audit — generate a report with findings. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps.

**Why this is its own command:** /docs-audit covers code-vs-docs accuracy. /www-audit covers marketing-and-legal accuracy. Neither asks "is the running system actually configured for prod scale, resilience, and observability." That's this command. Its source-of-truth anchors are different: deploy configs, env defaults, OTel instrumentation, settings registry, encryption-key derivation, scheduled tasks, abuse thresholds, plus the live-fetch endpoints that operators consult during incidents.

The audit is most valuable when **Atlas Cloud** is the deployment under review — every finding maps to "could this misroute a customer's data, drop their mail, miss an abuse signal, or hide a P1 from on-call." Self-hosted operators benefit too — the audit doubles as a "is your Atlas instance prod-ready" checklist.

**Before starting:** read [docs/agents/audits.md](../../docs/agents/audits.md) (shared audit conventions) and run its **Step 0 self-check** against this command file — fix any drifted references in this file as part of the run. *Last verified against the codebase: 2026-07-09.*

---

## Execution Strategy

Run 4 agents in parallel, one per audit domain. Each agent reads the relevant code and cross-references against the production source of truth (settings registry, env defaults, OTel instrumentation, deployed health endpoints).

The deployed surface as of writing: `api.useatlas.dev`, `api-eu.useatlas.dev`, `api-apac.useatlas.dev`, `app.useatlas.dev`, `docs.useatlas.dev`, `www.useatlas.dev`, plus the sandbox sidecar service (internal). Discover from the `deploy/` directory (one subdirectory per deployed service: `api`, `api-eu`, `api-apac`, `web`, `www`, `docs`, `dns` — railway.json + Dockerfiles are the in-repo deploy SSOT), supplemented by `memory/railway.md` when available — don't trust this list.

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

**Code surface:** `packages/api/src/lib/agent.ts`, `packages/api/src/lib/db/connection.ts`, `packages/api/src/lib/tools/sql.ts` + `packages/api/src/lib/tools/sql-execution-plan.ts`, `packages/api/src/lib/db/internal.ts`, every external-call site (LLM provider, plugin sandbox, email transport, OAuth providers).
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
4. **Sandbox backend unreachable** — the correct behavior DIFFERS by deploy mode:
   - **Self-hosted default chain** (`lib/tools/backends/selection.ts`: plugin/BYOC > Vercel sandbox > nsjail explicit > sidecar > nsjail auto-detect > just-bash dev-only): does the chain actually fall through, or does the first failure abort?
   - **SaaS pins `["vercel-sandbox"]`** in `deploy/api/atlas.config.ts` — deny-all egress, **fail-closed on exhaustion**. On SaaS, falling through to another backend (especially `just-bash`) is a CRITICAL isolation-escape finding, NOT graceful degradation. Verify exhaustion surfaces a structured error and does not fall back.
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
| CRITICAL | SaaS sandbox falls back past the pinned `vercel-sandbox` backend (must fail closed) |
| HIGH | Self-hosted sandbox priority chain breaks on first backend's failure (doesn't actually fall through) |
| HIGH | Health endpoint 200s when internal DB is down |
| MEDIUM | Connection-pool exhaustion surfaces as 500 with no `requestId` |
| MEDIUM | OTel exporter outage blocks API boot |

---

## Part C: Config Hygiene & Boot-Time Guards (HIGH)

**Code surface:** `packages/api/src/lib/config.ts`, `packages/api/src/lib/settings.ts`, `packages/api/src/lib/effect/layers.ts` (`buildAppLayer` and the boot Layer DAG), `packages/api/src/lib/startup.ts`, `packages/api/src/lib/email/dpa-guard.ts` (the precedent shape).
**Source of truth:**
- `.env.example` (declared env contract)
- `packages/api/src/lib/settings.ts` (settings registry — what's hot-reloadable, what's startup-only)
- `apps/docs/content/shared/reference/environment-variables.mdx` (just freshly backfilled by /docs-audit)
- Real Railway env values (operator confirms or memory:railway.md hints)

### Steps

1. **Existing boot guards inventory.** Find every boot-time assertion:
   - **The SaaS boot contract** — `SAAS_ENV_KEYS` in `lib/effect/saas-env.ts` enumerates every env var SaaS-mode boot reads, and the fail-closed guards in `lib/effect/saas-guards.ts` (Turnstile, rate-limit RPM, billing, MCP spine, …) refuse to boot without them. This is the primary inventory — audit its *coverage* (is every SaaS-critical input in the contract?), not its existence. Full audit doc: `docs/development/saas-env-audit.md`
   - Versioned encryption keyset (`db/secret-encryption.ts` — versioned AES-256-GCM; rotation runbook at `apps/docs/content/docs/platform-ops/encryption-key-rotation.mdx`)
   - SaaS DPA email guard (`lib/email/dpa-guard.ts`, #1969)
   - Settings registry validation (corrupt settings → fail boot?)
   - Required-but-unset env vars (`ATLAS_DATASOURCE_URL`, `ATLAS_PROVIDER`, etc. — what fails boot vs warns?)
   - **The dev relaxation footgun** — `relaxSaasGuardForDev` no-ops ALL SaaS fail-closed guards when `ATLAS_DEPLOY_ENV=development`. Verify no customer-facing deploy config (`deploy/api*/`) sets `development`; that would silently disable every boot guard → CRITICAL
2. **Missing boot guards** — for each high-risk config setting, ask: would a boot guard have caught it? Candidates:
   - `ATLAS_DEPLOY_MODE=saas` requires `/ee` (resolution via `resolveDeployMode`; without enterprise it resolves to `self-hosted`) — is the mismatch loud at boot or silent?
   - Region-routing assertions: deployment claims region X (`ATLAS_REGION_*` / residency config) — does any code verify the matching residency tables exist?
   - Plugin schema validity at boot (vs lazy validation when first invoked)
   - OpenStatus monitor IDs vs deployed monitor inventory (memory: `reference_openstatus.md`, if available)
3. **Default-value safety** — for each numeric config (rate limits, timeouts, pool sizes), is the default appropriate for **prod scale** or for **dev convenience**? Compare:
   - `ATLAS_AGENT_MAX_STEPS` default 25 — fine for prod
   - `ATLAS_QUERY_TIMEOUT` default 30s — fine
   - `ATLAS_ROW_LIMIT` default 1000 — fine
   - Connection pool `pool.perOrg.*` defaults (5 / 30000 / 50 / 2 / 5) — fine for trial-tier, undersized for Business?
   - `ATLAS_RATE_LIMIT_RPM_CHAT` (memory: F-74 separate-bucket chat ceiling) — what's the actual production value vs default?
   - `ATLAS_CONVERSATION_STEP_CAP` default 500 — fine
4. **Hot-reloadable vs startup-only correctness** — the lock mechanism now exists: `SAAS_IMMUTABLE_KEYS` (in `lib/effect/saas-env.ts`) blocks runtime mutation of boot-guard-dependent keys. Audit its MEMBERSHIP, not its existence: every setting whose value a boot guard validated (DPA email vendor, encryption keys, deploy mode, plan-tier enforcement) must be in the immutable set or have a hot-reload path that re-runs the guard. A guard-validated key that's runtime-mutable is the finding.
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

**Code surface:** `packages/api/src/lib/db/migrate.ts`, SQL migration files (`packages/api/src/lib/db/migrations/`), the demo-data seed flow, scheduled tasks, plugin install lifecycle, region-migration paths (`packages/api/src/lib/residency/`).
**Source of truth:**
- Drizzle Kit migration framework (shipped 0.9.6, #978)
- The 3-region cross-region migration shipped in 1.0.0 (#1154)
- Scheduled task lifecycle per `0.6.0` action timeout / rollback work
- Plugin install/uninstall paths

### Steps

1. **Migrations** — three CI guards now cover the mechanical cases; verify they're green and audit only what they DON'T cover:
   - `scripts/check-migration-rename-discipline.sh` enforces two-phase drop (no single-phase `RENAME COLUMN`/`DROP COLUMN` — the N-1↔N deploy-overlap case). Covered.
   - `scripts/check-schema-drift.sh` enforces schema.ts mirrors (prevents the next `drizzle-kit generate` emitting a `DROP TABLE`). Covered.
   - `migrate-pg.test.ts` runs every migration against real Postgres. Covered.
   - **Residual audit surface:** long-lock DDL on hot tables (e.g. non-`CONCURRENTLY` index builds, `ALTER COLUMN` type changes with active writes), data backfills in `db/migrations/scripts/` that aren't idempotent under retry, and rollback paths (none are auto-generated — check for explicit rollback scripts on risky migrations)
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

**Code surface:** Whatever the audit agents reference + the `deploy/` directory (service inventory) + `memory/reference_openstatus.md` when available.
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

## Part F: Security Seam Sweep (pre-tag runs — HIGH)

**When:** only when running with a release-cycle window (`$LAST_TAG..HEAD`, per [docs/agents/audits.md](../../docs/agents/audits.md)). `/security-review` covers a *branch's pending diff*; this part covers the *whole cycle* on the seams where a subtle regression is a tenant-isolation or data-exposure incident.

**Method:** for each seam below, `git log "$LAST_TAG"..HEAD --oneline -- <paths>`. Zero commits → PASS, record and move on. Otherwise read each touching diff and verify the seam's invariant survived. Guard-first: where a guard script is listed, run it — a green guard closes the mechanical half of the check; the diff review covers semantics the guard can't see.

| Seam | Paths | Invariant to verify | Guard |
|---|---|---|---|
| SQL validation | `packages/api/src/lib/tools/sql.ts`, `sql-execution-plan.ts` | One AST parse shared by ALL consumers (shape guards, forbidden functions, whitelist, classifier); unparseable → rejected, never skipped; out-of-reach → `reject`, never silent re-route | — |
| Table whitelist | `packages/api/src/lib/semantic/whitelist.ts` | Failed scan **fails closed** (`getWhitelistedTablesStrict`); never falls back to a broader set | — |
| Secret encryption | `packages/api/src/lib/db/secret-encryption.ts`, `db/integration-tables.ts`, `db/internal.ts` | New credential tables joined `INTEGRATION_TABLES` with `_encrypted` columns; the legacy `internal.ts` passthrough gained NO new call sites (frozen at two columns) | — |
| Sandbox selection | `packages/api/src/lib/tools/backends/selection.ts`, `deploy/api/atlas.config.ts` | SaaS still pins `["vercel-sandbox"]`, deny-all egress, fail-closed on exhaustion | — |
| Tenant credential resolution | Twenty/plugin credential resolvers | `resolveWorkspaceCredentials` stays DB-only in both deploy modes; no plugin install reads operator env | `scripts/check-twenty-resolver-imports.sh` |
| Auth & enterprise auth | `packages/api/src/lib/auth/`, `ee/src/auth/` (sso, scim, roles, ip-allowlist) | No fail-open path introduced (a `catch { return false }` on an authz check is a false *negative* only if false means denied — verify direction); session/timeout semantics unchanged unless intended | — |
| MCP security model | `packages/mcp/src/` (esp. `actor.ts`, `onboarding.ts`, `dispatch-gate.ts`, `billing-gate.ts`), `packages/api/src/lib/mcp/` | ADR-0016 model intact; `@atlas/ee` coupling confined to the two audited seam files (`MCP_ALLOWED_FILES`) | `scripts/check-ee-imports.sh` |
| EE boundary | `packages/api/src/lib/effect/enterprise-layer.ts` | Still the ONLY core file importing `@atlas/ee`; Noop layers still fail closed for gated features | `scripts/check-ee-imports.sh` + `consumer-fail-closed.test.ts` |
| Content publish | `packages/api/src/api/routes/admin-publish.ts`, `packages/api/src/lib/content-mode/` | `/api/v1/admin/publish` remains the single draft→published path; no new out-of-band status stamping without a recorded carve-out | — |
| RLS injection | RLS paths in `packages/api/src/lib/tools/` (grep `rls`) | Injection still reuses the threaded parse; RLS can't be bypassed by a query shape the validator accepts | — |

### Findings to flag

| Severity | Pattern |
|---|---|
| CRITICAL | Any invariant above regressed (fail-closed became fail-open, second parse introduced, new env-credential read, sandbox fallback un-pinned) |
| HIGH | Seam commit whose diff can't be confirmed safe from reading (needs a human or a deeper session) — name the commit, don't wave it through |
| MEDIUM | Guard script covering a seam was itself modified this cycle (verify the guard still guards) |

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
4. **Migration & live surface** (Parts D + E) — migration backward-compat residue, region-migration rollback, scheduled-task unwind, backup verification, plugin lifecycle, plus the live-curl spot checks

When running pre-tag with a release-cycle window, add a 5th agent:

5. **Security seam sweep** (Part F) — per-seam `$LAST_TAG..HEAD` diff review + guard runs; skip on non-cycle runs

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
