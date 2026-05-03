/**
 * CORS header computation shared between the global Hono middleware and the
 * streaming-response paths (demo chat, main chat) that bypass middleware via
 * `throw new HTTPException(200, { res: streamResponse })`.
 *
 * The streaming response is constructed inside the route handler with its
 * own headers, then thrown so Hono's onError handler returns it raw — at
 * which point the CORS middleware's queued headers are NOT applied. Without
 * this helper, cross-origin streaming requests succeed at the network level
 * but the browser blocks the response for missing
 * `Access-Control-Allow-Origin`. (#2037)
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("cors");

const bootCorsOrigin = process.env.ATLAS_CORS_ORIGIN;
let corsSettingsWarnLogged = false;

/**
 * Resolve the configured CORS origin. Reads from settings cache (so admin
 * changes take effect without restart) with a fallback to the boot-time env.
 * Defaults to `"*"` when unset — fine for API-key/BYOT auth (header-based).
 */
export function resolveCorsOrigin(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency at module load
    const { getSettingAuto } = require("@atlas/api/lib/settings") as {
      getSettingAuto: (key: string) => string | undefined;
    };
    return getSettingAuto("ATLAS_CORS_ORIGIN") ?? bootCorsOrigin ?? "*";
  } catch (err) {
    if (!corsSettingsWarnLogged) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "CORS: failed to read live setting — falling back to boot-time origin",
      );
      corsSettingsWarnLogged = true;
    }
    return bootCorsOrigin ?? "*";
  }
}

/**
 * Compute the CORS response headers for a given request origin. Returns the
 * exact headers the streaming-response path should attach so cross-origin
 * fetches receive `Access-Control-Allow-Origin` (the browser blocks any
 * non-OPTIONS response missing this, even when the preflight succeeded).
 */
export function corsResponseHeaders(requestOrigin: string): Record<string, string> {
  const configured = resolveCorsOrigin();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After, x-conversation-id",
  };

  if (configured === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
    // Per CORS spec, credentials must NOT be set with wildcard origin.
  } else if (configured === requestOrigin) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  // Non-matching origin: no CORS headers — browser will reject (correct).

  return headers;
}
