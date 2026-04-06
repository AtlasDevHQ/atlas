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
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

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
}

export interface SettingWithValue extends SettingDefinition {
  currentValue: string | undefined;
  source: "env" | "override" | "workspace-override" | "default";
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

  // Rate Limiting
  {
    key: "ATLAS_RATE_LIMIT_RPM",
    section: "Rate Limiting",
    label: "Rate Limit (RPM)",
    description: "Max requests per minute per user (0 or empty = disabled)",
    type: "number",
    envVar: "ATLAS_RATE_LIMIT_RPM",
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

  // Sandbox
  {
    key: "ATLAS_SANDBOX_BACKEND",
    section: "Sandbox",
    label: "Sandbox Backend",
    description:
      "Sandbox backend for explore/Python tool isolation. " +
      "Valid values: vercel-sandbox, sidecar, e2b-sandbox, daytona-sandbox, or a registered plugin ID.",
    type: "string",
    envVar: "ATLAS_SANDBOX_BACKEND",
    scope: "workspace",
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
    key: "ATLAS_PROVIDER",
    section: "Agent",
    label: "LLM Provider",
    description: "LLM provider for the agent",
    type: "select",
    options: ["anthropic", "openai", "bedrock", "ollama", "openai-compatible", "gateway"],
    default: "anthropic",
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
  {
    key: "ATLAS_EXPERT_SCHEDULER_ENABLED",
    section: "Intelligence",
    label: "Expert Scheduler",
    description: "Enable periodic semantic layer analysis (runs the improvement engine automatically)",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_EXPERT_SCHEDULER_ENABLED",
    scope: "workspace",
  },
  {
    key: "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
    section: "Intelligence",
    label: "Expert Schedule Interval",
    description: "Hours between scheduled expert analysis runs",
    type: "number",
    default: "24",
    envVar: "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
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

  // Appearance
  {
    key: "ATLAS_BRAND_COLOR",
    section: "Appearance",
    label: "Brand Color",
    description: "Primary brand color in oklch format (used for theme tokens)",
    type: "string",
    default: "oklch(0.759 0.148 167.71)",
    envVar: "ATLAS_BRAND_COLOR",
    scope: "platform",
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

/** Check if the current deploy mode is SaaS (lazy — avoids circular import at module load). */
function isSaasMode(): boolean {
  // Lazy-import to avoid circular dependency at module evaluation time.
  // getConfig() is a cheap singleton read after boot.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require("@atlas/api/lib/config") as { getConfig: () => { deployMode?: string } | null };
    return getConfig()?.deployMode === "saas";
  } catch (err) {
    // intentionally ignored: config module may not be ready during early module init
    console.debug("isSaasMode: config not yet available:", err instanceof Error ? err.message : String(err));
    return false;
  }
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
 * Set a settings override in the DB and update the in-process cache.
 * Throws if no internal DB is available.
 *
 * When orgId is provided and the setting is workspace-scoped, stores a
 * workspace-level override. Platform-scoped settings ignore orgId.
 */
export async function setSetting(key: string, value: string, userId?: string, orgId?: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal database required to persist settings overrides");
  }
  const def = SETTINGS_MAP.get(key);
  if (!def) {
    throw new Error(`Unknown setting key: "${key}"`);
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
}

/**
 * Delete a settings override, reverting to the next tier in the fallback chain.
 * Throws if no internal DB is available.
 */
export async function deleteSetting(key: string, userId?: string, orgId?: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal database required to manage settings overrides");
  }

  const def = SETTINGS_MAP.get(key);
  if (!def) {
    throw new Error(`Unknown setting key: "${key}"`);
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

      // In SaaS mode, hot-reloadable settings don't require restart
      const requiresRestart = (def.requiresRestart && !isSaasMode())
        ? true
        : undefined;

      return { ...def, requiresRestart, currentValue, source };
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

/** Settings that produce immediate runtime side effects when changed. */
const SIDE_EFFECT_KEYS = new Set(["ATLAS_LOG_LEVEL"]);

/**
 * Apply runtime side effects after a setting value changes.
 * Only runs in SaaS mode for hot-reloadable settings.
 */
function applySettingSideEffect(key: string, value: string): void {
  if (!isSaasMode() || !SIDE_EFFECT_KEYS.has(key)) return;

  if (key === "ATLAS_LOG_LEVEL") {
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
  }
}
