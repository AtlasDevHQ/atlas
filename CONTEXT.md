# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

## Pillars

Atlas reaches the outside world in three distinct ways. A given **catalog row** fits in exactly one pillar; the split matters because the install lifecycle, credential storage, and admin UX differ across them. Some third-party *systems* span pillars by carrying multiple catalog rows — see "Multi-pillar systems" below.

- **Datasource** — a third-party system Atlas *reads* tabular data from to answer questions. Configured in `/admin/connections`, queried by the agent via the `executeSQL` tool, backed by `semantic/entities/*.yml`. Examples: Postgres, MySQL, Snowflake, ClickHouse, BigQuery, DuckDB, Salesforce (SOQL).
  _Avoid_: Connector, "data source" (two words), "DB connection" (means the pool, not the third-party system).

- **Chat Platform** — a third-party chat service through which customers *talk to* Atlas. Atlas listens for messages and replies. Examples: Slack, Microsoft Teams, Discord, Google Chat, Telegram, WhatsApp.
  _Avoid_: bare "Platform" (overloaded historically — always say "Chat Platform" when you mean the chat surface), "chat integration", "chat service".

- **Action Target** — a third-party system Atlas *writes to or acts on* (creates issues, sends emails, fires webhooks). The customer doesn't talk to Atlas through these; Atlas reaches out. Examples: GitHub, Linear, Email (SMTP), Webhooks.
  _Avoid_: "Outbound integration", "Action Integration". Bare "Integration" is ambiguous — it can mean a Chat Platform, an Action Target, or the umbrella over the latter two.

### One user-facing surface per pillar

A given third-party system appears on **exactly one** admin page, determined by its pillar:

- Datasource → `/admin/connections`
- Chat Platform → `/admin/integrations` (chat section)
- Action Target → `/admin/integrations` (actions section)

The install **handler** it uses (OAuth, Form, Static-bot per "Install models" below) is orthogonal to the pillar. A Datasource can use OAuth (Salesforce), a Chat Platform can use Static-bot (Telegram), an Action Target can use Form (Webhook). Pillar determines *where it appears*; install handler determines *how credentials are obtained*. Conflating the two would put OAuth-installed Datasources on the integrations page just because OAuth is "where catalog cards live today" — that's an install-mechanism leak into user-facing taxonomy.

### Anti-confusions across pillars

- "Salesforce integration" is ambiguous — Salesforce is a **Datasource** (read via SOQL), not an Action Target, even though it has an OAuth install dance that looks superficially like GitHub's. Its UI home is `/admin/connections`.
- "GitHub integration" is ambiguous — GitHub is an **Action Target** (Atlas creates issues, comments). It is *not* a Chat Platform, even though CONTEXT.md historically lumped it in alongside Slack.
- "Connection" is overloaded — say **Datasource** (the third-party system) or **Workspace Connection** (the chat OAuth handshake, defined below). Never just "connection" in glossary-relevant prose.

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

## Plugin lifecycle

- **Plugin Catalog** — the runtime registry of plugins / integrations available on a deployment. Backed by the `plugin_catalog` table. Seeded from `atlas.config.ts` at boot (see [ADR-0002](./docs/adr/0002-catalog-seeded-from-config-at-boot.md)). Holds `min_plan`, `enabled`, `config_schema` per entry. Ops can flip `enabled` for emergency disable.
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
