# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

> **This file is the UN-SPLIT REMAINDER, not the whole domain.** Atlas uses the
> multi-context layout ([CONTEXT-MAP.md](CONTEXT-MAP.md)); seventeen of its eighteen contexts
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
> | Query Cache | [docs/contexts/query-cache/CONTEXT.md](docs/contexts/query-cache/CONTEXT.md) |
>
> They were moved, not copied: no section below duplicates them. The remaining one
> sections are still governed here, and the map says so per row.

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
