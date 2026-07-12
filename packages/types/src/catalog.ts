/**
 * Plugin catalog vocabulary — shared by `@atlas/api` (canonical owner of the
 * `plugin_catalog` schema + Zod validation) and `@useatlas/chat` (consumes
 * the catalog at boot to decide which chat adapters to instantiate).
 *
 * Pre-#2665 the literal unions were inline-duplicated in `plugins/chat/src/`
 * because the chat plugin can't import `@atlas/api` (CLAUDE.md
 * "Frontend is a pure HTTP client" — same package boundary). The same
 * concern applies to plugin packages, so the shared seam is `@useatlas/types`.
 *
 * A rename or addition to either tuple is now a single edit propagating
 * through both packages via TypeScript's literal-union exhaustiveness checks.
 */

// ---------------------------------------------------------------------------
// install_model — install-handler dispatch key
// ---------------------------------------------------------------------------

/**
 * Install handlers a catalog entry can dispatch to. Determines which UI
 * flow the customer admin sees on `/admin/integrations`:
 *
 * - `oauth` — Customer admin clicks Connect → operator-owned App Registration
 *   OAuth dance → bot token persists to per-Workspace encrypted credential
 *   store. Chat: Slack. Integration: Salesforce, Jira, GitHub Apps (1.5.3),
 *   Linear OAuth (1.5.3).
 * - `form` — Customer admin fills a form (API key, SMTP creds, webhook
 *   URL); validates against the catalog entry's `config_schema`; persists
 *   to `workspace_plugins.config` + encrypted credential storage.
 *   Integrations: Email (SMTP), Webhook, Obsidian, GitHub PAT (self-host),
 *   Linear API-key (1.5.3).
 * - `static-bot` — Operator-shared bot serves every Workspace; customer
 *   admin provides only a per-Workspace routing identifier (Discord
 *   `guild_id`, Telegram `chat_id`, Teams `tenant_id`, WhatsApp phone
 *   number) via form. No per-Workspace bot token. Chat: Teams, Discord,
 *   Google Chat, Telegram, WhatsApp.
 * - `oauth-datasource` — OAuth credential acquisition (the same
 *   operator-owned App dance as `oauth`) but DATASOURCE persistence:
 *   multi-instance (`install_id` composite PK), credential written to
 *   `workspace_plugins.config` via selective-field encryption, and
 *   probe-on-install caches the `openapi_snapshot`. Distinct from `oauth`
 *   (single-instance chat/action, credential in `chat_cache` / per-plugin
 *   store). v0.0.2 slice 6c (#3030): GitHub-as-datasource reuses GitHub's
 *   existing App registration; the "refresh" path is App-JWT installation-
 *   token minting, not refresh-token rotation. Pillar: datasource.
 */
export const CATALOG_INSTALL_MODELS = ["oauth", "form", "static-bot", "oauth-datasource"] as const;
export type CatalogInstallModel = (typeof CATALOG_INSTALL_MODELS)[number];

// ---------------------------------------------------------------------------
// type — admin-UI grouping
// ---------------------------------------------------------------------------

/**
 * `type` groups catalog entries for admin-UI display. Backend dispatches
 * by `install_model` (orthogonal), not by `type`. Future milestones may
 * add `datasource` once datasource plugins migrate to the catalog
 * (Architecture Backlog).
 */
export const CATALOG_ENTRY_TYPES = ["chat", "integration"] as const;
export type CatalogEntryType = (typeof CATALOG_ENTRY_TYPES)[number];

// ---------------------------------------------------------------------------
// pillar — three-pillar taxonomy (ADR-0006)
// ---------------------------------------------------------------------------

/**
 * The three orthogonal ways Atlas reaches the outside world, per ADR-0006:
 *
 * - `datasource` — Atlas reads tabular data from it (SQL / SOQL / equivalent).
 *   Lives on `/admin/connections`. Examples: Postgres, MySQL, Snowflake,
 *   ClickHouse, BigQuery, DuckDB, Salesforce.
 * - `chat` — Customer talks to Atlas through it. Lives on
 *   `/admin/integrations` (Chat section). Examples: Slack, Teams, Discord,
 *   Google Chat, Telegram, WhatsApp.
 * - `action` — Atlas writes to / acts on it. Lives on `/admin/integrations`
 *   (Actions section). Examples: GitHub, Linear, Email, Webhooks.
 * - `knowledge` — Atlas reads it as descriptive context (never as queryable
 *   data). Lives on `/admin/knowledge` (the Knowledge Base pillar, ADR-0028).
 *   Examples: Upload, Bundle Sync, Notion, Confluence, GitBook, Zendesk. These
 *   rows carry `type = 'context'` and are seeded with `pillar = 'knowledge'`
 *   explicitly (it is never derived from the catalog `type` — see
 *   `pillarFromCatalogType`).
 *
 * Multi-pillar systems (e.g. GitHub-as-Action-Target + future
 * GitHub-as-Datasource) carry one catalog row per pillar, not one row
 * with a pillar array — see ADR-0006 for the least-privilege rationale.
 *
 * Mirrors the `chk_plugin_catalog_pillar` and `chk_workspace_plugins_pillar`
 * CHECK constraints on the DB (migration 0092, widened to admit `knowledge`
 * by migration 0161). Like `datasource`, `knowledge` is multi-instance per
 * (workspace, catalog) — the `workspace_plugins_singleton` partial unique
 * index stays scoped to `chat`/`action`.
 */
export const PILLARS = ["datasource", "chat", "action", "knowledge"] as const;
export type Pillar = (typeof PILLARS)[number];

// ---------------------------------------------------------------------------
// implementation_status — coming-soon affordance (ADR-0007)
// ---------------------------------------------------------------------------

/**
 * Whether Atlas has shipped a working install path for a catalog row.
 *
 * - `available` — install handler is wired; the card renders a working
 *   Connect / Configure CTA (gated by plan + deploy-config).
 * - `coming_soon` — Atlas hasn't shipped it yet; the card renders an
 *   inert grey badge with no CTA. Operators can override per deploy via
 *   `atlas.config.ts:overrideImplementationStatus`.
 *
 * `coming_soon` dominates every other gate in the install-status state
 * machine (`@atlas/api/lib/integrations/install-status-machine`).
 *
 * Mirrors the `chk_plugin_catalog_implementation_status` CHECK constraint
 * on the DB (migration 0092).
 */
export const IMPLEMENTATION_STATUSES = ["available", "coming_soon"] as const;
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Chat adapter names
// ---------------------------------------------------------------------------

/**
 * Canonical chat platform names supported by `@useatlas/chat`. The chat
 * SDK's `Adapter` interface types `name` as a bare `string` because
 * adapters are pluggable, but Atlas only loads the platforms enumerated
 * here — narrowing to the literal union lets host `executeQuery`
 * callbacks type-narrow via `if (adapter.name !== "slack")` and forces
 * every `switch (adapter.name)` to be exhaustive at compile time.
 *
 * The runtime tuple `CHAT_ADAPTER_NAMES` is the source of truth — the
 * `ChatAdapterName` literal union is derived from it via
 * `(typeof CHAT_ADAPTER_NAMES)[number]`, and `plugins/chat`'s Zod
 * schema (`z.enum(CHAT_ADAPTER_NAMES)`) validates catalog input against
 * the same set. Extend the tuple and both the type and runtime
 * validation update together.
 */
export const CHAT_ADAPTER_NAMES = [
  "slack",
  "teams",
  "discord",
  "gchat",
  "telegram",
  "github",
  "linear",
  "whatsapp",
] as const;
export type ChatAdapterName = (typeof CHAT_ADAPTER_NAMES)[number];
