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
