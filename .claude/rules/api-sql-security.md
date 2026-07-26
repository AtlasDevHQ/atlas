---
paths:
  - "packages/api/src/lib/tools/**"
  - "packages/api/src/lib/semantic/**"
  - "semantic/**"
---

# SQL security and the validation pipeline

Every rule here is load-bearing for the product's core safety property: the agent can read the customer's data and can never write it.

- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **One AST parse, shared everywhere** — All SQL parsed via `node-sql-parser` (PostgreSQL/MySQL, auto-detected) **exactly once** per validation (`parseOnce` in `lib/tools/sql.ts`): the shape guards (single SELECT, no `SELECT … INTO`, no PG `ONLY`), the forbidden-function AST walk (`pg_read_file`, `dblink`, `pg_sleep`, `load_file`, …), the table whitelist, and the query classifier all read that same parse — one table set by construction, so the classifier that drives approval gating + PII masking can never diverge from the whitelist. Regex guard is a first pass, not the only check. Unparseable queries are **rejected**, never silently skipped
- [ ] **Table whitelist** — Only whitelisted semantic-layer tables are queryable (`packages/api/src/lib/semantic/whitelist.ts`). File layouts: `semantic/entities/` (default group), `semantic/groups/<group>/entities/` (canonical per-group, [ADR-0012](docs/adr/0012-group-scoped-semantic-layer-directories.md) — the directory is authoritative), `semantic/<source>/entities/` (legacy). On SaaS the whitelist is DB-backed (`semantic_entities` keyed by connection group, `loadOrgWhitelist`). A failed scan **fails closed** (`getWhitelistedTablesStrict`) — never falls back to a broader set. Schema-qualified queries need the qualified name in the whitelist
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL/MySQL get a session-level timeout. Default 30s, via `ATLAS_QUERY_TIMEOUT`

## The pipeline

Validation (all consumers share **one** AST parse — `parseOnce` in `lib/tools/sql.ts`):

0. Empty check → 1. Regex mutation guard → 2. AST shape guards (single SELECT, no `SELECT…INTO`, forbidden functions, PG `ONLY`) → 3. Table whitelist + query classification from the same parse (CTE names excluded)

At execution: RLS injection (optional; reuses the threaded parse) → Auto LIMIT → Statement timeout.

Routing: `lib/tools/sql-execution-plan.ts` (`resolveSqlExecutionPlan`) resolves reach → routing mode → per-leg execution targets into a discriminated plan — `reject` (out-of-reach is a hard error, never a silent re-route) | `single` | `fanout`. The same `resolveReachableGroups` feeds both the advertised source catalog and the enforcing gate, so advertised == enforceable by construction (ADR-0022).
