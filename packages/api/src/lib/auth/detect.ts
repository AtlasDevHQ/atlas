/**
 * Auth mode detection.
 *
 * Resolves the active auth mode from environment variables and config.
 *
 * Priority (highest → lowest):
 *   1. `ATLAS_AUTH_MODE` env var (explicit override)
 *   2. `auth` field in atlas.config.ts (when not "auto")
 *   3. Auto-detection from env var presence:
 *      JWKS (byot) > Better Auth (managed) > API key (simple-key) > none
 *
 * Result is cached — call resetAuthModeCache() in tests.
 */

import type { AuthMode } from "@atlas/api/lib/auth/types";
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth");

/** User-friendly aliases accepted by ATLAS_AUTH_MODE. */
const MODE_ALIASES: Record<string, AuthMode> = {
  "none": "none",
  "api-key": "simple-key",
  "simple-key": "simple-key",
  "managed": "managed",
  "byot": "byot",
};

export type AuthModeSource = "explicit" | "config" | "auto-detected";

let _cached: AuthMode | null = null;
let _source: AuthModeSource | null = null;

/**
 * Detect auth mode using the three-tier priority chain:
 * env var → config file → auto-detect. Cached after first call.
 */
export function detectAuthMode(): AuthMode {
  if (_cached !== null) return _cached;

  const explicit = process.env.ATLAS_AUTH_MODE?.trim();
  if (explicit) {
    const resolved = MODE_ALIASES[explicit.toLowerCase()];
    if (resolved) {
      _cached = resolved;
      _source = "explicit";
      log.info({ mode: _cached }, "Auth mode: %s (explicit)", _cached);
      return _cached;
    }
    const valid = Object.keys(MODE_ALIASES).join(", ");
    throw new Error(
      `Invalid ATLAS_AUTH_MODE '${explicit}'. Valid values: ${valid}. ` +
      `Remove ATLAS_AUTH_MODE to use auto-detection, or set it to a valid value.`,
    );
  }

  // Config file auth (middle priority)
  const config = getConfig();
  if (config?.auth && config.auth !== "auto") {
    const resolved = MODE_ALIASES[config.auth];
    if (resolved) {
      _cached = resolved;
      _source = "config";
      log.info({ mode: _cached }, "Auth mode: %s (config)", _cached);
      return _cached;
    }
    log.warn(
      { configAuth: config.auth },
      "Config auth value '%s' not recognized — falling through to auto-detection",
      config.auth,
    );
  }

  // Auto-detection fallback
  if (process.env.ATLAS_AUTH_JWKS_URL) {
    _cached = "byot";
  } else if (process.env.BETTER_AUTH_SECRET) {
    _cached = "managed";
  } else if (process.env.ATLAS_API_KEY) {
    _cached = "simple-key";
  } else {
    _cached = "none";
  }

  _source = "auto-detected";
  log.info({ mode: _cached }, "Auth mode: %s (auto-detected)", _cached);
  return _cached;
}

/**
 * Return how the auth mode was resolved: "explicit" (env var),
 * "config" (atlas.config.ts), or "auto-detected" (env var presence).
 * Returns null if detectAuthMode() has not been called yet.
 */
export function getAuthModeSource(): AuthModeSource | null {
  return _source;
}

/** Reset cached auth mode. For testing only. */
export function resetAuthModeCache(): void {
  _cached = null;
  _source = null;
}
