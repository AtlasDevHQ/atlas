# Install models

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Install models` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


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
