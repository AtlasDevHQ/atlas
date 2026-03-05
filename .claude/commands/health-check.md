# Atlas Codebase Health Check

Perform a comprehensive codebase audit against CLAUDE.md guidelines and established patterns. Run periodically (~10 PRs) to catch drift and technical debt.

**Mode:** Read-only — do NOT make changes. Generate a structured report.

---

## Part A: Gate Checks (Must Pass)

### A0. Lint, Type Check, Tests & Dependency Sync

Run all four CI gates. If any fail, stop and report — the codebase is broken.

```bash
bun run lint           # ESLint (flat config) — 0 warnings
bun run type           # TypeScript strict mode via tsgo — 0 errors
bun run test           # bun test across @atlas/api + @atlas/cli + @atlas/mcp
bun x syncpack lint    # Workspace dependency versions consistent
```

| Check | What to Look For |
|-------|------------------|
| Lint warnings | Any output = FAIL |
| Type errors | Any output = FAIL |
| Test failures | Any `FAIL` = FAIL |
| Version drift | syncpack lint errors = FAIL (fix with `bun run deps:fix`) |

**If any gate fails, stop and report the failures before proceeding.**

---

## Part B: Security (SQL) — CRITICAL

### B1. SQL Validation Pipeline Integrity

**Reference:** `packages/api/src/lib/tools/sql.ts`, `packages/api/src/lib/tools/__tests__/sql.test.ts`

The 4-layer pipeline is Atlas's primary security boundary. Verify it hasn't been weakened.

| Check | What to Verify |
|-------|----------------|
| Regex guard | All DML/DDL keywords blocked: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE, EXEC, COPY, LOAD, VACUUM, REINDEX |
| DB-specific patterns | MySQL: SHOW, DESCRIBE, HANDLER, LOAD DATA. ClickHouse: OPTIMIZE, SYSTEM, DETACH. Snowflake: MERGE, PUT, GET, COPY INTO. DuckDB: PRAGMA, INSTALL, ATTACH |
| AST parse rejection | `node-sql-parser` rejects invalid queries — **never** silently allows unparseable SQL through |
| Table whitelist | Only tables from `semantic/entities/*.yml` or `semantic/{source}/entities/*.yml` queryable. Schema-qualified refs require qualified name in whitelist |
| CTE handling | CTE names extracted from AST and excluded from whitelist check (not exploitable as bypass) |
| Auto LIMIT | Every query gets LIMIT appended. Default 1000, configurable via `ATLAS_ROW_LIMIT` |
| Statement timeout | Session-level timeout set. Default 30s, configurable via `ATLAS_QUERY_TIMEOUT` |

**Grep checks:**
```
Grep for: validateSQL|BLOCKED_PATTERNS|BLOCKED_KEYWORDS in packages/api/src/lib/tools/sql.ts
Verify test count: packages/api/src/lib/tools/__tests__/sql.test.ts should have 115+ test cases
```

**Red flags:**
- Any code path that bypasses AST validation
- `catch` blocks that swallow parse errors and allow the query through
- New SQL operations that skip `validateSQL`

---

### B2. Readonly Database Enforcement

**Reference:** `packages/api/src/lib/db/connection.ts`

| Database | Enforcement Method |
|----------|-------------------|
| PostgreSQL | Validation-only (SELECT-only via validateSQL). `statement_timeout` + `search_path` per-connection |
| MySQL | `SET SESSION TRANSACTION READ ONLY` + `SET SESSION MAX_EXECUTION_TIME` |
| ClickHouse | `readonly: 1` per-query setting |
| Snowflake | Stage operation blocking (PUT, GET, COPY INTO blocked in validateSQL) |
| DuckDB | File read blocking (ATTACH, INSTALL blocked in validateSQL), memory limits |
| Salesforce | SOQL validation (separate path) |

**Check:** Each database adapter sets readonly/timeout at connection or session level. No adapter skips this.

---

### B3. Secrets Protection

**Reference:** `packages/api/src/lib/security.ts`, `packages/api/src/lib/auth/audit.ts`

| Check | What to Verify |
|-------|----------------|
| `SENSITIVE_PATTERNS` regex | Covers password, secret, credential, SSL, connection strings |
| SQL tool scrubbing | Error messages scrubbed before returning to agent |
| Audit log scrubbing | Secrets scrubbed before persisting to DB |
| Logger redaction | Pino redaction paths prevent secrets in structured logs |
| Health endpoint | Does NOT expose connection strings, API keys, or internal state |
| Error responses | Stack traces never sent to client |

**Grep checks:**
```
Grep for: SENSITIVE_PATTERNS|scrubSensitive|redact in packages/api/src/
Grep for: stack|stackTrace in packages/api/src/api/ — should not appear in response bodies
```

---

### B4. Explore Tool Isolation

**Reference:** `packages/api/src/lib/tools/explore.ts`, `packages/api/src/lib/tools/explore-nsjail.ts`

| Check | What to Verify |
|-------|----------------|
| `resolveSafePath` | Restricts all file reads to `semantic/` directory. No `..` traversal possible |
| Allowed commands | Only `ls`, `cat`, `grep`, `find` — no writes, no shell escapes |
| Sandbox priority | Vercel sandbox > nsjail > just-bash. `ATLAS_SANDBOX=nsjail` enforces hard failure if nsjail unavailable |
| nsjail config | No network, read-only `semantic/` mount, no host secrets, runs as nobody:65534 |
| No silent degradation | When `ATLAS_SANDBOX=nsjail`, missing nsjail binary = error (not fallback to just-bash) |

**Red flags:**
- New commands added to the allowed list without security review
- Sandbox backend that silently falls back to a less-secure option
- Path resolution that doesn't canonicalize symlinks

---

## Part C: Auth & Access Control — HIGH

### C1. Auth System Integrity

**Reference:** `packages/api/src/lib/auth/`

| Check | What to Verify |
|-------|----------------|
| Mode detection | Priority: JWKS > Better Auth > API key > none. Cached after first call |
| Simple key | Timing-safe comparison (`timingSafeEqual`), not `===` |
| Managed auth | `BETTER_AUTH_SECRET` min 32 chars enforced |
| BYOT | JWKS endpoint validated, issuer check, optional audience check |
| Rate limiting | Per-user (authenticated) or per-IP (fallback). 429 with Retry-After header |
| Audit logging | All queries logged with user identity, scrubbed SQL, timing |

**Grep checks:**
```
Grep for: timingSafeEqual in packages/api/src/lib/auth/simple-key.ts — must be present
Grep for: authenticateRequest in packages/api/src/api/routes/ — every route that needs auth uses it
```

---

## Part D: Code Quality — HIGH

### D1. No Secrets in Source

```
Grep for: sk-ant-|sk-proj-|AKIA|password\s*=\s*["'] in packages/ and examples/ and apps/
Exclude: .env.example, test files with obviously fake values, CLAUDE.md documentation
```

Any real-looking API key, connection string, or credential = CRITICAL.

---

### D2. Console Usage in Production Code

```
Grep for: console\.(log|error|warn|debug|info) in packages/api/src/ and packages/cli/bin/ and packages/mcp/src/
Exclude: test files (*test*, *spec*), test-setup.ts
```

| Location | Acceptable? |
|----------|-------------|
| `explore-nsjail.ts` | Yes — child process stderr logging |
| Test files | Yes |
| Everything else | No — should use Pino logger |

---

### D3. TODO/FIXME/HACK Audit

```
Grep for: TODO|FIXME|HACK|XXX|TEMP in packages/ and apps/ and examples/
Exclude: node_modules/, .next/, dist/
```

For each found: assess whether it's tracked in a GitHub issue. Untracked TODOs = tech debt.

---

### D4. Error Handling Quality

| Check | What to Verify |
|-------|----------------|
| No swallowed errors | `catch` blocks don't silently ignore errors (empty catch or catch-and-continue) |
| Structured errors | API routes return structured JSON errors, not raw strings |
| No `any` in catch | `catch (e: any)` should be `catch (e)` with proper narrowing |

```
Grep for: catch\s*\( in packages/api/src/ — review each for swallowed errors
Grep for: catch.*any in packages/api/src/ — flag improper typing
```

---

## Part E: Architecture Compliance — HIGH

### E1. Frontend Isolation

**Rule:** `@atlas/web` does NOT depend on `@atlas/api`. Frontend talks to API over HTTP only.

```
Check: packages/web/package.json should NOT list @atlas/api as a dependency
Grep for: @atlas/api in packages/web/src/ — should find ZERO matches
```

**Exception:** `examples/nextjs-standalone/` embeds `@atlas/api` server-side via catch-all route (this is intentional).

---

### E2. Import Hygiene

| Check | What to Verify |
|-------|----------------|
| No cross-boundary relative imports | No `../../../packages/` style imports crossing workspace boundaries |
| Correct aliases | `@atlas/api` uses package name for imports. `@atlas/web` uses `@/` |
| Package exports respected | Imports use paths defined in package.json `exports` field |

```
Grep for: \.\./\.\./\.\./packages in packages/ — should find ZERO
Grep for: from ['"]\.\./ in packages/api/src/ — check none cross package boundaries
```

---

### E3. Server External Packages

**Rule:** `pg`, `mysql2`, `@clickhouse/client`, `just-bash`, `pino`, `pino-pretty` must stay in `serverExternalPackages` in the `create-atlas` template.

```
Check: create-atlas/ template's next.config — verify serverExternalPackages list is complete
Check: examples/nextjs-standalone/ next.config — same verification
```

---

### E4. bun Only

**Rule:** Never npm, yarn, or node.

```
Grep for: npm run|npm install|yarn |npx |node_modules/\.bin in packages/ and scripts/ and .github/
Exclude: CLAUDE.md, README.md, docs/ (documentation may mention npm for context)
```

All scripts, CI, and Dockerfiles should use `bun` exclusively.

---

## Part F: Agent & Tools Compliance — MEDIUM-HIGH

### F1. Agent Step Limit

**Reference:** `packages/api/src/lib/agent.ts`

```
Grep for: stepCountIs|maxSteps|stopWhen in packages/api/src/lib/agent.ts
```

| Check | What to Verify |
|-------|----------------|
| Max steps | `stopWhen: stepCountIs(25)` or equivalent — don't increase without good reason |
| No infinite loops | No code path that could bypass step counting |

---

### F2. Tool Return Structure

**Rule:** Tools return structured data, not raw strings.

| Tool | Expected Return |
|------|----------------|
| `executeSQL` | `{ columns, rows }` |
| `explore` | Structured file/directory content |

```
Check: packages/api/src/lib/tools/*.ts — verify return types match expected structure
```

---

### F3. Tool Registry Immutability

**Reference:** `packages/api/src/lib/tools/registry.ts`

| Check | What to Verify |
|-------|----------------|
| Default registry frozen | `defaultRegistry.freeze()` called — no runtime mutations |
| No tool injection | No code path adds tools to a frozen registry |

---

## Part G: Deployment Compliance — MEDIUM

### G1. Dockerfile Consistency

| Check | What to Verify |
|-------|----------------|
| Bun version pinned | All Dockerfiles use exact same `oven/bun:X.Y.Z` version matching CI `BUN_VERSION` |
| Non-root user | Final stage runs as non-root (atlas:atlas or similar) |
| Health check | `HEALTHCHECK` instruction present, hits `/api/health` |
| No secrets baked in | No `ENV` or `ARG` with real credentials |
| Multi-stage build | Deps/build stages separated from runtime stage |

```
Check all Dockerfiles: examples/docker/Dockerfile
Grep for: oven/bun: — verify version matches
Grep for: USER — verify non-root
Grep for: HEALTHCHECK — verify present
```

---

### G2. Environment Variable Hygiene

| Check | What to Verify |
|-------|----------------|
| `.env` not committed | `.gitignore` includes `.env` |
| `.env.example` current | All env vars from CLAUDE.md have entries in `.env.example` |
| Startup validation | `packages/api/src/lib/startup.ts` checks for required vars |
| No deprecated vars | No code references removed/renamed env vars |

---

## Part H: Semantic Layer & Config — MEDIUM

### H1. Semantic Layer Schema

```
Check: semantic/entities/*.yml — valid YAML with required fields (table, description, columns)
Check: semantic/catalog.yml — lists all entities
Check: semantic/glossary.yml — ambiguous terms marked
```

| Check | What to Verify |
|-------|----------------|
| Entity files parse | All YAMLs load without errors |
| Required fields | Every entity has `table`, `description`, `columns` |
| Column types valid | Types are: text, integer, real, numeric, date, boolean (or DB-specific equivalents) |
| Metrics reference valid tables | `semantic/metrics/*.yml` reference tables that exist in entities |

---

### H2. Declarative Config

**Reference:** `packages/api/src/lib/config.ts`

| Check | What to Verify |
|-------|----------------|
| Config precedence | `atlas.config.ts` overrides env vars for datasources/tools when present |
| Env var fallback | Without config file, env vars work exactly as documented |
| Config schema | Zod validation catches malformed configs at startup |

---

## Part I: Observability — MEDIUM

### I1. Structured Logging

**Reference:** `packages/api/src/lib/logger.ts`

| Check | What to Verify |
|-------|----------------|
| Pino used everywhere | No raw `console.log` in production paths (see D2) |
| Request context | `requestId` + `userId` bound via AsyncLocalStorage |
| Redaction | Sensitive fields redacted in log output |
| Log levels | Appropriate levels used (error for errors, warn for warnings, not info for everything) |

---

### I2. Health Endpoint

**Reference:** `packages/api/src/api/routes/health.ts`

| Check | What to Verify |
|-------|----------------|
| Probes all systems | Datasource, internal DB, semantic layer, explore backend, auth mode |
| No secrets exposed | Response doesn't include connection strings, API keys |
| Stale state detection | Backend capability failures correctly reflected (not cached stale) |

---

## Part J: Documentation Sync — LOW

### J1. CLAUDE.md Accuracy

| Check | What to Verify |
|-------|----------------|
| Quick Reference table | All file paths exist and point to correct files |
| Architecture section | Package list matches actual `packages/` directory |
| Commands section | All `bun run` commands work |
| Env var table | All listed env vars are actually read by the codebase |
| Provider table | Provider list matches `packages/api/src/lib/providers.ts` |

---

### J2. Example Configs

| Check | What to Verify |
|-------|----------------|
| docker-compose.yml files | Port mappings, volume mounts consistent with docs |
| Platform configs | `railway.json`, `render.yaml` reference correct ports and commands |
| Package versions | Example package.json versions match monorepo (syncpack should catch this) |

---

## Execution Strategy

Use the Task tool with `subagent_type=Explore` to parallelize investigation. Run up to 4 agents in parallel:

1. **Gate agent** — Run A0 checks (lint, type, test, syncpack)
2. **Security agent** — Run B1-B4 and C1 checks (SQL validation, secrets, explore isolation, auth)
3. **Architecture agent** — Run D1-D4, E1-E4, F1-F3, G1-G2 checks (code quality, imports, deployment)
4. **Compliance agent** — Run H1-H2, I1-I2, J1-J2 checks (semantic layer, observability, docs)

---

## Output Format

```markdown
## Gate Results
- [ ] Lint: PASS/FAIL (details if fail)
- [ ] Type check: PASS/FAIL
- [ ] Tests: PASS/FAIL (X passed, Y failed)
- [ ] Syncpack: PASS/FAIL

## Critical Issues (Must Fix)
| File:Line | Section | Issue | Fix |
|-----------|---------|-------|-----|

## High Issues (Fix Soon)
| File:Line | Section | Issue | Fix |
|-----------|---------|-------|-----|

## Medium Issues (Should Fix)
| File:Line | Section | Issue | Fix |
|-----------|---------|-------|-----|

## Low Issues (Can Defer)
| File:Line | Section | Issue | Recommendation |
|-----------|---------|-------|----------------|

## Positive Patterns (Keep Doing)
- Pattern — Where it's done well
```

---

## Priority Order

1. **GATE (A0):** Lint, Type, Tests, Syncpack — must pass before proceeding
2. **CRITICAL (B1-B4):** SQL validation pipeline, readonly enforcement, secrets, explore isolation
3. **HIGH (C1, D1-D4, E1-E2):** Auth integrity, no secrets in source, console usage, error handling, frontend isolation, import hygiene
4. **MEDIUM-HIGH (E3-E4, F1-F3):** Server external packages, bun-only, agent compliance, tool registry
5. **MEDIUM (G1-G2, H1-H2, I1-I2):** Deployment, semantic layer, observability
6. **LOW (J1-J2, K1):** Documentation sync, dev tooling

---

## Focus Areas

Start with these directories:

| Priority | Directory | What to Check |
|----------|-----------|---------------|
| CRITICAL | `packages/api/src/lib/tools/` | SQL validation, explore isolation, tool registry |
| CRITICAL | `packages/api/src/lib/security.ts` | Secrets scrubbing patterns |
| HIGH | `packages/api/src/lib/auth/` | Auth modes, rate limiting, audit |
| HIGH | `packages/api/src/lib/db/` | Connection adapters, readonly enforcement |
| HIGH | `packages/api/src/api/routes/` | Route auth, error handling |
| MEDIUM | `packages/web/src/` | Frontend isolation, no API imports |
| MEDIUM | `packages/api/src/lib/agent.ts` | Step limit, tool orchestration |
| MEDIUM | `examples/` | Dockerfile compliance, config consistency |
| LOW | `semantic/` | YAML validity, entity completeness |
| LOW | `CLAUDE.md` | Documentation accuracy |

---

## Part K: Dev Tooling — LOW

### K1. Portless Integration

**Reference:** Root `package.json`, `.env.example`

| Check | What to Verify |
|-------|----------------|
| devDependency present | `portless` in root `package.json` devDependencies |
| Dev scripts use portless | `dev` script starts proxy (`portless proxy start &&`) and wraps with `portless api.atlas` and `portless atlas` |
| Backward compat | `dev:api` and `dev:web` do NOT use portless |
| Production unaffected | `scripts/start.sh` has zero portless references |
| CI unaffected | `.github/workflows/` has zero portless references |
| `.env.example` documented | `ATLAS_API_URL=http://api.atlas.localhost:1355` documented |

**Red flags:**
- portless in production dependencies (must be devDependencies only)
- portless referenced in Dockerfiles or CI workflows
