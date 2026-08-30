# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

> **This file is the UN-SPLIT REMAINDER, not the whole domain.** Atlas uses the
> multi-context layout ([CONTEXT-MAP.md](CONTEXT-MAP.md)); sixteen of its eighteen contexts
> have been extracted and are **not** in this file (#5302):
>
> | Context | Now lives in |
> | --- | --- |
> | Company Atlas | [docs/contexts/company-atlas/CONTEXT.md](docs/contexts/company-atlas/CONTEXT.md) |
> | Deployment posture | [docs/contexts/deployment-posture/CONTEXT.md](docs/contexts/deployment-posture/CONTEXT.md) — ⚠️ marked stale 2026-08-17 |
> | Notebooks (retired) | [docs/contexts/notebooks/CONTEXT.md](docs/contexts/notebooks/CONTEXT.md) — history only |
> | Pillars | [docs/contexts/pillars/CONTEXT.md](docs/contexts/pillars/CONTEXT.md) |
> | Chat Platform mechanics | [docs/contexts/chat-platform-mechanics/CONTEXT.md](docs/contexts/chat-platform-mechanics/CONTEXT.md) |
> | Knowledge Base mechanics | [docs/contexts/knowledge-base-mechanics/CONTEXT.md](docs/contexts/knowledge-base-mechanics/CONTEXT.md) |
> | Plugin lifecycle | [docs/contexts/plugin-lifecycle/CONTEXT.md](docs/contexts/plugin-lifecycle/CONTEXT.md) |
> | Install models | [docs/contexts/install-models/CONTEXT.md](docs/contexts/install-models/CONTEXT.md) |
> | Operator vs Customer | [docs/contexts/operator-vs-customer/CONTEXT.md](docs/contexts/operator-vs-customer/CONTEXT.md) |
> | Conversation scope | [docs/contexts/conversation-scope/CONTEXT.md](docs/contexts/conversation-scope/CONTEXT.md) |
> | Semantic layer scoping | [docs/contexts/semantic-layer-scoping/CONTEXT.md](docs/contexts/semantic-layer-scoping/CONTEXT.md) |
> | Semantic improvement | [docs/contexts/semantic-improvement/CONTEXT.md](docs/contexts/semantic-improvement/CONTEXT.md) |
> | Learned query patterns | [docs/contexts/learned-query-patterns/CONTEXT.md](docs/contexts/learned-query-patterns/CONTEXT.md) |
> | Chat turn presentation | [docs/contexts/chat-turn-presentation/CONTEXT.md](docs/contexts/chat-turn-presentation/CONTEXT.md) |
> | Dashboard editing | [docs/contexts/dashboard-editing/CONTEXT.md](docs/contexts/dashboard-editing/CONTEXT.md) |
> | MCP & agent governance | [docs/contexts/mcp-agent-governance/CONTEXT.md](docs/contexts/mcp-agent-governance/CONTEXT.md) |
>
> They were moved, not copied: no section below duplicates them. The remaining two
> sections are still governed here, and the map says so per row.

## Query Cache

- **Query Cache** — the per-region, in-process store of `executeSQL` result rows (`lib/cache/`), keyed by (SQL, Datasource connection, Workspace, user claims, **resolved RLS config**) so entries are tenant-isolated by construction. One per API process, shared by every Workspace in the region. Distinct from the chat-SDK state store (`chat_cache:*` keys — Workspace Connection credentials, not query results) and from a dashboard card's **cached data** (persisted per-card snapshots, refreshed by publish/cron — see "Dashboard editing").
  _Avoid_: bare "cache" in cross-subsystem prose (say Query Cache); "chat cache" for this concept (`chat_cache` is credential storage).

- **CacheBackend contract** — the async interface (`get`/`set`/`delete`/`flush`/`flushByOrg`/`stats`, all `Promise`-returning) a Query Cache backend satisfies (`lib/cache/types.ts`). The default in-process LRU implements it; a plugin can supply an external one (Redis, Memcached), validated on registration (`validateCacheBackend`) — a shape-invalid backend **fails that plugin's init** (red + sticky in plugin health) while the cache degrades to the LRU so queries keep working. Async-by-contract is what kills the phantom-hit failure mode: an unawaited Promise is truthy, so a sync-shaped `get()` would read as a hit for every query.
  _Avoid_: a synchronous backend method (the contract is Promise-returning end to end); silently falling back to the LRU on a bad backend without failing the plugin.

- **Scope tags / scoped invalidation** — every `set()` carries a `CacheScope` (`{ orgId?, connectionId }`); the LRU keeps an `orgId → keys` side index (consistent across set / delete / capacity-eviction / TTL-expiry / flush) so `flushByOrg(orgId)` purges exactly one Workspace's entries. Org deletion and residency migration purge **per-org**, never fleet-wide — a co-tenant's warm entries survive one Workspace's teardown. The connection tag is retained so a future per-connection invalidation can filter an org's entries by it (no reader does yet). Fleet-wide `flush()` stays for config reload + the admin flush button.
  _Avoid_: nuclear `flush()` for a single-Workspace event (use `flushByOrg`); an `orgId` in the scope tag that differs from the `orgId` in the cache key (they must be the same Workspace or `flushByOrg` misses).

- **Org-bucketed cache stats** — the per-Workspace hit/miss accounting the admin cache page reports (#4549): each Workspace's bucket carries a since-labeled **lifetime rate** plus a sliding **last-hour rate** (two-generation window — current + previous hour's counters, the previous decaying linearly as the hour progresses; no ring buffer). Lives in a module-level registry (`lib/cache/stats-registry.ts`) ABOVE the backend, recorded at the single agent read site in `lib/tools/sql.ts` — `CacheBackend.get(key)` structurally cannot attribute a **miss** to a Workspace (the key isn't in the backend), so the backend's own `stats()` counters remain its global self-report and the registry is the additional app-maintained per-org layer. Counters therefore survive backend resize/plugin swap. Responses are per-caller: workspace admins see only their bucket; fleet totals are platform-admin-only. There is no admin-facing reset verb (the only reset export, `resetCacheStatsRegistry`, is test-isolation-only) — a flush "moves the window" emergently (post-flush misses drag the last-hour rate down).
  _Avoid_: recording hits/misses inside a backend (miss attribution is impossible there); treating the backend's `stats()` hits/misses and the registry as the same numbers (they are two deliberate layers); a bypassed read as a miss (it consulted no cache).

- **Query Cache governance principle** — ADR-0033: *the cache key captures every input that determined an entry's rows; anything that can veto a query runs before the cache check; and the hit path re-applies every layer that transforms rows on the way out.* Concretely: the **resolved RLS config** hashes into the key alongside claims (`lib/cache/keys.ts`) so tightening RLS orphans pre-change entries by construction — no flush choreography (closes audit H3); plugin **`beforeQuery`** dispatch sits *above* the cache check (`lib/tools/sql.ts`) so a rejection blocks warm hits and a rewrite lands in the key (closes M11's governance half; the metrics half is the documented live-only carve-out below); and masking + the current row limit re-apply on every hit. The **live-path-only** carve-out: `afterQuery` + connection SLA/`recordQuery` metrics observe *executions*, so a hit — which doesn't execute — never fires them. The **L9 invariant**: when both Workspace (org) and claims are absent, an entry rests solely on the Datasource connection; that is correct only for single-tenant-per-connection deployments, so any per-tenant discriminator MUST surface through org or claims, never left implicit.
  _Avoid_: "flush the cache on RLS change" (the rejected event-based alternative — key-hashing is invariant-based); treating a cache hit as an execution (it has no datasource round-trip to observe).

## Lead source (CRM acquisition)

- **Lead source** — *how a prospect/lead first reached Atlas*, as recorded in the CRM. Carried on the `LeadEvent` discriminated union's `source` field (`demo` / `signup` / `conversion` / …) — defined once in `plugins/twenty/src/lead-normalizer.ts` (`LeadEventSchema`, the SSOT for the `crm_outbox` payload wire shape; the `SaasCrm.upsertLead` contract aliases it as `SaasCrmLeadInput`) and mapped by the Twenty normalizer onto two Person fields: **`atlasFirstSource`** (sticky first-touch — never overwritten once set) and **`atlasLastSource`** (last-touch — updated each event). A self-serve trial signup emits a `signup` lead through `SaasCrm.upsertLead`; a Stripe-paid conversion stamps `conversion`. A signup arriving over MCP is the **same lead-source concept reached by a different method** — it flows through the identical `upsertLead` → `crm_outbox` → Twenty pipeline, distinguished (if at all) by its `source` value, never by a new pipeline.
  _Avoid_: treating it as **Agent origin** (that governs agent traffic); inventing a parallel "acquisition channel" concept (this is it); putting CRM provenance on the trial grant (the grant carries runtime entitlement state like the trial meter, not marketing attribution).

- **MCP admin tool** — an MCP tool that *configures* Atlas (creates a Datasource, connects an integration, raises a policy) rather than reading data — as opposed to the read-only query tools (`executeSQL`, `explore`, the semantic-layer tools).
  _Avoid_: "configuration surface" (bare "surface" is the pillar admin page).

- **MCP action policy** — the per-workspace, customer-admin allow/deny over MCP action *categories* (e.g. "no datasource creation via MCP at all"). Evaluated first in the dispatch gate order and short-circuits before scope / RBAC / approval. Distinct from the **origin ceiling** — the non-configurable product invariant that MCP may never *lower* governance (disable RLS, the table whitelist, an approval rule, etc.). See [ADR-0016](./docs/adr/0016-mcp-v2-security-model.md).
  _Avoid_: conflating it with the origin ceiling — the action policy is customer-configurable; the ceiling is not.

- **Query shape** — *who authors the SQL* that answers a data question, across every surface (chat, MCP, CLI, REST). Two shapes:
  - **NL-agent query** — the caller sends a natural-language *question* and **Atlas's own agent** writes and runs the SQL (chat, CLI `atlas query`, the synchronous query API). Token-metered. The recommended **happy path**.
  - **Raw query** — the caller sends a *query they authored themselves* (a `SELECT` via the `executeSQL` tool / CLI `atlas sql`, driven by the caller's own LLM or a human/CI script). Atlas validates and executes but authors nothing. Runs no Atlas LLM → solvency-gated, not token-metered. The **advanced** surface.
  The distinction is load-bearing for *trust*: a raw query's author is **external and untrusted**, so the 4-layer validation pipeline + read-only connection is the **sole** boundary (a member reaches exactly the agent-loop's whitelist/RLS reach — no escalation). See [ADR-0027](./docs/adr/0027-executesql-over-rest-security.md).
  _Avoid_: calling raw query "the chat route" (chat is NL-agent); implying a **sandbox** contains SQL — SQL runs in the customer's database and is never sandboxed; only `explore`/`python` (untrusted code on Atlas's host) are.
