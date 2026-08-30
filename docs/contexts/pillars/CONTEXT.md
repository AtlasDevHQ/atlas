# Pillars

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Pillars` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


Atlas reaches the outside world in four distinct ways. A given **catalog row** fits in exactly one pillar; the split matters because the install lifecycle, credential storage, and admin UX differ across them. Some third-party *systems* span pillars by carrying multiple catalog rows — see **Multi-pillar systems** in [Install models](../install-models/CONTEXT.md).

- **Datasource** — a third-party system Atlas *reads* tabular data from to answer questions. Configured in `/admin/connections`, queried by the agent via the `executeSQL` tool, backed by `semantic/entities/*.yml`. Examples: Postgres, MySQL, Snowflake, ClickHouse, BigQuery, DuckDB, Salesforce (SOQL).
  _Avoid_: Connector, "data source" (two words), "DB connection" (means the pool, not the third-party system).

- **Chat Platform** — a third-party chat service through which customers *talk to* Atlas. Atlas listens for messages and replies. Examples: Slack, Microsoft Teams, Discord, Google Chat, Telegram, WhatsApp.
  _Avoid_: bare "Platform" (overloaded historically — always say "Chat Platform" when you mean the chat surface), "chat integration", "chat service".

- **Action Target** — a third-party system Atlas *writes to or acts on* (creates issues, sends emails, fires webhooks). The customer doesn't talk to Atlas through these; Atlas reaches out. Examples: GitHub, Linear, Email (SMTP), Webhooks.
  _Avoid_: "Outbound integration", "Action Integration". Bare "Integration" is ambiguous — it can mean a Chat Platform, an Action Target, or the umbrella over the latter two.

- **Knowledge Base** — a third-party **content corpus Atlas reads** ([ADR-0040](../../adr/0040-the-class-major-ingest-contract.md) widened the charter from "descriptive document corpora"; #5202). What a corpus lands is decided by its source's class contract, never by the admin: **knowledge documents** (descriptive context — business rules, runbooks, product definitions), **episodes** feeding the Company Atlas (Zoom transcripts, Outlook mail — why such a collection legitimately shows zero documents), or both (a docs-class corpus like Confluence, when that class arrives). A **knowledge document** is descriptive only — never queried as data, never authoritative, never extracted into a fact (see anti-confusions below, including the reviewed-fact carve-out); each document is owned by exactly one Knowledge Base install. Knowledge documents scope to the Workspace, never to a Connection group — an entity describes a group's *schema*, a knowledge document describes the *business*. Examples: OKF bundle upload, Notion, Confluence.
  _Avoid_: "knowledge connection" ("connection" is overloaded — see anti-confusions), "context source" ("source" is a deprecated alias for Connection group), "docs integration"; group-scoping knowledge documents (affinity is a `tags` concern).

### One user-facing surface per pillar

A given third-party system appears on **exactly one** admin page, determined by its pillar:

- Datasource → `/admin/connections`
- Chat Platform → `/admin/integrations` (chat section)
- Action Target → `/admin/integrations` (actions section)
- Knowledge Base → `/admin/knowledge`

The install **handler** it uses (OAuth, Form, Static-bot per [Install models](../install-models/CONTEXT.md)) is orthogonal to the pillar. A Datasource can use OAuth (Salesforce), a Chat Platform can use Static-bot (Telegram), an Action Target can use Form (Webhook). Pillar determines *where it appears*; install handler determines *how credentials are obtained*. Conflating the two would put OAuth-installed Datasources on the integrations page just because OAuth is "where catalog cards live today" — that's an install-mechanism leak into user-facing taxonomy.

### Anti-confusions across pillars

- "Salesforce integration" is ambiguous — Salesforce is a **Datasource** (read via SOQL), not an Action Target, even though it has an OAuth install dance that looks superficially like GitHub's. Its UI home is `/admin/connections`.
- "GitHub integration" is ambiguous — GitHub is an **Action Target** (Atlas creates issues, comments). It is *not* a Chat Platform, even though CONTEXT.md historically lumped it in alongside Slack.
- "Connection" is overloaded — say **Datasource** (the third-party system) or **Workspace Connection** (the chat OAuth handshake, defined in [Chat Platform mechanics](../chat-platform-mechanics/CONTEXT.md)). Never just "connection" in glossary-relevant prose.
- The **Knowledge Base** pillar is *descriptive*; the **semantic layer** is *authoritative*. Both are "context the agent reads," but a knowledge document never runs verbatim, never extends the table whitelist, and never gates the agent — the semantic layer stays the sole authority over what is queryable (whitelist), what a metric means (pinned metrics), and what the agent must ask about first (glossary gating). This moat boundary is a property of the taxonomy, not a discipline of any one implementation.
  - *Reviewed-fact carve-out* — a **reviewed fact** is a third thing, neither descriptive nor a knowledge document. It is a row in the **Company Brain** substrate (see [Company Atlas](../company-atlas/CONTEXT.md); [ADR-0036](../../adr/0036-atlas-as-company-brain.md) amends [ADR-0028](../../adr/0028-knowledge-base-fourth-pillar.md) rather than superseding it, and still holds the substrate vocabulary this glossary does not restate), authoritative *for its class* and yielding to the **warehouse** — tier 1, the analytics Datasource resolved through the semantic layer and answered by `executeSQL` — in any overlap (`TRUST_TIERS` in `packages/api/src/lib/brain/types.ts`). What holds a fact is a **review gate**, not descriptiveness, so it sits off the descriptive/authoritative axis entirely. Knowledge documents are unchanged: still descriptive-only, and deliberately left *outside* that tier ordering rather than ranked at its bottom.
- "Notion/Confluence integration" is ambiguous and genuinely dual — the same system can be a **REST Datasource** (live `executeRestOperation` calls against the vendor API: always-current, but slow, rate-limited, and shaped by the vendor's API) or a **Knowledge Base** (content ingested as knowledge documents: indexed, searchable, review-gated — faster and more accurate for informing answers). Per the multi-pillar rule, that's one catalog row per (system, pillar); a customer can install both.
- **"KB" / "knowledge base"** is overloaded in loose usage — it can mean the **Knowledge Base pillar** (above: a corpus Atlas *ingests* as knowledge documents, home `/admin/knowledge`, OKF) or the customer-facing **help center** (human support/how-to articles — e.g. Featurebase — that live outside the product and may deep-link the docs portal). Reserve **Knowledge Base** for the pillar; say **help center** for the support-article surface. The docs site (`docs.useatlas.dev`) is neither — it is the **documentation portal**.
