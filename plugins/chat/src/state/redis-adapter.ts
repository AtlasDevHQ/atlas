/**
 * Redis state adapter (stub).
 *
 * Placeholder for future Redis-backed state adapter.
 * Accepts the config value so the Zod schema can validate "redis" as a
 * backend type, but throws at construction time until implemented.
 */

import type { StateAdapter } from "chat";

/**
 * Create a Redis-backed state adapter.
 * @throws Always — Redis adapter is not yet implemented.
 */
export function createRedisAdapter(_redisUrl?: string): StateAdapter {
  throw new Error(
    "Redis state adapter is not yet implemented. Use 'pg' or 'memory' backend instead.",
  );
}
