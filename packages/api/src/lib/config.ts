/**
 * Declarative configuration for Atlas.
 *
 * Loads configuration from `atlas.config.ts` in the project root (if present),
 * falling back to environment variables for backward compatibility. The config
 * file is optional and additive — existing env-var-only deploys work without
 * changes.
 *
 * @example
 * ```typescript
 * // atlas.config.ts
 * import { defineConfig } from "@atlas/api/lib/config";
 *
 * export default defineConfig({
 *   datasources: {
 *     default: { url: process.env.ATLAS_DATASOURCE_URL! },
 *     warehouse: { url: "postgresql://...", schema: "analytics", description: "Data warehouse" },
 *   },
 *   tools: ["explore", "executeSQL"],
 *   auth: "auto",
 *   semanticLayer: "./semantic",
 * });
 * ```
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./logger";
import type { ConnectionRegistry } from "./db/connection";
import type { ToolRegistry } from "./tools/registry";
import { ACTION_APPROVAL_MODES, type ActionApprovalMode } from "@atlas/api/lib/action-types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";
import {
  IMPLEMENTATION_STATUSES,
  type ImplementationStatus,
} from "@useatlas/types";
import {
  DEFAULT_AUTO_PROMOTE_CLICKS,
  DEFAULT_COLD_WINDOW_DAYS,
} from "@atlas/api/lib/suggestions/approval-service";

// ---------------------------------------------------------------------------
// Sandbox backend names (used in config validation and explore backend selection)
// ---------------------------------------------------------------------------

/**
 * Backend names operators can use in `sandbox.priority`.
 * Plugin backends are always tried first and are not included here.
 */
const SANDBOX_BACKEND_NAMES = ["vercel-sandbox", "nsjail", "sidecar", "just-bash"] as const;
export type SandboxBackendName = (typeof SANDBOX_BACKEND_NAMES)[number];

const log = createLogger("config");

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const RateLimitConfigSchema = z.object({
  /** Max queries per minute for this datasource. */
  queriesPerMinute: z.number().int().positive().default(60),
  /** Max concurrent queries for this datasource. */
  concurrency: z.number().int().positive().default(5),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

const DatasourceConfigSchema = z.object({
  /** Database connection string (postgresql:// or mysql:// for core; other schemes via plugins). */
  url: z.string().min(1, "Datasource URL must not be empty"),
  /** PostgreSQL schema name (sets search_path). Ignored for MySQL and plugin-managed connections. */
  schema: z.string().optional(),
  /** Human-readable description shown in the agent system prompt. */
  description: z.string().optional(),
  /** Max connections in the pool for this datasource. */
  maxConnections: z.number().int().positive().optional(),
  /** Idle timeout in milliseconds before a connection is closed. */
  idleTimeoutMs: z.number().int().positive().optional(),
  /** Per-source rate limiting configuration. */
  rateLimit: RateLimitConfigSchema.optional(),
});

export type DatasourceConfig = z.infer<typeof DatasourceConfigSchema>;

const AuthConfigSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("api-key"),
  z.literal("managed"),
  z.literal("byot"),
]);

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

const ActionApprovalSchema = z.enum(ACTION_APPROVAL_MODES);

const ActionDefaultsSchema = z.object({
  approval: ActionApprovalSchema.optional(),
  timeout: z.number().int().positive().optional(),
  maxPerConversation: z.number().int().positive().optional(),
});

export type ActionDefaults = z.infer<typeof ActionDefaultsSchema>;

const AtlasRoleSchema = z.enum(ATLAS_ROLES);

const PerActionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  approval: ActionApprovalSchema.optional(),
  /** Minimum role required to approve this action. Overrides the approval mode's default role mapping. */
  requiredRole: AtlasRoleSchema.optional(),
  /** Execution timeout in milliseconds. Overrides the global defaults.timeout. */
  timeout: z.number().int().positive().optional(),
  credentials: z.record(z.string(), z.object({ env: z.string() })).optional(),
  rateLimit: z.number().int().positive().optional(),
}).passthrough();

export type PerActionConfig = z.infer<typeof PerActionConfigSchema>;

const ActionsConfigSchema = z.object({
  defaults: ActionDefaultsSchema.optional(),
}).catchall(PerActionConfigSchema);

export type ActionsConfig = z.infer<typeof ActionsConfigSchema>;

const RLSConditionSchema = z.object({
  /** Column name to filter on. Must be a valid SQL identifier. */
  column: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Must be a valid column name"),
  /** Claim path to extract the filter value from the user's claims. Supports dot-delimited paths. */
  claim: z.string().min(1),
});

export type RLSCondition = z.infer<typeof RLSConditionSchema>;

const RLSPolicySchema = z.object({
  /** Tables this policy applies to. Use ["*"] for all tables. */
  tables: z.array(z.string().min(1)).min(1),
  /** Column name to filter on (single-condition shorthand). */
  column: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Must be a valid column name").optional(),
  /** Claim path (single-condition shorthand). */
  claim: z.string().min(1).optional(),
  /** Multiple column/claim conditions — ANDed together within this policy. */
  conditions: z.array(RLSConditionSchema).min(1).optional(),
}).refine(
  (p) => {
    const hasSingle = p.column !== undefined || p.claim !== undefined;
    const hasConditions = p.conditions !== undefined;
    if (hasSingle && hasConditions) return false;
    if (!hasSingle && !hasConditions) return false;
    if (hasSingle && (p.column === undefined || p.claim === undefined)) return false;
    return true;
  },
  { message: "Each policy must specify either { column, claim } or { conditions: [...] }, not both" },
);

export type RLSPolicy = z.infer<typeof RLSPolicySchema>;

const RLSConfigSchema = z.object({
  /** Whether RLS is active. When true, policies are enforced on every query. */
  enabled: z.boolean().default(false),
  /** RLS policies. Each policy maps a claim to a column on one or more tables. */
  policies: z.array(RLSPolicySchema).default([]),
  /** How to combine conditions from different policies. "and" (default) requires all policies to match. "or" requires at least one policy to match. */
  combineWith: z.enum(["and", "or"]).default("and"),
}).refine(
  (cfg) => !cfg.enabled || cfg.policies.length > 0,
  { message: "RLS is enabled but no policies are defined", path: ["policies"] },
);

export type RLSConfig = z.infer<typeof RLSConfigSchema>;

const SandboxConfigSchema = z.object({
  /**
   * Ordered list of explore backends to try. The first available backend is
   * used. Plugin backends are always tried first (not listed here).
   *
   * Valid values: "vercel-sandbox", "nsjail", "sidecar", "just-bash".
   *
   * @example ["sidecar", "nsjail", "just-bash"]
   */
  priority: z.array(z.enum(SANDBOX_BACKEND_NAMES)).min(1)
    .refine(
      (arr) => new Set(arr).size === arr.length,
      { message: "sandbox.priority must not contain duplicate backend names" },
    )
    .optional(),

  /**
   * Vercel Sandbox account identity for off-Vercel deploys (e.g. Railway).
   * The team and project IDs are NOT secret (only `VERCEL_TOKEN` is) and are
   * constant across regions, so they belong in config rather than stamped as
   * `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` on every regional service (#3706).
   * The env vars still override when set, so self-hosted operators can point a
   * deploy at their own Vercel account without editing config. The token stays
   * in env on every path. On the Vercel platform these are unused (OIDC auth).
   */
  vercel: z.object({
    teamId: z.string().min(1),
    projectId: z.string().min(1),
  }).optional(),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/** Modules that can never be unblocked via `allowModules`. */
const PYTHON_CRITICAL_MODULES = ["os", "subprocess", "sys", "shutil"];

const PythonConfigSchema = z.object({
  /** Additional modules to block (added to the default blocked list). */
  blockedModules: z.array(z.string().min(1, "Module name must not be empty")).default([]),
  /** Modules to remove from the default blocked list. Critical modules (os, subprocess, sys, shutil) cannot be unblocked. */
  allowModules: z.array(z.string().min(1, "Module name must not be empty")).default([]),
}).refine(
  (cfg) => !cfg.allowModules.some((m: string) => PYTHON_CRITICAL_MODULES.includes(m)),
  {
    message: `Cannot unblock critical Python modules (${PYTHON_CRITICAL_MODULES.join(", ")}). These are blocked regardless of configuration.`,
    path: ["allowModules"],
  },
);

export type PythonConfig = z.infer<typeof PythonConfigSchema>;

/**
 * Default per-org pool `maxConnections` — the value the schema fills when
 * a `pool.perOrg` block is present but omits `maxConnections`. Held in
 * lockstep with `DEFAULT_ORG_POOL_SETTINGS.maxConnections` in
 * `db/connection.ts` (the runtime registry default used when no
 * `pool.perOrg` is configured at all) so the schema-resolved default and
 * the registry default can't drift — they previously split 10 vs 5, which
 * made an intentional `5` config trip a phantom "below floor" alarm (#2943).
 *
 * A connection is borrowed per in-flight SQL statement and released
 * immediately (chat turns hold zero during LLM thinking; dashboard refresh
 * is sequential), so 5 simultaneous statements per org is ample for
 * conversational load. Raise it (per tier) only once pool-wait latency
 * actually shows up in metrics. See `deploy.mdx#pool-default-warning`.
 */
const DEFAULT_ORG_POOL_MAX_CONNECTIONS = 5;

/**
 * Per-org pool sizing defaults, sized for conversational load. Production
 * SaaS regions can configure higher limits via `atlas.config.ts` if
 * pool-wait latency appears; `_warnPoolDefaultsInSaaS()` only flags the
 * genuine mistake of omitting `pool.perOrg` entirely (isolation off).
 */
const OrgPoolConfigSchema = z.object({
  /** Max connections per pool per org. */
  maxConnections: z.number().int().positive().default(DEFAULT_ORG_POOL_MAX_CONNECTIONS),
  /** Idle timeout in ms for per-org pool connections. Default 30000. */
  idleTimeoutMs: z.number().int().positive().default(30000),
  /** Max org pool sets before LRU eviction. Default 50. */
  maxOrgs: z.number().int().positive().default(50),
  /** Warmup probes when an org pool is first created. Default 2. */
  warmupProbes: z.number().int().nonnegative().default(2),
  /** Consecutive query errors before auto-drain of an org pool. Default 5. */
  drainThreshold: z.number().int().positive().default(5),
});

export type OrgPoolConfigInput = z.input<typeof OrgPoolConfigSchema>;

const PoolConfigSchema = z.object({
  /** Per-org pool isolation settings. When configured, each org gets its own
   *  connection pool for noisy-neighbor isolation in SaaS mode. */
  perOrg: OrgPoolConfigSchema.optional(),
});

const RegionConfigSchema = z.object({
  /** Human-readable region label for the admin console. */
  label: z.string().min(1),
  /**
   * Database URL for the region's internal database.
   *
   * Intentionally **not** `.min(1)` (#3176): the SaaS deploy config
   * (`deploy/api/atlas.config.ts`) declares all regions in one map and reads
   * each `databaseUrl` from a region-specific env var, but a given api service
   * only sets the env var for the region it claims (`ATLAS_API_REGION`). The
   * other regions' vars resolve to `""`/`undefined` (the Railway shared-scope
   * hazard), and a fleet-wide `.min(1)` parse here would abort boot on every
   * service for one unset non-claimed region. The hard `postgres://`
   * well-formedness check is scoped to the **claimed** region by
   * `RegionGuardLive` (`lib/effect/saas-guards.ts`), which already validates
   * per-claim — so an empty/malformed *claimed* URL still fails boot, while an
   * empty/unset *non-claimed* URL no longer takes down the fleet.
   */
  databaseUrl: z.string().optional(),
  /** Optional datasource URL override for analytics in this region. */
  datasourceUrl: z.string().min(1).optional(),
  /** Public API endpoint for this region (e.g. "https://api-eu.useatlas.dev"). */
  apiUrl: z.string().url().optional(),
});

export type RegionConfigInput = z.input<typeof RegionConfigSchema>;

const ResidencyConfigSchema = z.object({
  /** Available regions and their database configuration. Keys are region identifiers (e.g. "eu-west"). */
  regions: z.record(z.string().min(1), RegionConfigSchema).refine(
    (r) => Object.keys(r).length > 0,
    { message: "At least one region must be configured when residency is enabled" },
  ),
  /** Default region for new workspaces. Must be a key in the regions map. */
  defaultRegion: z.string().min(1),
  /** When true, misrouted requests receive 421 Misdirected Request instead of a warning log. */
  strictRouting: z.boolean().default(false),
}).refine(
  (cfg) => cfg.defaultRegion in cfg.regions,
  { message: "defaultRegion must be one of the configured regions", path: ["defaultRegion"] },
);

export type ResidencyConfig = z.infer<typeof ResidencyConfigSchema>;

// ---------------------------------------------------------------------------
// Catalog declaration (1.5.2 slice 2 — issue #2650)
// ---------------------------------------------------------------------------

/**
 * Catalog vocabulary (`install_model`, `type`) is hoisted to
 * `@useatlas/types` (#2665) so `@useatlas/chat` can share the literal
 * unions without taking a hard `@atlas/api` dep. JSDoc on each member
 * lives in `packages/types/src/catalog.ts`. The re-exports here keep
 * the long-standing call sites (`from "@atlas/api/lib/config"`) working
 * without churn.
 */
import {
  CATALOG_INSTALL_MODELS,
  CATALOG_ENTRY_TYPES,
} from "@useatlas/types";
export {
  CATALOG_INSTALL_MODELS,
  CATALOG_ENTRY_TYPES,
};
export type {
  CatalogInstallModel,
  CatalogEntryType,
} from "@useatlas/types";

/**
 * Plan tiers a catalog entry can require. Unified with `PLAN_TIERS`
 * from `@useatlas/types` (#2666) so catalog `min_plan` and workspace
 * `plan_tier` share one vocabulary — the comparator in
 * `lib/integrations/install/plan-rank.ts` ranks both sides off the
 * same table. Pre-#2666 catalog rows still carrying `team` /
 * `enterprise` are normalized to `business` by migration 0090.
 */
const CATALOG_MIN_PLANS = ["free", "trial", "starter", "pro", "business"] as const;

const CatalogEntrySchema = z.object({
  /**
   * Stable identifier (e.g. `"slack"`, `"salesforce"`, `"linear-apikey"`).
   * Used as the primary lookup key in `plugin_catalog.slug` and as the
   * dispatch key in `AdapterRegistry`. Lowercase letters, digits, and
   * dashes only — matches the Platform's canonical short name.
   */
  slug: z.string().regex(
    /^[a-z][a-z0-9-]*$/,
    "catalog entry slug must be lowercase alphanumeric with dashes (e.g. 'slack', 'linear-apikey')",
  ),
  /** Admin-UI grouping (chat Platforms vs integration plugins). */
  type: z.enum(CATALOG_ENTRY_TYPES),
  /** Install-handler dispatch key — see {@link CATALOG_INSTALL_MODELS}. */
  install_model: z.enum(CATALOG_INSTALL_MODELS),
  /** Optional human-readable name; defaults to slug-derived if omitted. */
  name: z.string().min(1).optional(),
  /** Optional admin-UI description copy. */
  description: z.string().min(1).optional(),
  /** Optional icon URL for admin-UI cards. */
  iconUrl: z.string().url().optional(),
  /** Plan-tier gate evaluated at customer-install time. Defaults to `starter`. */
  min_plan: z.enum(CATALOG_MIN_PLANS).optional().default("starter"),
  /**
   * Whether customers can install this entry today. Operators flip to
   * `false` (in DB) for emergency-disable without a deploy; the seed
   * preserves a DB-side `false` even if the config declares `true`.
   * Defaults to `true`.
   */
  enabled: z.boolean().optional().default(true),
  /**
   * Whether the entry is offered in SaaS deployments. `false` hides the
   * row from SaaS admin-UI listings while keeping it available on self-
   * host. The canonical case is GitHub PAT mode (per-user token tied to
   * one employee — unsafe in B2B SaaS). Defaults to `true`.
   */
  saas_eligible: z.boolean().optional().default(true),
  /**
   * Whether Atlas has shipped a working install handler for this entry
   * (#2747 / ADR-0007). `coming_soon` renders the row inert in the
   * admin UI — grey "Coming soon" badge, no CTA — regardless of plan
   * tier or install presence. The state-machine in
   * `lib/integrations/install-status-machine.ts` treats this as the
   * highest-priority gate.
   *
   * Defaults to `available` to preserve the pre-#2747 wire shape (every
   * declared entry was implicitly shippable). Mark a row `coming_soon`
   * when the catalog entry exists for visibility but the install path
   * (handler, env vars, OAuth app, manifest) isn't ready — Teams,
   * Discord, gchat, Telegram, WhatsApp in the 1.5.3 placeholder set.
   *
   * Self-host operators who've shipped their own handler for a row
   * Atlas marks `coming_soon` can promote it via
   * {@link AtlasConfig.overrideImplementationStatus} without forking
   * the catalog.
   */
  implementation_status: z.enum(IMPLEMENTATION_STATUSES).optional().default("available"),
  /**
   * Form-field declaration for `install_model: "form"` entries (#2660 —
   * Email, Webhook, Obsidian). Each entry describes a field rendered by
   * `/admin/integrations`' install modal and validated server-side at
   * `POST /api/v1/integrations/:slug/install-form`. Fields flagged
   * `secret: true` flow through `plugins/secrets.ts::encryptSecretFields`
   * before persistence so credential material lands encrypted in
   * `workspace_plugins.config` JSONB.
   *
   * Persisted into `plugin_catalog.config_schema` (JSONB) by the catalog
   * seeder, then echoed back to the admin UI on the `/catalog` read so
   * the modal renders the right inputs without a deploy-specific build
   * artifact. The shape mirrors `ConfigSchemaField` from
   * `lib/plugins/registry.ts` — kept structurally identical to avoid an
   * import cycle (the schema layer can't pull from the plugins layer).
   *
   * Optional even for `install_model: "form"` so OAuth / static-bot
   * entries don't need a placeholder. Form-based entries without a
   * declared schema are rejected at the install route with a 400 — the
   * route can't validate user input without one.
   */
  configSchema: z.array(
    z.object({
      key: z.string().min(1),
      type: z.enum(["string", "number", "boolean", "select"]),
      label: z.string().optional(),
      description: z.string().optional(),
      required: z.boolean().optional(),
      secret: z.boolean().optional(),
      options: z.array(z.string()).optional(),
      default: z.unknown().optional(),
    }).strict(),
  ).optional(),
}).strict().refine(
  // Form-based entries are useless without a field list — the install
  // route validates submitted form data against the declared
  // `configSchema`. A missing/empty schema would accept any payload at
  // install time. Reject at config-load so the misconfig surfaces in
  // the Zod parse, not at the first install attempt. OAuth entries don't
  // carry a schema. The form-shaped static-bots (Telegram / Teams /
  // Google Chat / WhatsApp) DO carry one — the #3140 routing-identifier
  // modal renders it and the install route resolves the routing field
  // from it — but the requirement is enforced per-platform at install
  // time (a missing routing field is a 501), so `configSchema` stays
  // optional in this schema for them rather than required here.
  (entry) => entry.install_model !== "form" || (Array.isArray(entry.configSchema) && entry.configSchema.length > 0),
  {
    message: "configSchema is required (and non-empty) for catalog entries with install_model='form'",
    path: ["configSchema"],
  },
);

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
/** Input shape (defaults not yet applied) — what `atlas.config.ts` authors. */
export type CatalogEntryInput = z.input<typeof CatalogEntrySchema>;

export { CatalogEntrySchema };

const AtlasConfigSchema = z.object({
  /**
   * Named datasource connections. The "default" key is used when no
   * connectionId is specified. At least one datasource should be defined.
   */
  datasources: z.record(z.string(), DatasourceConfigSchema).optional(),

  /**
   * Tool names to enable. When omitted, defaults to the two core tools
   * (explore, executeSQL).
   */
  tools: z.array(z.string()).optional(),

  /**
   * Auth mode. "auto" (default) auto-detects from env vars — same as the
   * current behavior. Other values pin the mode explicitly.
   */
  auth: AuthConfigSchema.optional().default("auto"),

  /**
   * Path to the semantic layer directory, relative to the project root.
   * Defaults to "./semantic".
   */
  semanticLayer: z.string().optional().default("./semantic"),

  /**
   * Action framework configuration. Per-action overrides use the action
   * type as the key (e.g. `"slack:send"`). The special `defaults` key
   * sets fallback values for all actions.
   */
  actions: ActionsConfigSchema.optional(),

  /**
   * Maximum total pool slots across all datasource pools.
   * When a new datasource registration would exceed this limit,
   * the least-recently-used datasource is evicted.
   */
  maxTotalConnections: z.number().int().positive().default(100),

  /**
   * Plugin instances to register at boot. Each element should satisfy
   * the `AtlasPlugin` interface from `@useatlas/plugin-sdk`.
   *
   * Zod validates structural shape (id, type, version) at config load
   * time. Plugin-level configSchema validation happens at factory call
   * time via `createPlugin()`.
   */
  plugins: z.array(z.unknown()).optional(),

  /**
   * Scheduler configuration for recurring scheduled tasks.
   * Requires ATLAS_SCHEDULER_ENABLED=true to activate.
   */
  scheduler: z.object({
    /** Execution backend: "bun" runs an in-process tick loop, "webhook" relies on external cron hitting POST /:id/run, "vercel" uses Vercel Cron hitting POST /tick. */
    backend: z.enum(["bun", "webhook", "vercel"]).default("bun"),
    /** Maximum concurrent task executions per tick. */
    maxConcurrentTasks: z.number().int().positive().default(5),
    /** Per-task execution timeout in milliseconds. */
    taskTimeout: z.number().int().positive().default(60_000),
    /** Tick interval in seconds (how often the scheduler checks for due tasks). */
    tickIntervalSeconds: z.number().int().positive().default(60),
  }).optional(),

  /**
   * Row-Level Security configuration. When enabled, every SQL query gets
   * automatic WHERE clause injection based on the authenticated user's claims.
   */
  rls: RLSConfigSchema.optional(),

  /**
   * Sandbox / explore backend configuration. Override the default backend
   * selection priority for the explore tool.
   */
  sandbox: SandboxConfigSchema.optional(),

  /**
   * Python tool import guard configuration. Customize which modules are
   * blocked or allowed in the defense-in-depth import checker.
   */
  python: PythonConfigSchema.optional(),

  /**
   * Session timeout configuration. Idle timeout invalidates sessions that
   * haven't been used within the specified duration. Absolute timeout
   * invalidates sessions after a fixed duration regardless of activity.
   * Values are in seconds. 0 means disabled.
   */
  session: z.object({
    /** Seconds of inactivity before a session is invalidated. 0 = disabled. */
    idleTimeout: z.number().int().nonnegative().default(0),
    /** Maximum session lifetime in seconds from creation. 0 = disabled. */
    absoluteTimeout: z.number().int().nonnegative().default(0),
  }).optional(),

  /**
   * Semantic index configuration. When enabled (default), a pre-computed
   * summary of the semantic layer is injected into the agent system prompt
   * to reduce explore tool calls.
   */
  semanticIndex: z.object({
    /** Whether the semantic index is enabled. Default: true. */
    enabled: z.boolean().default(true),
  }).optional(),

  /**
   * Connection pool configuration. The `perOrg` sub-key enables tenant-scoped
   * pooling in SaaS mode — each org gets isolated pool instances to prevent
   * noisy-neighbor issues.
   */
  pool: PoolConfigSchema.optional(),

  /**
   * Query result cache configuration. When enabled (default), identical
   * queries return cached results within the TTL. Cache keys include
   * orgId for tenant isolation.
   */
  cache: z.object({
    /** Whether query caching is enabled. Default: true. */
    enabled: z.boolean().default(true),
    /** Time-to-live in milliseconds. Default: 300000 (5 minutes). */
    ttl: z.number().int().positive().default(300_000),
    /** Maximum number of cached entries. Default: 1000. */
    maxSize: z.number().int().positive().default(1000),
  }).optional(),

  /**
   * Adaptive starter prompt configuration. Controls the empty-chat grid
   * served by the resolver behind `GET /api/v1/starter-prompts`.
   */
  starterPrompts: z.object({
    /**
     * Cold-start window (days) applied to `prompt_collections.created_at`
     * when the resolver pulls the library tier. Also bounds the approval
     * queue for learned-popular prompts — only suggestions with a recent
     * `last_seen_at` are eligible for auto-promotion.
     */
    coldWindowDays: z.number().int().positive().default(DEFAULT_COLD_WINDOW_DAYS),
    /**
     * Distinct-user click threshold that auto-promotes a learned suggestion
     * into the admin approval queue. Clicks are counted once per user
     * within the cold window.
     */
    autoPromoteClicks: z.number().int().positive().default(DEFAULT_AUTO_PROMOTE_CLICKS),
    /**
     * Hard cap on per-user pinned starter prompts. Attempting to pin past
     * this cap returns a user-visible error. Default: 10.
     */
    maxFavorites: z.number().int().positive().default(10),
  }).optional(),

  /**
   * Enterprise feature gating. When enabled, enterprise-only features
   * in `/ee` are unlocked at runtime. A license key is required for
   * production use. AGPL core is completely unaffected when this is
   * absent or disabled.
   */
  enterprise: z.object({
    /** Whether enterprise features are enabled. Default: false. */
    enabled: z.boolean().default(false),
    /** License key for enterprise features. */
    licenseKey: z.string().min(1).optional(),
  }).optional(),

  /**
   * Deploy mode. "saas" enables hosted product features (enterprise-gated),
   * "self-hosted" disables them, "auto" (default) detects from environment.
   * The resolved binary value is exposed as `deployMode` on ResolvedConfig.
   */
  deployMode: z.enum(["auto", "saas", "self-hosted"]).optional().default("auto"),

  /**
   * Data residency configuration. When configured, workspaces are assigned
   * to geographic regions and connections route to region-specific databases.
   * Requires enterprise features to be enabled.
   */
  residency: ResidencyConfigSchema.optional(),

  /**
   * Plugin Catalog declaration — flat list of installable chat Platforms
   * and integration plugins. Implements ADR-0002 S3: declarative at deploy
   * time, idempotently seeded into `plugin_catalog` at boot, then DB-
   * canonical for runtime reads. Operator declares; customer admin
   * installs via the admin UI (slice 3 — #2651).
   *
   * `type` groups for admin-UI display; `install_model` dispatches the
   * install-handler family. Slugs must be unique within the array.
   *
   * @see docs/adr/0002-catalog-seeded-from-config-at-boot.md
   */
  catalog: z.array(CatalogEntrySchema).optional().refine(
    (entries) => {
      if (!entries) return true;
      const slugs = new Set<string>();
      for (const entry of entries) {
        if (slugs.has(entry.slug)) return false;
        slugs.add(entry.slug);
      }
      return true;
    },
    "catalog entries must have unique slugs — duplicate found",
  ),

  /**
   * Per-deploy override for a catalog row's `implementation_status`.
   * Map from catalog slug → `"available" | "coming_soon"`. Per ADR-0007
   * (1.5.3 #2743), this hook lets a self-host operator who's shipped
   * their own install handler for a row Atlas marks `coming_soon`
   * promote it to `available` without forking the catalog.
   *
   * **Inert in slice 5 (#2743)** — the read path is wired through
   * `getCatalogImplementationStatus()` but no UI consumer renders the
   * override yet. Slice 9 (#2747) consumes it to flip a card's CTA
   * from inert to active.
   */
  overrideImplementationStatus: z
    .record(z.string(), z.enum(IMPLEMENTATION_STATUSES))
    .optional(),
});

/** The output type after Zod parsing (defaults applied, all fields present). */
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

/** The input type for user-authored config (optional fields allowed). */
export type AtlasConfigInput = z.input<typeof AtlasConfigSchema>;

/** Expose schemas and formatter for external validation (e.g. tests, CLI). */
export { AtlasConfigSchema, RateLimitConfigSchema, RLSConditionSchema, RLSPolicySchema, RLSConfigSchema, SandboxConfigSchema, PythonConfigSchema, PoolConfigSchema, OrgPoolConfigSchema, ResidencyConfigSchema };

/**
 * The resolved config after merging the config file with env var defaults.
 * Guaranteed to have all fields populated.
 */
export interface ResolvedConfig {
  datasources: Record<string, DatasourceConfig>;
  tools: string[];
  auth: AuthConfig;
  semanticLayer: string;
  /** Action framework configuration (optional, only when actions are enabled). */
  actions?: ActionsConfig;
  /** Maximum total pool slots across all datasource pools. */
  maxTotalConnections: number;
  /** Plugin instances to register at boot. */
  plugins?: unknown[];
  /** Scheduler configuration (only when ATLAS_SCHEDULER_ENABLED=true). */
  scheduler?: {
    backend: "bun" | "webhook" | "vercel";
    maxConcurrentTasks: number;
    taskTimeout: number;
    tickIntervalSeconds: number;
  };
  /** Row-Level Security configuration. */
  rls?: RLSConfig;
  /** Sandbox / explore backend configuration. */
  sandbox?: SandboxConfig;
  /** Python tool import guard overrides. */
  python?: PythonConfig;
  /** Session timeout configuration. */
  session?: { idleTimeout: number; absoluteTimeout: number };
  /** Semantic index configuration. */
  semanticIndex?: { enabled: boolean };
  /** Connection pool configuration for tenant-scoped pooling. */
  pool?: { perOrg?: { maxConnections: number; idleTimeoutMs: number; maxOrgs: number; warmupProbes: number; drainThreshold: number } };
  /** Query result cache configuration. */
  cache?: { enabled: boolean; ttl: number; maxSize: number };
  /** Adaptive starter prompt configuration. */
  starterPrompts?: { coldWindowDays: number; autoPromoteClicks: number; maxFavorites: number };
  /** Enterprise feature gating. */
  enterprise?: { enabled: boolean; licenseKey?: string };
  /** Data residency configuration for region-based routing. */
  residency?: ResidencyConfig;
  /** Resolved deploy mode — binary "saas" or "self-hosted" (auto is resolved at boot). */
  deployMode?: "saas" | "self-hosted";
  /**
   * Set when `atlas.config.ts` requested `deployMode: "saas"` but enterprise
   * was not enabled, so `resolveDeployMode` silently downgraded to
   * `self-hosted` (the config-file path — the env-var path fails boot via
   * `EnterpriseGuardLive` instead). The env-path downgrade is loud; this
   * config-file path otherwise only emits a CRITICAL log. Threaded here so
   * `/health` can surface a `degraded` flag + reason beyond the log line
   * (#3184). Absent on a normal boot.
   */
  deployModeDowngraded?: { reason: string };
  /**
   * Plugin Catalog declaration — flat list of installable chat Platforms
   * and integration plugins. Seeded into `plugin_catalog` at boot via
   * `CatalogSeeder` (1.5.2 — #2650). Optional on `ResolvedConfig`
   * (omitted when the operator declared no catalog) to match the
   * conditional-spread pattern other optional fields use here; consumers
   * should default to `[]` via `config.catalog ?? []`.
   */
  catalog?: CatalogEntry[];
  /**
   * Per-deploy override for a catalog row's `implementation_status`.
   * Map from catalog slug → `"available" | "coming_soon"`. Read via
   * {@link getCatalogImplementationStatus} (1.5.3 #2743). Inert until
   * slice 9 (#2747) wires a UI consumer.
   */
  overrideImplementationStatus?: Record<string, ImplementationStatus>;
  /** Whether the config was loaded from a file or synthesized from env vars. */
  source: "file" | "env";
}

// ---------------------------------------------------------------------------
// defineConfig() — type-safe authoring helper
// ---------------------------------------------------------------------------

/**
 * Type-safe helper for authoring `atlas.config.ts`. Validates the config
 * at build time via TypeScript and at runtime via Zod.
 *
 * Accepts the input shape (optional fields allowed). Zod applies defaults
 * during `loadConfig()`.
 */
export function defineConfig(config: AtlasConfigInput): AtlasConfigInput {
  return config;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Resolved config singleton — populated by {@link loadConfig}.
 * Starts as null; after `loadConfig()` runs, this is always set.
 */
let _resolved: ResolvedConfig | null = null;

/**
 * Return the current resolved config, or null if {@link loadConfig} has
 * not been called yet.
 */
export function getConfig(): ResolvedConfig | null {
  return _resolved;
}

/**
 * Read the per-deploy operator override for a catalog row's
 * `implementation_status`. Returns the override when set, otherwise
 * `undefined` — callers fall back to the catalog row's stored value.
 *
 * Per ADR-0007 / 1.5.3 slice 5 (#2743): wired but inert. No UI consumer
 * renders the override yet — slice 9 (#2747) is the first reader.
 *
 * @param slug catalog slug (e.g. `"discord"`, `"postgres"`)
 * @param config optional injected config (defaults to {@link getConfig})
 */
export function getCatalogImplementationStatus(
  slug: string,
  config: ResolvedConfig | null = getConfig(),
): ImplementationStatus | undefined {
  return config?.overrideImplementationStatus?.[slug];
}

/**
 * Build a ResolvedConfig from environment variables alone.
 * This is the fallback path when no `atlas.config.ts` exists.
 */
export function configFromEnv(): ResolvedConfig {
  const datasources: Record<string, DatasourceConfig> = {};

  if (process.env.ATLAS_DATASOURCE_URL) {
    datasources.default = {
      url: process.env.ATLAS_DATASOURCE_URL,
      ...(process.env.ATLAS_SCHEMA ? { schema: process.env.ATLAS_SCHEMA } : {}),
    };
  }

  // Action framework config from env vars
  let actions: ActionsConfig | undefined;
  if (process.env.ATLAS_ACTIONS_ENABLED === "true") {
    const defaults: ActionDefaults = {};
    const approval = process.env.ATLAS_ACTION_APPROVAL;
    if (approval) {
      if ((ACTION_APPROVAL_MODES as readonly string[]).includes(approval)) {
        defaults.approval = approval as ActionApprovalMode;
      } else {
        log.warn({ value: approval, valid: ACTION_APPROVAL_MODES }, "Invalid ATLAS_ACTION_APPROVAL — using default 'manual'");
      }
    }
    const timeout = parseInt(process.env.ATLAS_ACTION_TIMEOUT ?? "", 10);
    if (Number.isFinite(timeout) && timeout > 0) {
      defaults.timeout = timeout;
    }
    const maxPerConv = parseInt(process.env.ATLAS_ACTION_MAX_PER_CONVERSATION ?? "", 10);
    if (Number.isFinite(maxPerConv) && maxPerConv > 0) {
      defaults.maxPerConversation = maxPerConv;
    }
    actions = { defaults };
  }

  // Scheduler config from env vars
  let scheduler: ResolvedConfig["scheduler"];
  if (process.env.ATLAS_SCHEDULER_ENABLED === "true") {
    const rawBackend = process.env.ATLAS_SCHEDULER_BACKEND;
    const backend = rawBackend === "webhook" ? "webhook" as const : rawBackend === "vercel" ? "vercel" as const : "bun" as const;
    const maxConcurrent = parseInt(process.env.ATLAS_SCHEDULER_MAX_CONCURRENT ?? "", 10);
    const timeout = parseInt(process.env.ATLAS_SCHEDULER_TIMEOUT ?? "", 10);
    const tick = parseInt(process.env.ATLAS_SCHEDULER_TICK_INTERVAL ?? "", 10);
    scheduler = {
      backend,
      maxConcurrentTasks: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 5,
      taskTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
      tickIntervalSeconds: Number.isFinite(tick) && tick > 0 ? tick : 60,
    };
  }

  // RLS config from env vars (single-policy shorthand)
  let rls: RLSConfig | undefined;
  if (process.env.ATLAS_RLS_ENABLED === "true") {
    const column = process.env.ATLAS_RLS_COLUMN;
    const claim = process.env.ATLAS_RLS_CLAIM;
    if (!column || !claim) {
      throw new Error(
        `ATLAS_RLS_ENABLED=true requires both ATLAS_RLS_COLUMN and ATLAS_RLS_CLAIM to be set. ` +
        `Got: ATLAS_RLS_COLUMN=${column ?? "(unset)"}, ATLAS_RLS_CLAIM=${claim ?? "(unset)"}`,
      );
    }
    const rlsParseResult = RLSConfigSchema.safeParse({
      enabled: true,
      policies: [{ tables: ["*"], column, claim }],
      combineWith: "and",
    });
    if (!rlsParseResult.success) {
      throw new Error(
        `Invalid RLS environment variable configuration: ${rlsParseResult.error.issues.map((i) => i.message).join("; ")}. ` +
        `Check ATLAS_RLS_COLUMN (must be a valid SQL identifier) and ATLAS_RLS_CLAIM.`,
      );
    }
    rls = rlsParseResult.data;
  }

  // Sandbox priority from env var (comma-separated backend names)
  let sandbox: SandboxConfig | undefined;
  const rawPriority = process.env.ATLAS_SANDBOX_PRIORITY;
  if (rawPriority) {
    const names = rawPriority.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new Error(
        `ATLAS_SANDBOX_PRIORITY is set but empty after parsing. ` +
        `Expected comma-separated backend names: ${SANDBOX_BACKEND_NAMES.join(", ")}`,
      );
    }
    const parseResult = SandboxConfigSchema.safeParse({ priority: names });
    if (!parseResult.success) {
      throw new Error(
        `Invalid ATLAS_SANDBOX_PRIORITY: ${parseResult.error.issues.map((i) => i.message).join("; ")}. ` +
        `Valid backends: ${SANDBOX_BACKEND_NAMES.join(", ")}`,
      );
    }
    sandbox = parseResult.data;
  }

  return {
    datasources,
    tools: ["explore", "executeSQL"],
    auth: "auto",
    semanticLayer: "./semantic",
    ...(actions ? { actions } : {}),
    maxTotalConnections: 100,
    ...(scheduler ? { scheduler } : {}),
    ...(rls ? { rls } : {}),
    ...(sandbox ? { sandbox } : {}),
    // Session timeout from env vars
    ...((() => {
      const idle = parseInt(process.env.ATLAS_SESSION_IDLE_TIMEOUT ?? "", 10);
      const abs = parseInt(process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT ?? "", 10);
      const idleTimeout = Number.isFinite(idle) && idle > 0 ? idle : 0;
      const absoluteTimeout = Number.isFinite(abs) && abs > 0 ? abs : 0;
      return (idleTimeout > 0 || absoluteTimeout > 0) ? { session: { idleTimeout, absoluteTimeout } } : {};
    })()),
    // Semantic index from env vars
    ...(process.env.ATLAS_SEMANTIC_INDEX_ENABLED === "false"
      ? { semanticIndex: { enabled: false } }
      : {}),
    // Cache config from env vars
    ...((() => {
      const enabled = process.env.ATLAS_CACHE_ENABLED !== "false" && process.env.ATLAS_CACHE_ENABLED !== "0";
      const ttl = parseInt(process.env.ATLAS_CACHE_TTL ?? "", 10);
      const maxSize = parseInt(process.env.ATLAS_CACHE_MAX_SIZE ?? "", 10);
      return {
        cache: {
          enabled,
          ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 300_000,
          maxSize: Number.isFinite(maxSize) && maxSize > 0 ? maxSize : 1000,
        },
      };
    })()),
    // Starter prompt config from env vars
    ...((() => {
      const coldWindow = parseInt(process.env.ATLAS_STARTER_PROMPT_COLD_WINDOW_DAYS ?? "", 10);
      const autoPromote = parseInt(process.env.ATLAS_STARTER_PROMPT_AUTO_PROMOTE_CLICKS ?? "", 10);
      const maxFavs = parseInt(process.env.ATLAS_STARTER_PROMPT_MAX_FAVORITES ?? "", 10);
      return {
        starterPrompts: {
          coldWindowDays:
            Number.isFinite(coldWindow) && coldWindow > 0 ? coldWindow : DEFAULT_COLD_WINDOW_DAYS,
          autoPromoteClicks:
            Number.isFinite(autoPromote) && autoPromote > 0 ? autoPromote : DEFAULT_AUTO_PROMOTE_CLICKS,
          maxFavorites:
            Number.isFinite(maxFavs) && maxFavs > 0 ? maxFavs : 10,
        },
      };
    })()),
    // Enterprise config from env vars
    enterprise: {
      enabled: process.env.ATLAS_ENTERPRISE_ENABLED === "true",
      ...(process.env.ATLAS_ENTERPRISE_LICENSE_KEY
        ? { licenseKey: process.env.ATLAS_ENTERPRISE_LICENSE_KEY }
        : {}),
    },
    // Catalog is operator-declared in atlas.config.ts; env-var fallback
    // leaves it undefined (self-host without chat/integration installs).
    source: "env",
  };
}

/**
 * Attempt to find and dynamically import `atlas.config.ts` (or `.js`, `.mjs`)
 * from the project root. Returns null when no config file is found.
 *
 * Uses a cache-busting query parameter on the import path so that the file
 * is always re-evaluated (important when the server restarts with a changed
 * config).
 */
async function tryLoadConfigFile(
  projectRoot: string,
): Promise<AtlasConfig | null> {
  const candidates = [
    "atlas.config.ts",
    "atlas.config.js",
    "atlas.config.mjs",
  ];

  for (const filename of candidates) {
    const filePath = path.resolve(projectRoot, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      log.info({ file: filePath }, "Loading config file");
      // Cache-bust: append timestamp so Bun re-evaluates the module
      const mod = await import(`${filePath}?t=${Date.now()}`);
      if (mod.default === undefined || mod.default === null) {
        throw new Error(
          `Config file "${filename}" does not have a default export. ` +
          `Use \`export default defineConfig({ ... })\` or \`module.exports = { ... }\`.`,
        );
      }
      const raw = mod.default;
      log.debug({ file: filePath }, "Config file loaded successfully");
      return raw;
    } catch (err) {
      // If the file exists but fails to parse/import, that is a hard error
      // that the user needs to fix — do not silently fall back to env vars.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load config file "${filename}": ${detail}`,
        { cause: err },
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

const VALID_PLUGIN_TYPES = new Set(["datasource", "context", "interaction", "action", "sandbox"]);

/**
 * Validate plugin array entries have the required structural shape:
 * `id` (non-empty string), `type` (valid PluginType), `version` (non-empty string).
 *
 * Also detects duplicate plugin IDs.
 *
 * This is the sole structural validation point for plugins in the config
 * pipeline — it must not be removed. Plugin-level configSchema validation
 * is handled by `createPlugin()` at factory call time (typically before
 * this runs, during config file evaluation).
 *
 * @throws {Error} When any plugin entry fails validation.
 */
function validatePlugins(plugins: unknown[]): void {
  const errors: string[] = [];
  const seenIds = new Map<string, number>();

  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];

    if (p === null || p === undefined || typeof p !== "object") {
      errors.push(`plugin at index ${i}: expected a plugin object, got ${p === null ? "null" : typeof p}`);
      continue;
    }

    const obj = p as Record<string, unknown>;

    // Build label upfront: use plugin id if available, otherwise index
    const hasId = "id" in obj && typeof obj.id === "string" && obj.id.trim();
    const label = hasId ? `plugin "${obj.id}" (index ${i})` : `plugin at index ${i}`;

    // id
    if (!("id" in obj) || typeof obj.id !== "string") {
      errors.push(`${label} is missing "id" (string)`);
    } else if (!obj.id.trim()) {
      errors.push(`${label} has an empty "id"`);
    } else {
      // Duplicate id check
      const prevIndex = seenIds.get(obj.id);
      if (prevIndex !== undefined) {
        errors.push(`${label} has duplicate id "${obj.id}" (first seen at index ${prevIndex})`);
      } else {
        seenIds.set(obj.id, i);
      }
    }

    // types
    if (!("types" in obj) || !Array.isArray(obj.types)) {
      errors.push(`${label} is missing "types" (array of plugin types)`);
    } else if (obj.types.length === 0) {
      errors.push(`${label} has an empty "types" array — must contain at least one plugin type`);
    } else {
      for (const t of obj.types) {
        if (typeof t !== "string" || !VALID_PLUGIN_TYPES.has(t)) {
          errors.push(`${label} has invalid type "${t}" in "types" — must be one of: ${[...VALID_PLUGIN_TYPES].join(", ")}`);
        }
      }
    }

    // version
    if (!("version" in obj) || typeof obj.version !== "string") {
      errors.push(`${label} is missing "version" (string)`);
    } else if (!obj.version.trim()) {
      errors.push(`${label} has an empty "version"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid plugin configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Zod error formatting
// ---------------------------------------------------------------------------

/** Loosely-typed Zod issue — works across Zod v3 and v4. */
type Issue = z.ZodError["issues"][number];

/**
 * Human-readable labels for config fields. Used to give context beyond
 * raw Zod type names (e.g. "connection URL" for datasources.*.url).
 */
const FIELD_HINTS: Record<string, string> = {
  "datasources.*.url": "connection URL",
  auth: "auth mode",
  semanticLayer: "path to the semantic layer directory",
  maxTotalConnections: "max total pool connections",
};

/** Map of common misspellings/variants to the correct value. */
const COMMON_SUGGESTIONS: Record<string, Record<string, string>> = {
  auth: {
    "apiKey": "api-key",
    "api_key": "api-key",
    "apikey": "api-key",
    "API-KEY": "api-key",
    "API_KEY": "api-key",
    "basic": "api-key",
    "bearer": "byot",
    "token": "byot",
    "bring-your-own-token": "byot",
    "true": "managed",
    "false": "none",
    "off": "none",
    "on": "auto",
    "default": "auto",
  },
};

/**
 * Look up a human-readable hint for a field path. Supports wildcards:
 * `datasources.mydb.url` matches `datasources.*.url`.
 */
function getFieldHint(fieldPath: string): string | undefined {
  if (FIELD_HINTS[fieldPath]) return FIELD_HINTS[fieldPath];
  // Try wildcard: replace middle segments with *
  const parts = fieldPath.split(".");
  if (parts.length >= 3) {
    const wildcard = `${parts[0]}.*.${parts.slice(2).join(".")}`;
    if (FIELD_HINTS[wildcard]) return FIELD_HINTS[wildcard];
  }
  return undefined;
}

/**
 * Extract the received value from the issue's message (Zod v4 encodes
 * it in the message string rather than a dedicated field).
 */
function extractReceived(issue: Issue): string | undefined {
  // Zod v4 invalid_type message: "Invalid input: expected string, received number"
  const match = issue.message.match(/received (\S+)/);
  if (match) return match[1];
  return undefined;
}

/**
 * Check if the received value for a field has a common suggestion.
 */
function getSuggestion(fieldPath: string, input: unknown): string | undefined {
  const topField = fieldPath.split(".")[0];
  const suggestions = COMMON_SUGGESTIONS[topField];
  if (!suggestions || typeof input !== "string") return undefined;
  const correct = suggestions[input];
  if (correct) return `Did you mean "${correct}"?`;
  return undefined;
}

/**
 * Format a single Zod issue into a human-readable line.
 */
function formatIssue(issue: Issue, rawInput: unknown): string {
  const fieldPath = issue.path.length > 0
    ? issue.path.map(String).join(".")
    : "(root)";
  const hint = getFieldHint(fieldPath);

  // Resolve the value that was actually passed for this path
  let inputAtPath: unknown = rawInput;
  for (const segment of issue.path) {
    if (inputAtPath != null && typeof inputAtPath === "object") {
      inputAtPath = (inputAtPath as Record<string, unknown>)[String(segment)];
    } else {
      inputAtPath = undefined;
      break;
    }
  }

  let line: string;
  // Use unknown-typed accessor to handle Zod v4 issue shapes safely
  const issueObj = issue as unknown as Record<string, unknown>;

  switch (issue.code) {
    case "invalid_type": {
      const expected = String(issueObj.expected ?? "unknown");
      const received = extractReceived(issue) ?? typeof inputAtPath;
      const expectedLabel = hint ? `${expected} (${hint})` : expected;
      line = `Config error at ${fieldPath}: expected ${expectedLabel}, got ${received}`;
      break;
    }
    case "invalid_union": {
      // Zod v4: `errors` is an array of issue arrays
      const unionErrors = issueObj.errors as unknown[][] | undefined;
      const validOptions: string[] = [];
      if (unionErrors) {
        for (const errGroup of unionErrors) {
          const issues = Array.isArray(errGroup) ? errGroup : [];
          for (const sub of issues) {
            const subObj = sub as Record<string, unknown>;
            // Zod v4 uses "invalid_value" with a "values" array
            if (subObj.code === "invalid_value" && Array.isArray(subObj.values)) {
              for (const v of subObj.values) {
                const opt = `"${v}"`;
                if (!validOptions.includes(opt)) validOptions.push(opt);
              }
            }
            // Zod v3 uses "invalid_literal" with "expected"
            if (subObj.code === "invalid_literal" && subObj.expected !== undefined) {
              const opt = `"${subObj.expected}"`;
              if (!validOptions.includes(opt)) validOptions.push(opt);
            }
          }
        }
      }
      if (validOptions.length > 0) {
        line = `Config error at ${fieldPath}: invalid value. Valid options: ${validOptions.join(", ")}`;
      } else {
        line = `Config error at ${fieldPath}: ${issue.message}`;
      }
      break;
    }
    case "invalid_value": {
      // Zod v4 uses "invalid_value" for enums and literals
      const values = issueObj.values as unknown[] | undefined;
      if (values && values.length > 0) {
        line = `Config error at ${fieldPath}: invalid value. Valid options: ${values.map((o) => `"${o}"`).join(", ")}`;
      } else {
        line = `Config error at ${fieldPath}: ${issue.message}`;
      }
      break;
    }
    default: {
      line = `Config error at ${fieldPath}: ${issue.message}`;
    }
  }

  // Append suggestion for common mistakes
  const suggestion = getSuggestion(fieldPath, inputAtPath);
  if (suggestion) {
    line += ` — ${suggestion}`;
  }

  return line;
}

/**
 * Format a ZodError into human-readable, multi-line error messages.
 *
 * Each line shows the field path, expected type, and received value.
 * Common mistakes get targeted suggestions (e.g. "did you mean 'api-key'?").
 * All errors are shown, not just the first one.
 *
 * @param error - The ZodError to format.
 * @param rawInput - The original input that was validated (used to resolve
 *   actual received values and to generate suggestions).
 */
export function formatZodErrors(error: z.ZodError, rawInput?: unknown): string {
  return error.issues.map((issue) => `  - ${formatIssue(issue, rawInput)}`).join("\n");
}

/**
 * Validate a raw config object against the Zod schema and return a
 * ResolvedConfig. Throws on validation failure with human-readable errors.
 */
export function validateAndResolve(raw: unknown): ResolvedConfig {
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(
      `atlas.config.ts must export a plain object. Got ${Array.isArray(raw) ? "array" : typeof raw}.`,
    );
  }

  const parseResult = AtlasConfigSchema.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(`Invalid atlas.config.ts:\n${formatZodErrors(parseResult.error, raw)}`);
  }

  const config = parseResult.data;

  // Structural validation of plugin entries (id, type, version)
  if (config.plugins?.length) {
    validatePlugins(config.plugins);
  }

  return {
    datasources: config.datasources ?? {},
    tools: config.tools ?? ["explore", "executeSQL"],
    auth: config.auth ?? "auto",
    semanticLayer: config.semanticLayer ?? "./semantic",
    ...(config.actions ? { actions: config.actions } : {}),
    maxTotalConnections: config.maxTotalConnections ?? 100,
    ...(config.plugins?.length ? { plugins: config.plugins } : {}),
    ...(config.scheduler ? { scheduler: config.scheduler } : {}),
    ...(config.rls ? { rls: config.rls } : {}),
    ...(config.sandbox ? { sandbox: config.sandbox } : {}),
    ...(config.python ? { python: config.python } : {}),
    ...(config.session ? { session: config.session } : {}),
    ...(config.semanticIndex ? { semanticIndex: config.semanticIndex } : {}),
    ...(config.pool ? { pool: config.pool } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.starterPrompts ? { starterPrompts: config.starterPrompts } : {}),
    ...(config.enterprise ? { enterprise: config.enterprise } : {}),
    ...(config.residency ? { residency: config.residency } : {}),
    ...(config.catalog && config.catalog.length > 0
      ? { catalog: config.catalog }
      : {}),
    ...(config.overrideImplementationStatus
      ? { overrideImplementationStatus: config.overrideImplementationStatus }
      : {}),
    source: "file",
  };
}

/**
 * Load and validate Atlas configuration.
 *
 * Resolution order:
 * 1. Look for `atlas.config.ts` (or .js/.mjs) in the project root.
 * 2. If found, parse and validate with Zod.
 * 3. If not found, build a config from environment variables.
 *
 * The resolved config is cached as a module-level singleton accessible
 * via {@link getConfig}.
 *
 * @param projectRoot - The directory to search for config files. Defaults
 *   to `process.cwd()`.
 * @throws {Error} When the config file exists but is invalid (Zod errors
 *   are formatted into a human-readable message).
 */
/**
 * Resolve the deploy mode for a ResolvedConfig.
 *
 * Calls `resolveDeployMode` from `@atlas/api/lib/effect/deploy-mode`
 * (pure core helper — promoted from `@atlas/ee/deploy-mode` in #2572 to
 * end the dynamic-import dance during config bootstrap). Mutates
 * `resolved.deployMode` in place and logs the result. EE still
 * re-exports `resolveDeployMode` for any external caller pinned to the
 * old path.
 */
async function applyDeployMode(
  resolved: ResolvedConfig,
  configFileValue?: "auto" | "saas" | "self-hosted",
): Promise<void> {
  // Env var takes priority over config file; config file takes priority over default
  const rawSetting = (process.env.ATLAS_DEPLOY_MODE ?? configFileValue) as
    | "saas" | "self-hosted" | "auto" | undefined;

  // Warn on unrecognized values
  if (rawSetting && !["auto", "saas", "self-hosted"].includes(rawSetting)) {
    log.warn(
      { value: rawSetting },
      "Unrecognized ATLAS_DEPLOY_MODE value — treating as auto",
    );
  }

  // Lazy require keeps `config.ts` at the bottom of the dep graph. The
  // resolver itself is a sync pure function that lazy-requires `getConfig`
  // and `hasInternalDB` — neither pulls in anything heavy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveDeployMode } = require("@atlas/api/lib/effect/deploy-mode") as {
    resolveDeployMode: (raw?: typeof rawSetting) => "saas" | "self-hosted";
  };
  resolved.deployMode = resolveDeployMode(rawSetting);
  log.info({ deployMode: resolved.deployMode }, "Deploy mode resolved");

  // #1978 — when deployMode "saas" was requested but resolveDeployMode
  // silently downgraded to "self-hosted", the contract guards (DPA,
  // encryption, internal DB) all skip. Env-set is handled by
  // `EnterpriseGuardLive` (fail boot); the config-file path falls back
  // to a CRITICAL warning here because the config file may legitimately
  // be checked into a self-hosted distribution that lacks `@atlas/ee`.
  //
  // Inlined rather than imported from `lib/effect/saas-guards.ts`
  // because that module's static import of `Config` from `./layers`
  // makes `layers.ts` (and its dynamic `await import("@atlas/api/lib/telemetry")`
  // chain) statically reachable from any consumer of `config.ts`.
  // Next.js's App Router tracer follows dynamic imports too, so the
  // create-atlas standalone scaffold would fail at build time trying to
  // resolve `@opentelemetry/sdk-node`. Keeping the helper inline here
  // walls the boot-only modules off from request-path consumers.
  // Only a CONFIG-FILE "saas" that was the OPERATIVE request counts as a silent
  // downgrade. A *recognized* explicit env value (`saas` | `self-hosted` |
  // `auto`) wins over the config file (resolveDeployMode precedence), so it's an
  // env-driven resolution, not a missing-enterprise downgrade:
  //   - env "saas"        → EnterpriseGuardLive hard-fails at boot
  //   - env "self-hosted" → explicit operator override (#3198 Codex P2)
  //   - env "auto"        → explicit auto-resolution, not a config downgrade
  //                         (#3198 Codex P2)
  // But an UNRECOGNIZED env value (a typo like "sasa", or unset/empty) is NOT a
  // deliberate override — resolveDeployMode treats it as `auto` and the config
  // file's "saas" is still the operator's expressed intent, so the downgrade
  // signal must survive (#3198 Codex follow-up). Mirrors the same recognized
  // set resolveDeployMode validates against.
  const envDeployMode = process.env.ATLAS_DEPLOY_MODE;
  const envSetRecognizedMode =
    envDeployMode === "saas" || envDeployMode === "self-hosted" || envDeployMode === "auto";
  if (
    resolved.deployMode !== "saas" &&
    !envSetRecognizedMode &&
    configFileValue === "saas"
  ) {
    // Cause-agnostic wording (#3198 Codex round 4): the downgrade can be caused
    // by missing enterprise OR an invalid ATLAS_DEPLOY_MODE (treated as auto) OR
    // auto-resolution without an internal DB even when enterprise IS enabled.
    // Don't assert a single cause — list the candidates so the prescribed
    // remediation can actually fix the resolved state.
    const reason =
      `atlas.config.ts requested deployMode "saas" but it resolved to "${resolved.deployMode}" — ` +
      `the SaaS contracts (DPA, encryption, internal-DB guards) are NOT running. Likely causes: ` +
      `@atlas/ee not installed or ATLAS_ENTERPRISE_ENABLED unset; an invalid ATLAS_DEPLOY_MODE value ` +
      `(treated as "auto"); or auto-resolution without DATABASE_URL. Fix the underlying cause, or ` +
      `remove the deployMode override from atlas.config.ts. See #1978.`;
    log.error(
      {
        requested: "saas",
        resolved: resolved.deployMode,
        source: "atlas.config.ts",
      },
      `CRITICAL: ${reason}`,
    );
    // #3184 — surface the silent downgrade beyond the log so a headless
    // Railway box shows a degraded `/health` signal, not just one easy-to-miss
    // CRITICAL line. Health reads this off the resolved config singleton.
    resolved.deployModeDowngraded = { reason };
  }

  // Pool-default warning runs after deploy mode resolves so the
  // SaaS-only emission is honored. Self-hosted deploys (whether
  // intentional or silently downgraded when enterprise is missing)
  // skip the warning — see the silent-downgrade log block above.
  _warnPoolDefaultsInSaaS(resolved);
}

/**
 * Boot-time pool-sizing log for SaaS deploys. Two emission paths,
 * deliberately at different severities (#2943):
 *
 *   1. `pool.perOrg` is undefined → **CRITICAL**. The operator never
 *      opted into per-org pooling, so SaaS noisy-neighbor isolation is
 *      off and a single tenant can starve every other org's connections.
 *      This is the genuine forgot-to-size mistake worth alerting on.
 *   2. `pool.perOrg` is explicitly configured → **INFO**, regardless of
 *      the value. An explicit `maxConnections` is an intentional sizing
 *      decision, not a misconfiguration — a connection is borrowed per
 *      in-flight SQL statement and released immediately, so a small value
 *      is ample for conversational load. Flagging it CRITICAL was alert
 *      fatigue (it fired on every boot of the deliberately-sized prod
 *      config). If the value is genuinely too low, pool-wait latency will
 *      surface in metrics (now exported via #2940) — raise it then.
 *
 * Self-hosted is silent (returns early) — every AGPL operator is
 * presumptively at trial / evaluation scale where per-org pooling is
 * optional.
 *
 * Exported because the `loadConfig()` e2e path can't easily reach the
 * SaaS-resolved branch in tests (no `@atlas/ee` build).
 *
 * @internal
 */
export function _warnPoolDefaultsInSaaS(resolved: ResolvedConfig): void {
  if (resolved.deployMode !== "saas") return;

  const perOrg = resolved.pool?.perOrg;

  if (!perOrg) {
    log.error(
      {
        reason: "pool-defaults",
        perOrgConfigured: false,
      },
      `CRITICAL: SaaS deploy booted without pool.perOrg configured — per-org pool isolation is off, ` +
        `so a single noisy tenant can starve every other org's connections. Add pool.perOrg in ` +
        `atlas.config.ts (see deploy.mdx#pool-default-warning). See #1983.`,
    );
    return;
  }

  // Explicitly configured → intentional sizing. INFO, not CRITICAL.
  log.info(
    {
      reason: "pool-sizing",
      perOrgConfigured: true,
      maxConnections: perOrg.maxConnections,
      maxOrgs: perOrg.maxOrgs,
    },
    `Per-org pool sized at ${perOrg.maxConnections} connection(s) × up to ${perOrg.maxOrgs} org(s) — ` +
      `ample for conversational load (connections are borrowed per in-flight SQL statement). Raise it if ` +
      `pool-wait latency appears in metrics. See deploy.mdx#pool-default-warning. See #2943.`,
  );
}

export async function loadConfig(
  projectRoot: string = process.cwd(),
): Promise<ResolvedConfig> {
  const raw = await tryLoadConfigFile(projectRoot);

  if (raw === null) {
    log.info("No atlas.config.ts found — using environment variables");
    const resolved = configFromEnv();
    await applyDeployMode(resolved);
    _resolved = resolved;
    return resolved;
  }

  const configDeployMode = (raw as Record<string, unknown>).deployMode as
    | "auto" | "saas" | "self-hosted" | undefined;
  const resolved = validateAndResolve(raw);
  await applyDeployMode(resolved, configDeployMode);

  log.info(
    {
      datasources: Object.keys(resolved.datasources),
      tools: resolved.tools,
      auth: resolved.auth,
      semanticLayer: resolved.semanticLayer,
    },
    "Config loaded from file",
  );

  _resolved = resolved;

  // Flush query cache on config reload to avoid stale results
  try {
    const { flushCache } = await import("@atlas/api/lib/cache/index");
    flushCache();
  } catch (err) {
    // Dynamic import may fail on first load before cache is wired — other errors must be logged
    if (err instanceof Error && !err.message.includes("Cannot find module")) {
      log.warn({ err: err.message }, "Failed to flush query cache during config reload");
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Wiring helpers — apply config to ConnectionRegistry and ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Register datasources from the resolved config into the ConnectionRegistry.
 * Skips if no datasources are defined (the registry will lazy-init from
 * ATLAS_DATASOURCE_URL on first access, preserving backward compat).
 *
 * @param config - The resolved configuration.
 * @param registry - The ConnectionRegistry to register into. When omitted,
 *   uses the global singleton from `./db/connection`.
 */
export async function applyDatasources(
  config: ResolvedConfig,
  registry?: ConnectionRegistry,
): Promise<void> {
  if (Object.keys(config.datasources).length === 0) {
    log.debug("No datasources in config — ConnectionRegistry will use env var fallback");
    return;
  }

  const connRegistry = registry ?? (await import("./db/connection")).connections;

  connRegistry.setMaxTotalConnections(config.maxTotalConnections);

  if (config.pool?.perOrg) {
    connRegistry.setOrgPoolConfig(config.pool.perOrg);
  }

  for (const [id, ds] of Object.entries(config.datasources)) {
    try {
      log.info({ connectionId: id }, "Registering datasource from config");
      connRegistry.register(id, {
        url: ds.url,
        schema: ds.schema,
        description: ds.description,
        maxConnections: ds.maxConnections,
        idleTimeoutMs: ds.idleTimeoutMs,
      });

      // Fire initial health check — logs on failure but does not block startup.
      // A degraded connection is still usable (the DB may recover).
      connRegistry.healthCheck(id).then((result) => {
        if (result.status !== "healthy") {
          log.warn(
            { connectionId: id, status: result.status, message: result.message },
            "Datasource registered but initial health check failed — connection may be misconfigured",
          );
        }
      }).catch((healthErr) => {
        log.warn(
          { err: healthErr instanceof Error ? healthErr.message : String(healthErr), connectionId: id },
          "Initial health check failed after registration",
        );
      });

      if (ds.rateLimit) {
        const { registerSourceRateLimit } = await import("./db/source-rate-limit");
        registerSourceRateLimit(id, {
          queriesPerMinute: ds.rateLimit.queriesPerMinute,
          concurrency: ds.rateLimit.concurrency,
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to register datasource "${id}": ${detail}`,
        { cause: err },
      );
    }
  }
}

/**
 * Validate that the tool names in the config match registered tools in the
 * default registry. Throws if any tool names are unrecognized.
 *
 * @param config - The resolved configuration.
 * @param registry - The ToolRegistry to validate against. When omitted,
 *   uses the default registry from `./tools/registry`.
 * @throws {Error} When config references tool names not in the registry.
 */
export async function validateToolConfig(
  config: ResolvedConfig,
  registry?: ToolRegistry,
): Promise<void> {
  const toolRegistry = registry ?? (await import("./tools/registry")).defaultRegistry;

  const unknownTools: string[] = [];
  for (const toolName of config.tools) {
    if (!toolRegistry.get(toolName)) {
      unknownTools.push(toolName);
    }
  }
  if (unknownTools.length > 0) {
    const available = Object.keys(toolRegistry.getAll());
    throw new Error(
      `Unknown tool(s) in config: ${unknownTools.join(", ")}. ` +
      `Available: ${available.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Startup integration — single entry point for server boot
// ---------------------------------------------------------------------------

/**
 * Load config, wire datasources, and validate tool names.
 * Call this once during server startup (e.g. in server.ts).
 *
 * @param projectRoot - Directory to search for config files.
 * @param opts - Optional dependency injection for registries (used in tests).
 * @throws {Error} When the config file is present but invalid.
 */
export async function initializeConfig(
  projectRoot?: string,
  opts?: {
    connectionRegistry?: ConnectionRegistry;
    toolRegistry?: ToolRegistry;
  },
): Promise<ResolvedConfig> {
  const config = await loadConfig(projectRoot);
  const connRegistry = opts?.connectionRegistry;
  await applyDatasources(config, connRegistry);
  await validateToolConfig(config, opts?.toolRegistry);

  // Start periodic health checks when datasources are registered
  const registry = connRegistry ?? (await import("./db/connection")).connections;
  if (registry.list().length > 0) {
    registry.startHealthChecks();
  }

  return config;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Reset the cached config. For testing only. */
export function _resetConfig(): void {
  _resolved = null;
}

/** Set the cached config directly. For testing only. */
export function _setConfigForTest(config: ResolvedConfig | null): void {
  _resolved = config;
}
