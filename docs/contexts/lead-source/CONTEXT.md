# Lead source (CRM acquisition)

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Lead source (CRM acquisition)` section, moved unchanged except that
> relative links are repathed for the new depth. It is no longer in the root file.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


- **Lead source** — *how a prospect/lead first reached Atlas*, as recorded in the CRM. Carried on the `LeadEvent` discriminated union's `source` field (`demo` / `signup` / `conversion` / …) — defined once in `plugins/twenty/src/lead-normalizer.ts` (`LeadEventSchema`, the SSOT for the `crm_outbox` payload wire shape; the `SaasCrm.upsertLead` contract aliases it as `SaasCrmLeadInput`) and mapped by the Twenty normalizer onto two Person fields: **`atlasFirstSource`** (sticky first-touch — never overwritten once set) and **`atlasLastSource`** (last-touch — updated each event). A self-serve trial signup emits a `signup` lead through `SaasCrm.upsertLead`; a Stripe-paid conversion stamps `conversion`. A signup arriving over MCP is the **same lead-source concept reached by a different method** — it flows through the identical `upsertLead` → `crm_outbox` → Twenty pipeline, distinguished (if at all) by its `source` value, never by a new pipeline.
  _Avoid_: treating it as **Agent origin** (that governs agent traffic); inventing a parallel "acquisition channel" concept (this is it); putting CRM provenance on the trial grant (the grant carries runtime entitlement state like the trial meter, not marketing attribution).

- **MCP admin tool** — an MCP tool that *configures* Atlas (creates a Datasource, connects an integration, raises a policy) rather than reading data — as opposed to the read-only query tools (`executeSQL`, `explore`, the semantic-layer tools).
  _Avoid_: "configuration surface" (bare "surface" is the pillar admin page).

- **MCP action policy** — the per-workspace, customer-admin allow/deny over MCP action *categories* (e.g. "no datasource creation via MCP at all"). Evaluated first in the dispatch gate order and short-circuits before scope / RBAC / approval. Distinct from the **origin ceiling** — the non-configurable product invariant that MCP may never *lower* governance (disable RLS, the table whitelist, an approval rule, etc.). See [ADR-0016](../../adr/0016-mcp-v2-security-model.md).
  _Avoid_: conflating it with the origin ceiling — the action policy is customer-configurable; the ceiling is not.

- **Query shape** — *who authors the SQL* that answers a data question, across every surface (chat, MCP, CLI, REST). Two shapes:
  - **NL-agent query** — the caller sends a natural-language *question* and **Atlas's own agent** writes and runs the SQL (chat, CLI `atlas query`, the synchronous query API). Token-metered. The recommended **happy path**.
  - **Raw query** — the caller sends a *query they authored themselves* (a `SELECT` via the `executeSQL` tool / CLI `atlas sql`, driven by the caller's own LLM or a human/CI script). Atlas validates and executes but authors nothing. Runs no Atlas LLM → solvency-gated, not token-metered. The **advanced** surface.
  The distinction is load-bearing for *trust*: a raw query's author is **external and untrusted**, so the 4-layer validation pipeline + read-only connection is the **sole** boundary (a member reaches exactly the agent-loop's whitelist/RLS reach — no escalation). See [ADR-0027](../../adr/0027-executesql-over-rest-security.md).
  _Avoid_: calling raw query "the chat route" (chat is NL-agent); implying a **sandbox** contains SQL — SQL runs in the customer's database and is never sandboxed; only `explore`/`python` (untrusted code on Atlas's host) are.
