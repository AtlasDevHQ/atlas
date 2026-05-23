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
 */
export const CATALOG_INSTALL_MODELS = ["oauth", "form", "static-bot"] as const;
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
