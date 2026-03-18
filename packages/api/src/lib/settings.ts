/**
 * Application settings persistence — DB overrides for env var config.
 *
 * Settings follow a three-tier resolution: DB override > env var > default.
 * When no internal DB is available, all settings are read-only from env vars.
 *
 * The in-process cache is populated at startup and updated on writes,
 * so reads never hit the database after initialization.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("settings");

// ---------------------------------------------------------------------------
// Settings registry — defines all known settings with metadata
// ---------------------------------------------------------------------------

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
}

export interface SettingWithValue extends SettingDefinition {
  currentValue: string | undefined;
  source: "env" | "override" | "default";
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
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
  },
  {
    key: "ATLAS_QUERY_TIMEOUT",
    section: "Query Limits",
    label: "Query Timeout",
    description: "Query timeout in milliseconds",
    type: "number",
    default: "30000",
    envVar: "ATLAS_QUERY_TIMEOUT",
  },

  // Rate Limiting
  {
    key: "ATLAS_RATE_LIMIT_RPM",
    section: "Rate Limiting",
    label: "Rate Limit (RPM)",
    description: "Max requests per minute per user (0 or empty = disabled)",
    type: "number",
    envVar: "ATLAS_RATE_LIMIT_RPM",
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
  },
  {
    key: "ATLAS_RLS_COLUMN",
    section: "Security",
    label: "RLS Column",
    description: "Column name used for RLS filtering (e.g. tenant_id)",
    type: "string",
    envVar: "ATLAS_RLS_COLUMN",
    requiresRestart: true,
  },
  {
    key: "ATLAS_RLS_CLAIM",
    section: "Security",
    label: "RLS Claim",
    description: "JWT claim path for RLS value extraction (e.g. org_id)",
    type: "string",
    envVar: "ATLAS_RLS_CLAIM",
    requiresRestart: true,
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
  },
  {
    key: "ATLAS_SESSION_ABSOLUTE_TIMEOUT",
    section: "Sessions",
    label: "Absolute Timeout",
    description: "Maximum session lifetime in seconds from creation (0 = disabled)",
    type: "number",
    default: "0",
    envVar: "ATLAS_SESSION_ABSOLUTE_TIMEOUT",
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
  },
  {
    key: "ATLAS_MODEL",
    section: "Agent",
    label: "Model",
    description: "Model ID override (leave empty for provider default)",
    type: "string",
    envVar: "ATLAS_MODEL",
    requiresRestart: true,
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
  },
  {
    key: "OPENAI_API_KEY",
    section: "Secrets",
    label: "OpenAI API Key",
    description: "API key for the OpenAI provider",
    type: "string",
    secret: true,
    envVar: "OPENAI_API_KEY",
  },
  {
    key: "DATABASE_URL",
    section: "Secrets",
    label: "Internal Database URL",
    description: "PostgreSQL connection string for Atlas internals",
    type: "string",
    secret: true,
    envVar: "DATABASE_URL",
  },
  {
    key: "ATLAS_DATASOURCE_URL",
    section: "Secrets",
    label: "Datasource URL",
    description: "Analytics datasource connection string",
    type: "string",
    secret: true,
    envVar: "ATLAS_DATASOURCE_URL",
  },
];

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, { value: string; updated_at: string; updated_by: string | null }>();

const SETTINGS_KEYS = new Set(SETTINGS_REGISTRY.map((s) => s.key));

/** @internal Reset cache — for testing only. */
export function _resetSettingsCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Load all settings from the internal DB into the in-process cache.
 * Call once at startup. No-op when no internal DB.
 */
export async function loadSettings(): Promise<number> {
  if (!hasInternalDB()) return 0;

  try {
    const rows = await internalQuery<Record<string, unknown> & SettingRow>(
      "SELECT key, value, updated_at::text, updated_by FROM settings",
    );

    _cache.clear();
    for (const row of rows) {
      _cache.set(row.key, {
        value: row.value,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
    }

    if (rows.length > 0) {
      log.info({ count: rows.length }, "Loaded settings from internal DB");
    }
    return rows.length;
  } catch (err) {
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
 * Get a setting value with three-tier resolution: DB override > env var > default.
 */
export function getSetting(key: string): string | undefined {
  // DB override takes priority
  const cached = _cache.get(key);
  if (cached) return cached.value;

  // Env var
  const envVal = process.env[key];
  if (envVal !== undefined) return envVal;

  // Default from registry
  const def = SETTINGS_REGISTRY.find((s) => s.key === key);
  return def?.default;
}

/**
 * Set a settings override in the DB and update the in-process cache.
 * Throws if no internal DB is available.
 */
export async function setSetting(key: string, value: string, userId?: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal database required to persist settings overrides");
  }
  if (!SETTINGS_KEYS.has(key)) {
    throw new Error(`Unknown setting key: "${key}"`);
  }

  await internalQuery(
    `INSERT INTO settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
    [key, value, userId ?? null],
  );

  _cache.set(key, {
    value,
    updated_at: new Date().toISOString(),
    updated_by: userId ?? null,
  });

  log.info({ key, actorId: userId }, "Setting override saved");
}

/**
 * Delete a settings override, reverting to env var / default.
 * Throws if no internal DB is available.
 */
export async function deleteSetting(key: string, userId?: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal database required to manage settings overrides");
  }

  await internalQuery("DELETE FROM settings WHERE key = $1", [key]);
  _cache.delete(key);

  log.info({ key, actorId: userId }, "Setting override removed");
}

/**
 * Get all DB overrides (for admin listing).
 */
export async function getAllSettingOverrides(): Promise<SettingRow[]> {
  if (!hasInternalDB()) return [];

  return await internalQuery<Record<string, unknown> & SettingRow>(
    "SELECT key, value, updated_at::text, updated_by FROM settings ORDER BY key",
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
 * Returns all known settings with current values and sources,
 * suitable for the admin API response.
 */
export function getSettingsForAdmin(): SettingWithValue[] {
  return SETTINGS_REGISTRY.map((def) => {
    const override = _cache.get(def.key);
    const envVal = process.env[def.envVar];

    let currentValue: string | undefined;
    let source: "env" | "override" | "default";

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

    return { ...def, currentValue, source };
  });
}

/** Returns the settings registry definitions (no values). */
export function getSettingsRegistry(): readonly SettingDefinition[] {
  return SETTINGS_REGISTRY;
}
