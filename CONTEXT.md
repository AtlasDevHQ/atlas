# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

## Chat-platform integration

These four terms are distinct and frequently confused. Pin them.

- **Platform** — the third-party chat service (Slack, Microsoft Teams, Discord, Google Chat, Telegram, GitHub, Linear, WhatsApp). Atlas does not own this; we integrate with it.
- **Adapter** — the Atlas-side code under `plugins/chat/src/adapters/<platform>.ts` that translates Platform events into the chat-SDK's neutral shape. One adapter per Platform. Lives in the `@useatlas/chat` plugin.
- **App Registration** — the operator's developer-portal record with a Platform vendor (e.g. "Atlas" as a Slack App in the Slack API console). Carries the `client_id` / `client_secret` / redirect URIs / event-subscription endpoints. **One per Platform per Atlas deployment.** A SaaS operator runs one App Registration per supported Platform; a self-host operator can run their own.
- **Workspace Connection** — the OAuth-completed link between a single customer Workspace and a single Platform, holding the customer's per-workspace bot token in the chat-SDK's state store (`chat_cache:slack:installation:<teamId>` and equivalents). One per (Workspace × Platform) pair.

### Cardinality

- App Registrations: `Platform → 1` per deployment (operator-owned)
- Workspace Connections: `(Workspace, Platform) → 1` (customer-owned, OAuth-completed)
- Adapters in code: `Platform → 1` per Atlas codebase (always present, conditionally activated)

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

## Deployment posture (as of 2026-05-19)

Atlas SaaS is deployed to two real Workspaces only: the maintainer's internal team and an internal demo team. **No external customers.** This is the "pre-customer clean-break" window — schema migrations can hard-drop, API contracts can change without versioning, no deprecation shims needed. The precedent is the #2620 / #2626 / #2634 / #2641 sequence, all clean breaks.

The implication for upcoming work, including the Multi-Adapter SaaS Readiness milestone: prefer the architecturally correct shape over the migration-preserving one. The cost of a wrong-shaped contract that ships and then needs a v2 dwarfs the cost of breaking the two internal Workspaces today.

This posture has a deadline: the first external customer onboards. Anything in flight by then has to lock its contracts. Until then, the door is open.

## Operator vs Customer

Atlas runs in two deploy modes: **SaaS** (one operator, many customers) and **self-host** (operator and customer are the same party). The terms below refer to the role, not the person — on self-host one person plays both.

- **Operator** — the party who runs the Atlas instance. Owns the deploy, the App Registrations, the catalog seed (`atlas.config.ts`), the infrastructure choices (sandbox priority, scheduler backend, residency regions). Controls what's *possible*.
- **Customer admin** — the party who configures a specific Workspace. Owns Workspace Connections, integration installs, per-Workspace config (channel allowlists, model selection, BYOT credentials, etc.). Controls what's *active* for their Workspace.
- **The seam** — where Operator capability meets Customer activation. Lives at `plugin_catalog` (operator declares) → `workspace_plugins` (customer activates). Any surface that puts Customer concerns into operator-only space (e.g. requiring an `atlas.config.ts` edit to add a Platform per customer) is a **leak** of self-host shape into SaaS shape. See ADRs 0001–0003 for closing the chat-Platform leak.
