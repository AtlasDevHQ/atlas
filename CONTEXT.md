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
