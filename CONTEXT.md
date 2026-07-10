# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

## Pillars

Atlas reaches the outside world in four distinct ways. A given **catalog row** fits in exactly one pillar; the split matters because the install lifecycle, credential storage, and admin UX differ across them. Some third-party *systems* span pillars by carrying multiple catalog rows — see "Multi-pillar systems" below.

- **Datasource** — a third-party system Atlas *reads* tabular data from to answer questions. Configured in `/admin/connections`, queried by the agent via the `executeSQL` tool, backed by `semantic/entities/*.yml`. Examples: Postgres, MySQL, Snowflake, ClickHouse, BigQuery, DuckDB, Salesforce (SOQL).
  _Avoid_: Connector, "data source" (two words), "DB connection" (means the pool, not the third-party system).

- **Chat Platform** — a third-party chat service through which customers *talk to* Atlas. Atlas listens for messages and replies. Examples: Slack, Microsoft Teams, Discord, Google Chat, Telegram, WhatsApp.
  _Avoid_: bare "Platform" (overloaded historically — always say "Chat Platform" when you mean the chat surface), "chat integration", "chat service".

- **Action Target** — a third-party system Atlas *writes to or acts on* (creates issues, sends emails, fires webhooks). The customer doesn't talk to Atlas through these; Atlas reaches out. Examples: GitHub, Linear, Email (SMTP), Webhooks.
  _Avoid_: "Outbound integration", "Action Integration". Bare "Integration" is ambiguous — it can mean a Chat Platform, an Action Target, or the umbrella over the latter two.

- **Knowledge Base** — a third-party knowledge corpus Atlas *ingests descriptive context* from (business rules, runbooks, product definitions) to inform its answers. Content lands per-Workspace as **knowledge documents**, each owned by exactly one Knowledge Base install; it is descriptive only — never queried as data, never authoritative (see anti-confusions below). Knowledge documents scope to the Workspace, never to a Connection group — an entity describes a group's *schema*, a knowledge document describes the *business*. Examples: OKF bundle upload, Notion, Confluence.
  _Avoid_: "knowledge connection" ("connection" is overloaded — see anti-confusions), "context source" ("source" is a deprecated alias for Connection group), "docs integration"; group-scoping knowledge documents (affinity is a `tags` concern).

### One user-facing surface per pillar

A given third-party system appears on **exactly one** admin page, determined by its pillar:

- Datasource → `/admin/connections`
- Chat Platform → `/admin/integrations` (chat section)
- Action Target → `/admin/integrations` (actions section)
- Knowledge Base → `/admin/knowledge`

The install **handler** it uses (OAuth, Form, Static-bot per "Install models" below) is orthogonal to the pillar. A Datasource can use OAuth (Salesforce), a Chat Platform can use Static-bot (Telegram), an Action Target can use Form (Webhook). Pillar determines *where it appears*; install handler determines *how credentials are obtained*. Conflating the two would put OAuth-installed Datasources on the integrations page just because OAuth is "where catalog cards live today" — that's an install-mechanism leak into user-facing taxonomy.

### Anti-confusions across pillars

- "Salesforce integration" is ambiguous — Salesforce is a **Datasource** (read via SOQL), not an Action Target, even though it has an OAuth install dance that looks superficially like GitHub's. Its UI home is `/admin/connections`.
- "GitHub integration" is ambiguous — GitHub is an **Action Target** (Atlas creates issues, comments). It is *not* a Chat Platform, even though CONTEXT.md historically lumped it in alongside Slack.
- "Connection" is overloaded — say **Datasource** (the third-party system) or **Workspace Connection** (the chat OAuth handshake, defined below). Never just "connection" in glossary-relevant prose.
- The **Knowledge Base** pillar is *descriptive*; the **semantic layer** is *authoritative*. Both are "context the agent reads," but a knowledge document never runs verbatim, never extends the table whitelist, and never gates the agent — the semantic layer (pinned metrics, glossary gating, whitelist) stays the sole authoritative context surface. This moat boundary is a property of the taxonomy, not a discipline of any one implementation.
- "Notion/Confluence integration" is ambiguous and genuinely dual — the same system can be a **REST Datasource** (live `executeRestOperation` calls against the vendor API: always-current, but slow, rate-limited, and shaped by the vendor's API) or a **Knowledge Base** (content ingested as knowledge documents: indexed, searchable, review-gated — faster and more accurate for informing answers). Per the multi-pillar rule, that's one catalog row per (system, pillar); a customer can install both.
- **"KB" / "knowledge base"** is overloaded in loose usage — it can mean the **Knowledge Base pillar** (above: a corpus Atlas *ingests* as knowledge documents, home `/admin/knowledge`, OKF) or the customer-facing **help center** (human support/how-to articles — e.g. Featurebase — that live outside the product and may deep-link the docs portal). Reserve **Knowledge Base** for the pillar; say **help center** for the support-article surface. The docs site (`docs.useatlas.dev`) is neither — it is the **documentation portal**.

## Chat Platform mechanics

These four terms are distinct and frequently confused. Pin them.

- **Chat Platform** — see Pillars above. Slack-shaped surfaces only (Slack, Teams, Discord, Google Chat, Telegram, WhatsApp).
- **Adapter** — the Atlas-side code under `plugins/chat/src/adapters/<platform>.ts` that translates Chat Platform events into the chat-SDK's neutral shape. One adapter per Chat Platform. Lives in the `@useatlas/chat` plugin.
- **App Registration** — the operator's developer-portal record with a Chat Platform vendor (e.g. "Atlas" as a Slack App in the Slack API console). Carries the `client_id` / `client_secret` / redirect URIs / event-subscription endpoints. **One per Chat Platform per Atlas deployment.** A SaaS operator runs one App Registration per supported Chat Platform; a self-host operator can run their own. Action Targets may also have App Registrations (e.g. a GitHub App), but the term originated and is most load-bearing for the chat pillar.
- **Workspace Connection** — the OAuth-completed link between a single customer Workspace and a single Chat Platform, holding the customer's per-workspace bot token in the chat-SDK's state store (`chat_cache:slack:installation:<teamId>` and equivalents). One per (Workspace × Chat Platform) pair. **Chat-pillar specific** — Action Target installs persist credentials elsewhere (see `db/secret-encryption.ts`) and are described as **Workspace Installs**, not Workspace Connections.

### Cardinality

- App Registrations: `Chat Platform → 1` per deployment (operator-owned)
- Workspace Connections: `(Workspace, Chat Platform) → 1` (customer-owned, OAuth-completed)
- Adapters in code: `Chat Platform → 1` per Atlas codebase (always present, conditionally activated)

### Anti-confusions

- "Slack integration" is ambiguous — disambiguate to App Registration (operator-side), Adapter (code), or Workspace Connection (customer-side).
- "Adapter is enabled" is ambiguous — say either "Adapter has credentials wired" (deploy-level, operator-controlled) or "Workspace Connection exists" (workspace-level, customer-controlled).

## Knowledge Base mechanics

- **Collection** — the customer-facing unit of knowledge organization: a named, independently-searchable **hosted OKF bundle** (one tree, one root `index.md`). Realized as one Knowledge Base **Workspace Install** — the install id is the collection's slug (the datasource pillar's multi-instance pattern, not the chat/action singleton). A **knowledge document** belongs to exactly one collection; uploads upsert into the collection's tree by path. Typical split: one collection per product or corpus, so search can scope to one without wading through the others.
  _Avoid_: "bundle" for the hosted thing (a bundle is the *interchange artifact* uploaded or exported; the collection is what Atlas hosts); conflating with **Connection group** (a SQL-only concept — collections never route queries).
- **Importer** — a *generation-side* tool that turns an external docs corpus (Fumadocs site, markdown tree, later Mintlify) into an OKF bundle Atlas ingests through the **existing** upload route or bundle-sync connector — zero `packages/api` changes per importer (ADR-0028 §5 posture; the one-time wire-contract single-homing in #4373 that repointed `packages/api`'s parsers at `@atlas/okf-bundle/wire` aside). An importer = the shared **bundle builder** + one **doc-source adapter** (`@atlas/fumadocs-okf` is the first; the **markdown-tree adapter** — the core's own `createMarkdownTreeSource`, promoted from the docs portal's shims in #4374 — is the second, and makes "any docs folder" / Mintlify one nav-filter away. The docs portal's local mode consumes it; only portal policy — audience transform, section list, the deployed `llms.txt` shim — stays in `apps/docs`).
  _Avoid_: "connector" for these (a connector is *server-side* — credentialed install, scheduled sync; ADR-0030's territory — which is where Confluence landed, as a Knowledge Sync Connector rather than an importer).
- **Doc-source seam** — the one interface an importer implements (`@atlas/okf-bundle`): a source enumerates pages; a page carries a relative path, optional title/description/tags, and resolves a markdown body asynchronously. Everything downstream is the bundle builder's, identical for every source.
- **Knowledge Sync Connector** — a *server-side* vendor pull ([ADR-0030](./docs/adr/0030-knowledge-sync-connector-seam.md), #4376; the reopened ADR-0028 §5 follow-up): a knowledge-pillar catalog row whose collections Atlas syncs on the Scheduler — cheap **incremental** cycles off a persisted per-collection **high-water mark** (with an overlap window), plus periodic **reconciliation crawls** (the correctness anchor: full enumeration, subtractive archiving of vendor-deleted paths, full-set cap validation — cadence via the `ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS` settings knob). A connector = a **vendor client** (enumerate + fetch changes, per-vendor, test-doubled) + a **converter** (pure, vendor format → markdown); scheduling, backoff (429/`Retry-After`), caps, and ingest are the shared engine's (`lib/knowledge/connector-sync.ts`), never per-vendor. Connectors consume collected documents and enter the ingest transaction at **document level** (`ingestDocuments` — no tar round-trip), stamped `connector:<vendor>` in `atlas_source`; every write lands `draft` — connectors **structurally cannot publish**. Confluence Cloud and Notion (PRD #4375) are the first two vendors.
  _Avoid_: "importer" for these (an importer is *generation-side* — it produces a bundle, runs outside Atlas, needs no credentials); calling bundle-sync a Knowledge Sync Connector (bundle-sync pulls a ready-made bundle from an endpoint; a connector talks a vendor API and converts).
- **Bundle builder** — the source-neutral core (`@atlas/okf-bundle`): collect → generation-time cap validation → collision guard → deterministic USTAR+gzip pack, with the reserved-basename fold/rename that makes built-count == ingested-count by construction. Recorded invariant: collect (documents) and pack (transport) stay separate, so the Knowledge Sync Connector engine (ADR-0030) consumes collected documents at the document-level ingest seam (`ingestDocuments`) without packing an archive just to unpack it in-process. Its leaf **wire module** (`@atlas/okf-bundle/wire`) single-homes the OKF wire contract — reserved basenames, frontmatter field set, `Document` default, `okf_version`, the `atlas:` extension key, ingest-cap defaults, the mechanical markdown helpers — which `packages/api`'s parsers import back; importers never depend on `@atlas/api` at runtime (the adapter package's round-trip test dev-deps it).

### Cardinality

- Collections: `(Workspace, Knowledge Base catalog row) → many` (multi-instance, like datasource installs)
- Knowledge documents: `document → 1 collection`

## Plugin lifecycle

- **Plugin Catalog** — the runtime registry of plugins / integrations available on a deployment. Backed by the `plugin_catalog` table. Seeded from `atlas.config.ts` at boot (see [ADR-0002](./docs/adr/0002-catalog-seeded-from-config-at-boot.md)). Holds `min_plan`, `enabled`, `config_schema` per entry. Ops can flip `enabled` for emergency disable. **Operator-curated only**: every runtime path that creates or mutates catalog rows is operator-authored, enforced at the write seam by `assertOperatorCatalogWrite` (`lib/plugins/catalog-provenance.ts`, #4174; INSERT/UPDATE sites drift-pinned by its test) — third-party/community plugin submission is gated on plugin-execution isolation (#4099).
- **Workspace Install** — a `workspace_plugins` row indicating a specific Workspace has installed a specific catalog entry. Per-(Workspace × catalog_id). Holds the per-Workspace install metadata: who installed, when, per-Workspace config. Does **not** hold credentials — those live in store-of-record per plugin type (e.g. `chat_cache` for chat platforms per [ADR-0003](./docs/adr/0003-two-store-chat-install-metadata-credentials.md)).
- **Eager plugin** — a plugin that needs boot-time registration to do its job. The chat plugin is canonical: must instantiate Adapter classes and subscribe to listener events before the first request arrives. Eager plugins live in `atlas.config.ts:plugins[]` and seed catalog rows.
- **Lazy plugin** — a plugin consulted per-request, instantiable on demand. Salesforce, Jira, query-time integrations. Lives only in `plugin_catalog`; loaded by the agent loop on first per-Workspace use. Not present in `atlas.config.ts:plugins[]`.

## Install models

A Workspace Connection (per above) is established differently depending on the Platform's own auth model. The three install handlers below cover all known cases; the catalog row's `install_model` field tells the admin UI which handler to invoke.

- **OAuth install** — Customer admin clicks Connect; OAuth dance runs against operator-owned App Registration; per-Workspace token returned and stored in platform-native credential store. Examples: Slack, Linear (OAuth mode), GitHub Apps (multi-tenant), Salesforce, Jira. Handler: `OAuthPlatformInstallHandler`.
- **Form install** — Customer admin fills a form (API key, SMTP creds, webhook URL, etc.); data validates against the catalog entry's `config_schema`; persists to `workspace_plugins.config` + encrypted credential storage via `db/secret-encryption.ts`. No OAuth dance. Examples: Email (SMTP), Webhook, Obsidian, Linear (API-key mode), GitHub (PAT mode). Handler: `FormBasedInstallHandler`.
- **Static-bot install** — Operator-shared bot serves all Workspaces; customer admin provides a per-Workspace routing identifier (Discord `guild_id`, Telegram `chat_id`, Teams `tenant_id`, WhatsApp phone number) via form. No per-Workspace bot token — events from the operator-shared bot are routed to the right Workspace by matching the identifier. Examples: Telegram, Discord, WhatsApp, Teams (MultiTenant), Google Chat. Handler: `StaticBotInstallHandler`.

The handlers share the workspace-install shape (a `workspace_plugins` row gets created in all three cases) but differ in what gets persisted as credentials. `StaticBotInstallHandler` is essentially a degenerate form-install where the "credentials" are routing identifiers, not secrets.

### Multi-pillar systems

Some third-party systems are useful in more than one pillar. GitHub is the canonical example: it's an **Action Target** (Atlas creates issues, comments, opens PRs) *and* a **Datasource** (Atlas queries issues, PRs, commits for analytics). Linear is similar.

The pattern: one **catalog row per (system, pillar)**, not one row that spans pillars. So GitHub-as-Action-Target ships as catalog slug `github` (Action Target) and a future GitHub-as-Datasource ships as catalog slug `github-data` (Datasource, lives on `/admin/connections`). Each row has its own install (likely different OAuth scopes), its own credentials, its own disconnect.

Why split rather than one-row-many-pillars:
- **Least privilege.** A customer who wants Atlas to query GitHub data is not necessarily the same customer who wants Atlas to write to GitHub. Bundling forces a permission superset.
- **Disconnect semantics stay obvious.** Removing the Datasource row doesn't remove the Action Target row; each pillar's surface owns its own lifecycle.
- **The one-surface-per-pillar rule survives.** Each row appears on exactly one admin page.

The UX cost — "I already connected GitHub, why am I being asked again?" — is mitigated by the second install detecting existing credentials and offering "Extend scopes" instead of a fresh "Connect."

### Multi-mode integrations

Some integrations support multiple install models *within the same pillar*. Linear-as-Action-Target has both OAuth-app and API-key modes; GitHub-as-Action-Target has App-multi-tenant, App-single-tenant, and PAT modes. Treat each `(integration, install_mode)` pair as a **separate catalog row** rather than one row with a mode toggle. (Combined with the multi-pillar rule above: total catalog rows for a system = pillars × install_modes-per-pillar.) The catalog query stays simple (`SELECT … WHERE install_model = 'oauth'` for handler dispatch); the admin UI renders distinct cards ("Linear (OAuth)" and "Linear (API Key)") so the customer admin sees the real trade-off. Naming convention: catalog slug is `<platform>-<mode>` for non-default modes (e.g. `linear` for OAuth as default, `linear-apikey` for the API-key alternative).

### SaaS-vs-self-host eligibility

A few install models are unsafe on SaaS even though they work on self-host. GitHub PAT mode is the canonical example — a Personal Access Token is scoped to one GitHub user, so the integration breaks when that user leaves the customer's company. The catalog row carries a `saas_eligible: boolean` flag (or equivalent gate) that hides the entry from SaaS admin UI while leaving it available for self-host operators wiring their own deploy. Decisions: `min_plan` is for plan-tier gating (Free vs Team vs Enterprise); `saas_eligible` is for deploy-mode gating (SaaS vs self-host).

### Credential rotation

Rotation semantics differ per `install_model`:

- **OAuth** — refresh tokens managed by Atlas (auto-refresh on expiry; re-prompt customer admin if refresh fails)
- **Form** — manual customer-admin rotation; expired credentials surface as actionable errors
- **Static-bot** — operator rotates env vars; Atlas restart picks up new credentials; no per-Workspace impact

Each install handler's interface docstring should call out its rotation semantics so consumers write the right error-handling shape.

## Deployment posture (as of 2026-05-19)

Atlas SaaS is deployed to two real Workspaces only: the maintainer's internal team and an internal demo team. **No external customers.** This is the "pre-customer clean-break" window — schema migrations can hard-drop, API contracts can change without versioning, no deprecation shims needed. The precedent is the #2620 / #2626 / #2634 / #2641 sequence, all clean breaks.

The implication for upcoming work, including the Multi-Adapter SaaS Readiness milestone: prefer the architecturally correct shape over the migration-preserving one. The cost of a wrong-shaped contract that ships and then needs a v2 dwarfs the cost of breaking the two internal Workspaces today.

This posture has a deadline: the first external customer onboards. Anything in flight by then has to lock its contracts. Until then, the door is open.

## Operator vs Customer

Atlas runs in two deploy modes: **SaaS** (one operator, many customers) and **self-host** (operator and customer are the same party). The terms below refer to the role, not the person — on self-host one person plays both.

- **Operator** — the party who runs the Atlas instance. Owns the deploy, the App Registrations, the catalog seed (`atlas.config.ts`), the infrastructure choices (sandbox priority, scheduler backend, residency regions). Controls what's *possible*.
- **Customer admin** — the party who configures a specific Workspace. Owns Workspace Connections, integration installs, per-Workspace config (channel allowlists, model selection, BYOT credentials, etc.). Controls what's *active* for their Workspace.
- **The seam** — where Operator capability meets Customer activation. Lives at `plugin_catalog` (operator declares) → `workspace_plugins` (customer activates). Any surface that puts Customer concerns into operator-only space (e.g. requiring an `atlas.config.ts` edit to add a Platform per customer) is a **leak** of self-host shape into SaaS shape. See ADRs 0001–0003 for closing the chat-Platform leak.

## Conversation scope

A conversation can read from two kinds of **Datasource** (see Pillars): SQL connections and REST datasources. **Conversation scope** is the umbrella for *which* of those a given conversation can query. It has two axes — **SQL routing** and **REST scope** — surfaced together in the chat header's **scope picker** (`ChatScopePicker`, historically `ChatEnvPicker` / "env picker"). Scope is **per-conversation and authoritative**: it persists on the `conversations` row, an opened conversation restores its own scope, and a workspace-scoped browser preference (the *sticky* last selection) seeds brand-new chats. See [ADR-0011](./docs/adr/0011-unified-conversation-scope.md).

- **Conversation scope**:
  The full set of datasources a conversation can query — its SQL routing plus its REST scope. The scope picker's single source of truth.
  _Avoid_: "env" / "environment picker" (the picker predates REST and covered SQL only); "reach" (considered, dropped in favour of "scope").

- **SQL routing**:
  The SQL axis of scope — the active **Connection group**, which of its **Members** execute, and the **routing mode** (Auto/Pin/All) that decides that. `executeSQL` only.
  _Avoid_: "SQL scope" (the axis is named *routing*); "environment" used loosely for the group.

- **Connection group**:
  A named set of interchangeable SQL connections (e.g. a multi-region `prod` group with `apac-prod` / `eu-prod` / `us-prod`), carrying an operator-designated primary. The unit SQL routing binds to.
  _Avoid_: "environment" (informal only), "cluster".

- **Member**:
  One SQL connection within a connection group; an `executeSQL` execution target. REST datasources are **not** members — they have no such group membership and are not run by `executeSQL`.

- **Routing mode**:
  The Auto / Pin / All value of SQL routing — **Auto** (agent decides per turn), **Pin** (one member), **All** (fan out across every member). Persisted as `routingMode`. SQL-only; it never affects REST scope.
  _Avoid_: conflating with `executeSQL`'s per-turn **`scope`** argument (the agent's per-call member choice under Auto), or with the umbrella **Conversation scope**.

- **REST scope**:
  The REST axis of scope — which of the workspace's **REST datasources** the conversation can reach. Two states:
  - *Default* — all in scope (workspace-global REST is reachable in every conversation, per [ADR-0010](./docs/adr/0010-rest-datasource-environment-scoping.md)), narrowed by an **exclude-set** (`rest_excluded_datasource_ids`); a newly-added REST datasource is reachable by default, and SQL routing stays active.
  - *Focused (REST-only)* — the conversation targets exactly one REST datasource (`rest_focus_datasource_id`) and **SQL is suspended** (no `executeSQL`). The "ask Stripe only" case.
  _Avoid_: "REST routing" (REST is scoped/focused, not routed).

- **REST datasource**:
  A **Datasource** reached over an `openapi-generic` install via `executeRestOperation` rather than SQL. Workspace-global by default, optionally group-scoped (ADR-0010). In default REST scope iff (workspace-global OR scoped to the active group) AND not in the exclude-set; in focused scope iff it is the focus target.

### Relationships

- A **Conversation scope** has one **SQL routing** axis and one **REST scope** axis.
- **SQL routing** binds one **Connection group** + a **routing mode**; the group has one or more **Members**.
- **REST scope** is either *default* (workspace in-scope **REST datasources** minus the exclude-set, SQL active) or *focused* (one REST datasource, SQL suspended).
- A **routing mode** governs **Members** only; it never changes **REST scope** (REST scope follows the active group + exclude-set, mode-independent — ADR-0010).

### Flagged ambiguities

- "env picker" / "environment" — the chat-header control was built SQL-only (#2345) and named for environments; it now governs full **Conversation scope**. Canonical name: **scope picker**; "environment" survives only as an informal synonym for **Connection group**.
- "scope" is overloaded — **Conversation scope** (this umbrella) vs `executeSQL`'s per-turn **`scope`** argument (the agent's per-call member choice under Auto routing) vs ADR-0010 "in-scope". Disambiguate in prose.
- "reach" / "routing" as the umbrella — both considered and rejected. The umbrella is **Conversation scope**; the SQL axis is **SQL routing**; the REST axis is **REST scope**.
- "region" — overloaded across two unrelated axes. **Atlas-internal residency region** (the control-plane region that is the **sole physical home of a Workspace's entire control-plane footprint** — its identity (`user` / `organization` / `member` / `session` / `account`), metadata, audit log, conversations, and semantic layer. Each region is a **fully independent stack** — its own internal DB and its own Better Auth instance — so an EU Workspace has **no row in the US DB** and `api.useatlas.dev` `401`s it. `ResidencyResolver`, per-workspace, immutable (a change is an operator-driven cross-region *data migration*, never a re-pick). Two planes route differently: the **analytics-datasource** axis is resolved transparently *below* the connection and is **invisible to the agent**; the **auth/control plane** is region-pinned *above* the connection — the browser must reach the Workspace's *own* regional API to authenticate, so region must be known **before** the first identity write — see [ADR-0024](./docs/adr/0024-regional-identity-isolation.md)) is *not* the **Connection group / Member** axis (the customer's analytical datasources, which may physically live anywhere and which the agent ranges over). Cross-group analytical reach never composes with residency — residency sits below it and the agent never sees it. A group's members being *named* by region (`us-prod`) is the customer's own replica/shard naming, unrelated to Atlas residency.

### Example dialogue

> **Dev:** "If I **Pin** a conversation to `apac-prod`, does that stop it hitting Stripe?"
> **Maintainer:** "No — the **routing mode** only picks which **Member** runs `executeSQL`. Stripe is a workspace-global **REST datasource**, so it's in **REST scope** regardless of the pin. To take it out, **exclude** it. If you want *only* Stripe and no SQL at all, **focus** it — that suspends SQL routing for the conversation."

### Cross-source composition

When a question spans more than one **Datasource** — several **Connection groups**, or a group plus a **REST datasource** — Atlas answers by **cross-source composition**: the agent runs a separate query per source (`executeSQL` per group, `executeRestOperation` per REST datasource) and **correlates the returned result sets in its own reasoning**. The "join" is the LLM stitching result sets in context, not a SQL operation — so every individual query still stays within one source's dialect, whitelist, and AST validation.
  _Avoid_: "federation" / "cross-engine join" — Atlas has **no** query engine that executes a single SQL `JOIN` across heterogeneous datasources. A federated query engine (DuckDB-with-scanners / Trino) would be a separate, deliberately-unbuilt capability, never this.

## Semantic layer scoping

The semantic layer (entity YAMLs, glossary, metrics) describes the schema of a **Connection group**, not of an individual **Member** or **Datasource**. Members within a group are interchangeable and share a schema, so they share one set of entities; a standalone Datasource is simply a group-of-one. An entity therefore binds to exactly one Connection group.

- **Entity group scope** — the Connection group an entity describes; the unit behind "which entities belong to which database." Surfaced as the entity's **group** (YAML `group:`, the view's grouping, the CLI's target). A NULL/absent scope is the **default group** — the single-database case where the "which is for which" question doesn't arise, and the layout collapses to flat `semantic/entities/*.yml`.
  _Avoid_: scoping entities to a Member or an individual Datasource — members share a schema, so the binding is to the group, never to one connection.

### Flagged ambiguities

- "source" / `connection:` / `--source` — historically the entity-group scope wore three different names: the YAML `connection:` field, the CLI `--source` flag, and the admin/API `source` (computed as the group id, defaulting to `"default"`). All three denote the **Connection group**. Canonical surface term: **group**; the aliases are deprecated and being unified.

## Semantic improvement

The review loop through which AI-proposed changes to the semantic layer become real: an expert agent (interactive) or the scheduler (autonomous) proposes, an admin reviews, an approval applies.

- **Amendment** — the durable, reviewable unit of proposed semantic-layer change, and the *only* identity a proposed change has — the same one across every path that can create it (admin chat, scheduler, CLI). Lifecycle `pending → approved | rejected`, where **approved means applied**: a stamped-but-unapplied amendment is a bug, not a state.
  _Avoid_: "proposal" as a distinct noun — to propose is to create a *pending* Amendment; there is no second, in-memory thing. "Pattern" (the storage table's historical name).

- **Pending queue** — the org's pending Amendments; the single collection the review panel shows and the pending badge counts, regardless of which path created each Amendment. An Amendment created mid-conversation appears *in* the queue (marked as from this conversation), never in a parallel list.
  _Avoid_: "chat proposals" vs "pending amendments" as two collections — there is one queue with presentation markers.

- **Improvement conversation** — the admin's chat with the expert agent on the improve surface. It is a conversation, not a stored resource: nothing durable hangs off it except the Amendments it creates.
  _Avoid_: "improvement session" — implies a stored, addressable resource; there is none (deleted rather than made durable — any future resumability rides ADR-0020 durable agent sessions, never a bespoke store). The CLI's interactive loop keeps local REPL state; that is not a session either.

- **Rejection memory** — the org's rejected Amendment identities, which suppress re-proposal on every path (chat, scheduler, CLI). Enforced where an Amendment is created — a hit refuses the insert — never by prompt advice alone. A rejection is **permanent until an admin reconsiders it**; it does not age out.
  _Avoid_: time-windowed expiry; treating "the model was told not to" as suppression.

- **Reconsider** — the admin action that lifts a rejection: it returns a rejected Amendment to the Pending queue and removes its identity from rejection memory. The only way a rejected change comes back.
  _Avoid_: "unreject"; silent re-proposal by the agent (rejection memory forbids it by construction).

- **Anchor** — what an Improvement conversation optionally starts from: a **group**, an **entity**, or a **column**. The anchor scopes the agent's briefing and persists as context for the conversation; it is a launcher into the chat, never a cage — the admin can always converse free-form. A sweep ("find improvements") is simply the anchorless start.
  _Avoid_: modeling entry points as separate surfaces or modes — every entry point starts the same conversation with a different anchor.

- **Briefing** — the deterministic context the expert agent is handed at turn one of an Improvement conversation: health score, analyzer findings, audit-pattern summary, rejection memory, the Pending queue, and whatever the Anchor scopes in (a group's entity inventory, an entity's YAML, a column's profile). Served from tracked profiles with a staleness marker — never recomputed against the customer database just to start a chat.
  _Avoid_: making the agent rediscover deterministic facts through tool calls; "context dump" (the briefing is curated, anchor-scoped).

- **Dialect specialist** — engine-specific expertise (Postgres, MySQL, ClickHouse, …) as a composable prompt module keyed by dbType, shipped by the datasource plugin, and resolved into the conversation for the groups in scope. One agent, composed prompt: the specialist module knows the engine; the expert persona owns the semantic layer and Amendments.
  _Avoid_: separate per-engine agents handing off to each other; "the Postgres agent" as a distinct actor (it is a module in the one agent's prompt, in the same way an answer style is).

- **Baseline profile / LLM profile** — the two tracked tiers of knowing a connection. The baseline profile is cheap and deterministic (schema, types, counts, samples) and runs automatically when a profilable connection is created (REST datasources excluded). The LLM profile is the enrichment pass — never automatic, billing-gated, tracked per connection (when, over what).
  _Avoid_: one boolean "profiled"; running LLM enrichment implicitly.

- **Autonomous improvement** — the scheduler-driven mode: Atlas proposes Amendments on its own cadence for a workspace. Per-workspace opt-in, **off by default**, spending that workspace's own budget through the same billing gate as chat (agent origin `scheduler`), with new pending Amendments notified over the proactive seam. Entirely independent of interactive improvement — an admin reviews, converses, and approves without ever enabling autonomy. **Auto-approve is a second, separate opt-in on top of autonomy**, never implied by it.
  _Avoid_: gating the improve surface on the scheduler setting; "the scheduler is self-hosted-only" (it is SaaS-first; self-hosted's single workspace is the degenerate case, not a different model).

- **Live diff** — the diff an admin reviews, always computed against the entity's *current* baseline at render time. The propose-time diff stored on an Amendment is a record of intent, never the thing approved. A baseline that changes mid-review means one more human look at an updated live diff — a continuation of review, not an error.
  _Avoid_: approving the stored diff; auto-rebasing or "compatible change" heuristics (a changed baseline always gets a human look).

### Anti-confusions

- **Amendments refine; enrich grows.** Nothing an Amendment can do adds an entity or expands the queryable table set — that containment is what makes auto-approve and the scheduler safe to contemplate. A column or table with **no** semantic coverage is shown honestly as uncovered and routes to the enrich flow (a human-initiated act with whitelist consequences), never to an "add entity" amendment type.

- **Amendment approval IS the publish gate for that change.** Approving applies to the published entity directly — a recorded content-mode carve-out; the evidence-backed, admin-approved queue is review of publish grade, and routing its output into a second draft→publish wait would park approved changes invisibly. If a draft of the entity exists, the approve applies to the draft too (convergent by upsert-by-identity), so a later publish cannot clobber the approved change; a draft-side miss (the draft removed the target) is visibly skipped, never silent.

- **A glossary term binds to a group, and the glossary is amendable.** The glossary is a group-scoped document in the same semantic store as entities; a glossary Amendment (`add_glossary_term` / `update_glossary_term`) targets that document with the same lifecycle, rejection-memory identity, and eligibility rules as any other Amendment type — no special cases, and never a silent no-op (a type the apply cannot write must not be proposable).

- **Rollback-ability is part of the apply.** Every applied Amendment has a version snapshot to roll back to; a snapshot that cannot be taken fails the apply (the Amendment returns to pending with a visible reason) rather than proceeding without a rollback target.

- **Validation is a seam, not a tool.** An Amendment is validated where it is created (a proposal that fails never enters the Pending queue) and revalidated where it is applied (the post-apply document must parse as an entity; embedded SQL must parse as a query; each type may touch only its declared fields). Gates are code the payload must pass through, never advice the model may follow — there is no optional "validate" step whose verdict floats free.

- **An Amendment has exactly one workspace owner.** Every path that creates one stamps the workspace it belongs to; a NULL-owner row is legacy self-hosted data — tolerated on read there, never produced anew anywhere.

## Learned query patterns

The capture-and-payoff loop through which SQL query shapes observed in live execution become reusable knowledge for the agent: successful queries are captured as pending patterns, promotion (human or machine) makes them injectable, and relevant approved patterns are injected into future agent prompts. Vocabulary pinned by the learned-patterns elevation grill (2026-07-10, audit `.claude/research/learned-patterns-audit-2026-07-10.md`).

- **Query pattern** — the durable unit of learned query knowledge: a normalized SQL shape captured from a successful live execution, scoped to one workspace and one connection group. Lifecycle `pending → approved | rejected`. The learned-patterns surface shows query patterns **only** — Amendments are a different concept that historically shares the storage table, reviewed exclusively on the improve surface (#4569).
  _Avoid_: "learned pattern" and "query pattern" as different things (one concept; "learned" describes how it was born); treating an Amendment as a kind of pattern or vice versa.

- **Approval (of a query pattern)** — a human grant of **injection eligibility**: "this pattern is correct — inject it whenever it's relevant." An approved-by-human pattern is always eligible regardless of confidence; relevance still decides which eligible patterns enter a given turn. Approval never rewrites confidence.
  _Avoid_: stamping a floor confidence on approve (overloads the evidence meter with a trust signal); an approval whose effect the admin cannot observe.

- **Confidence** — the machine's evidence meter for a query pattern, derived from observed repetition. It gates **machine** promotion and ranks retrieval; it is never written by human decisions and never encodes trust. Human approval and machine confidence are the two independent roads to injection eligibility.
  _Avoid_: reading confidence as correctness or human endorsement; any human action that mutates it.

- **Auto-promotion** — the machine road to injection eligibility: a **workspace-scoped, per-workspace opt-in, off by default** — the same SaaS-first posture as autonomous improvement, with self-hosted's single workspace as the degenerate case. Capture is always-on everywhere (it is free and deterministic); auto-promotion is the workspace's one trust dial. Decay is its counterpart and never touches human approvals.
  _Avoid_: a platform-scoped or env-only promotion switch (a tenant-behavior knob belongs in the workspace settings registry); "the loop is self-maintaining" on a workspace that hasn't opted in.

- **Injection** — the payoff act: eligible, relevant query patterns rendered into an agent turn's prompt. Every injection is **attributed** — which patterns entered which turn is recorded — so a pattern's usage is observable evidence, in the cockpit and for any future feedback design. Crediting adapted queries back to their source pattern, and demoting patterns on bad outcomes, are explicitly deferred until attribution data exists.
  _Avoid_: unattributed injection (an approval whose effect nobody can observe); inferring usefulness from confidence.

- **Pattern identity** — what makes two observations the *same* query pattern: (workspace, connection group, normalized SQL fingerprint), enforced by the database. A repeat observation increments the existing pattern — it can never mint a second row. A seen-once pattern is captured but sits below the default review queue and below every promotion gate until it repeats.
  _Avoid_: application-side read-then-insert as the only dedup; timestamp uniquifiers; a review queue full of seen-once noise.

- **Eligible set** — the workspace-and-group's injectable patterns, from which relevance picks per turn: every human-approved pattern unconditionally, plus machine-promoted patterns by confidence. Ordered human-approved first (they never fall off any cap), then confidence, then last-observed as the saturation tiebreak. Full-text retrieval is the recorded scaling exit, adopted on evidence (library size, attribution showing relevant-but-unfetched misses), not preemptively.
  _Avoid_: any pre-relevance truncation that can drop a human-approved pattern; an unspecified order among confidence ties.

## Chat turn presentation

How one agent turn is presented in the chat transcript. A turn has two faces: the **activity** (everything the agent did on the way) and the **answer** (what the turn exists to deliver). Presentation is answer-first: the answer is the visually dominant element; activity is live while the agent works, then settles into a collapsed receipt. Vocabulary pinned by PRD #4292 (answer-first chat turn presentation); the receipt/promotion mechanics shipped with #4298 (finished turns, notebook convergence #4301) and #4300 (live working phase), so the present-tense descriptions below are shipped behavior — remaining #4292 slices (answer styles, editorial voice) note their own status.

- **Answer**:
  The final user-facing text of an agent turn — the thing the user asked for. Streams as the dominant element once the working phase ends.
  _Avoid_: "response" (the whole turn, activity included), "final message".

- **Activity**:
  Everything the agent did on the way to the answer — semantic-layer reads, SQL/REST executions, and narration. Rendered live during the working phase as a compact per-step feed; never interleaved at full weight with the answer.
  _Avoid_: "thinking" (model reasoning is a distinct, never-surfaced stream), "steps" (AI-SDK wire concept), "tool calls" (implementation term).

- **Working phase**:
  The interval between the user's send and the first answer token, during which the activity feed is live and ticking. Begins immediately on send (no dead air) and ends when the answer starts streaming.

- **Receipt**:
  The collapsed one-line summary the activity settles into once the answer begins (e.g. "Explored schema · 2 queries"). Expands on demand to the full activity — the work is inspectable, not ambient.
  _Avoid_: "thinking layer", "collapsed section".

- **Narration**:
  The agent's inter-step commentary ("the region column looks unpopulated, checking..."). Part of the activity, never part of the answer.
  _Avoid_: conflating with the answer — both are text on the wire; presentation must separate them.

- **Answer-bearing artifact**:
  A result table or chart that the answer itself presents — promoted out of the receipt to sit with the answer. At most one per turn by default; all other query results stay in the receipt.
  _Avoid_: "the last query's result" (answer-bearing is a semantic property, not a positional one).

- **Answer style**:
  The named editorial voice of the answer — `plain-english`, `analyst` (web default), `executive`, `conversational` (chat-platform default, ex-#2705). Resolves through the registry in `packages/api/src/lib/answer-styles.ts` (#4299): each style contributes exactly one prompt addendum to the system prompt; everything else (the `<suggestions>` contract, cross-source provenance guidance) is style-independent. Surfaces auto-select their default until the per-conversation picker lands (#4302).
  _Avoid_: "presentation mode" (the superseded #2705 binary — survives only as the chat-plugin boundary field, translated at the seam, and as the deliberately retained legacy heading inside the conversational addendum); any bare "mode" phrasing (deploy / content / routing collisions).

### Anti-confusions

- The **receipt** is not a "reasoning" or "thinking" display — model reasoning tokens are never surfaced in the transcript. The receipt contains activity (real executions and narration), not chain-of-thought.
- Answer-first presentation serves the **evaluating trial admin** too: their trust need is met by activity being *inspectable* (one click), not *ambient*. There is no persona toggle.

## Dashboard editing

How a dashboard is edited and made visible to a team. **Target-state vocabulary** — pinned during the dashboard elevation grill (2026-07-04, audit `.claude/research/dashboard-audit-2026-07-04.md`); the draft-first model below is the design contract, not yet shipped behavior (today direct manipulation commits live and only the agent path drafts).

- **Dashboard**:
  A persistent, shareable grid of **cards** with an optional top-level **parameter bar**. The unit that is created, shared, and published.
  _Avoid_: "board" (informal only), "report" (a separate shared-conversation concept).

- **Card**:
  The unit on the grid. A **chart card** carries a SQL query + visualization; a **text card** carries markdown (section headers, explainers) and no data.
  _Avoid_: "tile" for the persisted unit — a *tile* is the rendered presentation of a card on the **canvas**; "widget".

- **Canvas**:
  The dashboard grid surface a user looks at. Renders the caller's **draft** when they have one, the **published** state otherwise — so a user always sees the version they are editing, never a stale published copy while they work.
  _Avoid_: "grid" for the concept (the grid is the layout mechanism); "the dashboard view".

- **Draft**:
  The caller's private, per-user working copy of a dashboard. **Every** edit — direct manipulation (drag, rename, delete) and agent/chat edits alike — lands in the draft; it is invisible to teammates until **published**. One draft per (user, dashboard).
  _Avoid_: conflating with the content-mode `draft` status enum (a dashboard row is not content-mode gated); "staged change" (the retired **stage tracker**'s pending-destructive-op concept — decided 2026-07-10: destructive bound-editor ops land directly in the draft like every other edit, with inline undo; there is no second pending-changes store, and publish can no longer strand an unaccepted change).

- **Draft cache**:
  A draft card's own cached data, private to the **draft** it lives in — pinned during the second dashboard elevation grill (2026-07-10). Executing a card while holding a draft (refresh, parameter change, retry, first load of a never-published card) reads and writes the draft cache, never the **published** card's cached data and never the **Query Cache**. Every tile affordance — refresh, staleness, age, retry — works identically whether the card's data comes from the draft cache or the published cached data; a draft-only card is fully operable before **first publish**.
  _Avoid_: "the cache" unqualified on the dashboard surface (three distinct stores: draft cache, published cached data, Query Cache); treating a draft-only card as un-runnable until publish (the 404-until-published behavior is the defect this term retires).

- **Published**:
  The shared, org-visible state of a dashboard — the card set + metadata that teammates and shared links see. The merge target of **publish**.
  _Avoid_: treating "published" as a full content-mode status enum (there is no draft/published/**archived** tier on the dashboard row); conflating the one-time **first publish** visibility transition with the ongoing edit-gating.

- **First publish**:
  The one-time transition that makes a never-published dashboard visible to the rest of the org. Before it, a dashboard is **private to its creator** (a single "has ever been published" gate, not a content-mode status); after it, the dashboard stays org-visible permanently and subsequent **publish**es gate only the *edits*.
  _Avoid_: modeling this as a reversible status (it is a one-way gate — there is no "unpublish"/archive in this design).

- **Publish**:
  The single gated transition that three-way-merges the caller's **draft** into the **published** dashboard (409 on a stale baseline or a same-card conflict). The only path from private edit to teammate-visible.
  _Avoid_: "save" (editing continuously auto-persists to the draft; publish is the *promotion*, not the save).

- **Bound editor**:
  The dashboard-scoped chat drawer through which the agent builds and edits a dashboard. Its edits land in the caller's **draft**; the **canvas** — cards materializing and updating live — is the turn's **answer-bearing artifact**, so the drawer shows conversation + a collapsed **receipt** (per *Chat turn presentation*), not inline card previews. It is also the dashboards surface's own **creation instrument** (pinned 2026-07-10): creating a dashboard from the surface opens the bound editor on the empty canvas — the surface is a first-class creation origin, not a viewer that bounces new users back to main chat.
  _Avoid_: "bound chat" for the surface (say bound editor); rendering the build as full-weight inline tool cards (that is the divergent pre-convergence renderer being retired).

- **View / Edit (canvas modes)**:
  The two interaction modes of the **canvas**, pinned 2026-07-10: **View** is strictly read-only for the dashboard's *definition* — it offers only non-mutating affordances (refresh, fullscreen, CSV export, parameter/filter changes) and can never fork or touch a **draft**; **Edit** is where every definition mutation (remove, rename, duplicate, drag, SQL/config change) lives, all landing in the caller's draft. A browsing gesture must never create a draft.
  _Avoid_: exposing mutating tile controls in View (the pre-2026-07-10 defect); "read-only" to mean no-refresh (refreshing data is a View affordance — read-only gates the *definition*, not the data's freshness).

- **Tile**:
  The rendered presentation of a single **card** on the **canvas**, and the **unit of trust**: a tile carries its own status — loading, fresh, **stale**, errored, empty, not-filtered — surfaced *on the tile*, rather than deferring failures to a page-level banner.
  _Avoid_: using "tile" for the persisted unit (that is a **card**); collapsing *errored* (the query failed), *empty* (the query returned zero rows), and *never-run* (no cached data yet) into one "No cached data" state — they are three distinct tile states.

- **Stale (tile)**:
  A tile whose displayed data predates the current **card** definition (its SQL/config) or the active parameter/filter values — a first-class, *visible-but-quiet* state (a color-shifting age caption — muted → amber → red — plus a subtle body dim and a one-click retry, never a banner). A tile that fails to update stays labeled with its data's age and offers retry; it never silently substitutes old data for a failed new render.
  _Avoid_: "cached" as a synonym (all tile data is cached — staleness is *cache older than the current definition/params*, not the mere fact of caching).

- **Shared view**:
  The read-only, **data-only snapshot presentation** of a **published** dashboard reached through a share token. Exposes title/description + per-card title/kind/chart-config/annotations/cached data/layout — and *nothing else*. Never the raw SQL, connection/owner/org identifiers, refresh cron, or parameter definitions. Uniform across **public** (no-auth) and **org** (authenticated-teammate) share modes.
  Reached as a standalone page or as an **embed** (an iframe-framable presentation of the same shared view — decided 2026-07-10, mirroring the conversation embed): same token, same snapshot, same revocation/expiry; the embed is a frame around the shared view, never a second sharing surface.
  _Avoid_: treating the shared view as a live or inspectable dashboard (query inspection happens in-app, where auth gates it); "public dashboard" (the *dashboard* isn't public — a *token* grants snapshot access); modeling the embed as a new access mode (the token is the access control, framed or not).

### Anti-confusions

- The **draft** is a per-user *working copy*, not a content-mode visibility tier. Two editors have two independent drafts of the same published dashboard; publish merges, never overwrites (except last-writer-wins on title/description).
- **Publish** is not **refresh**. Publish promotes *definitions* (SQL, layout, config); refresh re-executes a card's SQL to update its *cached data*. A publish that changes SQL must trigger a refresh or the **shared view** shows new definitions over stale data.
- The **shared view** is data-only by construction, not by redaction-after-the-fact — the public projection is built from a minimal DTO, so a field can't leak by being forgotten. Raw SQL never reaches the wire on this surface.
- The **shared view** has a single **as-of** instant (decided 2026-07-10): every piece of temporal framing a share viewer sees — parameter chips, "data as of" captions — derives from the shown data's capture instant, never from view time or dashboard creation time. When a refresh updates the rows, all framing moves with them; the page can never contradict itself about what window the numbers cover.

## MCP & agent governance

The MCP server runs the same agent tools as the chat app, so the same governance (RBAC, approval rules, audit) must apply. These terms pin *who* is acting and *through what channel*.

- **MCP actor** — the identity an MCP request is attributed to and authorized as. Three kinds: *governed* (bound to a real user + org via `ATLAS_MCP_USER_ID` / `ATLAS_MCP_ORG_ID`), *trusted* (synthetic `system:mcp`, carrying no real identity), and *hosted* (resolved per OAuth bearer).
  _Avoid_: "MCP user" (the trusted actor is not a user).

- **Anonymous onboarding caller** — the identity-less entry point for self-serve signup over MCP. It is **not** an MCP actor (it carries no identity, governed/trusted/hosted) and is structurally incapable of reaching the dispatch gate pipeline. It can invoke exactly one tool (`start_trial`) on a separate, pre-auth registration path; that call *produces* a real user + Workspace, after which a normal *hosted* actor takes over via the OAuth/DCR connect. The single, audited pre-actor carve-out — never a fourth actor kind, never a `system:mcp` (*trusted*) fallback.
  _Avoid_: modeling it as a degenerate *trusted* actor (`system:mcp` is the operator's own process, a different boundary); "anonymous actor" (it is precisely *not* an actor).

- **Claim (an unclaimed Workspace)** — a Workspace provisioned over MCP by the *anonymous onboarding caller* exists **unclaimed** until a human comes to the web and completes the OTP interstitial (verify email via emailOTP — Atlas never uses magic links — set a credential/passkey, accept ToS). Claiming flips the trial from **metered** (token spend withheld so the agent won't answer data questions on Atlas's tokens; setup — datasource connect, semantic layer — is fully allowed) to **full** (normal `trial` token budget). The meter is a clamp on the token budget keyed on `emailVerified`, not a plan tier. Distinct from **solvency** (Gate 0): an *expired* trial is blocked on every surface including MCP by Gate 0, regardless of claim state or token budget. Both axes have one code home — `packages/api/src/lib/billing/trial-state.ts` (#4127: composite `deriveTrialState`; Gate 0 and the reaper's SQL consume its primitives/fragments) — and the Gate-0-before-claim ordering on the headless Atlas-token path is encoded in `checkAgentQueryGates` (`billing/agent-query-gates.ts`, #4128).
  _Avoid_: conflating *metered/full* (pre/post-claim token clamp) with *trial-expired/solvent* (Gate 0); calling an unclaimed Workspace a "draft" (that term is the content-mode status enum).

- **Agent origin** — the invocation channel a query or mutation reached the agent through: `chat` / `mcp` / `scheduler` / `slack`. Approval rules match on it and the audit log records it. See [ADR-0015](./docs/adr/0015-agent-origin-not-surface.md).
  _Avoid_: "approval surface" and bare "surface" (reserved for the pillar admin page); "source" (a deprecated alias for Connection group); conflating with **Lead source** below — agent origin is about *agent traffic* (approval/audit), lead source is about *CRM acquisition* (marketing attribution). Both can say "mcp"; they are different concepts.

## Query Cache

- **Query Cache** — the per-region, in-process store of `executeSQL` result rows (`lib/cache/`), keyed by (SQL, Datasource connection, Workspace, user claims) so entries are tenant-isolated by construction. One per API process, shared by every Workspace in the region. Distinct from the chat-SDK state store (`chat_cache:*` keys — Workspace Connection credentials, not query results) and from a dashboard card's **cached data** (persisted per-card snapshots, refreshed by publish/cron — see "Dashboard editing").
  _Avoid_: bare "cache" in cross-subsystem prose (say Query Cache); "chat cache" for this concept (`chat_cache` is credential storage).

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
