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
import { ANSWER_STYLE_NAMES } from "@atlas/api/lib/answer-styles";

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
    // #3341 — recipient allowlist for the agent's `sendEmail` tool.
    // Workspace members are always allowed; this adds extra domains.
    // Empty (the default) = workspace members only.
    key: "ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS",
    section: "Security",
    label: "Email Recipient Domains",
    description:
      "Comma-separated domains the agent's sendEmail tool may deliver to, in addition to workspace member addresses (e.g. example.com,partner.example). Empty = workspace members only.",
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
    // Options derive from the answer-style registry minus `conversational`:
    // that addendum is written for chat platforms (it references the Slack
    // "Show SQL" progressive-disclosure buttons), so it isn't offered as a
    // house voice for analyst-grade surfaces. No `default` on purpose — unset
    // means "track the surface default" (analyst), not a frozen copy of it.
    // Hot-reloadable: read per turn through the settings cache, no restart.
    key: "ATLAS_DEFAULT_ANSWER_STYLE",
    section: "Agent",
    label: "Default Answer Style",
    description:
      "Workspace default answer style (the house voice) for surfaces that don't explicitly choose one — web chat conversations without a per-conversation pick, and SDK/MCP/query API calls that send no style. A per-conversation pick always wins. Chat platforms (Slack mentions, proactive chat) choose their own voice per turn and are not affected. Reset to fall back to the built-in default (analyst).",
    type: "select",
    options: ANSWER_STYLE_NAMES.filter((s) => s !== "conversational"),
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
  // Scope split (#3392): the scheduler pair is PLATFORM-scoped — the expert
  // scheduler is a single process-global fiber forked once at boot
  // (`makeSchedulerLive` in lib/effect/layers.ts); there is no per-workspace
  // tick, so a workspace override would have nothing to apply to. Both are
  // consumed once at boot, hence `requiresRestart`. The auto-approve pair
  // below stays WORKSPACE-scoped: it is read per proposal in
  // `insertSemanticAmendment` (lib/db/internal.ts), which has the
  // amendment's orgId in scope.
  {
    key: "ATLAS_EXPERT_SCHEDULER_ENABLED",
    section: "Intelligence",
    label: "Expert Scheduler",
    description: "Enable periodic semantic layer analysis (runs the improvement engine automatically)",
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
    // #1978 — DpaGuardLive runs once at boot; without `requiresRestart`,
    // a hot-reload of this key via setSetting would silently bypass the
    // guard. Self-hosted admins see the "restart required" banner;
    // SaaS writes are additionally blocked by `SAAS_IMMUTABLE_KEYS`
    // below — a restart hint alone would still let a SaaS admin persist
    // a value the boot-time contract guard never re-evaluates. (Since
    // #3399 the SaaS metadata suppression no longer applies to
    // boot-consumed keys like this one, but the write block remains the
    // real guard.)
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
  // Nightly auto-promote/decay job (#3636). The enable + interval pair is a
  // single process-global fiber forked once at boot (makeSchedulerLive), so
  // they are PLATFORM-scoped + requiresRestart — mirrors the expert scheduler.
  // The gate knobs below are read once per tick (no orgId), hence platform too.
  {
    key: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
    section: "Dynamic Learning",
    label: "Auto-Promote / Decay Job",
    description:
      "Enable the nightly job that auto-promotes high-confidence, fast, frequently-seen learned patterns and demotes stale auto-promoted ones. Human approvals are never demoted; semantic amendments are never auto-promoted.",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
    requiresRestart: true,
    scope: "platform",
    saasVisible: false,
  },
  {
    key: "ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS",
    section: "Dynamic Learning",
    label: "Auto-Promote / Decay Interval",
    description: "Hours between nightly auto-promote/decay runs.",
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
      "Minimum times a pending pattern must have been seen before the nightly job will auto-promote it (alongside the confidence threshold and latency budget).",
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
  {
    key: "ATLAS_KNOWLEDGE_INGEST_MAX_DOCS",
    section: "Knowledge Base",
    label: "Ingest Max Documents",
    description:
      "Maximum number of documents a single knowledge bundle may ingest (default 1000; non-positive values fall back to the default).",
    type: "number",
    default: "1000",
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
      "Maximum raw upload size of a knowledge bundle (default 25000000 / 25 MB); also reused as the decoded-total cap that aborts a decompression bomb mid-inflate during extraction.",
    type: "number",
    default: "25000000",
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

const SETTINGS_MAP = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

/** @internal Reset cache — for testing only. */
export function _resetSettingsCache(): void {
  _cache = new Map();
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  // Apply runtime side effects for hot-reloadable settings
  applySettingSideEffect(key, value);

  log.info({ key, orgId: effectiveOrgId, actorId: userId }, "Setting override saved");
  // #3797 — louder audit trail when a runtime-mutable abuse control is changed
  // (especially disabled via the documented `0` sentinel), so weakening it is
  // traceable during an incident rather than buried in settings-change noise.
  auditSecuritySensitiveChange(key, "set", value, userId, effectiveOrgId);
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

  // Apply runtime side effects (e.g., revert log level to env var / default)
  const revertedValue = getSetting(key, effectiveOrgId);
  if (revertedValue !== undefined) {
    applySettingSideEffect(key, revertedValue);
  }

  log.info({ key, orgId: effectiveOrgId, actorId: userId }, "Setting override removed");
  // #3797 — clearing an abuse-control override reverts it to env/default,
  // which is itself a security-relevant change; audit it too.
  auditSecuritySensitiveChange(key, "clear", undefined, userId, effectiveOrgId);
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
        // 4-tier resolution for workspace-scoped settings
        const wsOverride = _cache.get(cacheKey(def.key, orgId));
        const platformOverride = _cache.get(cacheKey(def.key));
        const envVal = process.env[def.envVar];

        if (wsOverride) {
          currentValue = def.secret ? maskSecret(wsOverride.value) : wsOverride.value;
          source = "workspace-override";
        } else if (platformOverride) {
          currentValue = def.secret ? maskSecret(platformOverride.value) : platformOverride.value;
          source = "override";
        } else if (envVal !== undefined) {
          currentValue = def.secret ? maskSecret(envVal) : envVal;
          source = "env";
        } else {
          currentValue = def.default;
          source = "default";
        }
      } else {
        // Standard 3-tier for platform-scoped settings
        const override = _cache.get(cacheKey(def.key));
        const envVal = process.env[def.envVar];

        if (override) {
          currentValue = def.secret ? maskSecret(override.value) : override.value;
          source = "override";
        } else if (envVal !== undefined) {
          currentValue = def.secret ? maskSecret(envVal) : envVal;
          source = "env";
        } else {
          currentValue = def.default;
          source = "default";
        }
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

      return { ...def, requiresRestart, saasImmutable, currentValue, source };
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency
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
 * The `as const` is load-bearing: it preserves literal types so
 * `SaasImmutableKey` is a closed union and `SaasImmutableSettingError`
 * can refuse construction with an unknown key at compile time.
 */
const SAAS_IMMUTABLE_KEYS_LITERAL = [
  "ATLAS_EMAIL_PROVIDER",
  "ATLAS_DEPLOY_MODE",
  "ATLAS_RATE_LIMIT_RPM",
] as const;
const SAAS_IMMUTABLE_KEYS: ReadonlySet<SaasImmutableKey> = new Set(SAAS_IMMUTABLE_KEYS_LITERAL);

/** Closed union of keys that are immutable in SaaS mode. */
export type SaasImmutableKey = (typeof SAAS_IMMUTABLE_KEYS_LITERAL)[number];

/** Type-guard that narrows `string` → `SaasImmutableKey` at the throw site. */
function isSaasImmutableKey(key: string): key is SaasImmutableKey {
  return (SAAS_IMMUTABLE_KEYS as ReadonlySet<string>).has(key);
}

/**
 * Abuse-control thresholds that stay hot-reloadable by design (operators
 * tune them without a redeploy) but whose runtime mutation is
 * security-relevant (#3797). Unlike {@link SAAS_IMMUTABLE_KEYS}, these are
 * NOT write-blocked — the documented `0 = disabled` semantics and the
 * tune-without-restart contract are intentional. Instead, a write or clear
 * emits a distinct `log.warn` security-audit line (above the generic
 * "Setting override saved" info log) so weakening or disabling an abuse
 * control is traceable and alertable during an incident, not lost in the
 * settings-change noise. The per-IP / per-email start_trial limiters are the
 * subject of #3797; the sibling contact / demo attempt limiters share the
 * same shape and are reasonable future additions.
 */
export const SECURITY_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
  "ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM",
]);

/**
 * Pure audit decision for {@link auditSecuritySensitiveChange}: returns the
 * structured fields to log when `key` is a {@link SECURITY_SENSITIVE_KEYS}
 * abuse threshold, or `null` when it isn't (no audit). `disablesControl`
 * flags the `0`/non-finite disabled-sentinel for a `set` so an outright
 * disable is obvious in the log line and alertable. Exported for unit
 * testing the disable-detection without DB/logger plumbing.
 */
export function securitySensitiveAuditFields(
  key: string,
  action: "set" | "clear",
  value: string | undefined,
): { disablesControl: boolean } | null {
  if (!SECURITY_SENSITIVE_KEYS.has(key)) return null;
  const parsed = value === undefined ? undefined : Number(value);
  const disablesControl =
    action === "set" && (parsed === 0 || (parsed !== undefined && !Number.isFinite(parsed)));
  return { disablesControl };
}

/**
 * Emit a security-audit `log.warn` when a {@link SECURITY_SENSITIVE_KEYS}
 * abuse threshold is changed or cleared at runtime. `action` is `set` (a new
 * value persisted) or `clear` (override deleted → reverts to env/default).
 * A no-op for non-sensitive keys.
 */
function auditSecuritySensitiveChange(
  key: string,
  action: "set" | "clear",
  value: string | undefined,
  actorId: string | undefined,
  orgId: string | undefined,
): void {
  const fields = securitySensitiveAuditFields(key, action, value);
  if (!fields) return;
  log.warn(
    { key, action, value, disablesControl: fields.disablesControl, actorId, orgId, event: "security_setting.changed" },
    `Security-sensitive abuse control ${action === "clear" ? "override cleared" : "changed"} at runtime: ${key}`,
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
