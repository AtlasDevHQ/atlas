/**
 * Deploy mode resolution — promoted to core in #2572 so the
 * `DeployModeResolver` Tag (and `lib/config.ts:applyDeployMode`) can
 * resolve `"saas" | "self-hosted"` without core importing from
 * `@atlas/ee`.
 *
 * EE's `ee/src/deploy-mode.ts` is now a thin re-export for back-compat —
 * the resolution logic lives here. Behavior is identical: `"saas"` mode
 * requires enterprise to be enabled, otherwise falls back to
 * `"self-hosted"`. `"auto"` returns `"saas"` only when BOTH enterprise
 * is enabled AND an internal database is configured.
 *
 * Lazy-requires the config + internal-DB modules to keep this file at
 * the bottom of the dep graph (same trick `enterprise-layer.ts` uses for
 * `isEnterpriseEnabledLocal`).
 */

import type { DeployMode, DeployModeSetting } from "@useatlas/types";

/**
 * Read whether enterprise is enabled without importing from `@atlas/ee`.
 *
 * Mirrors `ee/src/index.ts:isEnterpriseEnabled` resolution order:
 *   1. `enterprise.enabled` in atlas.config.ts
 *   2. `ATLAS_ENTERPRISE_ENABLED` env var
 */
function isEnterpriseEnabledLocal(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConfig } = require("@atlas/api/lib/config") as {
    getConfig: () => { enterprise?: { enabled?: boolean } } | null;
  };
  const config = getConfig();
  if (config?.enterprise?.enabled !== undefined) {
    return config.enterprise.enabled;
  }
  return process.env.ATLAS_ENTERPRISE_ENABLED === "true";
}

function hasInternalDBLocal(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
    hasInternalDB: () => boolean;
  };
  return hasInternalDB();
}

/**
 * Resolve the effective deploy mode from the raw setting value.
 *
 * Logic:
 * - `"self-hosted"`: always returns `"self-hosted"`
 * - `"saas"`: requires enterprise enabled, otherwise falls back to
 *   `"self-hosted"`
 * - `"auto"` (default): returns `"saas"` when both enterprise is
 *   enabled AND an internal database is configured, otherwise
 *   `"self-hosted"`
 */
export function resolveDeployMode(raw?: DeployModeSetting): DeployMode {
  const setting: DeployModeSetting =
    raw ?? (process.env.ATLAS_DEPLOY_MODE as DeployModeSetting) ?? "auto";

  if (setting === "self-hosted") {
    return "self-hosted";
  }

  if (setting === "saas") {
    return isEnterpriseEnabledLocal() ? "saas" : "self-hosted";
  }

  // "auto" — detect from environment
  return isEnterpriseEnabledLocal() && hasInternalDBLocal()
    ? "saas"
    : "self-hosted";
}
