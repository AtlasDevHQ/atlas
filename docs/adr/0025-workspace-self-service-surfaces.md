# ADR-0025: A workspace operates Atlas through one gated core; the MCP and a workspace CLI are two transports over it, separated by credential — not by package

**Status:** Proposed
**Date:** 2026-06-27
**See also:** [ADR-0016](0016-mcp-v2-security-model.md) (MCP V2 security model), [ADR-0015](0015-agent-origin-not-surface.md) (agent origin, not surface), [ADR-0017](0017-datasource-profiler-seam.md) (profiler seam), [CLAUDE.md](../../CLAUDE.md) (SaaS-first configuration; SQL validation 4 layers)

## Context

The goal is **Railway's shape**: a Railway *customer* manages their own projects, services, and deployments through the `railway` CLI **or** Railway's MCP — as the tenant, never as the platform operator. The Atlas analog: a **workspace** should manage its own datasources, semantic layer, and queries through an Atlas CLI **or** the Atlas MCP, scoped to that workspace, with no trip through the dashboard and no operator privileges. "Pick your transport, operate your own tenant." The platform-operator tooling (managing *all* tenants, the Atlas-the-company concern) is a separate, internal thing entirely.

A static trace of both surfaces (2026-06-27) found they are not two implementations of one idea — they encode two different *identity models*, only one of which is tenant-safe:

1. **The MCP is already the tenant-self-service surface.** It resolves a real per-workspace actor — `loadActorUser` / `resolveMcpActor` (`packages/mcp/src/actor.ts`) binds `{ orgId, role }` from env (stdio) or a live-verified OAuth bearer (hosted) — and runs every dispatch through the ADR-0016 gate chain (`runMcpDispatchGate` in `dispatch-gate.ts`: billing → action-policy → `mcp:write` scope → RBAC → approval) with `origin=mcp` audit. It was *built* multi-tenant.

2. **The CLI has no tenant identity at all.** Of ~22 commands, 18 connect **directly to Postgres** (`ATLAS_DATASOURCE_URL` or `DATABASE_URL`/`ATLAS_TEAM_PG_URL`) — bypassing the API, its gates, its audit, and the tenant boundary. The four that go over HTTP (`query`, `import`, `migrate-import`, `smoke`) authenticate with `ATLAS_API_KEY`, which `packages/api/src/lib/auth/simple-key.ts` resolves to a **single global key, role defaulted to admin (`ATLAS_API_KEY_ROLE`), with no `activeOrganizationId`** — a god-key that reaches every workspace, with no `--workspace` selector to even name a tenant.

So today's CLI cannot be handed to a workspace by any path: the direct-DB half has no isolation, the HTTP half has a cross-tenant god-key. The instinct "the CLI is operator-only, split it" is directionally right but understates the gap — the problem is not that operator commands are *mixed in* (cosmetic); it is that **what would be left still has no way to say "I am workspace X, acting as a member."** A package split buys tidiness, not self-service. The asymmetry is historical: the CLI is the original build-time/operator tool (profiler, schema diff, the operator subcommands promoted from `internal/` in #2635); the MCP was designed after the boundary existed, to ADR-0016.

## Decision

**A workspace operates Atlas through one gated operations core. The MCP and a new workspace CLI are two thin transports over that core; which one an agent picks is a deployment preference, never a capability or trust difference. The surfaces are partitioned by the credential they carry, not by which package they live in.** Five sub-decisions:

### 1. The tenant CLI is the product; operator tooling is not a peer surface

The deliverable is a single **workspace CLI** — the `railway`-CLI analog — that, with the MCP, gives a workspace two transports onto the same gated core. Everything in it is reachable only through a workspace credential and clears the full gate chain. The platform-**operator** CLI (today's `ops`/`seed`/`proactive`/`export`/`learn`, direct-DB, manages *all* tenants) is internal Atlas-the-company tooling, shipped to the operator, never to a workspace; pulling it into its own binary/namespace is packaging cleanup (see Sequencing), not part of this surface design. The build-time codegen commands (`init`/`diff`/`improve`/`profile`) are a third, distinct category — local, direct-DB, run at *setup* time, mostly a self-hosted concern; their SaaS equivalent is `profile_datasource` over the API (sub-decision 3). They are not a "CLI surface" and do not need tenant identity because they run before/outside a multi-tenant server.

### 2. Two credential paths, both workspace-scoped — `atlas login` (human) and a workspace API key (agent)

Mirroring Railway's `login` vs. token split:

- **`atlas login`** — interactive browser OAuth/PKCE for a human developer; the CLI stores a short-lived bearer in `~/.atlas/credentials`. Reuses the existing primitives in `packages/oauth-helper` (PKCE, DCR, discovery — already consumed by the SDK for MCP auth), so this *flips an existing gate*, not new auth infrastructure.
- **A workspace-scoped API key** — the agent/CI path: hashed at rest, revocable, role-bearing, provisioned from the dashboard.

Both resolve **live, at every request, to `{ orgId, role }`** through the same actor path the MCP uses — authority is RBAC checked against the live `member` row, never a stale token claim (ADR-0016), so revocation/demotion is immediate. This per-workspace key is the missing primitive; the global `ATLAS_API_KEY` stays only as the operator/self-host escape hatch and is **not** extended to carry an org.

### 3. One gated core, two transports — the CLI reaches it over REST, the MCP in-process

The operations a workspace can perform are defined **once** — the gated facades the MCP tools already call (`@atlas/api/lib/datasources/mcp-lifecycle`, `@atlas/api/lib/tools/sql`, the semantic lookups) — and exposed through two thin transports so parity is *structural*, not a checklist re-verified each release. ADR-0016 rejected a loopback HTTP proxy *for the MCP* (it is in-process; call the lib layer directly); that holds. The workspace CLI is the opposite case — a genuinely separate process on a customer's machine — for which HTTP-with-a-bearer is the *correct* boundary, not a laundering hop. So the CLI calls REST, the MCP calls the lib layer, both bottom out in the same gate chain and audit.

REST already covers datasource CRUD (`/api/v1/admin/connections/*`, `/api/v1/admin/{archive,restore}-connection`) and semantic browse (`/api/v1/semantic/entities`, member-accessible via `standardAuth`). **Four MCP capabilities have no REST equivalent and are the new surface:** `executeSQL` (a raw validated SELECT — today only the agent loop and the MCP tool run one; `/api/v1/validate-sql` validates but does not execute), `runMetric` (execute a canonical metric by id), `profile_datasource` (the ADR-0017 profiler seam), and `explore` (read-only semantic traversal). Each must be authorizable under a **workspace key + member/admin role** (the existing admin-connection routes assume a session + the org `admin` role — i.e. the *workspace's* admin, not the platform operator — and must be taught to honor the new key and the role it carries), and each reuses the gate composer rather than re-deriving authorization.

### 4. `datasource create` captures secrets on stdin (human) or env-at-request (agent) — never argv

The MCP collects datasource secrets via masked form-mode elicitation that never enters the agent/LLM context (ADR-0016). A CLI has no LLM context to protect, but it has `argv`, shell history, and logs to keep secrets *out of*. So `atlas datasource create` prompts for credentials on **stdin** (like `git`/`psql` passphrase prompts) — never as a flag — or, for a headless agent with no TTY, reads them from an env var at the moment of the request. CI/automation without an interactive terminal **defers datasource creation to the dashboard or MCP** and uses pre-provisioned datasources. This is the one place transport parity legitimately stops, and it is a decision, not a gap.

### 5. A CLI call is `origin=cli`; the origin ceiling holds; self-hosted inherits the same binary

A workspace CLI adds `origin=cli` to ADR-0015's enum (approval rules match it, audit records it) without adding an authority axis — a member acting via CLI and via MCP clear the identical gate chain. The **origin ceiling** invariant is unchanged: `origin=cli` may *provision and raise* governance, never *lower* it (no CLI command to disable RLS, the whitelist, an approval rule, masking, tier), enforced structurally by the command not existing. And per the SaaS-first principle (ADR-0016), self-hosted **inherits the same workspace CLI binary** — it drops the SaaS-only scope term, keeps RBAC + approval, and the credential resolves to the single ambient org (or, with auth off, needs none). There is no separate "self-hosted CLI."

## Considered options

- **Just split the package into admin + user CLIs.** Rejected as the primary move (kept as packaging cleanup). It adds no tenant identity; the "user CLI" still holds only the god-key or a direct-DB connection. Cosmetics over the real gap.
- **Ship the existing CLI to workspaces with `ATLAS_API_KEY`.** Rejected — the global key has no `activeOrganizationId` and defaults to admin (`simple-key.ts`); a workspace holding it reads and mutates *every* tenant. That is the leak, not a workaround for it.
- **Give the CLI per-workspace *database* credentials and let it talk direct-DB.** Rejected — bypasses the gate chain (billing solvency, action-policy kill-switch, approval), the audit trail, RLS injection, and the SQL-validation pipeline. Workspace-scoping at the *database* layer is not the same boundary as workspace identity at the *API* layer; only the latter carries the gates.
- **Run the MCP server as a library inside the CLI.** Rejected — it couples the CLI to the MCP's in-process trust model and obscures the `origin=cli` distinction (ADR-0015). A thin HTTP client is the boundary; the shared core lives server-side.
- **Do nothing — the MCP is enough.** Rejected — the goal is transport *choice*. Some agent runtimes drive a CLI more naturally than an MCP client, and a thin REST CLI is cheap once the key primitive and the four endpoints exist (work the MCP wants regardless).

## Consequences

- **Workspace-scoped API keys + `atlas login` are the critical path.** The key table (hashed, revocable, role-bearing), its resolution into the existing actor/auth path, and its admission to the gate chain gate everything else. The login path is mostly wiring over `oauth-helper`. Build these first; the CLI is trivial after and impossible with the god-key.
- **`executeSQL` over REST is a genuine new attack surface.** A raw-SQL endpoint reachable by an API key is strictly more exposed than a tool inside an in-process MCP. It must carry the full discipline (4-layer validation → AST single-SELECT → table whitelist → auto-LIMIT → statement timeout → readonly connection → audit with `origin=cli`) and must never become a whitelist-skipping path. The other three endpoints follow the same "reuse the gate composer, don't re-derive auth" rule.
- **Parity is now a structural property to protect:** a new workspace capability is added to the core and exposed through *both* transports, or neither — never one.
- **Sequencing.** (1) workspace-scoped API keys + `atlas login` → (2) the four REST endpoints on the shared core → (3) the thin workspace CLI (a `smoke.ts`-shaped HTTP client) → (4) operator-CLI extraction (independent packaging, anytime). Steps 1–2 are also pure MCP-hardening and stand on their own.
- **No code ships with this ADR.** It settles the "thin HTTP client over one gated core, two credential paths" shape so the package-split instinct is not pursued in isolation. Open the build behind a grill of the key-scoping and the `executeSQL`-over-REST surface specifically.
