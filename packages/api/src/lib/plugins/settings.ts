/**
 * Plugin settings persistence — enable/disable state and config overrides.
 *
 * Stores plugin settings in the internal DB's `plugin_settings` table.
 * When no internal DB is available, all plugins are enabled and config
 * is read-only (from env vars / atlas.config.ts only).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PluginRegistry } from "./registry";

const log = createLogger("plugin-settings");

export interface PluginSettings {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  updatedAt: string;
}

/**
 * Load plugin settings from the internal DB and apply enabled/disabled
 * state to the registry. Call after plugins are registered.
 * No-op when no internal DB is available.
 */
export async function loadPluginSettings(registry: PluginRegistry): Promise<number> {
  if (!hasInternalDB()) return 0;

  try {
    const rows = await internalQuery<{
      plugin_id: string;
      enabled: boolean;
      config: Record<string, unknown> | null;
    }>("SELECT plugin_id, enabled, config FROM plugin_settings");

    let applied = 0;
    for (const row of rows) {
      if (!row.enabled) {
        if (registry.disable(row.plugin_id)) {
          applied++;
        }
      }
    }

    if (applied > 0) {
      log.info({ count: applied }, "Applied plugin settings from internal DB");
    }
    return applied;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not load plugin settings (table may not exist yet)",
    );
    return 0;
  }
}

/**
 * Save plugin enabled/disabled state to the internal DB.
 * Uses upsert to handle first-time saves.
 */
export async function savePluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal database required to persist plugin settings");
  }

  await internalQuery(
    `INSERT INTO plugin_settings (plugin_id, enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (plugin_id) DO UPDATE SET enabled = $2, updated_at = now()`,
    [pluginId, enabled],
  );
}

/**
 * Save plugin config overrides to the internal DB.
 * Uses upsert to handle first-time saves.
 */
export async function savePluginConfig(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal database required to persist plugin settings");
  }

  await internalQuery(
    `INSERT INTO plugin_settings (plugin_id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (plugin_id) DO UPDATE SET config = $2::jsonb, updated_at = now()`,
    [pluginId, JSON.stringify(config)],
  );
}

/**
 * Get plugin config overrides from the internal DB.
 * Returns null if no overrides are saved.
 */
export async function getPluginConfig(
  pluginId: string,
): Promise<Record<string, unknown> | null> {
  if (!hasInternalDB()) return null;

  try {
    const rows = await internalQuery<{ config: Record<string, unknown> | null }>(
      "SELECT config FROM plugin_settings WHERE plugin_id = $1",
      [pluginId],
    );
    return rows[0]?.config ?? null;
  } catch (err) {
    log.warn(
      { pluginId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load plugin config from internal DB",
    );
    return null;
  }
}

/**
 * Get all plugin settings from the internal DB.
 */
export async function getAllPluginSettings(): Promise<PluginSettings[]> {
  if (!hasInternalDB()) return [];

  try {
    const rows = await internalQuery<{
      plugin_id: string;
      enabled: boolean;
      config: Record<string, unknown> | null;
      updated_at: string;
    }>("SELECT plugin_id, enabled, config, updated_at FROM plugin_settings");

    return rows.map((r) => ({
      pluginId: r.plugin_id,
      enabled: r.enabled,
      config: r.config,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to load all plugin settings from internal DB",
    );
    return [];
  }
}
