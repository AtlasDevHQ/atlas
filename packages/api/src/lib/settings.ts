/**
 * Application settings persistence — DB overrides for env var config.
 *
 * Settings follow a four-tier resolution for workspace-scoped keys:
 *   workspace DB override > platform DB override > env var > default.
 * Platform-scoped settings use the original three-tier chain:
 *   platform DB override > env var > default.
 *
 * When no internal DB is available, all settings are read-only from env vars.
 *
 * The in-process cache is populated at startup and updated on writes,
 * so reads never hit the database after initialization.
 *
 * In SaaS mode (`ATLAS_DEPLOY_MODE=saas`), settings that normally require a
 * restart are hot-reloadable: a short-TTL live cache re-reads from the DB so
 * changes take effect within seconds without restarting the server.
 * Self-hosted mode preserves the original restart-required behavior.
 * Boot-consumed keys are the exception (#3399): a value read once at process
 * start (e.g. the expert scheduler pair) cannot be hot-reloaded by any cache,
 * so its `requiresRestart` hint is kept in BOTH modes — only keys
 * `applySettingSideEffect` actually hot-reloads suppress the hint on SaaS.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { EMAIL_PROVIDERS } from "@atlas/api/lib/integrations/types";
import { SaasImmutableSettingError } from "@atlas/api/lib/settings-errors";
import { WORKSPACE_DEFAULT_STYLE_OPTIONS } from "@atlas/api/lib/answer-styles";

const log = createLogger("settings");

// ---------------------------------------------------------------------------
// Settings registry — defines all known settings with metadata
// ---------------------------------------------------------------------------

export type SettingScope = "platform" | "workspace";

export interface SettingDefinition {
  key: string;
  section: string;
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "select";
  options?: string[];
  default?: string;
  secret?: boolean;
  envVar: string;
  /** When true, the server must be restarted for changes to take effect. When absent or false, changes are picked up at runtime via getSetting() on the next request. */
  requiresRestart?: boolean;
  /** Whether this setting can be overridden per-workspace ("workspace") or is global only ("platform"). Defaults to "platform". */
  scope: SettingScope;
  /** Whether this setting is visible to workspace admins in SaaS mode. Defaults to true. Platform admins always see all settings. */
  saasVisible?: boolean;
  /**
   * #3376 — whether SaaS workspace admins may write (PUT/DELETE) this
   * setting. When unset, the effective value defaults to `saasVisible`
   * (itself defaulting to true), so visibility and writability stay one
   * axis unless a key explicitly splits them. Keys managed by a dedicated
   * admin page on SaaS (e.g. the sandbox keys via /admin/sandbox) set
   * `saasVisible: false, saasWritable: true`: hidden from the generic
   * settings page, but still writable through their own surface.
   * Platform admins and self-hosted deployments are never restricted
   * by this flag.
   */
  saasWritable?: boolean;
}

export interface SettingWithValue extends SettingDefinition {
  currentValue: string | undefined;
  source: "env" | "override" | "workspace-override" | "default";
  /**
   * #1978 — true when the key participates in a boot-time contract guard
   * AND deploy mode is SaaS. The admin UI uses this to disable the input
   * (or render a tooltip) so a SaaS admin sees the immutability before
   * submit. Without this signal, the only feedback would be a 409 after
   * clicking Save. Always undefined in self-hosted.
   */
  saasImmutable?: boolean;
  /**
   * #4669 — the platform (global, org_id IS NULL) tier of a
   * workspace-scoped setting, resolved override → env → default with the
   * caller's workspace override deliberately excluded. This is the value
   * every workspace inherits unless it sets its own override — the
   * platform console renders it so an operator can manage the global row
   * without a no-org session or a direct DB write. Only populated for
   * workspace-scoped keys in the platform-admin (showAll) view;
   * platform-scoped keys already resolve at the platform tier via
   * `currentValue`/`source`.
   */
  platformValue?: string;
  /** #4669 — source of {@link platformValue}: never "workspace-override" by construction. */
  platformSource?: "env" | "override" | "default";
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
  org_id: string | null;
}

const SETTINGS_REGISTRY: SettingDefinition[] = [
  // Query Limits
  {
    key: "ATLAS_ROW_LIMIT",
    section: "Query Limits",
    label: "Row Limit",
    description: "Maximum rows returned per query",
    type: "number",
    default: "1000",
    envVar: "ATLAS_ROW_LIMIT",
    scope: "workspace",
  },
  {
    key: "ATLAS_QUERY_TIMEOUT",
    section: "Query Limits",
    label: "Query Timeout",
    description: "Query timeout in milliseconds",
    type: "number",
    default: "30000",
    envVar: "ATLAS_QUERY_TIMEOUT",
    scope: "workspace",
  },
  {
    key: "ATLAS_DELIVERY_MAX_ROWS",
    section: "Query Limits",
    label: "Delivery Row Limit",
    description: "Maximum rows per dataset in scheduled-delivery reports (1–10000)",
    type: "number",
    default: "50",
    envVar: "ATLAS_DELIVERY_MAX_ROWS",
    scope: "workspace",
  },

  // Cache — managed via the dedicated /admin/cache page (#4545). Enable/TTL
  // are per-workspace and hidden from the generic settings page but written
  // through the cache page's inline controls (saasVisible:false,
  // saasWritable:true — the sandbox-key dedicated-surface pattern). Max size
  // is platform-scoped (the LRU is one process-wide backend) so only platform
  // admins tune it. Readers in lib/cache/index.ts: cacheEnabled() /
  // getDefaultTtl() (exported), and getCache() (via getCacheMaxSize()).
  {
    key: "ATLAS_CACHE_ENABLED",
    section: "Cache",
    label: "Query Cache",
    description:
      "Cache identical query results within the TTL. Managed from the Cache admin page.",
    type: "boolean",
    default: "true",
    envVar: "ATLAS_CACHE_ENABLED",
    scope: "workspace",
    saasVisible: false,
    saasWritable: true,
  },
  {
    key: "ATLAS_CACHE_TTL",
    section: "Cache",
    label: "Cache TTL",
    description:
      "How long a cached query result stays fresh, in milliseconds (default 300000 = 5 minutes). Managed from the Cache admin page.",
    type: "number",
    default: "300000",
    envVar: "ATLAS_CACHE_TTL",
    scope: "workspace",
    saasVisible: false,
    saasWritable: true,
  },
  {
    key: "ATLAS_CACHE_MAX_SIZE",
    section: "Cache",
    label: "Cache Max Entries",
    description:
      "Maximum cached query results before LRU eviction. Applies process-wide across every workspace in the region (platform-scoped).",
    type: "number",
    default: "1000",
    envVar: "ATLAS_CACHE_MAX_SIZE",
    scope: "platform",
    saasVisible: false,
  },

  // Rate Limiting
  {
    key: "ATLAS_RATE_LIMIT_RPM",
    section: "Rate Limiting",
    label: "Rate Limit (RPM)",
    description: "Max requests per minute per user (0 or empty = disabled in self-hosted; SaaS rejects at boot)",
    type: "number",
    // No static default: a hardcoded value here would be returned by
    // getSetting() (Tier 4) BEFORE the deploy-env profile default could apply,
    // shadowing it — same reason ATLAS_PROVIDER omits one. The per-env default
    // (#2937) is supplied downstream by getRpmLimit() in auth/middleware.ts via
    // resolveRateLimitRpm() (env-profile.ts), which keeps the DB-override >
    // env-var > profile-default precedence intact. SaaS regions still stamp the
    // env var explicitly (RateLimitGuardLive reads it raw and fails boot if unset).
    envVar: "ATLAS_RATE_LIMIT_RPM",
    // RateLimitGuardLive runs once at boot and refuses to start a SaaS
    // region with the limiter disabled. Hot-reloading this key would
    // silently re-open the DDoS hole until next restart — same class
    // as ATLAS_EMAIL_PROVIDER (DPA guard) and ATLAS_DEPLOY_MODE.
    // SAAS_IMMUTABLE_KEYS below blocks SaaS writes; self-hosted keeps
    // hot-reload because the guard early-returns there anyway.
    requiresRestart: true,
    scope: "workspace",
  },
  {
    key: "ATLAS_RATE_LIMIT_RPM_CHAT",
    section: "Rate Limiting",
    label: "Chat Rate Limit (RPM)",
    description:
      "Max chat requests per minute per user (defaults to max(5, RPM/4) so a 25-step LLM run does not deplete the cheap-read allowance)",
    type: "number",
    envVar: "ATLAS_RATE_LIMIT_RPM_CHAT",
    scope: "workspace",
  },
  {
    key: "ATLAS_RATE_LIMIT_RPM_ADMIN",
    section: "Rate Limiting",
    label: "Admin Rate Limit (RPM)",
    description:
      "Max admin requests per minute per user (defaults to max(60, RPM) so a burst of DELETE + Test + Add Connection during an interactive admin session does not throttle on a low base RPM tuned for public traffic)",
    type: "number",
    envVar: "ATLAS_RATE_LIMIT_RPM_ADMIN",
    scope: "workspace",
  },
  {
    key: "ATLAS_RATE_LIMIT_RPM_WORKSPACE",
    section: "Rate Limiting",
    label: "Workspace Rate Limit (RPM)",
    description:
      "Max permission-gated non-admin requests per minute per user — dashboards today (defaults to max(60, RPM); a 20-card dashboard fires 20 render calls on load, and bucketing them separately keeps that burst from depleting the budget an operator needs to fix the workspace)",
    type: "number",
    envVar: "ATLAS_RATE_LIMIT_RPM_WORKSPACE",
    scope: "workspace",
  },

  // Security
  {
    key: "ATLAS_RLS_ENABLED",
    section: "Security",
    label: "Row-Level Security",
    description: "Enable row-level security filtering on queries",
    type: "boolean",
    envVar: "ATLAS_RLS_ENABLED",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_RLS_COLUMN",
    section: "Security",
    label: "RLS Column",
    description: "Column name used for RLS filtering (e.g. tenant_id)",
    type: "string",
    envVar: "ATLAS_RLS_COLUMN",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_RLS_CLAIM",
    section: "Security",
    label: "RLS Claim",
    description: "JWT claim path for RLS value extraction (e.g. org_id)",
    type: "string",
    envVar: "ATLAS_RLS_CLAIM",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_TABLE_WHITELIST",
    section: "Security",
    label: "Table Whitelist",
    description: "Only allow tables defined in the semantic layer",
    type: "boolean",
    default: "true",
    envVar: "ATLAS_TABLE_WHITELIST",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_CORS_ORIGIN",
    section: "Security",
    label: "CORS Origin",
    description: "Allowed CORS origin (set explicitly for cross-origin deployments)",
    type: "string",
    default: "*",
    envVar: "ATLAS_CORS_ORIGIN",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    // #3341 — recipient allowlist for agent-initiated email. Since #4479
    // this single knob gates BOTH agent email paths (the `sendEmail`
    // integration tool and the `sendEmailReport` action), and since #4663
    // it is their only domain source — the retired action-path env knob's
    // fallback is gone. Workspace members are always allowed; this adds
    // extra domains. Empty (the default) = workspace members only.
    key: "ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS",
    section: "Security",
    label: "Email Recipient Domains",
    description:
      "Comma-separated domains agent-initiated email (sendEmail tool + sendEmailReport action) may deliver to, in addition to workspace member addresses (e.g. example.com,partner.example). Empty = workspace members only.",
    type: "string",
    default: "",
    envVar: "ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS",
    scope: "workspace",
  },
  {
    // F-57 — admin user-mutation routes consult this when the target is
    // SCIM-provisioned. `strict` blocks the mutation with 409 SCIM_MANAGED;
    // `override` allows it to proceed and stamps the audit row with
    // `metadata.scim_override = true` so the bypass is reconstructable.
    // No-op for workspaces with no SCIM provider configured.
    key: "ATLAS_SCIM_OVERRIDE_POLICY",
    section: "Security",
    label: "SCIM Override Policy",
    description:
      "Admin mutations on SCIM-provisioned users: 'strict' blocks (409 SCIM_MANAGED) so the IdP stays canonical; 'override' allows but audits the override.",
    type: "select",
    options: ["strict", "override"],
    default: "strict",
    envVar: "ATLAS_SCIM_OVERRIDE_POLICY",
    scope: "workspace",
  },

  // Sessions
  {
    key: "ATLAS_SESSION_IDLE_TIMEOUT",
    section: "Sessions",
    label: "Idle Timeout",
    description: "Seconds of inactivity before a session is invalidated (0 = disabled)",
    type: "number",
    default: "0",
    envVar: "ATLAS_SESSION_IDLE_TIMEOUT",
    scope: "workspace",
  },
  {
    key: "ATLAS_SESSION_ABSOLUTE_TIMEOUT",
    section: "Sessions",
    label: "Absolute Timeout",
    description: "Maximum session lifetime in seconds from creation (0 = disabled)",
    type: "number",
    default: "0",
    envVar: "ATLAS_SESSION_ABSOLUTE_TIMEOUT",
    scope: "workspace",
  },

  // Sandbox — managed via dedicated /admin/sandbox page in SaaS mode.
  // ATLAS_SANDBOX_BACKEND splits the axes (#3376): hidden from the
  // generic settings page (the sandbox page is the canonical surface),
  // but the SaaS sandbox view saves it through PUT /admin/settings/{key},
  // so SaaS workspace admins keep write access to it. ATLAS_SANDBOX_URL
  // is written ONLY by the self-hosted view, so it inherits hidden ⇒
  // un-writable on SaaS (no surface needs the exception — #3390 review).
  {
    key: "ATLAS_SANDBOX_BACKEND",
    section: "Sandbox",
    label: "Sandbox Backend",
    description:
      "Sandbox backend for explore/Python tool isolation. " +
      "Valid values are backend ids only: vercel-sandbox, sidecar, e2b-sandbox, " +
      "daytona-sandbox, railway-sandbox, or a registered sandbox plugin ID. " +
      "Legacy bare provider keys (vercel, e2b, daytona, railway) are normalized " +
      "to their backend ids on read.",
    type: "string",
    envVar: "ATLAS_SANDBOX_BACKEND",
    scope: "workspace",
    saasVisible: false,
    saasWritable: true,
  },
  {
    key: "ATLAS_SANDBOX_URL",
    section: "Sandbox",
    label: "Sidecar URL",
    description:
      "Custom sidecar service URL for explore tool (only used when sandbox backend is 'sidecar')",
    type: "string",
    envVar: "ATLAS_SANDBOX_URL",
    scope: "workspace",
    saasVisible: false,
  },

  // Platform
  {
    key: "ATLAS_DEPLOY_MODE",
    section: "Platform",
    label: "Deploy Mode",
    description: "Deployment mode: saas (hosted product), self-hosted, or auto (detect)",
    type: "select",
    options: ["auto", "saas", "self-hosted"],
    default: "auto",
    envVar: "ATLAS_DEPLOY_MODE",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },

  // Agent
  {
    key: "ATLAS_AGENT_MAX_STEPS",
    section: "Agent",
    label: "Agent Max Steps",
    description: "Maximum tool-call steps per agent run (1–100)",
    type: "number",
    default: "25",
    envVar: "ATLAS_AGENT_MAX_STEPS",
    scope: "workspace",
  },
  {
    key: "ATLAS_CONVERSATION_STEP_CAP",
    section: "Agent",
    label: "Conversation Step Cap",
    description:
      "Aggregate step ceiling per conversation (default 500 = 20 follow-ups × 25 steps). Once exceeded the chat handler rejects further messages with `conversation_budget_exceeded` and the UI offers to start a new conversation. 0 disables the cap.",
    type: "number",
    default: "500",
    envVar: "ATLAS_CONVERSATION_STEP_CAP",
    scope: "workspace",
  },
  {
    // #4303 (PRD #4292) — the workspace "house voice". Applies wherever no
    // explicit answer style is chosen (web conversations without a #4302
    // per-conversation pick; SDK / MCP / /api/v1/query calls that send no
    // style). Chat-platform surfaces (Slack @mention, proactive) always pass
    // an explicit style per turn (conversational in practice), so this
    // default structurally never reaches them — the surface-scoping decision
    // the description documents. Resolution seam:
    // `resolveWorkspaceDefaultAnswerStyle` (lib/agent.ts).
    //
    // Options are the registry's offered house voices
    // (`WORKSPACE_DEFAULT_STYLE_OPTIONS` — the registry minus
    // `NON_HOUSE_VOICE_STYLES`): `conversational` is excluded because its
    // addendum is written for chat platforms (it references the Slack
    // "Show SQL" progressive-disclosure buttons). The read-side resolver
    // (`resolveWorkspaceDefaultAnswerStyle`, lib/agent.ts) enforces the same
    // list, so the env-var ingress can't smuggle a non-offered voice past
    // this select. No `default` on purpose — unset means "track the surface
    // default" (analyst), not a frozen copy of it. Hot-reloadable: read per
    // turn through the settings cache, no restart.
    key: "ATLAS_DEFAULT_ANSWER_STYLE",
    section: "Agent",
    label: "Default Answer Style",
    description:
      "Workspace default answer style (the house voice) for surfaces that don't explicitly choose one — web chat conversations without a per-conversation pick, and SDK/MCP/query API calls that send no style. A per-conversation pick always wins. Chat platforms (Slack mentions, proactive chat) choose their own voice per turn and are not affected. Reset to fall back to the built-in default (analyst).",
    type: "select",
    options: [...WORKSPACE_DEFAULT_STYLE_OPTIONS],
    envVar: "ATLAS_DEFAULT_ANSWER_STYLE",
    scope: "workspace",
  },
  // Context Compaction (#3759 — PRD #3751). When a turn's assembled context
  // crosses the fill fraction of the (coarsely-resolved) context window, older
  // history is collapsed into one generated summary while the most-recent N
  // steps + the system prompt are pinned. Default OFF — flag off = no change.
  {
    key: "ATLAS_COMPACTION_ENABLED",
    section: "Context Compaction",
    label: "Context Compaction",
    description:
      "When on, a long agent turn whose assembled context crosses the fill fraction is compacted — older history is replaced by a generated summary and the turn continues instead of erroring. Default off.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_COMPACTION_ENABLED",
    scope: "workspace",
  },
  {
    key: "ATLAS_COMPACTION_FILL_FRACTION",
    section: "Context Compaction",
    label: "Compaction Fill Fraction",
    description:
      "Trigger threshold as a fraction (0–1] of the model context window. When the assembled context crosses this fraction, a compaction pass runs. Default 0.85.",
    type: "number",
    default: "0.85",
    envVar: "ATLAS_COMPACTION_FILL_FRACTION",
    scope: "workspace",
  },
  {
    key: "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
    section: "Context Compaction",
    label: "Compaction Pinned Recent Steps",
    description:
      "How many of the most-recent agent steps to pin verbatim (never summarize) during a compaction pass (1–100). Default 6.",
    type: "number",
    default: "6",
    envVar: "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
    scope: "workspace",
  },
  {
    key: "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
    section: "Context Compaction",
    label: "Compaction Context Window (tokens)",
    description:
      "Override the context-window size (tokens) the compaction trigger computes against. Leave blank to resolve it per model from the catalog (e.g. 200k for Claude, 128k for GPT-4o); set a value to pin the window for a model the catalog doesn't cover or to deliberately tighten/loosen the budget. Takes precedence over the catalog.",
    type: "number",
    default: "",
    envVar: "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
    scope: "workspace",
  },
  {
    // #4869 — the shortlist starred at the top of the gateway model picker.
    //
    // This used to be a hardcoded `RECOMMENDED_MODEL_IDS` set in
    // `lib/gateway-catalog.ts`, which made curation redeploy-gated — the exact
    // property this issue exists to remove — and let entries rot invisibly
    // (`google/gemini-2.0-flash` sat in it after the gateway retired it; the
    // group just rendered one row short). As a setting it is hot-reloadable,
    // editable from /admin, and takes effect on the next catalog read rather
    // than at the next deploy.
    //
    // Platform-scoped: curating the house shortlist is an operator decision,
    // not a per-workspace one. Every workspace still picks any model it likes
    // from the full catalog — this only controls what floats to the top.
    key: "ATLAS_RECOMMENDED_MODELS",
    section: "Model Catalog",
    label: "Recommended Models",
    description:
      "Comma-separated Vercel AI Gateway model IDs to star at the top of the model picker (e.g. anthropic/claude-opus-5, openai/gpt-5.6-sol). IDs must match the gateway exactly — slash+dot form. Leave blank for no Recommended group; the full catalog stays selectable either way. IDs the gateway no longer serves are logged as a warning and skipped.",
    type: "string",
    default: [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4.5",
      "zai/glm-5.2",
      "moonshotai/kimi-k3",
    ].join(","),
    envVar: "ATLAS_RECOMMENDED_MODELS",
    scope: "platform",
  },
  {
    // #3761 — optional cheaper summary model. Names a SEPARATE model for the
    // compaction summarization call so reclaiming context need not cost as much
    // as the turn itself. Blank ⇒ the summary runs on the active turn model (the
    // Compaction 1 behavior). The named model is resolved on the SAME provider /
    // credentials as the turn (only the model id changes) via the providers layer.
    key: "ATLAS_COMPACTION_SUMMARY_MODEL",
    section: "Context Compaction",
    label: "Compaction Summary Model",
    description:
      "Optional model id for the compaction summarization call — typically a cheaper/faster model than the turn (e.g. a Haiku/mini tier). Leave blank to summarize on the active turn model. Resolved on the same provider and credentials as the turn; only the model id changes. Workspace-scoped, hot-reloadable.",
    type: "string",
    default: "",
    envVar: "ATLAS_COMPACTION_SUMMARY_MODEL",
    scope: "workspace",
  },
  {
    // #3745 / ADR-0020 — durable agent sessions. When on (and an internal DB is
    // present), each turn writes a terminal `agent_runs` checkpoint. Default
    // OFF: off, or no internal DB, → behavior identical to today. Hot-reloadable
    // (no requiresRestart) — the agent loop reads it per turn via getSettingAuto.
    key: "ATLAS_DURABILITY_ENABLED",
    section: "Agent",
    label: "Durable Sessions",
    description:
      "Persist a durable checkpoint of each agent turn to the internal database (ADR-0020). Requires an internal DB; off by default. Foundation for crash-resume and approval-park.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_DURABILITY_ENABLED",
    scope: "workspace",
  },
  {
    // Retention window for terminal (done/failed) runs; the scheduler sweep
    // deletes terminal runs older than this. Non-terminal runs are untouched.
    key: "ATLAS_DURABILITY_RETENTION_DAYS",
    section: "Agent",
    label: "Durable Session Retention (days)",
    description:
      "How long terminal agent-run checkpoints are retained before the retention sweep deletes them. Non-terminal runs are never swept.",
    type: "number",
    default: "30",
    envVar: "ATLAS_DURABILITY_RETENTION_DAYS",
    scope: "workspace",
  },
  {
    // Single-resumer lease TTL for crash-resume (#3747). A resume claims the run
    // for this many seconds; a second concurrent resume is rejected while the
    // lease is live. The TTL self-heals a resumer that died mid-resume — the run
    // becomes re-claimable once it lapses. Must out-live one full agent turn
    // (the loop's wall-clock budget is 180s), so the default is 300s.
    key: "ATLAS_DURABILITY_RESUME_LEASE_SECONDS",
    section: "Agent",
    label: "Resume Lease TTL (seconds)",
    description:
      "How long a crash-resume holds the single-resumer lease on an interrupted turn. A concurrent resume of the same run is rejected while the lease is live; the lease self-heals once it expires. Default 300s (longer than one agent turn).",
    type: "number",
    default: "300",
    envVar: "ATLAS_DURABILITY_RESUME_LEASE_SECONDS",
    scope: "workspace",
  },
  {
    // Max time a turn may stay parked awaiting a human approval decision (#3748).
    // The scheduler sweep fails parked runs past this window (a decision that
    // never landed). Default 1440 minutes (24h) matches the approval-queue's own
    // 24h request expiry, so the parked turn is reaped on the same clock.
    key: "ATLAS_DURABILITY_MAX_PARK_MINUTES",
    section: "Agent",
    label: "Max Park Duration (minutes)",
    description:
      "How long an agent turn may stay parked awaiting a human approval decision before the sweep fails it. Default 1440 minutes (24h), matching the approval-request expiry default.",
    type: "number",
    default: "1440",
    envVar: "ATLAS_DURABILITY_MAX_PARK_MINUTES",
    scope: "workspace",
  },
  {
    // #3757 / ADR-0020 — durable working-memory bounds. A session's working
    // memory must stay BOUNDED: a write whose slot count would exceed this cap is
    // REJECTED (surfaced to the caller), never truncated. Workspace-scoped +
    // hot-reloadable — `getMemoryMaxSlots(orgId)` (lib/durable-state.ts) reads it
    // per-turn at store build, so an admin can tighten/loosen the bound from
    // Admin → Settings with no redeploy. Overwriting an existing slot never
    // counts against this; only adding a NEW slot does.
    key: "ATLAS_MEMORY_MAX_SLOTS",
    section: "Agent",
    label: "Working Memory Max Slots",
    description:
      "Maximum number of named working-memory slots a single session may hold. A write that would add a new slot past this cap is rejected (never truncated). Default 64.",
    type: "number",
    default: "64",
    envVar: "ATLAS_MEMORY_MAX_SLOTS",
    scope: "workspace",
  },
  {
    // #3757 / ADR-0020 — per-value size cap for durable working memory. A write
    // whose serialized (JSON, UTF-8) value exceeds this many bytes is rejected
    // before persistence. Workspace-scoped + hot-reloadable via
    // `getMemoryMaxValueBytes(orgId)` (lib/durable-state.ts), same per-turn read
    // as the slot cap. Default 16384 (16 KiB) — generous for a remembered fact
    // (a table name, a filter set, a prior-result summary), tight enough that
    // memory can't become a bulk data sink.
    key: "ATLAS_MEMORY_MAX_VALUE_BYTES",
    section: "Agent",
    label: "Working Memory Max Value Size (bytes)",
    description:
      "Maximum serialized size (bytes, JSON/UTF-8) of a single working-memory slot value. A larger write is rejected before persistence (never truncated). Default 16384 (16 KiB).",
    type: "number",
    default: "16384",
    envVar: "ATLAS_MEMORY_MAX_VALUE_BYTES",
    scope: "workspace",
  },
  {
    key: "ATLAS_PROVIDER",
    section: "Agent",
    label: "LLM Provider",
    description: "LLM provider for the agent",
    type: "select",
    options: ["anthropic", "openai", "bedrock", "ollama", "openai-compatible", "gateway"],
    // No static default: an unset provider must fall through to
    // `getDefaultProvider()` (providers.ts), which picks `gateway` for
    // hosted/SaaS and `anthropic` for self-hosted. A hardcoded "anthropic"
    // here would override that and make SaaS report/run the wrong default (#3098).
    envVar: "ATLAS_PROVIDER",
    // #4462 — `requiresRestart` here is a display hint only (it neither
    // blocks a write nor defers application). The real guard is membership
    // in `SAAS_IMMUTABLE_KEYS` below: `ProactiveProviderKeyGuardLive`
    // validates this key's settings-resolved value at boot, so on SaaS both
    // writes and deletes are rejected. Self-hosted stays hot-reloadable.
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_MODEL",
    section: "Agent",
    label: "Model",
    description: "Model ID override (leave empty for provider default)",
    type: "string",
    envVar: "ATLAS_MODEL",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_LOG_LEVEL",
    section: "Agent",
    label: "Log Level",
    description: "Application log level",
    type: "select",
    options: ["trace", "debug", "info", "warn", "error", "fatal"],
    default: "info",
    envVar: "ATLAS_LOG_LEVEL",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },

  // Semantic Expert
  //
  // Scope split (#3392, #4516): the two `ATLAS_EXPERT_SCHEDULER_*` keys are
  // PLATFORM-scoped; the `ATLAS_AUTONOMOUS_IMPROVE_ENABLED` key after them is
  // WORKSPACE-scoped, as is the auto-approve pair.
  //  - `ATLAS_EXPERT_SCHEDULER_ENABLED` is the platform MASTER SWITCH — does the
  //    single process-global autonomous-improvement fiber run on this deployment
  //    at all (forked once at boot by `makeSchedulerLive` in lib/effect/layers.ts,
  //    hence `requiresRestart`)? `_INTERVAL_HOURS` is its cadence.
  //  - The per-workspace opt-in moved OUT of the master switch in #4516: on SaaS
  //    the tick iterates workspaces that set the WORKSPACE-scoped
  //    `ATLAS_AUTONOMOUS_IMPROVE_ENABLED`; on self-hosted the whole deployment is
  //    one implicit workspace gated by the master switch (the degenerate case,
  //    equivalent to the pre-#4516 behavior).
  //  - The auto-approve pair is WORKSPACE-scoped: read per proposal in
  //    `insertSemanticAmendment` (lib/db/internal.ts), which has the amendment's
  //    orgId in scope.
  {
    key: "ATLAS_EXPERT_SCHEDULER_ENABLED",
    section: "Intelligence",
    label: "Expert Scheduler",
    description: "Enable the autonomous-improvement fiber platform-wide (per-workspace opt-in is separate on SaaS)",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_EXPERT_SCHEDULER_ENABLED",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
    section: "Intelligence",
    label: "Expert Schedule Interval",
    description: "Hours between scheduled expert analysis runs",
    type: "number",
    default: "24",
    envVar: "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    // #4516 — per-workspace autonomous-improvement opt-in. Off by default and
    // WORKSPACE-scoped so enabling it is a workspace-admin settings action
    // (visible + writable to SaaS workspace admins via the default of the
    // saasVisible/saasWritable axis). Read per-tick (no `requiresRestart`): the
    // SaaS scheduler enumerates workspaces that have an explicit workspace-scoped
    // DB override set to true (not env/platform-default resolution). It is
    // orthogonal to auto-approve below — autonomy governs whether the scheduler
    // runs for a workspace; auto-approve governs whether eligible proposals
    // self-apply vs. queue, and is never implied by autonomy.
    key: "ATLAS_AUTONOMOUS_IMPROVE_ENABLED",
    section: "Intelligence",
    label: "Autonomous Improvement",
    description:
      "Let Atlas propose semantic-layer amendments for this workspace on its own cadence (spends this workspace's budget; off by default)",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_AUTONOMOUS_IMPROVE_ENABLED",
    scope: "workspace",
  },
  {
    key: "ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD",
    section: "Intelligence",
    label: "Auto-Approve Threshold",
    description: "Proposals with confidence >= this value and an eligible amendment type are auto-applied (leave empty to disable)",
    type: "string",
    default: "",
    envVar: "ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD",
    scope: "workspace",
  },
  {
    key: "ATLAS_EXPERT_AUTO_APPROVE_TYPES",
    section: "Intelligence",
    label: "Auto-Approve Types",
    description: "Comma-separated amendment types eligible for auto-approval. Others always queue for review.",
    type: "string",
    default: "update_description,add_dimension",
    envVar: "ATLAS_EXPERT_AUTO_APPROVE_TYPES",
    scope: "workspace",
  },

  // The alias auto-approve split (#5023, ADR-0037 §6). Modelled on the two
  // keys above and NOT a copy of their defaults, because the two subsystems
  // fail in opposite directions.
  //
  // `ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD` ships EMPTY — auto-approval off
  // until an admin opts in — and that is right for a YAML rewrite a human can
  // read and revert. Shipping the alias split off would be wrong, and T11
  // (#5016) §3(b) says why: day one the vocabulary and the entity store are
  // empty for every
  // workspace, so the first producer run emits an edge per entity. If each is a
  // proposal, the queue is `pattern-tiers.ts`'s named anti-goal — CONTEXT.md's
  // "a review queue full of seen-once noise" — at a scale nobody reviews. So
  // the shipped default is ADR-0037 §6's own split rather than "nothing".
  //
  // What the knob buys is the ability to turn the split OFF (empty threshold
  // → everything queues) or to widen it — never a decision an implementer had
  // to make for the operator.
  //
  // ⚠️ ONE CONSEQUENCE OF DEFAULTING ON, and where it is contained (#5162). A
  // workspace that opts OUT does so with a DB override, and `loadSettings`
  // treats a failed load as non-fatal. The swap is atomic, so `_cache` keeps
  // its last good contents on every failure EXCEPT the first load after boot,
  // which has no last good state to keep. In that one window the workspace
  // tier is simply absent: an opted-out workspace resolves through the chain
  // to this default and auto-approval would be back ON. The two keys above
  // cannot reach that state because their default is already the off position;
  // these can.
  //
  // The latch lives at the authority path, not here — `autoApproveEligible`
  // (`brain/vocabulary-decide.ts`) refuses while `settingsCacheEverLoaded()`
  // is false, because a tier that cannot be read cannot be honoured. Falsified
  // behaviourally in `brain/__tests__/vocabulary-decide-pg.test.ts` (pg-gated,
  // so it self-skips without TEST_DATABASE_URL) and unconditionally in
  // `lib/__tests__/settings.test.ts`.
  //
  // ⚠️ What this comment SAID until #5162, because the shape is the lesson: it
  // deferred the repair as "dormant today — nothing calls the seam until
  // #5034's producer". #5034 shipped 2026-08-06 and `extract.ts:1188` now
  // calls it. The conclusion happened to survive, but only because of a knob
  // this comment never named — `ATLAS_BRAIN_EXTRACTION_ENABLED`,
  // platform-scoped and default-off. A deferral whose stated trigger is not
  // its real gate expires silently, and nothing was watching the trigger it
  // did name.
  {
    key: "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD",
    section: "Intelligence",
    label: "Alias Auto-Approve Threshold",
    description:
      "Alias proposals with confidence >= this value and an eligible source class are approved without review (leave empty to queue everything)",
    type: "string",
    // 1, not 0.9: the only class eligible below is a warehouse primary key,
    // which is certain by construction. A threshold under 1 would let a future
    // producer's merely-probable edge auto-approve on a knob nobody re-read.
    default: "1",
    envVar: "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD",
    scope: "workspace",
    // #5161 — hidden from the generic settings page on Atlas Cloud, like the
    // nine other brain keys and like the third workspace-scoped one
    // (`ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED`). `scope: "workspace"` means "can
    // hold a different value per workspace", NOT "a workspace admin writes
    // it" — a platform admin sets the per-workspace override. Without this
    // line `saasVisible` defaults true and `saasWritable` resolves from it, so
    // a Cloud workspace admin could widen their own auto-approval bar.
    saasVisible: false,
  },
  {
    key: "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES",
    section: "Intelligence",
    label: "Alias Auto-Approve Sources",
    description:
      "Comma-separated alias proposal source classes eligible for auto-approval (warehouse_key, extractor, seam, human). Others always queue for review.",
    type: "string",
    // T11 (#5016) §3(b), verbatim: "Warehouse-derived entity edges backed by a
    // primary key may auto-approve. Extractor-derived and seam-proposed edges
    // always queue." ADR-0037 §6 restates the same rule with a semicolon and a
    // lowercase E — the quotation marks belong to the issue comment, which is
    // why the attribution does. Widening this to `extractor` is a real decision — an extractor
    // edge is an LLM's guess about which two spellings name one thing, and
    // approving it re-keys the corpus with no human in front of it.
    default: "warehouse_key",
    envVar: "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES",
    scope: "workspace",
    // #5161 — see the threshold key above for why a workspace-scoped key is
    // still platform-admin-only on Cloud.
    saasVisible: false,
  },

  // Demo
  {
    key: "ATLAS_DEMO_INDUSTRY",
    section: "Demo",
    label: "Demo Industry",
    description: "Industry of the demo dataset provisioned during onboarding (saas, cybersecurity, ecommerce)",
    type: "string",
    envVar: "ATLAS_DEMO_INDUSTRY",
    scope: "workspace",
    saasVisible: false,
  },

  // MCP — only the prompts gating today; future MCP-surface settings land here
  // so admins find them next to AI Agents under a single section.
  // #2076 — gating the canonical eval prompts is a "spot decision" that
  // a workspace admin makes once after picking their dataset, so we
  // surface it as a tri-state instead of a boolean. `auto` reads the
  // dataset signal (`__demo__` connection / `ATLAS_DEMO_INDUSTRY` set)
  // so the SaaS demo workspaces and self-hosted novamart fixtures both
  // light up without a manual flip; explicit `always` / `never` lets
  // a real-data customer opt in (e.g. they want NovaMart prompts as
  // examples for their analyst training set) or a demo workspace opt
  // out (e.g. running a pre-launch experiment).
  {
    key: "ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS",
    section: "MCP",
    label: "Expose canonical eval prompts",
    description:
      "Surface the 20 NovaMart canonical eval questions as MCP prompts/list entries. `auto` exposes them when the workspace has a published `__demo__` connection or `ATLAS_DEMO_INDUSTRY` is set; `always` exposes them regardless of dataset; `never` hides them.",
    type: "select",
    options: ["auto", "always", "never"],
    default: "auto",
    envVar: "ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS",
    scope: "workspace",
  },
  // #4409 / #2058 — Agent Auth Protocol spine kill-switch. The `agentAuth()`
  // plugin is registered UNCONDITIONALLY in buildPlugins() (schema + routes
  // always present, like twoFactor/passkey) — this key never toggles plugin
  // registration or schema. What it DOES gate: surface reachability (platform
  // tier — when off, the default, every agent-auth endpoint +
  // `/.well-known/agent-configuration` returns 404), capability EXECUTION
  // (workspace tier), and agent-audit emission (`agent-auth-audit.ts`).
  // Toggling needs NO REDEPLOY: this is a hot-reloadable settings key (not
  // `requiresRestart`; the `envVar` below is only the tier-3 fallback under
  // the hot-reloading DB tiers). The per-request gate reads it via
  // `getSettingLive` and fails closed (any resolution error ⇒ off).
  // `scope: "workspace"` makes the key mechanically override-able per
  // workspace, but the enablement is enforced at TWO tiers with ASYMMETRIC
  // power (#4419) — it is NOT a flat "workspace can override the platform"
  // precedence:
  //   • Operator (PLATFORM tier) = master on/off for EVERYONE. The HTTP-surface
  //     gate reads the platform tier only (no orgId), so platform-off ⇒ 404
  //     globally and a workspace CANNOT re-open it. This is the kill-switch.
  //   • Workspace admin (WORKSPACE tier) = opt-OUT of EXECUTION only. With the
  //     platform on, a workspace override of `false` seals that workspace's
  //     capability execution (others unaffected); it can only tighten, never
  //     turn the surface on when the platform default is off.
  // Kept experimental (upstream spec is a moving `v1.0-draft`) — default OFF.
  // Design + precedence rationale: `agent-auth-gate.ts`, the #4419 decision
  // recorded on #2058, and the operator doc
  // `apps/docs/content/docs/platform-ops/agent-auth-enablement.mdx`.
  {
    key: "ATLAS_AGENT_AUTH_ENABLED",
    section: "MCP",
    label: "Enable Agent Auth Protocol",
    description:
      "Expose the (experimental) Agent Auth Protocol surface: agent/host/capability endpoints and the `/.well-known/agent-configuration` discovery document. Hot-reloadable — takes effect within seconds, no redeploy. When off (default) the entire surface returns 404. Operator master switch: setting it at the platform level turns the surface on or off for everyone, and a workspace cannot re-enable it while the platform default is off. A workspace override can only tighten — setting it to off seals that workspace's capability execution while leaving others reachable. Leave off unless you are piloting agent-identity clients.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_AGENT_AUTH_ENABLED",
    scope: "workspace",
  },

  // Appearance
  {
    key: "ATLAS_BRAND_COLOR",
    section: "Appearance",
    // Default brand color — deep forest #1F5C45. Four-way lockstep with
    // brand.css `:root { --atlas-brand }` and the `DEFAULT_BRAND_COLOR`
    // constant in both packages/web and packages/react use-dark-mode.ts.
    label: "Brand Color",
    description: "Primary brand color in oklch format (used for theme tokens)",
    type: "string",
    default: "oklch(0.4 0.115 158)",
    envVar: "ATLAS_BRAND_COLOR",
    scope: "platform",
  },

  // Email
  {
    key: "ATLAS_EMAIL_PROVIDER",
    section: "Email",
    label: "Email Provider",
    description: "Platform default email provider",
    type: "select",
    options: [...EMAIL_PROVIDERS],
    default: "resend",
    envVar: "ATLAS_EMAIL_PROVIDER",
    // #1978 / #4462 — `DpaGuardLive` validates this key once, at boot.
    // `requiresRestart` is a UI HINT only: it neither blocks the write nor
    // defers when the new value is applied (see the `requiresRestart` note on
    // `SAAS_IMMUTABLE_KEYS` below). It exists so a self-hosted admin sees the
    // "restart required" banner. On SaaS the real guard is the write block:
    // the key is in `SAAS_IMMUTABLE_KEYS` below, so a settings write can't
    // silently invalidate a decision the boot guard already validated. (Since
    // #3399 the SaaS metadata suppression no longer applies to boot-consumed
    // keys like this one.)
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "RESEND_API_KEY",
    section: "Email",
    label: "Resend API Key",
    description: "API key for the Resend email provider",
    type: "string",
    secret: true,
    envVar: "RESEND_API_KEY",
    // #4462 — DpaGuardLive validates the RESOLVED transport at boot
    // (`resolveResendApiKey()` = this override → env), so on SaaS this key
    // is in `SAAS_IMMUTABLE_KEYS` below: both writes and deletes are
    // rejected, and the key is env-managed. Self-hosted keeps it
    // runtime-editable (the DPA guard early-returns there).
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "SENDGRID_API_KEY",
    section: "Email",
    label: "SendGrid API Key",
    description: "API key for the SendGrid email provider",
    type: "string",
    secret: true,
    envVar: "SENDGRID_API_KEY",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "POSTMARK_SERVER_TOKEN",
    section: "Email",
    label: "Postmark Server Token",
    description: "Server token for the Postmark email provider",
    type: "string",
    secret: true,
    envVar: "POSTMARK_SERVER_TOKEN",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_EMAIL_FROM",
    section: "Email",
    label: "From Address",
    description: "Default sender address for platform emails",
    type: "string",
    // Keep in sync with DEFAULT_FROM_ADDRESS in lib/email/delivery.ts (#3889).
    // It can't be imported here — delivery.ts depends on this module, so the
    // back-import would cycle — hence a synced literal rather than a shared ref.
    default: "Atlas <noreply@ship.useatlas.dev>",
    envVar: "ATLAS_EMAIL_FROM",
    scope: "platform",
    saasVisible: false,
  },

  // Secrets (read-only)
  {
    key: "ANTHROPIC_API_KEY",
    section: "Secrets",
    label: "Anthropic API Key",
    description: "API key for the Anthropic provider",
    type: "string",
    secret: true,
    envVar: "ANTHROPIC_API_KEY",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "OPENAI_API_KEY",
    section: "Secrets",
    label: "OpenAI API Key",
    description: "API key for the OpenAI provider",
    type: "string",
    secret: true,
    envVar: "OPENAI_API_KEY",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "DATABASE_URL",
    section: "Secrets",
    label: "Internal Database URL",
    description: "PostgreSQL connection string for Atlas internals",
    type: "string",
    secret: true,
    envVar: "DATABASE_URL",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_DATASOURCE_URL",
    section: "Secrets",
    label: "Datasource URL",
    description: "Analytics datasource connection string",
    type: "string",
    secret: true,
    envVar: "ATLAS_DATASOURCE_URL",
    scope: "platform",
    saasVisible: false,
  },

  // Spend policy (#4038, Structure B) — what happens once a workspace exhausts
  // its included at-cost usage credit ($20/seat). DEFAULT "continue": keep
  // serving at provider cost (zero markup), bounded by ATLAS_ABUSE_CEILING.
  // "cutoff": hard-block the moment the credit is spent (the effective ceiling
  // clamps to 100% of credit). Workspace-scoped so an admin owns their own
  // spend posture from Admin → Settings without a redeploy; hot-reloadable
  // (checkPlanLimits reads it live per request). Read at runtime via
  // resolveSpendPolicy in lib/billing/enforcement.ts — keeps
  // check-settings-readers green.
  {
    key: "ATLAS_SPEND_POLICY",
    section: "Billing",
    label: "Spend Policy (past included credit)",
    description:
      "What happens once a workspace spends its included usage credit ($20/seat). 'continue' (default) keeps serving at provider cost, bounded by the abuse ceiling. 'cutoff' hard-blocks at the credit (any overage returns a 429).",
    type: "select",
    options: ["continue", "cutoff"],
    default: "continue",
    envVar: "ATLAS_SPEND_POLICY",
    scope: "workspace",
  },

  // Abuse ceiling (#3990, re-denominated #4038) — the metered soft-cap cutoff
  // for the "continue" spend policy. Usage past 100% of the included at-cost
  // credit is METERED (served at provider cost), NOT blocked; the hard 429
  // cutoff fires only at this ceiling, expressed as a percent OF THE CREDIT.
  // It bounds runaway / abusive spend, not normal paying overage. Workspace-
  // scoped so an operator can lift it per tenant (e.g. a known heavy customer)
  // from Admin → Settings without a redeploy; hot-reloadable (no requiresRestart
  // — checkPlanLimits reads it live per request). Conservative default 500% =
  // 5× the credit = $100/seat: high enough that ordinary metered overage never
  // trips it, low enough to cap a runaway loop or compromised key at a bounded
  // multiple of the credit. 0 or empty disables the ceiling entirely (pure
  // metering, no cutoff) — only set that for a trusted workspace. Ignored when
  // the spend policy is "cutoff" (which clamps the ceiling to 100% of credit).
  {
    key: "ATLAS_ABUSE_CEILING",
    section: "Billing",
    label: "Abuse Ceiling (% of credit)",
    description:
      "Hard cutoff for metered at-cost overage under the 'continue' spend policy, as a percent of the workspace's included usage credit (default 500 = 5× credit = $100/seat). Usage between 100% and this ceiling is served at provider cost; at or above it, requests are blocked with a 429. 0 or empty disables the cutoff (pure metering).",
    type: "number",
    default: "500",
    envVar: "ATLAS_ABUSE_CEILING",
    scope: "workspace",
  },

  // Stripe Billing — the six paid-tier price IDs (#3703). These are
  // NON-SECRET Stripe constants (the genuine secrets — STRIPE_SECRET_KEY,
  // STRIPE_WEBHOOK_SECRET — stay env-only and are never registry-backed).
  // Platform-scoped + hot-reloadable: `getStripePlans()` / `resolvePlanTier
  // FromPriceId()` read them per-checkout via `getSettingAuto`, so an
  // operator can change pricing from Admin → Settings without a redeploy.
  // The env var is the self-host / boot fallback tier. `saasVisible: false`
  // keeps them off the generic workspace-admin settings page (pricing is a
  // platform-operator concern, not a per-tenant knob); platform admins always
  // see all settings. The monthly IDs are required for their tier to appear in
  // checkout — a missing one surfaces as an operator-actionable boot WARNING
  // (no longer a boot crash; see `BillingConfigGuardLive`). The annual IDs are
  // optional discount levers.
  {
    key: "STRIPE_STARTER_PRICE_ID",
    section: "Billing",
    label: "Starter Price ID (monthly)",
    description: "Stripe Price ID for the Starter plan (monthly, $39/seat). Required for the Starter tier to appear in checkout.",
    type: "string",
    envVar: "STRIPE_STARTER_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_STARTER_ANNUAL_PRICE_ID",
    section: "Billing",
    label: "Starter Price ID (annual)",
    description: "Stripe Price ID for the Starter plan (annual). Optional discount lever.",
    type: "string",
    envVar: "STRIPE_STARTER_ANNUAL_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_PRO_PRICE_ID",
    section: "Billing",
    label: "Pro Price ID (monthly)",
    description: "Stripe Price ID for the Pro plan (monthly, $69/seat). Required for the Pro tier to appear in checkout.",
    type: "string",
    envVar: "STRIPE_PRO_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_PRO_ANNUAL_PRICE_ID",
    section: "Billing",
    label: "Pro Price ID (annual)",
    description: "Stripe Price ID for the Pro plan (annual). Optional discount lever.",
    type: "string",
    envVar: "STRIPE_PRO_ANNUAL_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_BUSINESS_PRICE_ID",
    section: "Billing",
    label: "Business Price ID (monthly)",
    description: "Stripe Price ID for the Business plan (monthly, $149/seat). Required for the Business tier to appear in checkout.",
    type: "string",
    envVar: "STRIPE_BUSINESS_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_BUSINESS_ANNUAL_PRICE_ID",
    section: "Billing",
    label: "Business Price ID (annual)",
    description: "Stripe Price ID for the Business plan (annual). Optional discount lever.",
    type: "string",
    envVar: "STRIPE_BUSINESS_ANNUAL_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },

  // Stripe Billing — per-tier metered-overage price IDs (#3992; at-cost repoint
  // #4039). One metered (usage_type=metered) Stripe Price per paid tier, each
  // pointing at the single shared at-cost overage Billing Meter
  // (`atlas_usage_overage_cents`) at `unit_amount = 1` (1 cent / metered unit).
  // The `OverageMeter` reporter maps a workspace's tier → overage price (added
  // as a SECOND subscription item) and reports the period's at-cost overage
  // delta in CENTS to the meter, so the bill equals provider cost 1:1.
  // Platform-scoped + hot-reloadable (same as the monthly IDs):
  // `getOveragePriceIdForTier()` reads them per-operation via `getSettingAuto`,
  // so an operator can change the metered price from Admin → Settings without a
  // redeploy. `saasVisible: false` keeps them off the per-tenant settings page.
  // A missing one surfaces as an operator-actionable boot WARNING (not a crash;
  // see `BillingConfigGuardLive`) — its tier's overage simply won't be billed.
  {
    key: "STRIPE_STARTER_OVERAGE_PRICE_ID",
    section: "Billing",
    label: "Starter Overage Price ID (metered)",
    description: "Stripe Price ID for the Starter plan's at-cost metered usage overage (billed in cents, 1:1 with provider cost). Added as a second subscription item; required for Starter overage to be billed.",
    type: "string",
    envVar: "STRIPE_STARTER_OVERAGE_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_PRO_OVERAGE_PRICE_ID",
    section: "Billing",
    label: "Pro Overage Price ID (metered)",
    description: "Stripe Price ID for the Pro plan's at-cost metered usage overage (billed in cents, 1:1 with provider cost). Added as a second subscription item; required for Pro overage to be billed.",
    type: "string",
    envVar: "STRIPE_PRO_OVERAGE_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "STRIPE_BUSINESS_OVERAGE_PRICE_ID",
    section: "Billing",
    label: "Business Overage Price ID (metered)",
    description: "Stripe Price ID for the Business plan's at-cost metered usage overage (billed in cents, 1:1 with provider cost). Added as a second subscription item; required for Business overage to be billed.",
    type: "string",
    envVar: "STRIPE_BUSINESS_OVERAGE_PRICE_ID",
    scope: "platform",
    saasVisible: false,
  },

  // Billing scheduler cadences (#4130) — the plan-tier reconcile and
  // unclaimed-grace reap fiber intervals, previously hard-coded in
  // lib/effect/layers.ts. Platform-scoped: each is a single process-global
  // fiber forked once at boot by `makeSchedulerLive`, so there is no
  // per-workspace tick to override. Boot-consumed (the interval is resolved
  // when the fiber forks), hence `requiresRestart` — same shape as the
  // expert scheduler pair (#3399). Defaults preserve the pre-#4130 cadence.
  {
    key: "ATLAS_BILLING_RECONCILE_INTERVAL_HOURS",
    section: "Billing",
    label: "Plan-Tier Reconcile Interval",
    description: "Hours between plan-tier reconciliation sweeps (heals plan_tier drift from Stripe subscriptions and prunes the webhook event ledger)",
    type: "number",
    default: "6",
    envVar: "ATLAS_BILLING_RECONCILE_INTERVAL_HOURS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS",
    section: "Billing",
    label: "Unclaimed-Grace Reap Interval",
    description: "Hours between unclaimed-grace reaper sweeps (demotes lapsed unclaimed trial workspaces to the locked tier; SaaS only)",
    type: "number",
    default: "1",
    envVar: "ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },

  // Dynamic Learning — retrieval-time tuning for learned query patterns.
  // Workspace-scoped + hot-reloaded (read per-request via getSettingAuto), so
  // a tenant can tune them from Admin → Settings with no redeploy. The env var
  // is just the self-host fallback tier.
  {
    key: "ATLAS_LEARN_CONFIDENCE_THRESHOLD",
    section: "Dynamic Learning",
    label: "Pattern Confidence Threshold",
    description:
      "Minimum confidence score (0–1) for a learned pattern to be eligible for retrieval/auto-promotion. Lower promotes more aggressively; higher requires stronger evidence.",
    type: "number",
    default: "0.7",
    envVar: "ATLAS_LEARN_CONFIDENCE_THRESHOLD",
    scope: "workspace",
  },
  {
    key: "ATLAS_LEARN_RETRIEVAL_TURNS",
    section: "Dynamic Learning",
    label: "Pattern Retrieval Turns",
    description:
      "Number of trailing user turns assembled into the learned-pattern retrieval query. Widening the window lets a keyword-less follow-up (\"now break that down by region\") still match patterns via the keywords of earlier turns.",
    type: "number",
    default: "3",
    envVar: "ATLAS_LEARN_RETRIEVAL_TURNS",
    scope: "workspace",
  },
  // Workspace-scoped + hot-reloaded: read per-request via getSettingAuto in
  // perf-weighted retrieval. The nightly auto-promote job reads the SAME key at
  // platform scope (no orgId) for its latency gate, so a workspace override
  // affects only retrieval down-weighting, not promotion.
  {
    key: "ATLAS_LEARN_LATENCY_BUDGET_MS",
    section: "Dynamic Learning",
    label: "Pattern Latency Budget (ms)",
    description:
      "Patterns whose average execution time stays at or under this budget rank normally in retrieval; slower patterns are down-weighted (never excluded). Also the default latency ceiling for nightly auto-promotion.",
    type: "number",
    default: "5000",
    envVar: "ATLAS_LEARN_LATENCY_BUDGET_MS",
    scope: "workspace",
  },
  // Auto-promote/decay job (#3636, #4582). The enable dial is now the
  // WORKSPACE'S OWN trust dial: workspace-scoped, off by default, hot-reloaded —
  // one platform fiber iterates the workspaces that opted in (mirrors
  // ATLAS_AUTONOMOUS_IMPROVE_ENABLED). The fiber CADENCE (`_INTERVAL_HOURS`) is
  // still a single process-global fiber forked once at boot (makeSchedulerLive),
  // hence PLATFORM-scoped + requiresRestart; the gate knobs below are operator
  // policy read once per tick (no orgId), hence platform too.
  {
    key: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
    section: "Dynamic Learning",
    label: "Auto-Promote Learned Patterns",
    description:
      "Let Atlas auto-promote this workspace's high-confidence, fast, frequently-seen learned patterns and demote stale auto-promoted ones on its own cadence (off by default). Human approvals are never demoted; semantic amendments are never auto-promoted.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
    scope: "workspace",
  },
  {
    key: "ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS",
    section: "Dynamic Learning",
    label: "Auto-Promote / Decay Interval",
    description: "Hours between auto-promote/decay runs.",
    type: "number",
    default: "24",
    envVar: "ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_LEARN_PROMOTE_MIN_REPETITIONS",
    section: "Dynamic Learning",
    label: "Auto-Promote Min Repetitions",
    description:
      "Minimum times a pending pattern must have been seen before the auto-promote job will promote it (alongside the confidence threshold and latency budget).",
    type: "number",
    default: "5",
    envVar: "ATLAS_LEARN_PROMOTE_MIN_REPETITIONS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_LEARN_DECAY_UNSEEN_DAYS",
    section: "Dynamic Learning",
    label: "Pattern Decay Window (days)",
    description:
      "An auto-promoted pattern unseen for longer than this many days is demoted back to pending so the injected set stays fresh. Human-approved patterns are never auto-demoted.",
    type: "number",
    default: "30",
    envVar: "ATLAS_LEARN_DECAY_UNSEEN_DAYS",
    scope: "platform",
    saasVisible: false,
  },

  // ───────────────────────────────────────────────────────────────────────
  // SaaS tuning knobs promoted from env-only (#3705, Tier 1 of #3701).
  //
  // All platform-scoped + `saasVisible: false`: these are operator/region
  // infra knobs (public-surface rate limits, abuse-defense thresholds, cache
  // TTLs, OAuth token lifetimes), not per-tenant product settings — a tenant
  // must never be able to weaken their own abuse thresholds or the contact /
  // demo rate limits. `getSettingsForAdmin` only returns workspace-scoped keys
  // to workspace admins, so platform scope already keeps these off the tenant
  // settings page; `saasVisible: false` makes the operator-only intent explicit
  // (matches the RLS / deploy-mode / Stripe precedent above).
  //
  // The env var stays the fallback tier in every case (precedence:
  // platform DB override > env > registry default). Knobs read per-request /
  // per-event through `getSettingAuto` are hot-reloadable (no `requiresRestart`);
  // knobs consumed once at boot carry an honest `requiresRestart` hint.
  // (`OTEL_EXPORTER_OTLP_*` was evaluated and consciously LEFT as env — see
  // docs/development/saas-env-audit.md: telemetry inits before the settings
  // cache warms, so a DB-backed value could never apply at boot.)
  // ───────────────────────────────────────────────────────────────────────

  // Rate Limiting (continued) — public-surface limiters. Hot-reloadable:
  // `getContactRpmLimit()` reads per request.
  {
    key: "ATLAS_CONTACT_RATE_LIMIT_RPM",
    section: "Rate Limiting",
    label: "Contact Form Rate Limit (RPM)",
    description:
      "Max contact-form submissions per minute per IP (0 = disabled). Tighter than the chat limit — a real visitor submits a handful per minute; 30+ is abuse.",
    type: "number",
    default: "5",
    envVar: "ATLAS_CONTACT_RATE_LIMIT_RPM",
    scope: "platform",
    saasVisible: false,
  },

  // Self-serve MCP trial bootstrap (#3654, ADR-0018) — per-IP / per-email
  // creation-ATTEMPT limiters guarding the unauthenticated `start_trial`
  // onboarding caller. Hot-reloadable: `getTrialIpRpmLimit()` /
  // `getTrialEmailRpmLimit()` read per attempt. Per-IP is looser than the
  // contact form because the limit is on attempts, NOT trials — shared NATs
  // (co-working spaces, universities) must keep signing up; ADR-0018 rejects a
  // per-IP *trial* cap outright. Per-email is the tighter bound (one mailbox
  // retrying repeatedly is the spam signal).
  {
    key: "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
    section: "Rate Limiting",
    label: "Trial Signup Rate Limit — per IP (RPM)",
    description:
      "Max self-serve trial creation attempts per minute per IP (0 = disabled). Bounds attempt RATE, not trials per IP — shared NATs are not capped.",
    type: "number",
    default: "5",
    envVar: "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM",
    section: "Rate Limiting",
    label: "Trial Signup Rate Limit — per email (RPM)",
    description:
      "Max self-serve trial creation attempts per minute per email (0 = disabled). The tighter bound — one mailbox retrying repeatedly is the spam signal.",
    type: "number",
    default: "3",
    envVar: "ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM",
    scope: "platform",
    saasVisible: false,
  },

  // Demo (continued) — public email-gated demo. Hot-reloadable:
  // `getDemoRpmLimit()` / `getDemoMaxSteps()` read per request.
  {
    key: "ATLAS_DEMO_RATE_LIMIT_RPM",
    section: "Demo",
    label: "Demo Rate Limit (RPM)",
    description: "Max requests per minute per demo user (0 = disabled).",
    type: "number",
    default: "10",
    envVar: "ATLAS_DEMO_RATE_LIMIT_RPM",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_DEMO_MAX_STEPS",
    section: "Demo",
    label: "Demo Agent Max Steps",
    description: "Maximum tool-call steps per demo agent run (1–100).",
    type: "number",
    default: "10",
    envVar: "ATLAS_DEMO_MAX_STEPS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // #3931 — demo LLM override. The anonymous /demo path is top-of-funnel and
    // an unbounded, unattributed cost center; this lets an operator pick a
    // cheaper demo model without a redeploy. Blank ⇒ Haiku on the gateway
    // (SaaS — the curated NovaMart dataset de-risks the cheaper model), else
    // the platform default so a non-gateway deploy can never break. Resolved
    // per demo turn via `getDemoModelId()`.
    key: "ATLAS_DEMO_MODEL",
    section: "Demo",
    label: "Demo Model",
    description:
      "Model the public /demo path runs on — a gateway model id (e.g. anthropic/claude-haiku-4.5) or a direct model id matching the configured provider. Leave blank to default to Haiku on the gateway (SaaS) or the platform default on a non-gateway deploy.",
    type: "string",
    default: "",
    envVar: "ATLAS_DEMO_MODEL",
    scope: "platform",
    saasVisible: false,
  },

  // Abuse Prevention — anomaly-detection thresholds (lib/security/abuse.ts).
  // Hot-reloadable: `getAbuseConfig()` reads per query-event. Platform-only and
  // hidden from tenants by design — a workspace must not tune the thresholds
  // that defend the region against it.
  {
    key: "ATLAS_ABUSE_QUERY_RATE",
    section: "Abuse Prevention",
    label: "Query Rate Limit",
    description: "Queries per workspace within the window before escalation triggers.",
    type: "number",
    default: "200",
    envVar: "ATLAS_ABUSE_QUERY_RATE",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_ABUSE_WINDOW_SECONDS",
    section: "Abuse Prevention",
    label: "Detection Window (seconds)",
    description: "Sliding-window length (seconds) over which abuse counters accumulate.",
    type: "number",
    default: "300",
    envVar: "ATLAS_ABUSE_WINDOW_SECONDS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_ABUSE_ERROR_RATE",
    section: "Abuse Prevention",
    label: "Error Rate Threshold",
    description:
      "Failure ratio (0–1, e.g. 0.5 = 50%) above which a workspace with ≥10 queries in the window escalates.",
    type: "number",
    default: "0.5",
    envVar: "ATLAS_ABUSE_ERROR_RATE",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_ABUSE_UNIQUE_TABLES",
    section: "Abuse Prevention",
    label: "Unique Tables Limit",
    description: "Distinct tables a workspace may touch within the window before escalation triggers.",
    type: "number",
    default: "50",
    envVar: "ATLAS_ABUSE_UNIQUE_TABLES",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_ABUSE_THROTTLE_DELAY_MS",
    section: "Abuse Prevention",
    label: "Throttle Delay (ms)",
    description: "Injected per-request delay (ms) while a workspace sits at the 'throttled' level.",
    type: "number",
    default: "2000",
    envVar: "ATLAS_ABUSE_THROTTLE_DELAY_MS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS",
    section: "Abuse Prevention",
    label: "Escalation Cooldown (seconds)",
    description:
      "Dwell time (seconds) required at a level before the ladder advances to the next one. 0 disables the cooldown (test-only — a stray 0 in prod reopens the fast-walk regression, so a non-integer falls back to the default).",
    type: "number",
    default: "60",
    envVar: "ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS",
    scope: "platform",
    saasVisible: false,
  },

  // OAuth — token lifetimes for the MCP OAuth 2.1 provider + install state.
  // Access/refresh TTLs are baked into the Better Auth instance at boot
  // (`requiresRestart`); the install state-token TTL is read per-mint and is
  // hot-reloadable.
  //
  // NB: the access/refresh resolvers in lib/auth/server.ts read via
  // `getSettingOverride` (DB-override-only tier), so the `default` values below
  // are display-only — the live default is `DEFAULT_{ACCESS,REFRESH}_TOKEN_TTL_SECONDS`
  // in that file. Keep the two in sync (3600 / 2592000).
  {
    key: "ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    section: "OAuth",
    label: "Access Token TTL (seconds)",
    description: "Lifetime of OAuth 2.1 access tokens (default 1 hour). Baked into the auth instance at boot.",
    type: "number",
    default: "3600",
    envVar: "ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    section: "OAuth",
    label: "Refresh Token TTL (seconds)",
    description: "Lifetime of OAuth 2.1 refresh tokens (default 30 days). Baked into the auth instance at boot.",
    type: "number",
    default: "2592000",
    envVar: "ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    // The issue named this `ATLAS_OAUTH_STATE_TOKEN_TTL_SECONDS`; the actual
    // env var is `ATLAS_OAUTH_STATE_TTL_SECONDS` (integration-install OAuth
    // state token, lib/integrations/install/oauth-state-token.ts). Read
    // per-mint, so hot-reloadable. Clamped to [60, 3600] by the consumer.
    key: "ATLAS_OAUTH_STATE_TTL_SECONDS",
    section: "OAuth",
    label: "Install State Token TTL (seconds)",
    description: "Lifetime of integration-install OAuth state tokens (default 600, clamped to 60–3600).",
    type: "number",
    default: "600",
    envVar: "ATLAS_OAUTH_STATE_TTL_SECONDS",
    scope: "platform",
    saasVisible: false,
  },

  // Model Catalog — TTL of the BYOT provider model-list cache (Anthropic /
  // OpenAI / Bedrock). Hot-reloadable: `ttlMs()` reads per cache check.
  {
    key: "ATLAS_BYOT_CATALOG_TTL_MS",
    section: "Model Catalog",
    label: "Catalog Cache TTL (ms)",
    description: "How long fetched provider model catalogs are cached before re-fetch (default 6 hours).",
    type: "number",
    default: "21600000",
    envVar: "ATLAS_BYOT_CATALOG_TTL_MS",
    scope: "platform",
    saasVisible: false,
  },

  // MCP (continued) — hosted session-store + rate-limit caps. Hot-reloadable:
  // the hosted MCP transport mounts on the per-region API server (which runs
  // the SettingsLive refresh fiber) and re-reads these per sweep / per insert.
  {
    key: "ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS",
    section: "MCP",
    label: "Session Idle Timeout (ms)",
    description: "Idle time before an MCP session is reaped (default 30 min, 1-minute floor).",
    type: "number",
    default: "1800000",
    envVar: "ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_MCP_MAX_HELD_STREAM_AGE_MS",
    section: "MCP",
    label: "Max Held Stream Age (ms)",
    description:
      "How long a held GET SSE notification stream may stay open before the sweep reclaims its session under cap pressure (default 2 hours; 0 disables age-based reclaim).",
    type: "number",
    default: "7200000",
    envVar: "ATLAS_MCP_MAX_HELD_STREAM_AGE_MS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_MCP_RATE_LIMIT_MAX_KEYS",
    section: "MCP",
    label: "Rate-Limit Cache Max Keys",
    description:
      "Soft cap on the per-client rate-limit cache map (default 10000; values below 100 are clamped to 100).",
    type: "number",
    default: "10000",
    envVar: "ATLAS_MCP_RATE_LIMIT_MAX_KEYS",
    scope: "platform",
    saasVisible: false,
  },

  // Dashboards — dashboard PDF/PNG export render budget. Hot-reloadable:
  // `getExportTimeoutMs()` reads per export. Clamped to [5s, 180s].
  {
    key: "ATLAS_DASHBOARD_EXPORT_TIMEOUT_MS",
    section: "Dashboards",
    label: "Export Render Timeout (ms)",
    description: "Overall wall-clock budget for a dashboard export render (default 60000, clamped to 5000–180000).",
    type: "number",
    default: "60000",
    envVar: "ATLAS_DASHBOARD_EXPORT_TIMEOUT_MS",
    scope: "platform",
    saasVisible: false,
  },

  // Dashboards — max simultaneous headless renders (screenshot + PDF/PNG
  // export share one Chromium). Hot-reloadable: `getRenderConcurrency()` reads
  // per acquire. Excess requests queue rather than spawning unbounded browser
  // contexts. Clamped to [1, 16].
  {
    key: "ATLAS_DASHBOARD_RENDER_CONCURRENCY",
    section: "Dashboards",
    label: "Headless Render Concurrency",
    description:
      "Max simultaneous dashboard screenshot/export renders on the shared headless Chromium; excess requests queue (default 3, clamped to 1–16).",
    type: "number",
    default: "3",
    envVar: "ATLAS_DASHBOARD_RENDER_CONCURRENCY",
    scope: "platform",
    saasVisible: false,
  },

  // Dashboards — retention window before an abandoned never-published shell is
  // swept (#4320). A never-published dashboard with no cards and no drafts,
  // created longer than this many hours ago, is soft-deleted by the scheduler
  // sweep. `0` (or less) disables the sweep. Hot-reloadable:
  // `cleanupAbandonedDashboards()` reads it per tick.
  {
    key: "ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS",
    section: "Dashboards",
    label: "Abandoned Shell Cleanup (hours)",
    description:
      "Hours a never-published, empty dashboard shell (no cards, no drafts) may sit before the scheduler soft-deletes it. 0 disables cleanup (default 72).",
    type: "number",
    default: "72",
    envVar: "ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS",
    scope: "platform",
    saasVisible: false,
  },

  // Dashboards — retention window before an abandoned per-user DRAFT row is
  // swept (#4324). A `dashboard_user_drafts` row un-touched (not saved) for
  // longer than this many days is deleted by the scheduler sweep, so the table
  // can't grow unbounded from forked-then-abandoned drafts. `0` (or less)
  // disables the sweep. Hot-reloadable: `getDashboardDraftRetentionDays()`
  // (lib/dashboard-versioning.ts) reads it per tick — no redeploy to retune.
  {
    key: "ATLAS_DASHBOARD_DRAFT_RETENTION_DAYS",
    section: "Dashboards",
    label: "Abandoned Draft Retention (days)",
    description:
      "Days an un-touched per-user dashboard draft may sit before the scheduler deletes it (published/discarded drafts are removed immediately). 0 disables cleanup (default 30).",
    type: "number",
    default: "30",
    envVar: "ATLAS_DASHBOARD_DRAFT_RETENTION_DAYS",
    scope: "platform",
    saasVisible: false,
  },

  // Observability — plugin-health probe cache TTL. Hot-reloadable:
  // `getPluginHealthCacheTtlMs()` reads per health probe. (OTEL exporter
  // endpoint/headers are intentionally NOT here — see the block header above.)
  {
    key: "ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS",
    section: "Observability",
    label: "Plugin Health Cache TTL (ms)",
    description:
      "How long plugin-liveness results are cached before re-probing (default 15000, 0 disables caching, max 300000).",
    type: "number",
    default: "15000",
    envVar: "ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS",
    scope: "platform",
    saasVisible: false,
  },

  // Knowledge Base — OKF bundle ingest caps (#4207, ADR-0028 §5). Platform-
  // scoped operator knobs, read at ingest by `lib/knowledge/ingest-limits.ts`.
  // Registry-backed (not env) so a SaaS operator tunes them without a redeploy.
  //
  // The two tier-composed keys (docs, bundle bytes) deliberately carry NO static
  // `default` (#4235): a static default would shadow the deploy-mode-aware
  // fallback `ingest-limits.ts` applies — self-hosted keeps the shipped 1000 /
  // 25 MB, SaaS raises the ceiling to the Business tier's 5000 / 100 MB so that
  // entitlement is reachable. Same pattern as `ATLAS_RATE_LIMIT_RPM`.
  {
    key: "ATLAS_KNOWLEDGE_INGEST_MAX_DOCS",
    section: "Knowledge Base",
    label: "Ingest Max Documents",
    description:
      "Maximum number of documents a single knowledge bundle may ingest. Unset defaults to 1000 self-hosted and 5000 on Atlas Cloud (the Business-tier ceiling); non-positive values fall back to that default. On Atlas Cloud each workspace is additionally capped by its plan tier — the effective limit is the smaller of the two.",
    type: "number",
    envVar: "ATLAS_KNOWLEDGE_INGEST_MAX_DOCS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES",
    section: "Knowledge Base",
    label: "Ingest Max Document Size (bytes)",
    description:
      "Maximum decoded size of any single document in a knowledge bundle (default 1000000 / 1 MB; oversized documents are rejected per-file).",
    type: "number",
    default: "1000000",
    envVar: "ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES",
    section: "Knowledge Base",
    label: "Ingest Max Bundle Size (bytes)",
    description:
      "Maximum raw upload size of a knowledge bundle. Unset defaults to 25000000 (25 MB) self-hosted and 100000000 (100 MB) on Atlas Cloud (the Business-tier ceiling). Also reused as the decoded-total cap that aborts a decompression bomb mid-inflate during extraction. On Atlas Cloud each workspace is additionally capped by its plan tier — the effective limit is the smaller of the two.",
    type: "number",
    envVar: "ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES",
    scope: "platform",
    saasVisible: false,
  },
  {
    // OKF-native serving (#4208, ADR-0028 §3) — cap on the collection table-of-
    // contents compressed into the agent's system prompt, read by
    // `lib/knowledge/mirror.ts::getKnowledgeTocMaxBytes`. Registry-backed so an
    // operator resizes the prompt budget without a redeploy.
    key: "ATLAS_KNOWLEDGE_TOC_MAX_BYTES",
    section: "Knowledge Base",
    label: "Collection ToC Max Size (bytes)",
    description:
      "Maximum size of the Knowledge Base collection table-of-contents injected into the agent's system prompt (default 12000 ≈ 3k tokens); collections beyond the cap are omitted from the prompt and remain browsable via the explore tool. Non-positive values fall back to the default.",
    type: "number",
    default: "12000",
    envVar: "ATLAS_KNOWLEDGE_TOC_MAX_BYTES",
    scope: "platform",
    saasVisible: false,
  },

  // Knowledge Base — bundle-sync cadence + fetch caps (#4211). Platform-scoped
  // operator knobs; both hot-reload — the interval is re-read when the
  // scheduler arms each next tick (#4236), the fetch timeout is read per sync.
  {
    key: "ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS",
    section: "Knowledge Base",
    label: "Bundle Sync Interval (hours)",
    description:
      "How often bundle-sync knowledge collections pull their endpoint (default 24 — nightly). Hot-reloaded — a change takes effect by the next scheduled tick; non-positive values fall back to the default.",
    type: "number",
    default: "24",
    envVar: "ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS",
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_KNOWLEDGE_SYNC_FETCH_TIMEOUT_SECONDS",
    section: "Knowledge Base",
    label: "Bundle Sync Fetch Timeout (seconds)",
    description:
      "Per-sync time budget for downloading a collection's bundle endpoint (default 60; non-positive values fall back to the default). Bounds the whole fetch including redirects and body streaming.",
    type: "number",
    default: "60",
    envVar: "ATLAS_KNOWLEDGE_SYNC_FETCH_TIMEOUT_SECONDS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Knowledge Sync Connector reconciliation cadence (#4376, ADR-0030) — how
    // often a connector collection runs a FULL enumeration crawl (subtractive
    // archiving of vendor-deleted pages + full-set cap validation) instead of
    // the cheap incremental change fetch. Read per collection per cycle by
    // `lib/knowledge/connector-sync.ts::getKnowledgeSyncReconcileIntervalMs`.
    key: "ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS",
    section: "Knowledge Base",
    label: "Connector Reconciliation Interval (hours)",
    description:
      "How often a connector-synced knowledge collection runs a full reconciliation crawl — the pass that archives vendor-deleted pages and validates ingest caps over the full set (default 168 — weekly; incremental change syncs run every cycle). Hot-reloaded; non-positive values fall back to the default.",
    type: "number",
    default: "168",
    envVar: "ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Company-brain chat ingest backfill window (#4770, ADR-0036 §Ingestion) —
    // how far back a chat channel with no stored mark reads on its first pass.
    // The operator's lever when a first sync hits the per-sync record cap: the
    // cap warning names this knob. Read per cycle by
    // `lib/brain/ingest/slack/connector.ts::getChatBackfillWindowMs`.
    key: "ATLAS_BRAIN_CHAT_BACKFILL_DAYS",
    section: "Knowledge Base",
    label: "Chat History Backfill (days)",
    description:
      "How much history a newly-connected chat channel reads on its first sync (default 7). Lower it when a first sync reports that a channel has more history than one cycle can read; already-synced channels are unaffected. Hot-reloaded; non-positive values fall back to the default.",
    type: "number",
    default: "7",
    envVar: "ATLAS_BRAIN_CHAT_BACKFILL_DAYS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Company-brain chat WEBHOOK FAST-PATH (#4967, ADR-0036 §T6) — the
    // alternate writer that stores a Slack message as an episode seconds after
    // it is said rather than at the next sync tick. Read PER EVENT by
    // `lib/brain/ingest/slack/webhook.ts::isSlackWebhookFastPathEnabled`, so
    // flipping it off takes effect immediately — it is the operator's lever for
    // "stop writing episodes off Slack events right now", which is worth
    // nothing if it needs a restart.
    //
    // Default OFF, and the default is the point: the fast path contributes
    // LATENCY, never correctness. The poll is the correctness floor, so off is a
    // fully-supported steady state in which ingest is exactly what it was
    // before this shipped — not a degraded mode. Turning it on is a
    // staging-first change like every other Slack-surface change (CLAUDE.md),
    // because it changes which writer wins the race for a message and therefore
    // which one's grant derivation is frozen onto the row.
    //
    // Platform-scoped: the tee is registered once per process on the shared
    // Chat SDK instance, so there is no per-workspace half of this to turn on.
    // Which WORKSPACES it writes for is already decided by which ones installed
    // the Slack history source and which channels they scoped it to.
    key: "ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Chat Webhook Fast-Path",
    description:
      "Store Slack messages as brain episodes as they arrive, instead of waiting for the next sync. Off by default. For TOP-LEVEL messages this only changes how quickly one becomes available; for THREAD REPLIES it changes whether they are stored at all, because the scheduled sync reads conversations.history, which never returns replies. Only channels the Slack history source is scoped to are stored. Applies immediately.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Company-brain TRANSCRIPT ingest backfill window (#4965, ADR-0036 §T6).
    // Read per cycle by
    // `lib/brain/ingest/zoom/connector.ts::getTranscriptBackfillWindowMs`.
    //
    // Registered by #4966 rather than by #4965: the reader shipped with the
    // Zoom connector but the registry entry did not, so a knob that connector's
    // own clamp warnings name by key was reachable only as an env var and never
    // from Admin → Settings. The reader-side default and clamp are unchanged;
    // this makes the lever the warnings promise actually exist. (The registry
    // guard `scripts/check-settings-readers.sh` runs registry → reader, so an
    // unregistered key with a live reader is exactly the direction it cannot
    // see.)
    key: "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS",
    section: "Knowledge Base",
    label: "Meeting Transcript Backfill (days)",
    description:
      "How much history a newly-connected Zoom account reads on its first sync (default 30). Clamped to 180 days — Zoom serves at most six months of cloud recordings, so a wider window only spends API calls walking empty date ranges. Hot-reloaded; non-positive values fall back to the default.",
    type: "number",
    default: "30",
    envVar: "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Company-brain EMAIL ingest backfill window (#4966, ADR-0036 §T6) — how
    // far back a mailbox with no stored mark reads on its first pass. Read per
    // cycle by `lib/brain/ingest/outlook/connector.ts::getEmailBackfillWindowMs`.
    //
    // Its ceiling is a COST bound and not a vendor one, which is the difference
    // from the transcript knob above and the reason the default is not simply
    // raised: Exchange really does hold years of mail, and every message
    // ingested mints its own `audience:` row set to re-verify forever
    // (`lib/brain/ingest/outlook/audience.ts` §GRAIN PROBLEM). Widening this is
    // a standing per-cycle cost, not a one-off catch-up.
    key: "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS",
    section: "Knowledge Base",
    label: "Email Backfill (days)",
    description:
      "How much history a newly-connected mailbox reads on its first sync (default 30). Clamped to 365 days. Raise it deliberately: unlike chat and meetings, every message ingested creates its own access audience that is re-verified on every cycle from then on. Hot-reloaded; non-positive values fall back to the default.",
    type: "number",
    default: "30",
    envVar: "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Company-brain extraction fiber (#4771, ADR-0036 §Ingestion). Default OFF
    // while the brain milestone is in flight: the review surface (#4772) is
    // what makes an extracted fact usable, so until it lands the fiber would
    // spend model budget filling a queue nobody can read. Platform-scoped
    // because the fiber is process-wide and drains every workspace's episodes.
    // Read at fiber-registration time by
    // `lib/brain/extract.ts::isBrainExtractionEnabled`, so a change takes
    // effect on the next boot rather than on the next tick.
    key: "ATLAS_BRAIN_EXTRACTION_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Extraction",
    description:
      "Draw fact candidates from stored episodes — chat, meeting transcripts and mail alike — with the workspace's configured model, and stage them as drafts for review. Off by default; episodes keep being stored either way, so turning it on later extracts the backlog rather than losing it. Applies at restart.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_BRAIN_EXTRACTION_ENABLED",
    scope: "platform",
    saasVisible: false,
  },
  {
    // The INGEST tier (#5353). WORKSPACE-scoped, unlike the enablement switch
    // above, because it is a spend/quality trade a tenant can legitimately hold
    // a different position on — and because a BYO workspace's extraction runs on
    // that workspace's own key, so the bill is theirs.
    //
    // Blank rather than a hardcoded id, on `ATLAS_COMPACTION_SUMMARY_MODEL`'s
    // shape exactly: the DEFAULT lives in `providers.ts`'s
    // `PROVIDER_EXTRACTION_DEFAULTS`, keyed by the resolved provider, because
    // "the cheap tier" is a different string for anthropic, bedrock, gateway and
    // openai — and is nothing at all for `ollama` and `openai-compatible`, which
    // fall through to whatever the turn resolves.
    //
    // ⚠️ This key is read by the extraction fiber ALONE. The interactive path
    // resolves through `resolveSelection`, which does not read it, and
    // `providers-extraction-tier.test.ts` pins that — #5353's whole point is that
    // the ingest path stops inheriting the chat model, and a knob that quietly
    // worked in both directions would be the same coupling wearing a new name.
    key: "ATLAS_BRAIN_EXTRACTION_MODEL",
    section: "Knowledge Base",
    label: "Company Atlas Extraction Model",
    description:
      "Optional model id for the fact-extraction call, independent of the chat model. Leave blank for the cheap tier of whichever provider is configured (Haiku 4.5 on Anthropic, Bedrock and the gateway; gpt-4o-mini on OpenAI; the configured model on Ollama and OpenAI-compatible servers, which have no separate tier). Resolved on the same provider and credentials as chat — only the model id changes. Extraction is high-volume, has a latency budget of hours, and its output reaches a review queue as a draft rather than a person as an answer, which is why it does not follow the chat model. Workspace-scoped, hot-reloadable.",
    type: "string",
    default: "",
    envVar: "ATLAS_BRAIN_EXTRACTION_MODEL",
    scope: "workspace",
    saasVisible: false,
  },
  {
    // The Batch API path (#5352). PLATFORM-scoped and default OFF, matching the
    // extraction switch two rows up rather than the model tier above it: this
    // changes the fiber's CONTROL FLOW (submit now, collect later, an in-flight
    // ledger in between), and its blast radius is the process, not a tenant's
    // bill. Off until it has run a full cycle on staging, per #5352's own AC.
    //
    // Turning it off mid-run is safe and needs no drain: already-submitted
    // batches keep being collected (the collect phase does not read this key —
    // abandoning paid-for work on a config flip would be the expensive
    // direction), and no new ones are submitted. Read per tick, so it applies on
    // the next one rather than at restart.
    //
    // The `description` below states the Anthropic-only consequence for an
    // operator without re-arguing it — a settings page has to stand alone, and
    // the argument itself lives once in `lib/brain/extract-batch.ts`'s header.
    //
    // ⚠️ INERT ON SAAS, and the description says so. The AI Gateway exposes only
    // `POST /v1/messages` and `POST /v1/messages/count_tokens` — there is no
    // batches endpoint — and `getDefaultProvider()` resolves `gateway` whenever
    // `VERCEL` or `ATLAS_DEPLOY_MODE=saas` is set. So on Atlas Cloud this switch
    // changes nothing at all, and an operator who flips it expecting a halved
    // bill needs to be told that BEFORE they go looking for the saving.
    // Deliberately not worked around: #5337's CPU-local extractor and a move to
    // Bedrock both make batch moot rather than urgent.
    key: "ATLAS_BRAIN_EXTRACTION_BATCH_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Batch Extraction",
    description:
      "Submit fact extraction through the provider's batch endpoint — half the price, with an asynchronous turnaround measured in hours rather than seconds. Safe for this path by construction: extraction already runs on its own schedule and its drafts are not usable until a person reviews them. **Requires a deployment configured to talk to Anthropic directly (ATLAS_PROVIDER=anthropic).** It has no effect on Atlas Cloud or any deployment routed through the AI Gateway, which has no batch endpoint — those keep the immediate path whatever this is set to. Off by default. Turning it off does not discard work already submitted — those results are still collected — it only stops new submissions. Applies on the next cycle.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_BRAIN_EXTRACTION_BATCH_ENABLED",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Stage-0 pre-extraction triage (#5336). PLATFORM-scoped and default OFF,
    // matching the batch switch above rather than the suggester's workspace
    // enrollment, because the mechanisms differ: the suggester's dial ENROLLS
    // workspaces in a model-driven producer (where a platform-scope `true`
    // silently enrolling every SaaS tenant is the accident its off-by-default
    // prevents), while this changes the process-wide fiber's CONTROL FLOW and
    // never spends anything — its only power is to NOT call a model. Off by
    // default because extraction is live in prod and a filter that drops a
    // real claim is a new way to be quietly wrong; with it off the cycle is
    // byte-identical to today's, which `extract-triage.test.ts` pins.
    //
    // Read per TICK (like the batch switch, unlike the extraction switch), so
    // an operator who sees a real claim routed out can turn it off without a
    // restart. The rules themselves are enumerated in `lib/brain/triage.ts`;
    // triaged-out episodes are marked `triaged_out_at` + `triage_reason` —
    // never stamped extracted — and re-queue by clearing the mark.
    key: "ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Extraction Triage",
    description:
      "Route obviously claim-free episodes — bare acknowledgements like \"+1\" and \"on it\", pure emoji reactions, bodies too short to state anything — past the extraction model using a fixed, human-readable rule list, before any model call is made. No model and no scoring are involved; the rules are deterministic and biased toward letting episodes through. A routed-out episode is never marked extracted: it keeps a visible triage mark with the rule that fired, is counted per rule on the extraction cycle's audit row, and can be re-queued by clearing the mark. Off by default; applies on the next cycle, no restart.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED",
    scope: "platform",
    saasVisible: false,
  },
  {
    // The autonomous suggester's trust dial (#5488, ADR-0036 §T9 lock 1's
    // permitted autonomy). WORKSPACE-scoped, default OFF, hot-reloaded — one
    // platform fiber iterates the workspaces that opted in, resolved per tick
    // (mirrors ATLAS_LEARN_PROMOTE_DECAY_ENABLED, #4582).
    //
    // `saasVisible: false`, and here the mirror deliberately BREAKS from the
    // promote/decay precedent: that dial is a tenant-self-service toggle, but
    // every ATLAS_BRAIN_* key is hidden from the generic settings page on
    // Atlas Cloud — a page-level universal claim `check-brain-settings-doc.ts`
    // enforces, and the closest sibling (the warehouse cadence, the other
    // draft-filing cycle) already follows it. On SaaS the per-workspace
    // opt-in row is therefore written by a platform admin on the tenant's
    // behalf; still per-workspace, still explicit, just not self-serve.
    //
    // ⚠️ The platform-scope enrollment behaviour, stated because the tier
    // chain makes it a footgun: on SaaS, enrollment reads EXPLICIT workspace
    // overrides straight off the settings table (`lib/brain/suggester.ts`),
    // so a platform-scoped `true` enrolls NOBODY — enrolling every tenant in
    // an autonomous model-driven producer is exactly the accident lock 1's
    // off-by-default exists to prevent. On self-hosted the deployment's own
    // workspaces resolve through the normal tier chain, so the env var (or a
    // platform override) opts the single-tenant install in with no
    // per-workspace row to write.
    key: "ATLAS_BRAIN_SUGGESTER_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Autonomous Suggester",
    description:
      "Let Atlas scan this workspace's recently-idle conversations on its own cadence and stage any insights it finds as DRAFT suggestions on the review queue, marked as machine-suggested and distinct from a person's own proposals (off by default). It never publishes: every suggestion waits for a human reviewer, like every other draft. Turning it off stops new suggestions on the next run and never removes drafts already raised.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_BRAIN_SUGGESTER_ENABLED",
    scope: "workspace",
    saasVisible: false,
  },
  {
    // The suggester fiber's cadence. Platform-scoped + requiresRestart for the
    // promote/decay interval's exact reason: the fiber is forked once at boot
    // (makeSchedulerLive), so its cadence is process-wide operator policy —
    // only the on/off dial above is per-workspace.
    key: "ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS",
    section: "Knowledge Base",
    label: "Autonomous Suggester Interval",
    description: "Hours between autonomous suggester runs.",
    type: "number",
    default: "24",
    envVar: "ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    // Audience-membership sync (#4801, ADR-0036 §Access control). WORKSPACE-
    // scoped and default ON, unlike its extraction sibling above, because the
    // two knobs answer different questions. Extraction spends model budget, so
    // it defaults off; this resolves a Slack roster the workspace already
    // granted Atlas read access to, and defaulting it OFF would mean private-
    // channel ingest keeps producing facts that are invisible to everyone —
    // the exact failure #4801 exists to end.
    //
    // Workspace-scoped because it encodes a tenant's decision (may Atlas match
    // our Slack members' emails to Atlas accounts?), not an operator's. The
    // fiber ALSO reads this key with no workspace, which resolves to the
    // platform value — the operator's process-wide off switch, applied at
    // RESTART (the fiber's gate is evaluated once at registration). Mid-run, a
    // platform flip takes effect through the per-install re-read inside the
    // cycle — except for a workspace carrying an explicit `true` override,
    // since workspace precedence beats platform.
    key: "ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Audience Sync",
    description:
      "Keep company-brain audience membership in sync so facts drawn from private chat channels, meeting transcripts and mail are visible to the people who were in them — and hidden again when someone leaves. Matches participants' email addresses against existing Atlas accounts; it never creates accounts and never stores a roster. Switching this OFF does not stop those facts being collected: it stops the membership behind them being refreshed, so they stop granting anyone once they pass the staleness bound. Slack channels additionally need Slack's users:read and users:read.email scopes.",
    type: "boolean",
    default: "true",
    envVar: "ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED",
    scope: "workspace",
    saasVisible: false,
  },
  {
    // Cadence of the membership sync. A knob rather than a constant because it
    // is the lever for the revocation-latency question a security-conscious
    // workspace will ask ("how long after I remove someone can they still read
    // it?") — the answer is one interval, and this is where it is set.
    key: "ATLAS_BRAIN_AUDIENCE_SYNC_INTERVAL_MINUTES",
    section: "Knowledge Base",
    label: "Company Atlas Audience Sync Interval",
    description:
      "How often brain audience membership — private chat channels, meeting participants, mail recipients — is re-read from the source, in minutes (default 30). This is also the shortest delay between someone losing access at the source and losing access to facts drawn from it; an audience whose roster cannot be read keeps its membership until it can, up to the staleness limit below. Applies at restart; non-positive or unparseable values fall back to the default.",
    type: "number",
    default: "30",
    envVar: "ATLAS_BRAIN_AUDIENCE_SYNC_INTERVAL_MINUTES",
    scope: "platform",
    saasVisible: false,
  },
  {
    // The Coverage Surface's denominator enumeration (#5213, ADR-0041).
    //
    // Default ON, and workspace-scoped for the audience sync's reason one seam
    // over: the cycle reads a tenant's own vendor rosters, so the tenant is who
    // decides. ADR-0040's rule makes ON the right default — availability is
    // automatic, authority never is — and nothing this cycle writes is a claim:
    // it counts survey units and stores no message, no fact and no person.
    //
    // ⚠️ NOT a staleness knob. ADR-0041 refuses one by name ("No staleness knob
    // — not env, not the settings registry"), and this key does not become one:
    // it decides whether the roster is re-enumerated at all, never how far a
    // source may move before it is called stale.
    key: "ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Coverage Snapshot",
    description:
      "Keep the Company Atlas coverage page's denominators up to date by periodically enumerating what Atlas's credentials can see — the channels in a connected chat workspace, the entities and dimensions in the published semantic layer. Counts only: no message, no claim and no person is read or stored by this cycle. Switching it OFF freezes the coverage page at its last reading, which the page then labels with that date rather than showing zero.",
    type: "boolean",
    default: "true",
    envVar: "ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED",
    scope: "workspace",
    saasVisible: false,
  },
  {
    // Cadence of the denominator enumeration. Platform-scoped because the cost
    // it governs is the operator's — one channel-roster walk plus a bounded
    // probe rotation per connected workspace per cycle.
    key: "ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES",
    section: "Knowledge Base",
    label: "Company Atlas Coverage Snapshot Interval",
    description:
      "How often the Company Atlas coverage page's denominators are re-enumerated, in minutes (default 60). A roster changes on a human timescale — someone creates a channel, someone invites the bot — so this is also roughly how long a new channel takes to appear on the coverage page. Applies at restart; non-positive or unparseable values fall back to the default.",
    type: "number",
    default: "60",
    envVar: "ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES",
    scope: "platform",
    saasVisible: false,
  },
  {
    // The warehouse producer's cadence trigger (#5228, ADR-0039).
    //
    // ⚠️ Default OFF, like the extraction cycle above and for the same reason:
    // both file drafts into the review queue a human has to drain, which is the
    // resource ADR-0039 exists to protect. The roster/membership cycles beside
    // them (coverage snapshot, audience sync) default ON because they only count
    // and resolve — ADR-0040: availability is automatic, authority never is. So
    // a workspace gets scheduled runs only after somebody said so.
    // The manual `POST /admin/brain-enrollment/produce` is unaffected either
    // way; turning this on adds a second trigger, it does not gate the first.
    //
    // Workspace-scoped because it is the tenant's decision — they enrolled the
    // pairs and they staff the review queue. The fiber ALSO reads this key with
    // no workspace, which resolves to the platform value, and that read is the
    // boot gate.
    //
    // ⚠️ **The two reads compose as an AND, and for a DEFAULT-OFF key that is a
    // different sentence from the one the neighbours above carry.** Their
    // default is `"true"`, so their boot gate passes with nothing set and a
    // workspace override really is the only knob. This one defaults `"false"`:
    // with no platform value the fiber never starts, and a workspace switching
    // itself on changes nothing. **The platform switch turns the cadence ON; the
    // workspace switch chooses who gets it.**
    key: "ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED",
    section: "Knowledge Base",
    label: "Company Atlas Warehouse Cadence",
    description:
      "Re-read this workspace's enrolled warehouse dimensions on a schedule instead of only when an admin presses Run. Off by default. Each run reads the same (entity, dimension) pairs a human enrolled and files what it finds as drafts for review — an unchanged value is corroborated rather than re-filed, so a quiet warehouse costs no review; a changed one costs a draft and a tension edge. Turning it off stops future scheduled runs and leaves every fact already emitted exactly where it is. Two levels have to agree: the deployment-wide value starts the scheduler at all (read once at boot, so it applies at restart), and the per-workspace value chooses which workspaces it runs for (read each tick). Setting only the workspace value does nothing until the deployment-wide one is on.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED",
    scope: "workspace",
    saasVisible: false,
  },
  {
    // Cadence of the scheduled producer run. A knob rather than a constant in
    // the LENGTHENING direction only — the shortening direction is stopped by
    // `MIN_WAREHOUSE_CADENCE_INTERVAL_MS` in
    // `lib/scheduler/brain-warehouse-cadence.ts`, which carries
    // `WAREHOUSE_ROW_CAP`'s argument verbatim: a shorter cadence is a claim
    // about how much a human can review. Only the operator knows how long their
    // warehouse's meaning stays put, so lengthening is theirs and is unbounded.
    key: "ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS",
    section: "Knowledge Base",
    label: "Company Atlas Warehouse Cadence Interval",
    description:
      "How often the enrolled warehouse dimensions are re-read, in hours (default 24). This is also roughly how far behind the warehouse a published claim can be. Values below one hour are clamped to one hour: a shorter cadence files drafts faster than a person can review them, which is the queue the enrollment gate exists to protect. Applies at restart; non-positive or unparseable values fall back to the default.",
    type: "number",
    default: "24",
    envVar: "ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // The time bound on the interval knob's promise (#4808). Without it, "the
    // answer is one interval" holds only while the roster reads SUCCEED — a
    // channel Atlas was removed from fails every cycle forever and keeps
    // granting access on a roster nobody has been able to verify since.
    //
    // Platform-scoped, not workspace: it is a floor the operator sets. A
    // workspace admin raising their own staleness tolerance is precisely the
    // self-serving direction, and lowering it is not a decision they have the
    // signals to make.
    //
    // 7 days ≈ 336 default intervals — long enough that a Slack outage, a
    // token rotation, or a weekend of 429s resolves well inside it, so what
    // remains at expiry is an abandoned connection, which SHOULD stop granting.
    key: "ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS",
    section: "Knowledge Base",
    label: "Company Atlas Audience Staleness Limit",
    description:
      "How long a brain audience's membership — a private chat channel, a meeting's participants, a mail message's recipients — stays valid after Atlas last verified it against the source, in hours (default 168 = 7 days). Past this, facts drawn from that source stop being readable through its membership until a sync succeeds again, so a source Atlas has lost access to cannot keep granting access indefinitely. Suppressed grants are logged and counted, never dropped silently. Set to 0 to disable the limit and rely on the sync-cycle alerts alone.",
    type: "number",
    default: "168",
    envVar: "ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS",
    scope: "platform",
    saasVisible: false,
  },
  {
    // Cadence of the malformed-grant sweep (#4797). DAILY by default, and the
    // gap from the audience sync's 30 minutes is the point: a malformed grant
    // is a PERMANENT data defect, so the sweep re-reports the same rows every
    // cycle forever. The count on the span is a gauge and wants that; the log
    // line is the fix list and does not. Cadence is what keeps the second one
    // a digest rather than noise — see `lib/brain/grant-sweep.ts`'s header.
    //
    // Platform-scoped: this observes a data-integrity defect in the operator's
    // deployment, and a workspace admin turning down the rate at which their
    // own broken rows get reported is the self-serving direction.
    key: "ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS",
    section: "Knowledge Base",
    label: "Company Atlas Grant Sweep Interval",
    description:
      "How often Atlas scans company-brain facts and episodes for access grants that name nobody, in hours (default 24). Such rows are invisible to every reader and to the review queue, and nothing repairs them automatically — the sweep only counts and logs them, and never rejects or changes anything. Applies at restart; non-positive or unparseable values fall back to the default, values below 0.05 hours (3 minutes) are clamped up, and values above ~596 hours are clamped down to the maximum timer delay.",
    type: "number",
    default: "24",
    envVar: "ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS",
    scope: "platform",
    saasVisible: false,
  },
];

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: string;
  updated_at: string;
  updated_by: string | null;
}

/**
 * Cache key format:
 * - Platform (global): "KEY"
 * - Workspace-scoped: "KEY\0orgId"
 * The NUL separator is safe because neither key names nor org IDs contain it.
 */
function cacheKey(key: string, orgId?: string | null): string {
  return orgId ? `${key}\0${orgId}` : key;
}

let _cache = new Map<string, CacheEntry>();

/**
 * Whether {@link loadSettings} has ever completed successfully in this process
 * (#5162). Latches true on the first success and is never cleared by a later
 * FAILED load — the atomic swap leaves `_cache` holding its last good contents.
 * Only `_resetSettingsCache` (test-only) re-arms it.
 *
 * The one window this exists for is the first load after boot, which has no
 * last good state to keep: `_cache` is empty, so every DB-override tier is
 * silently absent and {@link getSetting} resolves straight to env/default. For
 * most keys that is fine. For a key whose default is the PERMISSIVE position,
 * it means a workspace's explicit opt-out evaporates and the authority it
 * withheld comes back on — see the `ATLAS_BRAIN_ALIAS_AUTO_APPROVE_*` block in
 * the registry above.
 */
let _cacheEverLoaded = false;

const SETTINGS_MAP = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

/**
 * Whether a DB-override tier could be consulted at all (#5162).
 *
 * Consumers that resolve an AUTHORITY decision through a workspace or platform
 * override must fail closed when this is false: a tier that was never read
 * cannot be honoured, so an override that would have withheld permission is
 * indistinguishable from one that was never set.
 *
 * ⚠️ `hasInternalDB() === false` reads as LOADED, deliberately. A deployment
 * with no internal DB resolves through env → default by design; that is a
 * supported configuration, not a degraded one, and an opt-out there is
 * expressed as an env var that IS present. Treating it as unloaded would fail
 * every self-hosted deployment closed for a tier it was never going to have.
 */
export function settingsCacheEverLoaded(): boolean {
  return !hasInternalDB() || _cacheEverLoaded;
}

/** @internal Reset cache — for testing only. */
export function _resetSettingsCache(): void {
  _cache = new Map();
  _cacheEverLoaded = false;
  _liveCache.clear();
}

// ---------------------------------------------------------------------------
// Live TTL cache — for SaaS hot-reload
// ---------------------------------------------------------------------------

/** Default TTL for the live settings cache (milliseconds). */
const LIVE_CACHE_TTL_MS = 5_000;

interface LiveCacheEntry {
  value: string | undefined;
  expiresAt: number;
}

const _liveCache = new Map<string, LiveCacheEntry>();

/**
 * Resolve current deploy mode (lazy — avoids circular import at module load).
 *
 * Three return states:
 *   - `"saas"` / `"self-hosted"` — `getConfig()` returned a resolved
 *     config object with a known `deployMode`.
 *   - `"unloaded"` — `getConfig()` returned `null`. Config singleton
 *     hasn't been initialized yet — legitimate at early module init
 *     and for AGPL builds that never call `loadConfig()`. Treated as
 *     self-hosted by all callers.
 *   - `"errored"` — the lazy `require()` itself threw, or `getConfig()`
 *     threw. This is a circular-import or instrumentation hiccup, NOT
 *     a legitimate self-hosted state. Contract guards treat this as
 *     fail-closed.
 *
 * The three-state distinction is load-bearing — see #1978 silent-failure
 * finding. A single `boolean` returning false on every non-saas case
 * conflated "config legitimately absent" (self-hosted) with "config
 * resolution itself failed" (suspicious), forcing the contract guard
 * to share the UX path's permissive default.
 */
type DeployModeSnapshot = "saas" | "self-hosted" | "unloaded" | "errored";

function resolveDeployModeSnapshot(): DeployModeSnapshot {
  let configMod: { getConfig: () => { deployMode?: string } | null };
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    configMod = require("@atlas/api/lib/config") as typeof configMod;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "resolveDeployModeSnapshot: require('@atlas/api/lib/config') threw",
    );
    return "errored";
  }
  let resolved: { deployMode?: string } | null;
  try {
    resolved = configMod.getConfig();
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "resolveDeployModeSnapshot: getConfig() threw",
    );
    return "errored";
  }
  if (resolved === null) return "unloaded";
  if (resolved.deployMode === "saas") return "saas";
  if (resolved.deployMode === "self-hosted") return "self-hosted";
  // Resolved object exists but deployMode isn't one of the canonical
  // values (still "auto", or future-added value) — treat as unloaded.
  return "unloaded";
}

/**
 * UX-oriented SaaS check — fail open (treat unloaded/errored as
 * non-SaaS) so the `requiresRestart` metadata suppression and
 * `SETTING_SIDE_EFFECTS` gating don't render spurious banners during
 * early module init. Used by `getSettingsForAdmin` and
 * `applySettingSideEffect`.
 */
function isSaasMode(): boolean {
  return resolveDeployModeSnapshot() === "saas";
}

/**
 * Guard-oriented SaaS check — used by `setSetting`/`deleteSetting` and,
 * since #3389, by the route-level write gates on PUT/DELETE
 * `/admin/settings/{key}` so the whole settings write path shares one
 * probe discipline.
 *
 * Fails CLOSED on `"errored"` (require() or getConfig() threw, which
 * shouldn't happen at request-handling time and is the silent-bypass
 * vector #1978's silent-failure finding flagged). Treats `"unloaded"`
 * as non-SaaS, matching the legitimate AGPL/dev case where config
 * was never loaded — self-hosted normal operation stays permissive.
 *
 * Asymmetry rationale: the boot guards in `lib/effect/saas-guards.ts`
 * read `config.deployMode` via `yield* Config` (typed, no fallback);
 * this runtime check is the only place a permissive fallback on the
 * "errored" state could silently let a SaaS admin persist a value the
 * running process won't honor. Better to over-reject (operator
 * restarts and retries) than under-reject (operator clicks Save, sees
 * "ok", walks away while the contract is silently broken on next
 * restart).
 */
export function isSaasModeForGuard(): boolean {
  const snapshot = resolveDeployModeSnapshot();
  if (snapshot === "saas") return true;
  if (snapshot === "errored") {
    log.warn(
      "isSaasModeForGuard: config resolution threw at runtime — failing closed (assuming SaaS) to preserve #1978 contract",
    );
    return true;
  }
  // self-hosted or unloaded — both legitimate non-SaaS states.
  return false;
}

/**
 * Read a setting with a short-TTL DB cache — for SaaS hot-reload.
 *
 * On cache hit (within TTL), returns the cached value immediately.
 * On cache miss, re-reads ALL settings from the DB (single query) and
 * refreshes the in-process cache, then returns the requested value.
 *
 * Falls back to `getSetting()` when no internal DB is available.
 */
export async function getSettingLive(key: string, orgId?: string): Promise<string | undefined> {
  if (!hasInternalDB()) return getSetting(key, orgId);

  const liveKey = cacheKey(key, orgId);
  const entry = _liveCache.get(liveKey);
  const now = Date.now();

  if (entry && now < entry.expiresAt) {
    return entry.value;
  }

  // Re-read all settings from DB (single round-trip) and refresh _cache
  await loadSettings();

  // Resolve through the normal tier chain (now with fresh _cache)
  const value = getSetting(key, orgId);

  // Store in live cache with TTL
  _liveCache.set(liveKey, { value, expiresAt: now + LIVE_CACHE_TTL_MS });

  return value;
}

/**
 * Synchronous setting read that is hot-reloadable in SaaS mode.
 *
 * In SaaS mode, this reads from the in-process cache which is refreshed
 * on demand by `getSettingLive()` calls and by `setSetting()` writes.
 * In self-hosted mode, this is identical to `getSetting()`.
 *
 * For settings on the hot-path (SQL validation, RLS, CORS), consumers call
 * this instead of `getSetting()` — the cache is kept warm by writes and
 * by demand-driven `getSettingLive()` reads.
 */
export function getSettingAuto(key: string, orgId?: string): string | undefined {
  // Both modes use the same in-process cache. In SaaS mode the cache is
  // refreshed more aggressively (on every write + demand-driven live reads).
  // The synchronous path is identical — the difference is cache freshness.
  return getSetting(key, orgId);
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Load all settings from the internal DB into the in-process cache.
 * Called at startup and periodically by the refresh timer in SaaS mode.
 * No-op when no internal DB.
 */
export async function loadSettings(): Promise<number> {
  if (!hasInternalDB()) return 0;

  try {
    const rows = await internalQuery<Record<string, unknown> & SettingRow>(
      "SELECT key, value, updated_at::text, updated_by, org_id FROM settings",
    );

    const next = new Map<string, CacheEntry>();
    for (const row of rows) {
      next.set(cacheKey(row.key, row.org_id), {
        value: row.value,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
    }
    _cache = next; // atomic swap — readers see old or new, never empty
    _cacheEverLoaded = true;

    if (rows.length > 0) {
      log.info({ count: rows.length }, "Loaded settings from internal DB");
    }
    return rows.length;
  } catch (err) {
    // On error, _cache is unchanged — atomic swap ensures readers see last successful load
    const msg = err instanceof Error ? err.message : String(err);
    // "42P01" = relation does not exist — expected on first boot before migration
    const isTableMissing = msg.includes("does not exist") || msg.includes("42P01");
    if (isTableMissing) {
      log.warn({ err: msg }, "Settings table does not exist yet — using env vars only");
    } else {
      log.error({ err: msg }, "Failed to load settings from internal DB — using env vars only");
    }
    return 0;
  }
}

/**
 * Get a setting value with tiered resolution.
 *
 * For workspace-scoped settings with an orgId:
 *   workspace DB override → platform DB override → env var → default
 *
 * For platform-scoped settings (or no orgId):
 *   platform DB override → env var → default
 */
export function getSetting(key: string, orgId?: string): string | undefined {
  const def = SETTINGS_MAP.get(key);

  if (orgId && def?.scope === "workspace") {
    // Tier 1: workspace-level DB override
    const wsOverride = _cache.get(cacheKey(key, orgId));
    if (wsOverride) return wsOverride.value;

    // Tier 2: platform-level DB override
    const platformOverride = _cache.get(cacheKey(key));
    if (platformOverride) return platformOverride.value;
  } else {
    // Platform-scoped or no orgId: standard DB override
    const cached = _cache.get(cacheKey(key));
    if (cached) return cached.value;
  }

  // Tier 3: env var
  const envVar = def?.envVar ?? key;
  const envVal = process.env[envVar];
  if (envVal !== undefined) return envVal;

  // Tier 4: registry default
  return def?.default;
}

/**
 * Read ONLY the DB-override tier for a key (no env / default fallback).
 *
 * For boot-consumed knobs whose resolver already takes an injected `env`
 * object (e.g. the OAuth token-TTL resolvers, which accept a synthetic env
 * in unit tests): layering `getSettingOverride(key) ?? env.KEY` preserves the
 * platform DB override > env > default precedence without `getSettingAuto`'s
 * read of the live `process.env` shadowing the injected one. Returns the
 * workspace override first for workspace-scoped keys when an orgId is given,
 * else the platform override; `undefined` when no override is set.
 */
export function getSettingOverride(key: string, orgId?: string): string | undefined {
  const def = SETTINGS_MAP.get(key);
  if (orgId && def?.scope === "workspace") {
    const wsOverride = _cache.get(cacheKey(key, orgId));
    if (wsOverride) return wsOverride.value;
  }
  return _cache.get(cacheKey(key))?.value;
}

/**
 * Set a settings override in the DB and update the in-process cache.
 * Throws if no internal DB is available.
 *
 * When orgId is provided and the setting is workspace-scoped, stores a
 * workspace-level override. Platform-scoped settings ignore orgId.
 */
export async function setSetting(key: string, value: string, userId?: string, orgId?: string): Promise<void> {
  const def = SETTINGS_MAP.get(key);
  if (!def) {
    throw new Error(`Unknown setting key: "${key}"`);
  }

  // #1978 — DpaGuardLive runs once at boot. Settings that participate in
  // contract guards (DPA, deploy mode) must not be hot-reloaded in SaaS,
  // or the guard would be silently bypassed until next restart. Reject
  // the write rather than persist a value the running process won't honor.
  // Runs BEFORE the hasInternalDB() check so the more-specific contract
  // error fires first — an operator hitting "Internal database required"
  // when the value was definitionally rejectable would waste time
  // debugging the DB. Uses isSaasModeForGuard() (fails closed) rather
  // than isSaasMode() so a transient getConfig() failure cannot bypass.
  if (isSaasImmutableKey(key) && isSaasModeForGuard()) {
    throw new SaasImmutableSettingError(key);
  }

  if (!hasInternalDB()) {
    throw new Error("Internal database required to persist settings overrides");
  }

  // Platform-scoped settings always store globally
  const effectiveOrgId = def.scope === "platform" ? undefined : orgId;

  if (effectiveOrgId) {
    await internalQuery(
      `INSERT INTO settings (key, value, updated_at, updated_by, org_id)
       VALUES ($1, $2, now(), $3, $4)
       ON CONFLICT (key, org_id) WHERE org_id IS NOT NULL
       DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [key, value, userId ?? null, effectiveOrgId],
    );
  } else {
    await internalQuery(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) WHERE org_id IS NULL
       DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [key, value, userId ?? null],
    );
  }

  _cache.set(cacheKey(key, effectiveOrgId), {
    value,
    updated_at: new Date().toISOString(),
    updated_by: userId ?? null,
  });

  // Bust live cache so next read picks up the new value immediately
  _liveCache.clear();

  // #3797 — louder audit trail when a runtime-mutable abuse control is changed
  // (especially disabled via the documented `0` sentinel), so weakening it is
  // traceable during an incident rather than buried in settings-change noise.
  //
  // ⚠️ BEFORE the side effect, not after. The row is committed and both caches
  // are updated by this point, so the security-relevant change is already live;
  // a side-effect handler that throws would otherwise take the audit down with
  // it and leave a landed change with no record. The audit needs nothing the
  // side effect produces, so the ordering is free. No handler throws today —
  // the only one catches internally — which makes this cheap insurance rather
  // than a live fix.
  //
  // ⚠️ **THIS ORDERING ARGUMENT COVERS THE PINO LINE ONLY, and it was written when
  // that was the only audit.** Since #5262 the DURABLE `admin_action_log` row is
  // filed by the CALLER, after `setSetting` returns — so a throw from
  // `applySettingSideEffect` below, or from the caller's own `log.info`, escapes
  // the route's `SaasImmutableSettingError`-only catch, reaches `runHandler`, and
  // returns the GENERIC 500. That 500 implies the write did not land while the
  // setting is live and no row was filed, which is the opposite of what
  // `settingsAuditFailureBody` was written to say. Insurance-only today for the
  // same reason as above; the point is that the reasoning here no longer reaches
  // the row that matters most.
  auditSecuritySensitiveChange(key, "set", value, userId, effectiveOrgId);

  // Apply runtime side effects for hot-reloadable settings
  applySettingSideEffect(key, value);

  log.info({ key, orgId: effectiveOrgId, actorId: userId }, "Setting override saved");
}

/**
 * Delete a settings override, reverting to the next tier in the fallback chain.
 * Throws if no internal DB is available.
 */
export async function deleteSetting(key: string, userId?: string, orgId?: string): Promise<void> {
  const def = SETTINGS_MAP.get(key);
  if (!def) {
    throw new Error(`Unknown setting key: "${key}"`);
  }

  // #3389 — clearing an override is a write: deleting a SAAS_IMMUTABLE
  // key's override on SaaS would reset it to env/default behind the
  // boot-time contract guards, the same silent-bypass class #1978 closed
  // for setSetting. Same guard, same error, same ordering rationale:
  // runs BEFORE the hasInternalDB() check so the more-specific contract
  // error fires first, and uses isSaasModeForGuard() (fails closed) so a
  // transient getConfig() failure cannot bypass.
  if (isSaasImmutableKey(key) && isSaasModeForGuard()) {
    throw new SaasImmutableSettingError(key);
  }

  if (!hasInternalDB()) {
    throw new Error("Internal database required to manage settings overrides");
  }
  const effectiveOrgId = def.scope === "platform" ? undefined : orgId;

  if (effectiveOrgId) {
    await internalQuery("DELETE FROM settings WHERE key = $1 AND org_id = $2", [key, effectiveOrgId]);
  } else {
    await internalQuery("DELETE FROM settings WHERE key = $1 AND org_id IS NULL", [key]);
  }
  _cache.delete(cacheKey(key, effectiveOrgId));

  // Bust live cache so next read picks up the reverted value
  _liveCache.clear();

  // #3797 — clearing an abuse-control override reverts it to env/default,
  // which is itself a security-relevant change; audit it too. Before the side
  // effect for the same reason as `setSetting`: the delete has committed, so
  // the audit must not be reachable-only-if the revert succeeds.
  auditSecuritySensitiveChange(key, "clear", undefined, userId, effectiveOrgId);

  // Apply runtime side effects (e.g., revert log level to env var / default)
  const revertedValue = getSetting(key, effectiveOrgId);
  if (revertedValue !== undefined) {
    applySettingSideEffect(key, revertedValue);
  }

  log.info({ key, orgId: effectiveOrgId, actorId: userId }, "Setting override removed");
}

/**
 * Get all DB overrides (for admin listing).
 * When orgId is provided, returns both platform-level and workspace-level overrides.
 */
export async function getAllSettingOverrides(orgId?: string): Promise<SettingRow[]> {
  if (!hasInternalDB()) return [];

  if (orgId) {
    return await internalQuery<Record<string, unknown> & SettingRow>(
      "SELECT key, value, updated_at::text, updated_by, org_id FROM settings WHERE org_id IS NULL OR org_id = $1 ORDER BY key",
      [orgId],
    );
  }

  return await internalQuery<Record<string, unknown> & SettingRow>(
    "SELECT key, value, updated_at::text, updated_by, org_id FROM settings ORDER BY key",
  );
}

// ---------------------------------------------------------------------------
// Admin API helpers
// ---------------------------------------------------------------------------

/** Mask a secret value for display. */
function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * Resolve a setting at the PLATFORM tier — global override → env → default,
 * with any workspace override deliberately out of scope. The single copy of
 * this ladder in the admin DISPLAY path (#4669) — runtime reads keep using
 * `getSetting`/`getSettingLive`, which do not mask secrets. The
 * platform-scoped display branch, the workspace-scoped fallthrough, and the
 * `platformValue` computation in {@link getSettingsForAdmin} all read it,
 * so they cannot drift.
 */
function resolvePlatformTier(def: SettingDefinition): {
  value: string | undefined;
  source: "env" | "override" | "default";
} {
  const override = _cache.get(cacheKey(def.key));
  if (override) {
    return { value: def.secret ? maskSecret(override.value) : override.value, source: "override" };
  }
  const envVal = process.env[def.envVar];
  if (envVal !== undefined) {
    return { value: def.secret ? maskSecret(envVal) : envVal, source: "env" };
  }
  return { value: def.default, source: "default" };
}

/**
 * Returns settings with current values and sources for the admin API.
 *
 * When orgId is provided, workspace-scoped settings resolve through the
 * 4-tier chain and include workspace-override source. Platform admins
 * (no orgId) see all settings at the platform level.
 *
 * When isPlatformAdmin is true, all settings are returned (platform + workspace).
 * Otherwise only workspace-scoped settings are returned (fail-closed default).
 */
export function getSettingsForAdmin(orgId?: string, isPlatformAdmin?: boolean): SettingWithValue[] {
  const showAll = isPlatformAdmin === true;

  return SETTINGS_REGISTRY
    .filter((def) => showAll || def.scope === "workspace")
    .map((def) => {
      let currentValue: string | undefined;
      let source: "env" | "override" | "workspace-override" | "default";

      if (orgId && def.scope === "workspace") {
        // 4-tier resolution for workspace-scoped settings: the workspace
        // override wins, then the shared platform-tier ladder.
        const wsOverride = _cache.get(cacheKey(def.key, orgId));
        if (wsOverride) {
          currentValue = def.secret ? maskSecret(wsOverride.value) : wsOverride.value;
          source = "workspace-override";
        } else {
          ({ value: currentValue, source } = resolvePlatformTier(def));
        }
      } else {
        // Standard 3-tier for platform-scoped settings (and workspace-scoped
        // keys viewed with no org context, where the platform tier IS the
        // resolved view).
        ({ value: currentValue, source } = resolvePlatformTier(def));
      }

      // #3399 — the SaaS suppression of the requiresRestart hint is
      // scoped to the keys `applySettingSideEffect` actually hot-reloads
      // (derived as HOT_RELOADED_KEYS below). Boot-consumed flagged keys
      // (e.g. the expert scheduler pair, #3392) genuinely need a restart
      // on SaaS too — the previous blanket `!inSaas` suppression left a
      // SaaS platform admin editing them with no staleness hint.
      // Self-hosted always shows the hint for flagged keys.
      const inSaas = isSaasMode();
      const requiresRestart =
        def.requiresRestart && !(inSaas && isHotReloadedKey(def.key))
          ? true
          : undefined;

      // #1978 — surface SaaS immutability so the admin UI can disable
      // the input rather than letting the operator submit and get a 409.
      // Only set the field when true so consumers without #1978 awareness
      // don't see a noisy `false` everywhere.
      const saasImmutable = inSaas && isSaasImmutableKey(def.key) ? true : undefined;

      // #4669 — platform tier of workspace-scoped keys, for the platform
      // console. Resolved WITHOUT the caller's workspace override (that
      // override would mask the global row an operator is managing —
      // e.g. a platform admin whose own workspace enables Agent Auth
      // must still see the platform tier as off). Platform-admin
      // (showAll) view only: workspace admins manage their own tier.
      let platformValue: string | undefined;
      let platformSource: "env" | "override" | "default" | undefined;
      if (showAll && def.scope === "workspace") {
        ({ value: platformValue, source: platformSource } = resolvePlatformTier(def));
      }

      return { ...def, requiresRestart, saasImmutable, currentValue, source, platformValue, platformSource };
    });
}

/** Returns the settings registry definitions (no values). */
export function getSettingsRegistry(): readonly SettingDefinition[] {
  return SETTINGS_REGISTRY;
}

/** Look up a setting definition by key. */
export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_MAP.get(key);
}

// ---------------------------------------------------------------------------
// Periodic settings refresh — for SaaS multi-instance consistency
// ---------------------------------------------------------------------------

/**
 * Single tick of the periodic settings refresh.
 *
 * Re-reads all settings from the internal DB and busts the live cache so
 * that getSettingLive() picks up the freshest values. Called by the
 * Effect fiber in SettingsLive (lib/effect/layers.ts).
 */
export async function refreshSettingsTick(): Promise<void> {
  await loadSettings();
  _liveCache.clear();
}

// ---------------------------------------------------------------------------
// Runtime side effects — applied when hot-reloadable settings change
// ---------------------------------------------------------------------------

/**
 * Settings that produce immediate runtime side effects when changed —
 * the single source of truth for "hot-reloaded in SaaS mode" (#3399).
 *
 * `applySettingSideEffect` dispatches on this map, and `HOT_RELOADED_KEYS`
 * (which scopes the SaaS `requiresRestart` suppression in
 * `getSettingsForAdmin`) is derived from the same map's keys. Adding a
 * side-effect handler therefore automatically suppresses the restart hint
 * for that key on SaaS — there is no second list to forget.
 */
const SETTING_SIDE_EFFECTS: Readonly<Record<string, (value: string) => void>> = {
  ATLAS_LOG_LEVEL: (value) => {
    try {
      // oxlint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency
      const { setLogLevel } = require("@atlas/api/lib/logger") as { setLogLevel: (level: string) => boolean };
      if (setLogLevel(value)) {
        log.info({ level: value }, "Log level updated via hot-reload");
      } else {
        log.warn({ level: value }, "Log level change rejected — invalid level");
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to apply log level change");
    }
  },
};

/**
 * Keys `applySettingSideEffect` hot-reloads at runtime in SaaS mode —
 * derived from `SETTING_SIDE_EFFECTS`, never maintained by hand. These
 * are the ONLY restart-flagged keys whose `requiresRestart` hint is
 * suppressed on SaaS; every other flagged key keeps the hint in both
 * deploy modes because its value is consumed at boot (#3399).
 */
export const HOT_RELOADED_KEYS: ReadonlySet<string> = new Set(Object.keys(SETTING_SIDE_EFFECTS));

/** True when `applySettingSideEffect` hot-reloads `key` in SaaS mode. */
export function isHotReloadedKey(key: string): boolean {
  return HOT_RELOADED_KEYS.has(key);
}

/**
 * Settings that boot-time guards depend on (`DpaGuardLive`,
 * `EnterpriseGuardLive`, etc.). In SaaS mode these guards run once at
 * process boot — hot-reloading the underlying setting would silently
 * bypass the guard until next restart, which is exactly the failure
 * mode #1978 closed. `setSetting` rejects writes for these keys in
 * SaaS so the only path to changing them is a controlled restart.
 *
 * Self-hosted preserves the runtime-mutable behavior — the guards
 * either don't run there (DPA) or are advisory (#1978 family).
 *
 * ## The invariant this set encodes (#4462)
 *
 * > A platform-scoped setting validated by a SaaS boot guard must either
 * > be a member of this set or be explicitly re-guarded on write. A
 * > `requiresRestart` hint is NEVER a guard.
 *
 * `requiresRestart` is annotation-only: it neither blocks a write nor
 * defers application (`setSetting` updates the in-process settings
 * cache that `getSetting`/`getSettingAuto` read, so the new value is
 * live on the very next read), so a
 * guard whose "it only takes effect next boot" rationale rests on the
 * flag is unsound. There is no validate-on-write seam in the registry,
 * and adding one was rejected in #4462 — membership here is the
 * mechanism: symmetric (blocks `setSetting` AND `deleteSetting`),
 * fail-closed (`isSaasModeForGuard`), and SaaS-only. Rotation stays
 * available out-of-band: change the env value, restart, and the boot
 * guard re-validates.
 *
 * Known cousin that is deliberately NOT here: the Stripe price-ID keys.
 * Their boot check is warn-only, so a runtime change can't slip past a
 * fail-boot guard.
 *
 * The `as const` is load-bearing: it preserves literal types so
 * `SaasImmutableKey` is a closed union and `SaasImmutableSettingError`
 * can refuse construction with an unknown key at compile time.
 */
const SAAS_IMMUTABLE_KEYS_LITERAL = [
  "ATLAS_EMAIL_PROVIDER",
  "ATLAS_DEPLOY_MODE",
  "ATLAS_RATE_LIMIT_RPM",
  // #4462 — `DpaGuardLive` validates the RESOLVED platform email
  // transport at boot via `resolveResendApiKey()` (registry override →
  // env). Deleting a registry-only override post-boot silently flips the
  // transport to the `ATLAS_SMTP_URL` bridge (a DPA violation the guard
  // never re-sees) or to "none" (platform mail silently dropped), with no
  // re-guard until the next restart.
  "RESEND_API_KEY",
  // #4462 — `ProactiveProviderKeyGuardLive` validates the SETTINGS-backed
  // proactive provider at boot via `getSettingAuto("ATLAS_PROVIDER")`.
  // Writing/clearing the override post-boot re-resolves the proactive
  // model live (`resolveModelFromSettings`), so an unkeyed provider fails
  // every proactive answer while boot and /health stay green.
  "ATLAS_PROVIDER",
] as const;
const SAAS_IMMUTABLE_KEYS: ReadonlySet<SaasImmutableKey> = new Set(SAAS_IMMUTABLE_KEYS_LITERAL);

/** Closed union of keys that are immutable in SaaS mode. */
export type SaasImmutableKey = (typeof SAAS_IMMUTABLE_KEYS_LITERAL)[number];

/** Type-guard that narrows `string` → `SaasImmutableKey` at the throw site. */
function isSaasImmutableKey(key: string): key is SaasImmutableKey {
  return (SAAS_IMMUTABLE_KEYS as ReadonlySet<string>).has(key);
}

/**
 * Settings that stay hot-reloadable by design (operators tune them without a
 * redeploy) but whose runtime mutation is security-relevant. Unlike
 * {@link SAAS_IMMUTABLE_KEYS} these are NOT write-blocked — the
 * tune-without-restart contract is intentional. Instead, a write or clear
 * emits a distinct `log.warn` security-audit line (above the generic
 * "Setting override saved" info log) so a weakening is traceable and
 * alertable during an incident, not lost in the settings-change noise.
 *
 * Two families live here, and they weaken in OPPOSITE directions — which is
 * why {@link securitySensitiveAuditFields} computes a per-key predicate
 * instead of one numeric rule:
 *
 * - **Abuse-control thresholds** (#3797) — the per-IP / per-email start_trial
 *   limiters. Documented `0 = disabled` semantics, so a *low or zero* value is
 *   the weakening. The sibling contact / demo attempt limiters share the shape
 *   and are reasonable future additions.
 * - **Alias auto-approve authority** (#5161) — the two knobs deciding which
 *   alias proposals re-key a corpus with no human in front of them. Here the
 *   weakening is a *wider* source list or a *lower* confidence bar, and the
 *   empty/unparseable value is the SAFE end (everything queues for review).
 *   Membership is the audit half of #5161; `saasVisible: false` on the defs is
 *   the access half.
 *
 * Adding a family means adding a rule in {@link SECURITY_SENSITIVE_RULES}. The
 * `as const` literal IS the key set and the rules are a `Record` over it, so a key
 * without a rule — or a rule without a key — is a compile error.
 *
 * ⚠️ This block documents {@link SECURITY_SENSITIVE_KEYS_LITERAL}, which is
 * declared further down the file; it sits here for reading order, not because it
 * attaches to the declaration below it.
 */
/**
 * What a settings write did: persisted a value, or removed the override and
 * reverted to the next tier. One definition rather than a copy at every consumer,
 * all of which have to agree — a count stood here and #5262 invalidated it, which
 * is why there is no longer a count or a list.
 */
export type SettingAuditAction = "set" | "clear";

/** The rule-derived flags carried by {@link SecuritySensitiveAuditLine}. */
export interface SecuritySensitiveAudit {
  readonly disablesControl: boolean;
  readonly widensAuthority: boolean;
}

/** How one sensitive key decides its audit flags from a written value. */
type SecuritySensitiveRule = (
  action: SettingAuditAction,
  value: string | undefined,
) => SecuritySensitiveAudit;

/**
 * The only alias source class that may auto-approve without widening the
 * authority — a warehouse primary key, certain by construction. Kept as a bare
 * string rather than imported from `brain/vocabulary-*`: `lib/settings.ts` is
 * below the brain modules and must not acquire an edge to them for an audit
 * predicate. The `ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES` registry `default` is
 * the same literal, and `settings.test.ts` pins the two together so the
 * duplication cannot rot.
 */
const ALIAS_SOURCE_CLASS_NOT_WIDENING = "warehouse_key";

/**
 * The abuse-control rule (#3797): the documented `0 = disabled` sentinel.
 *
 * ⚠️ Parses exactly as `trial-abuse.ts`'s `parseRpm` parses, for the same
 * reason {@link aliasThresholdRule} mirrors its own reader — and this rule did
 * NOT, until review measured it. Two divergences, in opposite directions:
 *
 * - `parseRpm` FLOORS, so `"0.9"` resolves to `0` and
 *   `sliding-window-rate-limit.ts`'s `limit === 0` short-circuit allows every
 *   request. The limiter is off and the old rule reported
 *   `disablesControl: false` — a false negative on exactly the event the flag
 *   exists to catch.
 * - `parseRpm` falls back to the shipped DEFAULT on non-finite or negative, so
 *   `"off"` leaves the limiter running at its shipped default — 5rpm per-IP,
 *   3 per-email. The old rule reported `disablesControl: true` — a false
 *   alarm, and a test pinned it.
 *
 * `settings.ts` cannot import `trial-abuse.ts` — that module imports
 * `getSettingAuto` from here, so the back-import would cycle — which makes the
 * duplication deliberate. It carries a value/effect table in `settings.test.ts`,
 * the same treatment `ALIAS_SOURCE_CLASS_NOT_WIDENING` gets for the same reason.
 */
const abuseThresholdRule: SecuritySensitiveRule = (action, value) => {
  if (action !== "set" || value === undefined) {
    return { disablesControl: false, widensAuthority: false };
  }
  const n = Number(value);
  // Non-finite or negative → `parseRpm` returns the fallback, so the control
  // stays ON and nothing was disabled. Otherwise it floors, and a floored zero
  // IS the disabled sentinel.
  const readerHonours = Number.isFinite(n) && n >= 0;
  return { disablesControl: readerHonours && Math.floor(n) === 0, widensAuthority: false };
};

/**
 * The alias source-list rule (#5161). Widens when any class beyond
 * `warehouse_key` is named.
 *
 * ⚠️ Judged on the WRITTEN value, not the reader's post-validation effect, and
 * that asymmetry with {@link aliasThresholdRule} below is deliberate.
 * `aliasAutoApproveSources` silently DROPS a token it doesn't recognise, so
 * `warehouse_key,extractr` widens nothing — but the operator who wrote it
 * believes they widened, the drop is invisible to them, and an audit log that
 * goes quiet on a typo'd privilege escalation is the wrong failure. The
 * threshold has no equivalent silent-drop: an out-of-range value there is
 * rejected INTO the safest state, loudly.
 */
const aliasSourcesRule: SecuritySensitiveRule = (action, value) => ({
  disablesControl: false,
  widensAuthority:
    action === "set" &&
    (value ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .some((t) => t !== ALIAS_SOURCE_CLASS_NOT_WIDENING),
});

/**
 * The alias confidence-bar rule (#5161). Widens only when the bar the reader
 * will actually apply is BELOW the shipped `1`.
 *
 * ⚠️ Parses exactly as `aliasAutoApproveThreshold` parses — `parseFloat`, then
 * the same `0 <= n <= 1` range — so the audit and the behaviour agree by
 * construction rather than by coincidence. Using `Number` here instead was a
 * measured false negative in review: `Number("0.5x")` is `NaN` so the write
 * audited as harmless, while `parseFloat("0.5x")` is `0.5` and the reader
 * halved the bar. An earlier draft paired that `Number` with a bare
 * `parsed < 1` and no range check, which also flagged `-0.5` as a widening when
 * the reader rejects it into the disabled (safest) state. Both directions are
 * pinned in `settings.test.ts`.
 */
const aliasThresholdRule: SecuritySensitiveRule = (action, value) => {
  if (action !== "set" || value === undefined || value.trim() === "") {
    return { disablesControl: false, widensAuthority: false };
  }
  const parsed = Number.parseFloat(value);
  const readerHonours = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
  return { disablesControl: false, widensAuthority: readerHonours && parsed < 1 };
};

/**
 * Every sensitive key, paired with the rule that reads it.
 *
 * ⚠️ THE TABLE IS THE SET — that is the whole point of the shape, and it is the
 * same `as const`-plus-closed-union device `SAAS_IMMUTABLE_KEYS` uses for the
 * same reason. A hand-maintained `Set` with a `switch`
 * beside it lets a fifth key be added with no rule, where it falls through to
 * whatever arm is last — and review measured that against the NUMERIC rule of
 * the day: a boolean key landing on {@link abuseThresholdRule} reported
 * `disablesControl: true` on `"true"` AND on `"false"`, because `Number("true")`
 * is `NaN`.
 *
 * ⚠️ Since that rule was fixed to mirror `parseRpm`, the same mis-wiring fails
 * the OTHER way — non-finite now reads as "the reader kept its default", so a
 * boolean key would report `disablesControl: false` on every value and audit
 * nothing at all. The direction flipped; the defect did not. Either way it is a
 * rule nobody chose, and nothing — not the compiler, not a test — would have
 * caught it.
 *
 * `Record<SecuritySensitiveKey, …>` makes "added a key, forgot the rule" a
 * compile error, and a typo in a key name a compile error rather than a silent
 * fall-through. This is #5161's own defect class one level up: a claim whose
 * subject was enlarged without re-checking the predicate riding on it.
 *
 * ⚠️ **A key marked `secret: true` in the registry may join this list.** Its
 * value is withheld from the audit line rather than the key being refused
 * (#5180) — {@link securitySensitiveAuditLine} carries why that call went the
 * way it did. Nothing else about adding a key changes: you do not need to touch
 * the logging path, which is the property that made this defect worth closing
 * before it had a subject.
 */
const SECURITY_SENSITIVE_KEYS_LITERAL = [
  "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
  "ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM",
  "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES",
  "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD",
] as const;

/** Closed union of keys whose runtime mutation is security-relevant. */
export type SecuritySensitiveKey = (typeof SECURITY_SENSITIVE_KEYS_LITERAL)[number];

const SECURITY_SENSITIVE_RULES: Record<SecuritySensitiveKey, SecuritySensitiveRule> = {
  ATLAS_TRIAL_IP_RATE_LIMIT_RPM: abuseThresholdRule,
  ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM: abuseThresholdRule,
  ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES: aliasSourcesRule,
  ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD: aliasThresholdRule,
};

export const SECURITY_SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  SECURITY_SENSITIVE_KEYS_LITERAL,
);

/** Type-guard that narrows `string` → {@link SecuritySensitiveKey}. */
function isSecuritySensitiveKey(key: string): key is SecuritySensitiveKey {
  return (SECURITY_SENSITIVE_KEYS as ReadonlySet<string>).has(key);
}

/**
 * Pure audit decision for {@link auditSecuritySensitiveChange}: the structured
 * fields to log when `key` is sensitive, or `null` when it isn't (no audit).
 * Exported so every rule is unit-testable without DB/logger plumbing.
 *
 * Two flags rather than one "weakened" boolean, because they are not the same
 * claim and an operator filters on different ones:
 *
 * - `disablesControl` — an abuse control was turned OFF (the `0`/non-finite
 *   sentinel). **Always false for the alias keys**: their disabled position
 *   (empty threshold) means *everything queues for review*, which is the safe
 *   end, and reusing the numeric rule there would flag the safest possible
 *   write as a disable. That inversion is why the rules are per-key.
 * - `widensAuthority` — more proposals now auto-approve with nobody in front
 *   of them. Always false for the abuse thresholds, which have no such notion.
 *
 * A `clear` flags neither on any key: it reverts to a platform override that
 * may itself be wide, so the written value does not determine the outcome.
 */
export function securitySensitiveAuditFields(
  key: string,
  action: SettingAuditAction,
  value: string | undefined,
): SecuritySensitiveAudit | null {
  if (!isSecuritySensitiveKey(key)) return null;
  return SECURITY_SENSITIVE_RULES[key](action, value);
}

/**
 * What an audit line records in place of a value it must not disclose.
 *
 * ⚠️ **Deliberately NOT {@link maskSecret}, and that divergence is the point.**
 * `maskSecret` emits `first4••••last4` as a *recognition* affordance: one
 * authenticated platform admin, looking at their own key on their own settings
 * page, needs to tell which credential is installed. A `log.warn` has neither
 * property — the stream is retained, exported, and readable by anyone with log
 * access, in SaaS potentially a third party — and the display mask's reveal
 * rate is calamitous at the short end: `"hunter2!!"` becomes `hunt••••r2!!`,
 * which is eight of nine characters. Inheriting a UX threshold into a security
 * sink imports a trade nobody made there.
 *
 * The audit's subject is *which control moved, and which way*. For a
 * secret-valued key that is not derivable from the characters anyway, so
 * withholding all of them costs the audit nothing. `key`, `action` and the two
 * rule flags carry the whole signal; `valueMasked` says the value was withheld.
 *
 * A truncated digest was considered and rejected: it correlates rotations
 * nicely, but a short or low-entropy secret is brute-forceable from one, which
 * adds a disclosure channel rather than removing one. So does a length marker,
 * for less benefit — and the empty string is withheld the same way as any
 * other value for exactly that reason: `value: undefined` where every other
 * secret reads `[withheld…]` would be a one-bit oracle on the secret's
 * content, which for the empty secret discloses it completely.
 *
 * ⚠️ Deliberately not any of the three placeholders it sits near, and one of
 * them is a trap rather than a style choice:
 * - `plugins/secrets.ts`'s `MASKED_PLACEHOLDER` (`••••••••`) is a
 *   ROUND-TRIPPING sentinel — `restoreMaskedSecrets` reads it back as "keep the
 *   stored value". Sharing it would make an audit line's contents meaningful to
 *   a settings writer, which is the opposite of what a redaction is for.
 * - pino's own default censor is `[Redacted]`, written into this same stream by
 *   `redact: redactPaths` for any field named `apiKey`/`token`/`secret`/…. A
 *   placeholder differing from it by one capital letter, meaning something
 *   else, is a trap for anyone grepping the stream.
 * - `maskSecret`'s `••••••••`, per the whole argument above.
 *
 * Self-describing, so a reader of the stream knows which mechanism withheld it
 * and does not have to guess. Kept module-private so a second sink with a
 * different audience cannot adopt it without deciding, here, that the trade
 * still holds.
 */
const REDACTED_AUDIT_VALUE = "[withheld:secret-setting]";

/**
 * Why {@link redactAuditValue} withheld a value.
 *
 * Three arms rather than two, because collapsing the latter two mislabels an
 * alert. `"unknown_definition"` reads as *registry drift* and sends an operator
 * to grep `SETTINGS_REGISTRY`; for a definition that belongs to a DIFFERENT key
 * the entry is right there and the bug is at the call site. Reported as drift,
 * that alert is closed as a false positive.
 */
export type AuditMaskReason = "secret" | "unknown_definition" | "definition_mismatch";

declare const auditedValueBrand: unique symbol;

/**
 * A string that has been through {@link redactAuditValue} — the ONLY thing an
 * audit line may carry in its `value` field.
 *
 * ⚠️ **The brand closes the seam-PRESERVING edit; the registry-flip test closes
 * the seam-REMOVING one. It is here because the suite it was measured
 * against could not be.** Round 1 ran `log.warn({ ...line, value }, …)` at the
 * emitter — issue #5180 verbatim, plaintext back in the log stream — against a
 * suite that took the registry's contents as fixed, and it passed every test.
 * Not because the tests were weak: no shipped sensitive key is `secret: true`,
 * so redacted and raw were identical on every input that suite reached, and the
 * edit was a behavioural no-op until the day it is a breach.
 *
 * ⚠️ That measurement is a fact about a suite, not a law about assertions, and
 * an earlier draft of this paragraph stated it as the latter — "an assertion
 * cannot see a difference that does not yet exist" — in the same docstring as
 * the section describing the assertion that sees it. A later round stopped assuming
 * the registry was fixed: flipping a definition to `secret: true` for one test
 * makes the difference reachable, and the leak becomes ordinary. See
 * "WHAT THE BRAND DOES NOT CLOSE" below for the split.
 *
 * The type is still the right instrument for the seam-PRESERVING edit:
 * {@link emitSecuritySensitiveAudit} takes a {@link SecuritySensitiveAuditLine},
 * whose `value` is branded, and a raw `string` is not assignable to it. That
 * one-keystroke edit is a compile error on the day it is harmless and on the day
 * it is not — and unlike a test, it does not need anyone to run the suite.
 *
 * This is the repo's own rule applied to itself — brand the OUTPUT, not just
 * the parameter — and the escalation the review loop asks for once a principle
 * has been argued twice: stop restating it in prose and make the state
 * unrepresentable.
 *
 * ⚠️ **WHAT THE BRAND DOES NOT CLOSE**, stated because a brand invites exactly
 * the wrong confidence, and both survivors were measured rather than guessed:
 *
 * - **A leak that never mentions the seam.** pino infers the first parameter's
 *   type from the literal you hand it, so there is no target type to check
 *   against and `log.warn({ ...line, value: raw }, …)` type-checks clean. The
 *   brand bites only where something is *expected* to carry it — hence
 *   {@link warnAuditLine}. Inline `log.warn` back and the fence is gone.
 * - **A dishonest `definition`.** The brand fences the OUTPUT of the decision;
 *   the INPUT is an ordinary structural value, so `{ …, secret: false }` at the
 *   call site reaches the verbatim arm with no cast.
 *
 * Both are closed by the registry-flip test in `settings-audit-log.test.ts`,
 * which makes redacted and raw differ on a reachable input. The brand and that
 * test cover disjoint edits and neither is redundant: the type catches the
 * seam-preserving spelling on a day nobody runs the suite, the test catches the
 * seam-removing one, which is the cheaper edit.
 *
 * The brand asserts "this went through the decision" — NOT "this is safe to
 * disclose". On the non-secret arm it carries the written value verbatim, by
 * design, so a second sink must not read it as a clearance.
 */
export type AuditedValue = string & { readonly [auditedValueBrand]: true };

/**
 * {@link redactAuditValue}'s decision: what to log, and why.
 *
 * ⚠️ **A UNION, so the correlation between the three fields is a compiler fact.**
 * It was an interface with `masked: boolean` and a docstring reading
 * "`maskReason` is `undefined` exactly when `masked` is false" — a biconditional
 * enforced by nothing, which `settings-write.ts` then spent a comment deriving a
 * consequence of. Worse, the prose was already violated: on a clear with a
 * mismatched definition, {@link securitySensitiveAuditLine} produced
 * `masked: false` WITH a `maskReason`, because it rebuilt the reason after the
 * decision had discarded it.
 *
 * As a union, `masked: true` implies both a present `maskReason` and a present
 * value, and `if (redacted.masked)` narrows all three at once.
 */
export type RedactedAuditValue =
  | {
      readonly value: AuditedValue | undefined;
      readonly masked: false;
      readonly maskReason?: undefined;
    }
  | {
      readonly value: AuditedValue;
      readonly masked: true;
      readonly maskReason: AuditMaskReason;
    };

/**
 * Does this definition belong to this key?
 *
 * ⚠️ **ONE PREDICATE, TWO QUESTIONS, and conflating them caused a regression.**
 * The wrong-key condition is asked for two different purposes:
 *
 * - *what reason to record for a withheld value* — {@link redactPresentAuditValue}
 * - *whether the CALLER has a bug* — `auditSettingsWrite`'s unconditional warn
 *
 * An attempt to serve the second by reading the first's `maskReason` broke the
 * clear path: with no value there is nothing to redact, so the decision never
 * consults the definition and reports no reason — while the caller bug is just as
 * real and just as worth warning about. A definition mismatch on a DELETE was
 * silently dropped, which is the defect `auditSettingsWrite`'s own warn exists to
 * prevent, and an existing test caught it.
 *
 * So the predicate is shared and the two uses stay separate. That is still one
 * source of truth — what it is not is one call site.
 */
export function definitionMismatchesKey(
  key: string,
  def: SettingDefinition | undefined,
): boolean {
  return def !== undefined && def.key !== key;
}

/**
 * The present-value arms, annotated so the non-optional `value` is CHECKED rather
 * than asserted.
 *
 * ⚠️ **An overload is an unchecked claim, and this one had already been broken
 * once.** TypeScript compares an overload signature to the IMPLEMENTATION
 * signature bivariantly, so a wide `RedactedAuditValue` implementation satisfies
 * a narrow `… & { value: AuditedValue }` overload without any arm being
 * verified. The docstring below records that an earlier draft returned
 * `undefined` for `""` — re-adding that arm reads as tidying, would have
 * type-checked clean, and would have shipped a 200 body missing a field the
 * published spec marks `required`.
 *
 * With the arms behind this annotated return type, that edit is `TS2322` here,
 * on the day it is written. Nothing about the decision moved; only who checks it.
 */
export function redactPresentAuditValue(
  key: string,
  def: SettingDefinition | undefined,
  value: string,
): RedactedAuditValue & { readonly value: AuditedValue } {
  // The sole minting site for {@link AuditedValue}. Every `as` below is a
  // string that has just been through the decision above it — that is what the
  // brand asserts, and keeping the casts in one function is what keeps the
  // assertion true.
  const audited = (v: string): AuditedValue => v as AuditedValue;

  if (def === undefined) {
    return { value: audited(REDACTED_AUDIT_VALUE), masked: true, maskReason: "unknown_definition" };
  }
  // ⚠️ BEFORE the `secret` arm, and the order is observable: a definition that is
  // both mismatched and secret reports `definition_mismatch`, because the caller
  // bug is the actionable fact and the secrecy of someone else's key is not
  // evidence about this one.
  if (definitionMismatchesKey(key, def)) {
    return {
      value: audited(REDACTED_AUDIT_VALUE),
      masked: true,
      maskReason: "definition_mismatch",
    };
  }
  if (def.secret === true) {
    return { value: audited(REDACTED_AUDIT_VALUE), masked: true, maskReason: "secret" };
  }
  return { value: audited(value), masked: false, maskReason: undefined };
}

/**
 * The written value as an audit line may record it (#5180), plus whether — and
 * why — it was withheld. Takes the KEY as well as the definition, so the decision
 * owns every reason it can report.
 *
 * ⚠️ It takes the WHOLE `SettingDefinition`, and an earlier draft narrowing it
 * to `Pick<…, "key" | "secret">` was measured to be a net loss. The narrowing
 * looked like good hygiene, but the only thing standing between this function
 * and a fabricated definition is how tedious one is to write: against the full
 * record a fake needs seven required fields and reads as a deliberate act,
 * while `{ key, secret: false }` reads as tidying — and `secret` is optional in
 * the `Pick`, so even `{ key }` lands in the verbatim arm. The registry-flip
 * test in `settings-audit-log.test.ts` is what actually closes that class; this
 * signature just declines to make it cheap.
 *
 * ⚠️ FAIL CLOSED ON AN UNKNOWN DEFINITION. A key with no registry entry cannot
 * be *shown* to be non-secret, and "we could not tell" is not a licence to
 * print. `settings.test.ts` pins every member of {@link SECURITY_SENSITIVE_KEYS}
 * to a registry entry, so through {@link securitySensitiveAuditLine} this arm is
 * a backstop against a rename rather than a live path — which is exactly why it
 * must not be the permissive one.
 *
 * ⚠️ It reports a `maskReason` rather than a bare boolean because the arms are
 * not the same event, and they route an operator to different places. See
 * {@link AuditMaskReason}.
 *
 * The empty string is withheld like any other value. An earlier draft returned
 * `undefined` for it — "nothing in `""` to withhold" — which was true about the
 * string and wrong about the stream: every other secret reads
 * `[withheld:secret-setting]`, so `undefined` singled the empty one out and
 * disclosed it exactly. Uniformity is the property; `action` carries set-vs-
 * clear, which is the distinction that was worth keeping.
 *
 * ⚠️ **THREE SINKS NOW, AND THE `Audit` IN THE NAME IS THE NARROWER WORD.**
 * #5263 asked whether the sink-generic name had become a liability once a
 * second sink adopted it — the #5180 review called it "a latent invitation".
 * The answer taken, deliberately, is that the trade GENERALISES and the name
 * stays:
 *
 * - the pino `security_setting.changed` line ({@link securitySensitiveAuditLine})
 * - the `admin_action_log.metadata` row (`lib/audit/settings-write.ts`)
 * - the settings `PUT` 200 body (`api/routes/admin.ts`, #5263)
 *
 * Renaming it to say which sink it serves was the alternative, and it is not
 * available: it serves three, and one of them is not an audit. The trade being
 * inherited is *withhold every character rather than reveal some* — see
 * {@link REDACTED_AUDIT_VALUE} for why that is not {@link maskSecret} — and it
 * holds at the response too, for a reason worth stating rather than assuming.
 * The `PUT` caller already holds the value it just sent, so withholding it in
 * the echo costs that caller nothing; what the echo owes is *what is now
 * stored*, and `valueMasked` says the characters were withheld rather than
 * leaving the placeholder indistinguishable from a literal.
 *
 * What does NOT generalise is any reading of the brand as a clearance —
 * {@link AuditedValue}'s last paragraph is the standing warning, and a fourth
 * sink with a different audience owes the same paragraph this one does.
 *
 *
 * ⚠️ **NO OVERLOADS, deliberately, and a round of review was spent learning
 * why.** This had a narrow `(def, value: string)` overload promising a present
 * {@link AuditedValue}. TypeScript checks an overload against the IMPLEMENTATION
 * signature bivariantly, so the promise was never verified against any arm — and
 * the wrapper's own body was the natural home for the edit that breaks it
 * (`value === "" ⇒ undefined`, which this file's history shows was shipped once).
 * Measured: adding that arm to the wrapper produced ZERO type errors.
 *
 * A caller holding a `string` calls {@link redactPresentAuditValue} directly and
 * gets a checked non-optional value. This function is the wide entry for callers
 * whose value may be absent. Nothing asserts a return the compiler has not
 * checked.
 */
export function redactAuditValue(
  key: string,
  def: SettingDefinition | undefined,
  value: string | undefined,
): RedactedAuditValue {
  if (value === undefined) return { value: undefined, masked: false, maskReason: undefined };
  return redactPresentAuditValue(key, def, value);
}

/** The 200 body `PUT /admin/settings/{key}` returns (#5263). */
export interface SettingUpdateResponse {
  readonly success: true;
  readonly key: string;
  /**
   * What is now stored, as {@link redactAuditValue} permits it to be echoed —
   * NOT the request's value played back. Read it with `valueMasked`.
   */
  readonly value: AuditedValue;
  /** True when `value` is the withheld placeholder rather than the characters. */
  readonly valueMasked: boolean;
  /**
   * Why it was withheld, when it was. Present exactly when `valueMasked` is true.
   *
   * ⚠️ **THE HUMAN-FACING SINK IS THE ONE THAT MOST NEEDS IT, and it shipped
   * without it.** The placeholder is `[withheld:secret-setting]`, so an admin who
   * just set a NON-secret key whose definition failed the key check was told
   * their setting was withheld as a *secret* — a wrong message, not merely a
   * generic one. The other two sinks carry a `maskReason`; this one had no field
   * to put it in.
   */
  readonly maskReason?: AuditMaskReason;
}

/**
 * Build the settings `PUT` 200 body, withholding a `secret: true` value (#5263).
 *
 * ⚠️ **A BUILDER RATHER THAN THREE LINES AT THE ROUTE, for the one reason that
 * survives: it is the only way to MEASURE the secret arm.** The route 403s a
 * `secret: true` key before any response body exists, so no request can carry a
 * secret value to the echo — an assertion written against the route can only
 * ever exercise the verbatim arm, which passes identically with the fix and
 * without it. That is #5180's accidental-equality trap arriving one sink later.
 * Pulled out here, the secret arm takes a real registry definition
 * (`ANTHROPIC_API_KEY`) in a unit test and the plaintext's absence is a measured
 * fact instead of an argument.
 *
 * ⚠️ It does NOT close the route inlining `{ success: true, key, value }` again,
 * and that is a TRADE rather than an impossibility — an earlier draft of this
 * paragraph said "nothing can", which the experiment below falsified. Both arms
 * were measured:
 *
 * - As shipped, the 200 schema's `value` is `z.string()` and
 *   {@link AuditedValue} is assignable to `string`, so the raw echo type-checks
 *   clean. `c.json` IS checked against the response schema; it just has nothing
 *   to object to in that direction.
 * - Branding the schema (`z.custom<AuditedValue>()`) DOES make the raw echo
 *   `TS2322` — and then `scripts/extract-openapi.ts` dies with
 *   `UnknownZodTypeError: Unknown zod object type`, even with `.openapi()`
 *   attached, so the spec and the api-reference docs stop generating.
 *
 * A compile-time guard on one unreachable arm is not worth the published spec,
 * so the seam-removing spelling is closed by a test in `admin-settings.test.ts`
 * asserting the response IS this builder's output. That is the same split
 * {@link AuditedValue} documents: a type for the seam-preserving edit, a test
 * for the seam-removing one.
 */
export function settingUpdateResponseBody(
  def: SettingDefinition | undefined,
  key: string,
  value: string,
): SettingUpdateResponse {
  // ⚠️ NO LOCAL MISMATCH CHECK — the decision owns it. This function briefly had
  // a hand-copied `def.key !== key` guard, which made it the THIRD copy of one
  // rule and the only copy that could not report the reason it found, because
  // `SettingUpdateResponse` had no field for it. Both are fixed at the source:
  // `redactPresentAuditValue` returns `definition_mismatch` itself, so the echo
  // and the audit row now agree because they are the SAME decision rather than
  // two implementations of it.
  const audited = redactPresentAuditValue(key, def, value);
  return {
    success: true,
    key,
    value: audited.value,
    valueMasked: audited.masked,
    ...(audited.masked ? { maskReason: audited.maskReason } : {}),
  };
}

/** The full structured payload {@link auditSecuritySensitiveChange} logs. */
export interface SecuritySensitiveAuditLine extends SecuritySensitiveAudit {
  readonly key: string;
  readonly action: SettingAuditAction;
  /**
   * The written value — verbatim, or replaced by {@link REDACTED_AUDIT_VALUE}
   * when the registry definition carries `secret: true`. Read it together with
   * `valueMasked`: without that flag a placeholder is indistinguishable from a
   * setting whose literal value happens to be that string.
   *
   * Branded, so only {@link redactAuditValue} can produce one — see
   * {@link AuditedValue} for why a type and not a test.
   */
  readonly value: AuditedValue | undefined;
  /** Whether `value` was withheld rather than recorded verbatim (#5180). */
  readonly valueMasked: boolean;
  /**
   * Why it was withheld. `"unknown_definition"` is the one worth alerting on —
   * it means a sensitive key has no registry entry, which is drift rather than
   * a routine masked write.
   */
  readonly maskReason: AuditMaskReason | undefined;
  readonly actorId: string | undefined;
  readonly orgId: string | undefined;
  /**
   * Why the two rule flags cannot be read as an exoneration, when they cannot.
   *
   * ⚠️ **THE SAME CAVEAT THE DURABLE ROW CARRIES, for symmetry that is the whole
   * point of #5262.** On a `clear` every rule short-circuits and returns
   * `false`/`false` — accurate about what the rule answered, and read by an
   * operator as "this write weakened nothing", which the rules explicitly decline
   * to establish for a clear. The value is derivable from `action` here, so this
   * is discoverability rather than new information; it exists so a reader of
   * either channel does not have to know that.
   */
  readonly judgement?: "reverted_value_not_evaluated";
  readonly event: "security_setting.changed";
}

/** Everything {@link securitySensitiveAuditLine} needs to build one line. */
export interface SecuritySensitiveAuditInput {
  readonly key: string;
  /**
   * `key`'s registry entry, or `undefined` when it has none.
   *
   * Passed in rather than looked up so the builder stays a pure function of its
   * inputs and the secret arm is reachable from a unit test without touching
   * the registry. The WHOLE definition, not a `Pick` of the two fields read —
   * see {@link redactAuditValue} for why narrowing it was a net loss.
   */
  readonly definition: SettingDefinition | undefined;
  readonly action: SettingAuditAction;
  readonly value: string | undefined;
  readonly actorId: string | undefined;
  readonly orgId: string | undefined;
}

/**
 * The exact payload the security-audit `log.warn` line carries, or `null` when
 * `key` is not sensitive (no audit). Pure, and exported so that
 * `settings-audit-log.test.ts` can assert the *emitted* object equals this
 * builder's output — pinning the pass-through itself, not just the payload.
 *
 * ⚠️ **A `secret: true` key IS allowed in {@link SECURITY_SENSITIVE_KEYS}; its
 * value is masked instead (#5180).** The alternative — refusing the
 * combination outright — was considered and rejected on three counts:
 *
 * 1. "Audit the change, never the content" is a legitimate pairing, not a
 *    contradiction. Rotating a credential that gates an abuse control is
 *    precisely the event an audit trail exists to record; refusing membership
 *    would make that rotation emit *nothing*, which is strictly worse than a
 *    line with a masked value.
 * 2. It is not expressible where it would have to be. `secret` lives on
 *    {@link SettingDefinition} inside a `SettingDefinition[]`, not on a
 *    literal-typed const, so `Record<SecuritySensitiveKey, …>` cannot see it —
 *    enforcement would be a runtime boot guard, trading a masked log line for a
 *    refusal to boot on a defect the mask already closes.
 * 3. The audit still records the *event* — who, when, which key, and which way
 *    the two rule flags moved. Only the characters go, and for a secret-valued
 *    key those were never the audit's subject. See {@link REDACTED_AUDIT_VALUE}
 *    for why this path does NOT reuse the display mask.
 *
 * The payload is built here in full — including `key` and `action` — so the
 * emitter has nothing left to assemble and no reason to name `value` again.
 *
 * ⚠️ That is a shape, not a guarantee, and the distinction was measured. An
 * earlier draft of this comment claimed the emitter "has no raw `value` in
 * scope to reach for"; `value` is its third parameter, so reaching for it is
 * one keystroke, and `log.warn({ ...line, value }, …)` reintroduced #5180 with
 * the whole suite green.
 *
 * It takes BOTH halves to close, and this comment has now been wrong in both
 * directions, so the split is worth stating exactly:
 *
 * - {@link AuditedValue} plus {@link warnAuditLine} close every spelling that
 *   still routes through {@link emitSecuritySensitiveAudit}.
 * - The registry-flip test in `settings-audit-log.test.ts` closes the spelling
 *   that inlines `log.warn` back here — which no type can see, because pino
 *   infers `log.warn`'s first parameter from the literal, leaving no target
 *   type to check against.
 *
 * Neither closes it alone: removing the seam removes the type, and the test only
 * became possible once it stopped assuming the registry was fixed — flipping a
 * definition to `secret: true` for one test makes raw and redacted differ on a
 * input that is reachable once a `secret: true` key joins
 * {@link SECURITY_SENSITIVE_KEYS}, which this module explicitly permits.
 */
export function securitySensitiveAuditLine(
  input: SecuritySensitiveAuditInput,
): SecuritySensitiveAuditLine | null {
  const { key, action, value, actorId, orgId } = input;
  const fields = securitySensitiveAuditFields(key, action, value);
  if (!fields) return null;
  // ⚠️ The wrong-key check lives in the decision now, not here. This site used to
  // discard the definition and then REBUILD the reason below — which is how the
  // union's `masked: false` + present `maskReason` state became reachable on a
  // clear. One call, one reason, no fixup.
  //
  // It structurally CANNOT close "this key's definition, lying about `secret`":
  // the compiling spelling is `{ ...def, secret: false }`, which passes the key
  // check and reaches the verbatim arm. Two tests cover that from opposite ends —
  // `definitionWithSecret` in `settings.test.ts` builds the spread and drives the
  // builder with it, and the registry-flip block in `settings-audit-log.test.ts`
  // mutates the shipped definition so redacted and raw differ on a reachable
  // input.
  const redacted = redactAuditValue(key, input.definition, value);
  return {
    key,
    action,
    value: redacted.value,
    valueMasked: redacted.masked,
    maskReason: redacted.maskReason,
    // Mirrors `auditSettingsWrite`'s row: a clear cannot be exonerated by flags
    // that only judge a written value.
    ...(action === "clear" ? { judgement: "reverted_value_not_evaluated" as const } : {}),
    disablesControl: fields.disablesControl,
    widensAuthority: fields.widensAuthority,
    actorId,
    orgId,
    event: "security_setting.changed",
  };
}

/**
 * Emit a security-audit `log.warn` when a {@link SECURITY_SENSITIVE_KEYS}
 * setting is changed or cleared at runtime. `action` is `set` (a new value
 * persisted) or `clear` (override deleted → reverts to env/default). A no-op
 * for non-sensitive keys.
 *
 * ⚠️ It emits through {@link emitSecuritySensitiveAudit} rather than calling
 * `log.warn` directly, and the indirection is load-bearing: `log.warn` takes
 * a first parameter it infers from the literal, so `log.warn({ ...line, value },
 * …)` — #5180 verbatim —
 * has no target type to be checked against and compiles. Routed through a
 * parameter typed {@link SecuritySensitiveAuditLine}, the same edit fails to
 * type-check, because `value` there is an {@link AuditedValue}.
 */
function auditSecuritySensitiveChange(
  key: string,
  action: SettingAuditAction,
  value: string | undefined,
  actorId: string | undefined,
  orgId: string | undefined,
): void {
  const line = securitySensitiveAuditLine({
    key,
    definition: getSettingDefinition(key),
    action,
    value,
    actorId,
    orgId,
  });
  if (!line) return;
  emitSecuritySensitiveAudit(line);
}

/**
 * `log.warn`, narrowed to this one payload shape.
 *
 * ⚠️ **The narrowing is what gives {@link AuditedValue} teeth, and calling
 * `log.warn` directly does not.** pino infers the first parameter's type from
 * whatever literal you hand it, so there is no target type to check against: no
 * excess-property check, and no branded-field check. Measured —
 * `log.warn({ ...line, value: raw }, …)` type-checks clean, while the same
 * object assigned into a `SecuritySensitiveAuditLine` position is `TS2322`. A
 * brand only bites where something is expected to have it. This alias creates
 * that expectation.
 */
const warnAuditLine: (line: SecuritySensitiveAuditLine, msg: string) => void = (line, msg) => {
  log.warn(line, msg);
};

/**
 * Write one built audit line to the log stream.
 *
 * ⚠️ Takes the payload and nothing else, deliberately, and emits through
 * {@link warnAuditLine} rather than `log.warn`. Both halves are load-bearing:
 * the parameter list keeps the raw value out of scope, and the typed alias
 * makes putting it back a compile error rather than a silent no-op.
 *
 * The message is built from `line`, never from the caller's arguments — a
 * template literal is a leak channel no type can close, so the only defence
 * there is that the raw value is not reachable from here. `settings-audit-log.
 * test.ts` asserts the message text and that it does not contain the value.
 */
function emitSecuritySensitiveAudit(line: SecuritySensitiveAuditLine): void {
  warnAuditLine(
    line,
    `Security-sensitive setting ${line.action === "clear" ? "override cleared" : "changed"} at runtime: ${line.key}`,
  );
}

/**
 * Apply runtime side effects after a setting value changes.
 * Only runs in SaaS mode for hot-reloadable settings.
 */
function applySettingSideEffect(key: string, value: string): void {
  if (!isSaasMode()) return;
  SETTING_SIDE_EFFECTS[key]?.(value);
}
