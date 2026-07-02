# executeSQL-over-REST: the validation pipeline is the sole boundary, so raw SQL is reached only as a delegated *member* credential, audited to its human owner

**Status:** accepted
**Date:** 2026-06-28
**See also:** [ADR-0025](0025-workspace-self-service-surfaces.md) (workspace self-service surfaces — two transports over one gated core), [ADR-0026](0026-cli-credential-key-scoping.md) (CLI credential key-scoping), [ADR-0016](0016-mcp-v2-security-model.md) (MCP V2 security model / the dispatch gate chain), [ADR-0015](0015-agent-origin-not-surface.md) (agent origin, not surface), [CLAUDE.md](../../CLAUDE.md) (SQL validation 4 layers)

## Context

ADR-0025 §3 names four MCP capabilities with no REST equivalent — `executeSQL`, `runMetric`, `profile_datasource`, `explore` — and §62 flags **`executeSQL`-over-REST** as "a genuine new attack surface … strictly more exposed than a tool inside an in-process MCP," to be opened only "behind a grill of the key-scoping and the `executeSQL`-over-REST surface specifically." This ADR records that grill (issue #4047), held 2026-06-28.

The grill turned on one corrected fact that reframes the whole surface:

**SQL is never sandboxed — not in the GUI, not in the MCP, not in the CLI — and that is correct by design.** The Vercel/nsjail/sidecar sandbox isolates exactly two tools (`explore`, `python`): *untrusted code running on Atlas's own host*, with `networkPolicy: "deny-all"` so it cannot even reach a datasource. SQL is the opposite shape: it executes **inside the customer's database** via the `ConnectionRegistry` driver pool (`db.query(...)`), reached only by the trusted API process that holds the credentials. There is no Atlas-side process to isolate, so a sandbox would add nothing — and the sandbox is deliberately *forbidden* from reaching the datasource. The containment for SQL is therefore, and can only be, **what query is allowed to be sent** (the 4-layer validation pipeline → table whitelist → RLS injection → auto-LIMIT → statement timeout) **and the connection's read-only privilege** (`SET default_transaction_read_only = on` + a read-only DB role).

That pipeline *is* the entire security boundary. Today only two semi-trusted authors reach it: Atlas's own agent loop (the LLM writes SQL under semantic-layer guidance) and the in-process MCP tool. #4047 widens the author to a **portable, file-stored credential** held by an **untrusted external party** (the customer's own Claude/Codex, a human, or a CI script) writing arbitrary SQL straight at the whitelist. The grill's job was not to add a sandbox (impossible) but to confirm the pipeline-plus-readonly-connection is airtight enough to be the *sole* boundary for an untrusted author, and that the credential is scoped to exactly one workspace at exactly the caller's member reach.

Two query **shapes** frame the surface:

- **Shape A — NL-agent query.** Caller sends a *question*; **Atlas's server-side LLM** writes and runs the SQL (chat GUI, `POST /api/v1/query`, CLI `atlas query`). Token-metered.
- **Shape B — raw SQL.** Caller sends a *SQL string* they authored; Atlas validates and executes (MCP `executeSQL`, #4047 `atlas sql`). Runs no Atlas LLM, so it is **solvency-gated but not token-metered**.

#4047 is Shape B. The NL-agent Shape A path already ships (`atlas query` → `/api/v1/query`); it is the recommended happy path, and raw SQL is the **advanced** surface.

## Decision

A workspace member reaches raw SQL over REST through the **same** `lib/tools/sql` pipeline the agent already runs, carrying the **full discipline**, authorized by a **delegated member credential** that the audit log traces back to a real human owner. Seven sub-decisions:

### 1. Billing gate-0 (solvency) is required at the route — parity with MCP `executeSQL` is an explicit AC

The MCP `executeSQL` tool declares `checksBilling` so a suspended / trial-expired / plan-exhausted workspace cannot reach a datasource (ADR-0016 gate 0). The obvious REST reuse target, `runUserQueryPipeline` (`sql.ts`), does **not** itself run gate-0 — its current callers (dashboards, validate-proposal) are already-authenticated surfaces where billing was enforced upstream. So #4047 **must** run `billingGateOrNull` (the same composer chat / `/api/v1/query` / MCP share) at the route, before the pipeline. "Gate parity with MCP `executeSQL`" is an acceptance criterion, not an assumption. Because Shape B runs no LLM, the gate is **solvency-only** (no token metering).

### 2. The role floor is `member`; raw SQL grants no reach a member doesn't already have

A member can already trigger `executeSQL` against the identical table whitelist + 4-layer validation through chat and the MCP — the agent runs *as* the member. Raw SQL adds **no new data reach**: same whitelist, same AST single-SELECT gate, same RLS injection, same readonly connection, and the pipeline still classifies `tablesAccessed`/`columnsAccessed` from the AST so **approval rules fire on raw SQL exactly as on agent SQL**. The only thing raw SQL removes is the LLM's self-restraint, which was never a security control (the semantic layer *guides*; the whitelist *enforces*). Gating to admin would diverge a member's CLI capability from their chat/MCP capability for no security gain. **Invariant:** *raw-SQL-over-REST reach ≡ agent-loop reach for the same member — same whitelist, same RLS, same approval classification; no privilege escalation.* Since #4185 this invariant is **structural, not comment-maintained**: `runUserQueryPipeline` (the raw path) and the agent `executeSQL` leaf are thin wrappers over the single shared `runSqlPipelineEffect` core in `lib/tools/sql.ts` (resolve → validate → fail-closed approval gate → source slot → plugin hooks → RLS → row limit → execute + audit), so a governance fix to the pipeline cannot apply to one path and silently skip the other — there is no second copy.

### 3. RLS is fail-closed on the CLI path

The pipeline applies `applyRLSEffect` with the **acting member's claims** exactly as the chat path does. A credential that cannot supply the required claim (RLS enabled, no usable claim) **blocks** — it never runs claim-less and never returns unfiltered rows. Supplying the member's claim on an unattended key is [#4046](https://github.com/AtlasDevHQ/atlas/issues/4046)'s responsibility (claim in key metadata); #4047 inherits `applyRLSEffect` unconditionally for whitelist-validated connections and adds no bypass.

### 4. There is no whitelist-skipping path — structural, not vigilant

`executeSQL` / `atlas sql` targets **SQL datasources only** — Postgres, MySQL, ClickHouse, Snowflake, BigQuery, DuckDB — and **every one** runs the full standard pipeline (regex + plugin forbidden-patterns → AST single-SELECT in the plugin dialect → **table whitelist** → **RLS** → **auto-LIMIT**). None set a `connection.validate`, so none take the customValidator branch that skips whitelist/RLS/auto-LIMIT. Non-SQL datasources (Salesforce SOQL, Elasticsearch DSL) are **unreachable** via `executeSQL` (you cannot express their queries as a `SELECT` string) and are served by their own tools with their own equivalent containment (e.g. `validateSOQL` + object whitelist + `appendSOQLLimit`). **Guard:** a regression test pins that the executeSQL path is whitelist-validated, so a *future* plugin that sets `connection.validate` on a SQL datasource cannot silently turn executeSQL into a bypass.

### 5. Workspace isolation derives from the credential, never from the request

`runUserQueryPipeline` derives the org from `reqCtx.user.activeOrganizationId` (the resolved credential), and every connection lookup is scoped to it; a `connectionId` from another workspace simply isn't found → `ConnectionNotRegisteredError`. The request body carries **no** org / workspace / connection-owner field a caller could spoof. Org identity is a property of the credential, full stop.

### 6. Audit is `origin=cli`, with a distinct `actor_kind`, always traceable to the human owner — never an anonymous passthrough

Every execution audits `origin=cli` (enum + CHECK added in ADR-0026) with the SQL + requestId. The audit carries **three** facts, not two:

- **`origin=cli`** — the transport.
- **`actor_kind`** — `human` for the `atlas login` device flow (a person approved it) vs a **distinct** kind (`api_key` / machine) for an unattended workspace key. Flattening both to `human` would be a lie in the trail; incident response on a leaked CI key vs a compromised human session are different investigations.
- **the owning user id** — the member who minted the key, whose `{role, claims}` it exercises. An API key is **delegated human access, never an anonymous principal.** The legacy god-key (`simple-key.ts`) mints a synthetic, human-less identity (`api-key-${hash}`) — that is precisely the passthrough-to-unknown this rejects. The workspace key ([#4046](https://github.com/AtlasDevHQ/atlas/issues/4046)) resolves to its real owning member (Better Auth `apiKey()` ties each key to a `userId`), and the audit records that owner so a leaked-key incident traces to a person and their scope immediately.

### 7. Rate-limit reuses the standard per-identity bucket; blast radius is self-contained

`standardAuth` rate-limits per identity, and in SaaS the connection pool is per-workspace (org pooling), so a key's query flood is bounded to *its own* workspace's pool + its own bucket — it cannot starve another tenant. With auto-LIMIT + statement-timeout + the pool's concurrency cap, "a CI key in a loop" is self-inflicted on the customer's own datasource. No dedicated bucket is built now; the limit is settings-tunable if CI throughput needs raising.

## The shared gate-parity contract (sibling endpoints)

`executeSQL` is the **sharpest** of the four ADR-0025 §3 endpoints, but the contract is shared: each REST endpoint over the gated core **reuses the gate composer rather than re-deriving auth**, and every one inherits sub-decisions 5–6 (credential-derived isolation; `origin=cli` audit with distinct `actor_kind`, traceable to the owner). They differ on the gates their operation needs:

- **`runMetric`** ([#4048](https://github.com/AtlasDevHQ/atlas/issues/4048)) — reaches a datasource → billing solvency gate-0 + member floor + whitelist/RLS via the metric's canonical SQL. Closest sibling to executeSQL.
- **`explore`** ([#4049](https://github.com/AtlasDevHQ/atlas/issues/4049)) — read-only semantic traversal, **metadata-only → no billing gate** (mirrors the MCP `explore` omitting `checksBilling`); still member floor + isolation + `origin=cli` audit. This is the one endpoint that *does* run inside the sandbox (the `explore` backend), reinforcing that the sandbox guards filesystem reads, not SQL.
- **`profile_datasource`** ([#4052](https://github.com/AtlasDevHQ/atlas/issues/4052)) — the ADR-0017 profiler seam; reads schema/stats from the datasource.

## Considered and rejected / deferred

- **Admin role floor for raw SQL** — rejected (sub-decision 2): a member already has the reach via chat; the whitelist is the boundary, not the LLM's restraint.
- **Add a sandbox to the SQL path** — rejected as a category error: SQL runs in the customer's DB, not on Atlas's host; the sandbox is deny-all and cannot reach a datasource. Containment is the validation pipeline + readonly connection.
- **Reuse the MCP `executeSQL` tool's internal pipeline directly** — rejected: couples the REST route to MCP-tool-shaped `CallToolResult` envelopes. Reuse `runUserQueryPipeline` (the REST-shaped sibling) and add gate-0 at the route.
- **A high-level MCP `query`/`ask` (Shape A) tool** — deferred to the Architecture Backlog as [#4094](https://github.com/AtlasDevHQ/atlas/issues/4094). The MCP keeps `executeSQL` as its native happy path (the customer already brings an LLM; the read tools route it through the semantic layer). Adding a delegate-to-Atlas's-agent tool is agent-in-agent (double LLM cost) and only worth it if generic clients write poor SQL.
- **A workspace-admin off-switch for raw SQL** (gate-1 analog) — deferred to the Architecture Backlog as [#4095](https://github.com/AtlasDevHQ/atlas/issues/4095), shaped to slot into the gate-1 seam. Not built now: Atlas is pre-customer and raw SQL is already contained by member-floor + whitelist + RLS + approval. Default would be enabled (no behavior change).

## Consequences

- #4047 ships as the **advanced** surface (NL `atlas query` stays the recommended path), reusing `runUserQueryPipeline` with gate-0 billing wired at the route, member floor, RLS fail-closed, credential-derived isolation, the whitelist-not-skipped regression guard, and `origin=cli` audit with a distinct owner-traceable `actor_kind`.
- The credential responsibilities (claim-on-key for RLS; distinct `actor_kind`; resolve to the real owning member, never an anonymous synthetic) land in [#4046](https://github.com/AtlasDevHQ/atlas/issues/4046).
- The shared gate-parity contract governs [#4048](https://github.com/AtlasDevHQ/atlas/issues/4048) / [#4049](https://github.com/AtlasDevHQ/atlas/issues/4049) / [#4052](https://github.com/AtlasDevHQ/atlas/issues/4052): reuse the composer, never re-derive auth, always `origin=cli`-audited to the owner.
- The `executeSQL`-over-REST grill (ADR-0025 §62, §Consequences) is **recorded**; #4047 moves from `ready-for-human` to `ready-for-agent`. The #4046 dependency stands (the unattended-key `actor_kind`/claims layer); the endpoint is buildable against the device-flow bearer (post-#4043) meanwhile.
