/**
 * Chat SDK state adapter types.
 *
 * Re-exports Chat SDK's StateAdapter and Lock interfaces and defines
 * Atlas-specific configuration for state backend selection.
 */

export type { StateAdapter, Lock } from "chat";

/**
 * Internal DB access — mirrors AtlasPluginContext["db"].
 * Plugins must not import from @atlas/api; they receive this via context.
 */
export interface PluginDB {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}

/** Configuration for the chat state backend. */
export interface StateBackendConfig {
  /** Which state backend to use. Default: "memory" */
  backend: "memory" | "pg" | "redis";
  /** Table name prefix for PG backend. Default: "chat_" */
  tablePrefix?: string;
  /** Redis connection URL (future — not yet implemented). */
  redisUrl?: string;
}
