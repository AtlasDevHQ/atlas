/**
 * Atlas SaaS configuration — app.useatlas.dev
 *
 * This config is used by all 3 regional API services (us, eu, apac).
 * Secrets and per-service values stay in Railway env vars; this file
 * defines the application-level configuration that's the same everywhere.
 *
 * Region-specific database URLs are read from env vars so the same Docker
 * image works for all regions:
 *   - ATLAS_REGION_US_DB_URL (defaults to DATABASE_URL)
 *   - ATLAS_REGION_EU_DB_URL
 *   - ATLAS_REGION_APAC_DB_URL
 *
 * Observability export (optional, OFF by default). OpenTelemetry traces +
 * metrics export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; it gates the
 * SDK init in `lib/telemetry.ts` (no endpoint → no-op tracer/meter, clean boot).
 * These are per-service runtime vars, NOT application config, so they live in
 * Railway like the region DB URLs above — and like those they must be set as
 * explicit per-service overrides on each regional service (`api`, `api-eu`,
 * `api-apac`); a shared-scope var resolves empty at runtime and silently drops
 * telemetry for the regions that didn't get the override:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT  (OTLP-HTTP collector base URL)
 *   - OTEL_EXPORTER_OTLP_HEADERS   (collector auth header(s), if required)
 * See apps/docs/content/docs/platform-ops/observability.mdx → "Production
 * deployment (Railway / SaaS)".
 */

import { defineConfig } from "./packages/api/src/lib/config";
// Relative import: atlas.config.ts lives at /app/ in the SaaS container,
// outside any workspace's node_modules resolution tree. The workspace
// symlink for @useatlas/chat is at /app/packages/api/node_modules/,
// which is not reachable via Node's upward node_modules walk from /app/.
// The `defineConfig` import above uses the same relative-path pattern
// for the same reason. Resolved at boot via bun's TS loader.
import { chatPlugin } from "./plugins/chat/src/index";
// Datasource ADAPTER plugins (#3253 / ADR-0013). Registered with empty config
// so each is available purely as an adapter: customers add their own connection
// per workspace via Admin → Connections (DB-stored, encrypted), resolved through
// the datasource bridge's `createFromConfig`. No operator env var, no static
// datasource. DuckDB is intentionally NOT registered here — it is file-path
// based and not a safe multi-tenant SaaS datasource (its plugin still supports
// adapter-only mode for self-host). Postgres + MySQL need no plugin — the bridge
// registers those DB-stored installs natively. Salesforce is intentionally NOT
// registered either — it is OAuth-managed (tokens in `integration_credentials`,
// connection built via the `LazyPluginLoader`), so the bridge skips it and a
// `salesforcePlugin({})` registration would be inert. See #3302 /
// ADR-0014. The Salesforce OAuth install handler is wired separately in
// `integrations/install/register.ts`, gated on `SALESFORCE_CLIENT_ID/SECRET`.
import { clickhousePlugin } from "./plugins/clickhouse/src/index";
import { snowflakePlugin } from "./plugins/snowflake/src/index";
import { bigqueryPlugin } from "./plugins/bigquery/src/index";
import { elasticsearchPlugin } from "./plugins/elasticsearch/src/index";
import { getProactiveAiRuntime } from "./packages/api/src/lib/effect/ai";
import { getEnterpriseRuntime } from "./packages/api/src/lib/effect/enterprise-layer";
import { createSlackWorkspaceIdResolver } from "./packages/api/src/lib/proactive/workspace-id-resolver";
import { createSlackProactiveUserResolver } from "./packages/api/src/lib/proactive/user-resolver";
import { createProactiveEnabledGate } from "./packages/api/src/lib/proactive/enabled-gate";
import {
  getChannelProactiveConfigs,
  getWorkspaceProactiveConfig,
} from "./packages/api/src/lib/proactive/workspace-config-loader";
import { createProactiveClassifier } from "./packages/api/src/lib/proactive/classifier-adapter";
import { createProactiveAnswerAdapter } from "./packages/api/src/lib/proactive/answer-adapter";
import { recordMeterEvent } from "./packages/api/src/lib/proactive/answer-meter";
import {
  handlePluginPauseRequest,
  isPaused,
} from "./packages/api/src/lib/proactive/pause-registry";
import { getWorkspaceQuotaStatus } from "./packages/api/src/lib/proactive/quota";
import { getAllowlist } from "./packages/api/src/lib/proactive/public-dataset";
import { WorkspaceInstallGate } from "./packages/api/src/lib/integrations/install/workspace-install-gate";
// Slice 3 of #2607 — host-side `executeQuery` that resolves Slack
// `team_id` → `chat_cache:slack:installation` → `org_id` → `botActorUser`
// before invoking the agent loop (post-#2634 the install store
// consolidated onto `chat_cache`). Replaces the slice-1 stub. The
// factory returns a plain async function — no `effect` import
// surfaces here, so the relative-import constraint stays satisfied.
import { createChatPluginExecuteQuery } from "./packages/api/src/lib/chat-plugin/executeQuery";

// Dedicated runtime for the proactive classifier + answer adapters.
// Built inside the workspace by `getProactiveAiRuntime()` so this file
// stays free of bare-package `effect` imports (which can't be resolved
// from /app/ in the SaaS container — the workspace's `effect` lives
// under packages/api/node_modules and isn't on the upward walk from
// /app/atlas.config.ts). Process-lifetime cached on the helper side.
const proactiveAiRuntime = getProactiveAiRuntime();

export default defineConfig({
  // ── Datasource ──────────────────────────────────────────────────
  // The default analytics datasource — env var fallback handles this,
  // but being explicit here for documentation.
  datasources: {
    default: {
      url: process.env.ATLAS_DATASOURCE_URL!,
    },
  },

  // ── Tools ───────────────────────────────────────────────────────
  tools: ["explore", "executeSQL"],

  // ── Plugin Catalog (1.5.2 slice 2 — #2650) ──────────────────────
  // Flat list with `type` + `install_model` as orthogonal fields per
  // PRD "Further Notes" + ADR-0002. Seeded into `plugin_catalog` at
  // boot by `CatalogSeeder`; ops can flip `enabled=false` in DB without
  // a deploy for emergency-disable (the seed preserves DB-side false).
  //
  // 1.5.2 ships the OAuth install path for Slack (chat). The other
  // chat Platforms ride along as `enabled: false` placeholders with
  // `install_model: 'static-bot'` — their install handler lands in
  // 1.5.3 alongside `StaticBotInstallHandler`. Integration plugins
  // (Salesforce, Jira, Email, Webhook, Obsidian) wire in slice 3
  // (#2651) via `LazyPluginLoader`; their entries land then.
  catalog: [
    {
      slug: "slack",
      type: "chat",
      install_model: "oauth",
      enabled: true,
      saas_eligible: true,
      min_plan: "starter",
    },
    // ── 1.5.3 placeholders — visible to customers as "Coming soon" ─────
    // Per CONTEXT.md, each of these has Platform-specific install
    // subtleties (Teams Azure-AD + manifest, Discord per-guild routing,
    // Telegram chat_id capture, WhatsApp Meta verification, gchat Google
    // Workspace Marketplace). They get `install_model: 'static-bot'`
    // per the install-handler spectrum and ride into the catalog as
    // `implementation_status: 'coming_soon'` (#2747) so the admin UI
    // renders them with a grey "Coming soon" badge and an inert CTA —
    // distinct from the upsell-lock state, since the gate is "Atlas
    // hasn't shipped this" rather than "your plan doesn't admit it".
    // `enabled: true` keeps them surfaced; the install-status state
    // machine short-circuits ahead of the install-handler dispatch.
    // Each row flips to `implementation_status: 'available'` in its
    // own slice (10–16) when the handler ships.
    // Microsoft Teams — 1.5.3 #2752 (Phase D). The operator wires an
    // Azure Bot registration (TEAMS_APP_ID + TEAMS_APP_PASSWORD); each
    // customer admin uploads the Atlas Teams app manifest to their
    // tenant (or installs from AppSource), then pastes their Microsoft
    // Entra ID tenant GUID into the install modal. The bot is
    // operator-shared in MultiTenant mode — Bot Framework token
    // acquisition is keyed on the app credentials, not on the customer
    // tenant — and `tenant_id` is the per-Workspace routing identifier
    // that scopes inbound activities.
    //
    // `tenant_id` is NOT marked `secret: true` — Microsoft tenant GUIDs
    // are routing identifiers that leak in every Bot Framework activity
    // envelope's `channelData.tenant.id`. Same posture as Discord's
    // `guild_id` and Telegram's `chat_id`.
    {
      slug: "teams",
      type: "chat",
      install_model: "static-bot",
      enabled: true,
      saas_eligible: true,
      // #3142 (umbrella #2994) shipped the cap-gated install + the full Teams
      // runtime branch. Teams is OAuth-shaped (like Discord): the Azure AD
      // admin-consent callback (`GET /api/v1/teams/callback`) returns the
      // *verified* tenant id — the ownership proof — and dispatches it into
      // `TeamsStaticBotInstallHandler.confirmInstall`, which persists through
      // `checkChatIntegrationLimitAndInstall` (over-cap → 429, reconnect
      // grandfathered). The generic `/install-form` route refuses Teams
      // (`oauthShaped`). The `@chat-adapter/teams` builder + the /webhooks/teams
      // receive route + the executeQuery Teams branch also land in #3142; teams
      // is added to the chatPlugin catalog below so its adapter instantiates +
      // the webhook mounts.
      implementation_status: "available",
      name: "Microsoft Teams",
      description:
        "Chat with Atlas inside Microsoft Teams. The operator wires a shared Azure Bot (TEAMS_APP_ID + TEAMS_APP_PASSWORD); customer admins upload the Atlas Teams manifest to their tenant (or install from AppSource), then point Atlas at their Microsoft Entra ID tenant GUID.",
      min_plan: "starter",
      configSchema: [
        {
          key: "tenant_id",
          type: "string",
          label: "Tenant ID",
          description:
            "Microsoft Entra ID tenant GUID (8-4-4-4-12 hex digits, e.g. 72f988bf-86f1-41af-91ab-2d7cd011db47). Find it in the Microsoft Entra admin center under Overview → Tenant ID, or run `az account show --query tenantId` in the Azure CLI.",
          required: true,
        },
        {
          key: "tenant_name",
          type: "string",
          label: "Tenant name",
          description:
            "Optional admin-friendly label for this tenant. Shown on the integrations card.",
          required: false,
        },
      ],
    },
    // Discord — 1.5.3 #2749 (Phase D). The operator wires a Discord
    // application (DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID + DISCORD_PUBLIC_KEY);
    // each customer admin clicks "Install" in /admin/integrations,
    // authorizes the Atlas bot in their Discord server, and Discord
    // redirects back to `/api/v1/integrations/discord/callback` with
    // the `guild_id`. `DiscordStaticBotInstallHandler` verifies the
    // bot's membership in that guild before persisting.
    //
    // `guild_id` is NOT marked `secret: true` — Discord snowflakes are
    // routing identifiers that leak in every interaction envelope.
    // Same posture as Telegram's `chat_id`.
    {
      slug: "discord",
      type: "chat",
      install_model: "static-bot",
      enabled: true,
      saas_eligible: true,
      implementation_status: "available",
      name: "Discord",
      description:
        "Chat with Atlas inside a Discord server. The operator wires a shared bot (DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID); customer admins authorize the bot per-server through Discord's OAuth bot-install flow.",
      min_plan: "starter",
      configSchema: [
        {
          key: "guild_id",
          type: "string",
          label: "Server ID",
          description:
            "Discord server (guild) snowflake. Captured automatically from Discord's OAuth bot-install redirect — admins don't paste this manually.",
          required: true,
        },
        {
          key: "guild_name",
          type: "string",
          label: "Server name",
          description:
            "Optional admin-friendly label. Defaults to the guild name returned by Discord's API at install time.",
          required: false,
        },
      ],
    },
    // Google Chat — 1.5.3 #2754 (Phase D). The operator wires a Google
    // Workspace Marketplace listing (env: `GCHAT_SERVICE_ACCOUNT_JSON`
    // + `GCHAT_PUBSUB_TOPIC`); each customer admin installs Atlas from
    // their Workspace Marketplace at the Workspace level, and the
    // Marketplace webhook delivers the `workspace_id`.
    // `GchatStaticBotInstallHandler` verifies reachability via a
    // Pub/Sub publish round-trip before persisting (a synthetic
    // verification message is published to the operator-shared topic;
    // a `messageIds` echo confirms the SA's `pubsub.publisher` grant
    // and the topic existence in one call).
    //
    // `workspace_id` is NOT marked `secret: true` — Google Workspace
    // customer ids are routing identifiers that leak in every Google
    // Chat event envelope's `space.customer` field. Same posture as
    // Discord's `guild_id` and Telegram's `chat_id`.
    {
      slug: "gchat",
      type: "chat",
      install_model: "static-bot",
      enabled: true,
      saas_eligible: true,
      // #3143 cap-gated `GchatStaticBotInstallHandler.confirmInstall`
      // (checkChatIntegrationLimitAndInstall — over-cap → 429, reconnect
      // grandfathered), but gchat stays coming_soon: its ownership-proven
      // bind is the Google Workspace **Marketplace install webhook** (which
      // delivers the customer-verified workspace_id), and that receiver isn't
      // wired yet. Flipping available would only expose the generic
      // `/install-form` paste path, where an admin could submit *another*
      // customer's workspace_id before that customer connects and capture
      // their inbound Chat events (cross-tenant) — Codex flagged this on
      // #3153. Flip to available once the Marketplace-webhook → confirmInstall
      // binding lands (tracked in #3154). The cap-gate is ready for that.
      implementation_status: "coming_soon",
      name: "Google Chat",
      description:
        "Chat with Atlas inside Google Chat. The operator wires a shared service account (GCHAT_SERVICE_ACCOUNT_JSON + GCHAT_PUBSUB_TOPIC) and publishes the Atlas listing in the Google Workspace Marketplace; customer admins install the listing per-Workspace, and Atlas captures the Workspace customer id from the Marketplace webhook.",
      min_plan: "starter",
      configSchema: [
        {
          key: "workspace_id",
          type: "string",
          label: "Workspace ID",
          description:
            "Google Workspace customer id. Captured automatically from the Marketplace install webhook — admins don't paste this manually. Find it in the Google Admin console under Account → Account settings → Customer ID (e.g. C01abc234) if you need to verify after install.",
          required: true,
        },
        {
          key: "workspace_domain",
          type: "string",
          label: "Workspace domain",
          description:
            "Optional admin-friendly label (e.g. acme.com). Shown on the integrations card.",
          required: false,
        },
      ],
    },
    // Telegram — first static-bot Platform to ship a real install
    // handler (1.5.3 #2748 — keystone slice for Phase D). The operator
    // wires a shared `TELEGRAM_BOT_TOKEN` (from @BotFather) PLUS a
    // mandatory `TELEGRAM_WEBHOOK_SECRET` (#3154 GAP 3 — the chat adapter
    // verifies it against the `x-telegram-bot-api-secret-token` header and
    // is NOT registered without it, so a missing secret fails closed rather
    // than leaving the unsigned webhook forgeable). Each customer admin
    // supplies the numeric `chat_id` of the chat they want Atlas to listen
    // on. `TelegramStaticBotInstallHandler` verifies reachability via
    // `getChat` before persisting.
    //
    // `chat_id` is NOT marked `secret: true` — Telegram chat ids are
    // routing identifiers (signed integers) that the Bot API leaks
    // freely in every message envelope. Marking them secret would
    // round-trip through `encryptSecretFields` for no security gain
    // and would block the admin UI from rendering the value on read.
    {
      slug: "telegram",
      type: "chat",
      install_model: "static-bot",
      enabled: true,
      saas_eligible: true,
      // #3141 (keystone of umbrella #2994) shipped the cap-gated static-bot
      // install: the generic `/install-form` route captures the chat_id and
      // `TelegramStaticBotInstallHandler.confirmInstall` persists through
      // `checkChatIntegrationLimitAndInstall` (over-cap → 429, reconnect
      // grandfathered). The legacy connect route that #2994 removed (uncapped,
      // non-routable) is gone for good.
      implementation_status: "available",
      name: "Telegram",
      description:
        "Chat with Atlas inside a Telegram group, channel, or 1:1 conversation. The operator wires a shared bot (TELEGRAM_BOT_TOKEN); each workspace points the bot at one chat by id.",
      min_plan: "starter",
      configSchema: [
        {
          key: "chat_id",
          type: "string",
          label: "Chat ID",
          description:
            "Numeric Telegram chat id. Negative for groups/channels (e.g. -1001234567890), positive for private chats. Use a bot like @userinfobot to look it up.",
          required: true,
        },
        {
          key: "display_name",
          type: "string",
          label: "Display name",
          description:
            "Optional admin-friendly label for this chat. Shown on the integrations card.",
          required: false,
        },
      ],
    },
    // WhatsApp — 1.5.3 #2753 (Phase D). The operator wires a Meta
    // Business / WhatsApp Business Cloud API account
    // (META_BUSINESS_ACCESS_TOKEN + META_BUSINESS_APP_ID, plus
    // WHATSAPP_APP_SECRET + WHATSAPP_VERIFY_TOKEN for the webhook
    // envelope verification). Each customer admin pastes their
    // WhatsApp Business phone number id (Meta's numeric routing id,
    // distinct from the human phone number) into the install modal.
    // `WhatsAppStaticBotInstallHandler` verifies the id is reachable
    // through the operator's Meta credentials via Graph API before
    // persisting.
    //
    // `phone_number_id` is NOT marked `secret: true` — Meta-issued
    // phone number ids are routing identifiers that leak in every
    // webhook envelope's `value.metadata.phone_number_id`. Same
    // posture as Discord's `guild_id` / Telegram's `chat_id` / Teams's
    // `tenant_id`.
    //
    // Plan gating: `min_plan: "business"` — Meta charges the operator
    // per-conversation for user-initiated (24h customer-service window)
    // and template-initiated conversations. The economics only work for
    // workspaces on the highest tier; lower-tier installs would unbound
    // operator spend in a way the rest of the static-bot family
    // (Telegram / Discord / Teams — free per-message) doesn't.
    {
      slug: "whatsapp",
      type: "chat",
      install_model: "static-bot",
      enabled: true,
      saas_eligible: true,
      // #3144 (umbrella #2994) shipped the cap-gated static-bot install:
      // the generic `/install-form` route captures the phone_number_id and
      // `WhatsAppStaticBotInstallHandler.confirmInstall` persists through
      // `checkChatIntegrationLimitAndInstall` (over-cap → 429, reconnect
      // grandfathered). #3144 also adds whatsapp to the chatPlugin catalog
      // below so its webhook receive route + adapter mount.
      implementation_status: "available",
      name: "WhatsApp",
      description:
        "Chat with Atlas inside WhatsApp. The operator wires a shared Meta Business / WhatsApp Business Cloud API account (META_BUSINESS_ACCESS_TOKEN + META_BUSINESS_APP_ID); each workspace admin points Atlas at one WhatsApp Business phone number by its Meta phone_number_id. Higher plan tier — Meta charges the operator per-conversation.",
      min_plan: "business",
      configSchema: [
        {
          key: "phone_number_id",
          type: "string",
          label: "Phone Number ID",
          description:
            "Meta's numeric phone number id (NOT the human-readable phone number, e.g. \"+1 415 555 0100\"). Find it in the Meta Business Suite under WhatsApp Manager → Phone numbers → API Setup → copy the \"Phone number ID\" field.",
          required: true,
        },
        {
          key: "display_phone",
          type: "string",
          label: "Display phone",
          description:
            "Optional admin-friendly label for this number. Defaults to the display_phone_number Meta returns at install time.",
          required: false,
        },
      ],
    },
    // ── Linear (1.5.3 #2750 — Phase D, Action Target) ──────────────
    // Two catalog rows, one per install mode (per CONTEXT.md
    // "Multi-mode integrations" — each install model is its own row so
    // the admin sees the real trade-off in /admin/integrations cards).
    // Both rows are pillar='action' (Atlas creates Linear issues; this
    // is NOT a chat platform — users don't talk to Atlas through Linear).
    // A future `linear-data` row for Linear-as-Datasource is documented
    // in ADR-0006 but out of scope for this milestone.
    //
    //   - `linear` (OAuth): Atlas OAuth App (per-deploy LINEAR_CLIENT_ID
    //     + LINEAR_CLIENT_SECRET); workspace admins grant Atlas access
    //     to one Linear workspace; refresh tokens persist in
    //     `integration_credentials`. Mirrors the Jira/Salesforce shape.
    //   - `linear-apikey` (form): workspace admin pastes a Personal API
    //     Key from Linear settings; the key encrypts inline into
    //     `workspace_plugins.config.api_key` via selective-field
    //     encryption (keyed on `secret: true` below).
    //
    // SaaS-eligible note: API-key mode is acceptable on SaaS for entry-
    // tier workspaces (low blast radius — a per-workspace personal key
    // can be rotated unilaterally). OAuth is the recommended path for
    // every other workspace. Self-host operators who'd rather not
    // register an OAuth App can use API-key mode exclusively.
    {
      slug: "linear",
      type: "integration",
      install_model: "oauth",
      enabled: true,
      saas_eligible: true,
      name: "Linear (OAuth)",
      description:
        "Create Linear issues from agent findings. Connects through your operator's Linear OAuth App and refreshes access tokens automatically.",
      min_plan: "starter",
    },
    {
      slug: "linear-apikey",
      type: "integration",
      install_model: "form",
      enabled: true,
      saas_eligible: true,
      name: "Linear (API Key)",
      description:
        "Create Linear issues from agent findings using a personal API key from Linear settings. The simplest install — no OAuth App registration required — but the key is tied to one Linear user.",
      min_plan: "starter",
      configSchema: [
        {
          key: "api_key",
          type: "string",
          label: "Linear Personal API Key",
          description:
            "Generate one at https://linear.app/settings/api → \"Personal API keys\". Stored encrypted at rest.",
          required: true,
          secret: true,
        },
        {
          key: "workspace_name",
          type: "string",
          label: "Workspace name",
          description:
            "Optional admin-friendly label for which Linear workspace this key belongs to. Defaults to the workspace name returned by Linear's API at first use.",
          required: false,
        },
      ],
    },
    // ── GitHub (1.5.3 #2751 — Phase D, Action Target) ──────────────
    // Three catalog rows, one per install mode (per CONTEXT.md
    // "Multi-mode integrations"). All rows are pillar='action' — Atlas
    // creates issues / opens PRs through GitHub; this is NOT a chat
    // platform. A future `github-data` row for GitHub-as-Datasource is
    // documented in ADR-0006 but out of scope for this milestone.
    //
    //   - `github` (App, multi-tenant OAuth): workspace admins grant a
    //     GitHub App per Atlas Workspace. Install handler persists the
    //     `installation_id` to `workspace_plugins.config` (encrypted via
    //     selective-field encryption). Installation tokens are minted
    //     on demand by the lazy builder (follow-up PR) signing a JWT
    //     with the App's private key. The primary SaaS-eligible mode.
    //   - `github-single-tenant` (App, single-tenant): identical wire
    //     shape to multi-tenant, but the App's install is pinned to one
    //     GitHub org (the operator's). `saas_eligible: false` because
    //     one org's install cannot serve multiple Atlas workspaces.
    //     `GITHUB_APP_INSTALLATION_ID` is operator-baked into env;
    //     "install" is a self-redirect through the callback URL.
    //   - `github-pat` (form): workspace admin pastes a Personal Access
    //     Token from https://github.com/settings/tokens. The token
    //     encrypts inline into `workspace_plugins.config.pat` via
    //     selective-field encryption. `saas_eligible: false` — a PAT is
    //     tied to one GitHub user and dies when they leave; acceptable
    //     for self-host but the failure mode is too sharp for SaaS.
    //
    // SaaS visibility: the catalog route filters out
    // `saas_eligible: false` rows on SaaS deploys, so only `github`
    // surfaces in the SaaS catalog. Self-host shows all three.
    {
      slug: "github",
      type: "integration",
      install_model: "oauth",
      enabled: true,
      saas_eligible: true,
      name: "GitHub (App)",
      description:
        "Create GitHub issues and open pull requests from agent findings. Connects through your operator's GitHub App and mints short-lived installation tokens automatically.",
      min_plan: "starter",
    },
    {
      slug: "github-single-tenant",
      type: "integration",
      install_model: "oauth",
      enabled: true,
      saas_eligible: false,
      name: "GitHub (App, single-tenant)",
      description:
        "Self-host only. Operator-baked GitHub App pinned to one GitHub organization. Use when you don't want to publish a multi-tenant App registration.",
      min_plan: "starter",
    },
    {
      slug: "github-pat",
      type: "integration",
      install_model: "form",
      enabled: true,
      saas_eligible: false,
      name: "GitHub (Personal Access Token)",
      description:
        "Self-host only. The simplest install — no GitHub App registration required — but the token is tied to one GitHub user. Atlas access dies if that user leaves the org or the token is revoked.",
      min_plan: "starter",
      configSchema: [
        {
          key: "pat",
          type: "string",
          label: "GitHub Personal Access Token",
          description:
            "Generate one at https://github.com/settings/tokens. Fine-grained tokens are recommended; classic tokens also work. Scope: `repo` (issues + pull requests). Stored encrypted at rest.",
          required: true,
          secret: true,
        },
        {
          key: "default_owner",
          type: "string",
          label: "Default owner (optional)",
          description:
            "GitHub user or organization Atlas defaults to when creating issues. Can be overridden per call. Leave blank to require the agent to specify each time.",
          required: false,
        },
      ],
    },
    // ── Lazy OAuth integrations (1.5.2 slice 8 — #2658 / #2659) ─────
    // Salesforce (#2658) established the pattern; Jira (#2659) proves
    // the abstraction by riding the same shared infra:
    //   - `install_model: 'oauth'` routes through the OAuth install
    //     handler dispatch.
    //   - Credentials persist in `integration_credentials` (migration
    //     0089), not `workspace_plugins.config` JSONB — refresh-token
    //     lifecycle needs its own row.
    //   - Operator wires `<PLATFORM>_CLIENT_ID` + `<PLATFORM>_CLIENT_SECRET`
    //     to a single App registration per region; per-Workspace OAuth
    //     consent against that App writes the install + credential rows.
    //   - On refresh failure, `workspace_plugins.config.status = 'reconnect_needed'`
    //     is set and the admin UI surfaces a Reconnect affordance.
    //
    // Jira note: Atlassian's 3LO returns a `cloudid` identifying which
    // Atlassian Cloud instance the customer connected. One Atlas
    // Workspace = one Atlassian Cloud (matches Salesforce's
    // `instance_url` shape). `cloudid` goes into
    // `workspace_plugins.config`; tokens go into
    // `integration_credentials`. Atlassian rotates the refresh token on
    // every refresh, so the new value is written back each time.
    {
      slug: "jira",
      type: "integration",
      install_model: "oauth",
      enabled: true,
      saas_eligible: true,
      name: "Jira",
      description:
        "Query Jira issues via JQL. Connects through your operator's Atlassian OAuth 2.0 (3LO) App and refreshes access tokens automatically.",
      min_plan: "starter",
    },
    // Salesforce is intentionally NOT declared here. Per ADR-0006 §"For
    // admin UX" (#2859), Salesforce lives exclusively on the Datasource
    // pillar — seeded by `seed-builtin-datasource-catalog.ts` with
    // `pillar='datasource'`, surfaced at `/admin/connections`. The
    // pre-1.5.3 integrations-catalog stub that lived here clobbered the
    // datasource row's pillar on every boot (the 0092 sync trigger then
    // flipped it to 'action'); 0097 dropped that trigger and exposed the
    // double-seed as a NOT NULL violation. Future Salesforce-as-Action
    // capability ships as a separate slug per the multi-pillar rule
    // (ADR-0006 §"Multi-pillar systems").
    // ── Form-based integrations (1.5.2 slice 7 — #2660) ─────────────
    // First form-based catalog entry. `configSchema` declares the SMTP
    // fields admins see in the install modal; the server-side Zod
    // mirror in `EmailFormInstallHandler` validates submissions. The
    // `password` field is `secret: true` so the seeded entry's schema
    // tells `encryptSecretFields` to route only that key through
    // `db/secret-encryption.ts` at install time.
    {
      slug: "email",
      type: "integration",
      install_model: "form",
      enabled: true,
      saas_eligible: true,
      name: "Email (SMTP)",
      description:
        "Send analysis emails through your own SMTP relay. Atlas stores credentials encrypted at rest and uses them only to deliver emails the agent generates.",
      configSchema: [
        {
          key: "host",
          type: "string",
          label: "SMTP host",
          description: "e.g. smtp.sendgrid.net or mail.example.com",
          required: true,
        },
        {
          key: "port",
          type: "number",
          label: "Port",
          description: "Typically 587 for STARTTLS or 465 for TLS.",
          required: true,
          default: 587,
        },
        {
          key: "username",
          type: "string",
          label: "Username",
          description: "SMTP auth username — often a full email address.",
          required: true,
        },
        {
          key: "password",
          type: "string",
          label: "Password",
          description: "SMTP auth password or API key. Stored encrypted at rest.",
          required: true,
          secret: true,
        },
        {
          key: "fromAddress",
          type: "string",
          label: "From address",
          description: "Sender — bare email or display-name form (\"Atlas <atlas@example.com>\").",
          required: true,
        },
        {
          key: "secure",
          type: "boolean",
          label: "Use TLS",
          description: "Defaults to true. Turn off only for internal-only relays without TLS.",
          required: false,
          default: true,
        },
      ],
    },
    // Obsidian — read-only access to the user's vault via the Local
    // REST API plugin (https://github.com/coddingtonbear/obsidian-
    // local-rest-api). `api_url` defaults to the plugin's loopback
    // listener so the canonical "install on my laptop" path works
    // without typing a URL; remote/tunneled vaults override it.
    {
      slug: "obsidian",
      type: "integration",
      install_model: "form",
      enabled: true,
      saas_eligible: true,
      name: "Obsidian",
      description:
        "Search the agent against notes in your Obsidian vault. Atlas reads through the Local REST API plugin — read-only, never writes.",
      configSchema: [
        {
          key: "api_url",
          type: "string",
          label: "API URL",
          description: "Base URL of the Obsidian Local REST API. Defaults to http://127.0.0.1:27123.",
          required: false,
          default: "http://127.0.0.1:27123",
        },
        {
          key: "api_key",
          type: "string",
          label: "API key",
          description: "Bearer token from the Local REST API plugin's settings tab. Stored encrypted at rest.",
          required: true,
          secret: true,
        },
      ],
    },
    // Twenty CRM — per-workspace API key + base URL override.
    // Credentials land in the dedicated `twenty_integrations` table;
    // the `workspace_plugins` row is the catalog binding only.
    // baseUrl is REQUIRED with NO default — a default
    // `https://crm.useatlas.dev` would silently point a self-hosted
    // operator's install at Atlas's own Twenty CRM. The SaaS
    // deployment carries that hostname separately via `TWENTY_BASE_URL`.
    {
      slug: "twenty",
      type: "integration",
      install_model: "form",
      enabled: true,
      saas_eligible: true,
      name: "Twenty CRM",
      description:
        "Upsert leads into Twenty CRM (Persons + Notes). Configure your workspace's Twenty hostname and API key — the key is encrypted at rest.",
      configSchema: [
        {
          key: "baseUrl",
          type: "string",
          label: "Base URL",
          description:
            "Your Twenty instance hostname (e.g. https://crm.example.com). No default — enter the URL of your own Twenty install.",
          required: true,
        },
        {
          key: "apiKey",
          type: "string",
          label: "API key",
          description:
            "Bearer API key from Twenty → Settings → API & Webhooks. Stored encrypted at rest.",
          required: true,
          secret: true,
        },
      ],
    },
    // Outbound webhook — POSTs analysis output to a customer-managed
    // HTTPS endpoint with HMAC-SHA256 signing. `signing_secret` is the
    // shared secret receivers verify against; rotation is "re-install"
    // (the form modal re-runs and overwrites the JSONB row).
    {
      slug: "webhook",
      type: "integration",
      install_model: "form",
      enabled: true,
      saas_eligible: true,
      name: "Webhook",
      description:
        "POST analysis output to a customer-managed HTTPS endpoint. Each request is signed with HMAC-SHA256 in the X-Atlas-Signature header.",
      configSchema: [
        {
          key: "url",
          type: "string",
          label: "Webhook URL",
          description: "Destination URL — must be https.",
          required: true,
        },
        {
          key: "signing_secret",
          type: "string",
          label: "Signing secret",
          description: "Shared secret used for HMAC-SHA256 signing. Stored encrypted at rest.",
          required: true,
          secret: true,
        },
        {
          key: "retry_policy",
          type: "select",
          label: "Retry policy",
          description: "How to handle 5xx / network failures.",
          required: false,
          default: "exponential",
          options: ["none", "exponential"],
        },
      ],
    },
  ],

  // ── Plugins ─────────────────────────────────────────────────────
  // Post-#2683: the chat plugin owns the full Slack surface end-to-end
  // at `/api/plugins/chat-interaction/webhooks/slack` — Bolt dispatches
  // events, slash commands, and interactivity off that single URL. The
  // pre-chat-plugin `/api/v1/slack/{commands,events,interactions}`
  // routes are retired; all three Slack-app request URLs (Events,
  // Slash Commands, Interactivity) MUST point at the chat-plugin
  // webhook. OAuth install/callback still live at
  // `/api/v1/integrations/slack/{install,callback}` — that surface is
  // separate from the retired routes.
  //
  // Multi-tenant SaaS: real bot tokens live in `chat_cache` under the
  // `slack:installation:<teamId>` key prefix (#2634 consolidated the
  // legacy `slack_installations` Postgres table into this store).
  // Atlas's OAuth callback writes; `@chat-adapter/slack` reads — both
  // sides share `SLACK_ENCRYPTION_KEY` so bot tokens stay encrypted
  // at rest via AES-256-GCM. OMIT `botToken` so the adapter operates
  // in multi-workspace mode.
  plugins: [
    // ── Datasource adapters (adapter-only / SaaS per-workspace) ──────
    // Order within plugins[] doesn't affect boot wiring — the datasource bridge
    // resolves adapters via the registry's getAll() (order-independent). Each
    // registers as an adapter only (no static connection); customers bring their
    // own ClickHouse / Snowflake / BigQuery / Elasticsearch per workspace. See
    // the import block above for why DuckDB + Salesforce are excluded and why
    // Postgres + MySQL need no entry.
    clickhousePlugin({}),
    snowflakePlugin({}),
    bigqueryPlugin({}),
    elasticsearchPlugin({}),
    chatPlugin({
      // Catalog-driven adapter activation (#2650 slice 2). The chat
      // plugin's `AdapterRegistry` reads the chat-type subset of the
      // catalog above and per-Platform credentials from `process.env`
      // (`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`
      // / `SLACK_ENCRYPTION_KEY` / optional `SLACK_BOT_TOKEN`). The old
      // `adapters: { slack: {...} }` field is gone — there is no longer
      // a way to wire a chat adapter outside the catalog seam.
      catalog: [
        {
          slug: "slack",
          type: "chat",
          install_model: "oauth",
          enabled: true,
          saas_eligible: true,
        },
        // Telegram — 1.5.3 #2748 keystone. The chatPlugin's local
        // catalog drives AdapterRegistry instantiation + webhook-route
        // mount; keep this list in lockstep with the top-level
        // `catalog` above for every chat-type row.
        {
          slug: "telegram",
          type: "chat",
          install_model: "static-bot",
          enabled: true,
          saas_eligible: true,
        },
        // Discord — 1.5.3 #2749 (Phase D). Same AdapterRegistry +
        // webhook-route mount story as Telegram; the install flow
        // diverges (OAuth-shaped redirect instead of pasted identifier)
        // and lives in `routes/integrations-discord.ts`.
        {
          slug: "discord",
          type: "chat",
          install_model: "static-bot",
          enabled: true,
          saas_eligible: true,
        },
        // Google Chat — 1.5.3 #2754 (Phase D). AdapterRegistry binds
        // the Workspace Events Pub/Sub subscription at boot; the HTTP
        // webhook is the fallback path for slash-command invocations.
        // Install captures `workspace_id` from the Marketplace webhook
        // and verifies it via a Pub/Sub publish round-trip (see
        // `GchatStaticBotInstallHandler`).
        {
          slug: "gchat",
          type: "chat",
          install_model: "static-bot",
          enabled: true,
          saas_eligible: true,
        },
        // WhatsApp — 1.5.3 #2753 / cap-gated install #3144 (Phase D).
        // #2753 shipped the @chat-adapter/whatsapp builder + the GET/POST
        // /webhooks/whatsapp receive routes, but this plugin-local catalog
        // never listed whatsapp — so the AdapterRegistry skipped it and the
        // webhook routes never mounted (a non-routable install, the #2994
        // defect). #3144 adds it here (in lockstep with the top-level
        // catalog) so the adapter instantiates + the webhook mounts when the
        // operator wires META_BUSINESS_ACCESS_TOKEN / WHATSAPP_APP_SECRET /
        // WHATSAPP_VERIFY_TOKEN.
        {
          slug: "whatsapp",
          type: "chat",
          install_model: "static-bot",
          enabled: true,
          saas_eligible: true,
        },
        // Microsoft Teams — #3142 (completing Phase D under umbrella #2994).
        // The plugin-local catalog drives AdapterRegistry instantiation +
        // webhook-route mount; teams was previously absent (so the adapter
        // never built and /webhooks/teams never mounted — a non-routable
        // install, the #2994 defect). Adding it here mounts the adapter +
        // webhook once TEAMS_APP_ID / TEAMS_APP_PASSWORD are wired.
        {
          slug: "teams",
          type: "chat",
          install_model: "static-bot",
          enabled: true,
          saas_eligible: true,
        },
      ],
      state: { backend: "pg" },
      // Host-side executeQuery — preserves the F-55 actor binding,
      // agentOrigin stamp, conversation persistence, rate-limit
      // key shape, and :lock: pending-approval flow that slack.ts's
      // legacy app_mention / thread-followup branches used to own.
      executeQuery: createChatPluginExecuteQuery(),
      // ── Proactive listener wiring (#2607) ─────────────────────────
      // Wires every callback the proactive listener consumes to host
      // helpers under `packages/api/src/lib/proactive/`. After this
      // block lands, flipping `workspace_proactive_config.enabled = true`
      // on a workspace + adding a `channel_proactive_config` row makes
      // Atlas emit 🤖 reactions in real time. The reaction-back / answer
      // flow runs through `executeQueryProactive`; the user-resolver
      // stub (multi-tenant gap — #2624) keeps every asker on the
      // unlinked path, where the adapter refuses safely.
      proactive: {
        platform: "slack",
        // Per-event resolution: maps Slack `team_id` →
        // `chat_cache.value.orgId` (post-#2634 consolidation, was
        // `slack_installations.org_id`). Returns null on unknown
        // tenants (silent skip — no classify, no meter, no
        // kill-switch read).
        resolveWorkspaceId: createSlackWorkspaceIdResolver(),
        // Two-tier gate: enterprise check (cached) + per-workspace
        // `workspace_proactive_config.enabled` (re-read every call).
        // `getEnterpriseRuntime()` provides ProactiveGate (and the rest
        // of EnterpriseSubsystem); the wider runtime is structurally
        // compatible with the narrower `ManagedRuntime<ProactiveGate>`
        // the factory requires.
        isEnabled: createProactiveEnabledGate(getEnterpriseRuntime()),
        // Per-event config fetchers (post-#2620 multi-tenant).
        getWorkspaceConfig: getWorkspaceProactiveConfig,
        getChannelConfigs: getChannelProactiveConfigs,
        // Classifier wraps Atlas's primary configured LLM via
        // `proactiveAiRuntime`. The factory's `RIn` type parameter
        // widens to accept the runtime's full service set.
        classify: createProactiveClassifier(proactiveAiRuntime),
        // Answer-flow wiring (#2623 item 1). SaaS deploys both halves:
        //   - public-dataset path for unlinked askers (curated allowlist
        //     gates `executeSQL` + `explore` at the tool boundary; the
        //     plugin-level post-filter is the second gate)
        //   - linked-asker path via `createSlackProactiveUserResolver`
        //     (#2624 validates the workspaceId; today every asker resolves
        //     as `{ kind: "unlinked" }` because there's no Slack-user
        //     link table in core yet — the unlinked branch is the safe
        //     branch and routes through the public-dataset allowlist
        //     gate, which is now tenant-scoped)
        answerFlow: {
          mode: "both",
          // Adapter-side getPublicDataset (constrains the agent at tool
          // construction). Listener-side getPublicDataset is the same
          // helper, wired alongside as `answerFlow.getPublicDataset` a
          // few lines down — that's the post-filter that gates the
          // result after the agent runs.
          executeQueryProactive: createProactiveAnswerAdapter(
            proactiveAiRuntime,
            {
              getPublicDataset: (_asker, { workspaceId }) =>
                getAllowlist(workspaceId),
            },
          ),
          userResolver: createSlackProactiveUserResolver(),
          // Plugin-level public-dataset allowlist (post-filter on the
          // listener side, distinct from the adapter option above).
          // Defense-in-depth: once #2624 closes the user-resolver gap
          // and linked askers reach the agent, this post-filter still
          // gates unlinked-asker results.
          getPublicDataset: (input) => getAllowlist(input.workspaceId),
        },
        // Three-layer kill switch + per-user opt-out (#2295). Plugin's
        // `IsPausedFn` input shape is a structural subset of the host
        // helper's — pass the helper directly.
        killSwitch: {
          enabled: true,
          isPaused,
          onPauseRequest: handlePluginPauseRequest,
        },
        // Feedback wiring (#2298) — collector intentionally omitted in
        // SaaS today; adding it would require a non-trivial host helper
        // (write to meter + optionally to evals dataset). Deferred to a
        // follow-up.
        feedback: { enabled: false },
        linkUrl:
          process.env.ATLAS_PUBLIC_WEB_URL ?? "https://app.useatlas.dev",
        // Per-event meter callback. `recordMeterEvent` swallows DB
        // failures internally (logs at error) so the Chat SDK event
        // loop never sees a rejection.
        onMeterEvent: recordMeterEvent,
        // Monthly cap reader. Plugin's `GetQuotaStatusFn` takes
        // `{ workspaceId }`; the host helper takes a bare `workspaceId`
        // (plus an optional `now` for tests), so adapt the shape here.
        getQuotaStatus: (input) => getWorkspaceQuotaStatus(input.workspaceId),
        // WorkspaceInstallGate (#2655) — outermost workspace-scoped
        // check, runs before classify / meter / quota / kill-switch.
        // `slack` matches `plugin_catalog.slug` for the Slack catalog
        // row above; the gate accepts both the slug and the
        // `catalog:slack` id, so the catalog seed timing (seeder runs
        // post-migration) doesn't matter here.
        installGate: {
          enabled: true,
          gate: WorkspaceInstallGate.isWorkspaceInstallActive,
          catalogId: "slack",
          // #2703 — feeds the listener's throttled deny log with the
          // four fact-state booleans + plan info so operators see
          // WHY a workspace is denied without running the rank table
          // themselves. The listener calls this only on the deny
          // path inside an open throttle window, so the cost is one
          // extra DB read per (workspaceId, channelId) per 10 min
          // for steady-state denied workspaces.
          describeState: WorkspaceInstallGate.describeState,
        },
      },
    }),
  ],

  // ── Auth ────────────────────────────────────────────────────────
  auth: "managed",

  // ── Deploy Mode ─────────────────────────────────────────────────
  deployMode: "saas",

  // ── Enterprise ──────────────────────────────────────────────────
  enterprise: {
    enabled: true,
  },

  // ── Sandbox ─────────────────────────────────────────────────────
  // SaaS uses Vercel Sandbox exclusively — per-request Firecracker microVM
  // isolation with networkPolicy: "deny-all". Off-Vercel auth requires
  // VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and VERCEL_TOKEN env vars on each
  // Railway api service. No fallback: a Vercel outage will hard-fail the
  // explore tool with a clear error rather than degrading to a less-isolated
  // backend that can't enforce multi-tenant boundaries.
  //
  // BYOC (#3370) deliberately supersedes this pin: when a workspace admin has
  // connected provider credentials on /admin/sandbox AND selected that
  // backend, explore runs on a sandbox built from the org's own stored
  // credentials, on the org's own account. That doesn't weaken the pin's
  // rationale — the pin exists because *shared* backends can't enforce
  // multi-tenant boundaries, while a BYOC backend executes only that org's
  // workload in that org's account, and fails closed (no silent fallback to
  // the operator account) if it can't start. The vercel, e2b, and daytona
  // BYOC runtimes ship in this image (#3409): the plugin workspace packages
  // plus their SDKs (e2b, @daytonaio/sdk) install via @atlas/api's
  // dependency edges, and a Dockerfile build assertion runs the real
  // availability probe and fails the image unless it reports exactly
  // {vercel, e2b, daytona} available and railway unavailable — the
  // provider-set decision is machine-checked there, not just prose here.
  // Railway is deliberately NOT shipped:
  // Railway has no deny-all egress mode (the card copy carries the warning)
  // and its SDK is beta — the SaaS switch is tracked in #3368. Its card
  // honestly reports "Unavailable". `/api/v1/admin/sandbox/status`'s
  // providerRuntimeAvailability is the live source of truth.
  sandbox: {
    priority: ["vercel-sandbox"],
  },

  // ── Connection Pool ─────────────────────────────────────────────
  pool: {
    perOrg: {
      enabled: true,
      maxConnections: 5,
      idleTimeoutMs: 30_000,
      maxOrgs: 50,
    },
  },

  // ── Scheduler ───────────────────────────────────────────────────
  scheduler: {
    backend: "bun",
    maxConcurrentTasks: 5,
    taskTimeout: 60_000,
    tickIntervalSeconds: 60,
  },

  // ── Cache ───────────────────────────────────────────────────────
  cache: {
    enabled: true,
    ttl: 300_000, // 5 minutes
    maxSize: 1000,
  },

  // ── Data Residency ──────────────────────────────────────────────
  residency: {
    defaultRegion: "us",
    strictRouting: false,
    regions: {
      "us": {
        label: "United States",
        databaseUrl: process.env.ATLAS_REGION_US_DB_URL ?? process.env.DATABASE_URL!,
        apiUrl: "https://api.useatlas.dev",
      },
      "eu": {
        label: "Europe",
        databaseUrl: process.env.ATLAS_REGION_EU_DB_URL!,
        apiUrl: "https://api-eu.useatlas.dev",
      },
      "apac": {
        label: "Asia Pacific",
        databaseUrl: process.env.ATLAS_REGION_APAC_DB_URL!,
        apiUrl: "https://api-apac.useatlas.dev",
      },
      // Staging arm — single-region soak environment. Per PRD #2894 it shares
      // the prod NovaMart datasource but its own Postgres (DATABASE_URL). No
      // real cross-region traffic ever claims residency="staging"; this arm
      // exists so the SaaS region guard at saas-guards.ts:570 accepts
      // ATLAS_API_REGION=staging without a hard-fail boot.
      "staging": {
        label: "Staging",
        databaseUrl: process.env.DATABASE_URL!,
        apiUrl: "https://api.staging.useatlas.dev",
      },
    },
  },
});
