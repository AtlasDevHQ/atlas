/**
 * State adapter factory and re-exports.
 *
 * Entry point for creating a Chat SDK state adapter based on plugin config.
 * The adapter is passed to `new Chat({ state })` and also used by the bridge
 * for conversation caching and lock-based dedup.
 */

import type { StateAdapter } from "chat";
import type { StateConfig } from "../config";
import type { PluginDB } from "./types";
import { createMemoryState } from "./memory-adapter";
import { createPgAdapter } from "./pg-adapter";
import { createRedisAdapter } from "./redis-adapter";

export type { StateAdapter, Lock, PluginDB } from "./types";
export { PgStateAdapter, createPgAdapter } from "./pg-adapter";
export { createMemoryState } from "./memory-adapter";
export { createRedisAdapter } from "./redis-adapter";

/**
 * Create a state adapter from config.
 *
 * @param config - State backend configuration
 * @param db     - Plugin DB context (required for "pg" backend)
 */
export function createStateAdapter(
  config: StateConfig | undefined,
  db: PluginDB | null,
): StateAdapter {
  const backend = config?.backend ?? "memory";

  switch (backend) {
    case "memory":
      return createMemoryState();

    case "pg": {
      if (!db) {
        throw new Error(
          "PG state adapter requires an internal database (DATABASE_URL). " +
            "Either configure DATABASE_URL or use the 'memory' state backend.",
        );
      }
      return createPgAdapter(db, { tablePrefix: config?.tablePrefix });
    }

    case "redis":
      return createRedisAdapter(config?.redisUrl);

    default: {
      const _exhaustive: never = backend;
      throw new Error(`Unknown state backend: ${String(_exhaustive)}`);
    }
  }
}
