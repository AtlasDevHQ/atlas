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
 * Reads the enterprise flag via the canonical `enterprise-config.ts`
 * helper (#2587 retired the local `isEnterpriseEnabledLocal` fork).
 * `hasInternalDBLocal` stays lazy-`require`'d to keep `lib/db/internal`
 * out of this file's eager dep graph.
 */

import type { DeployMode, DeployModeSetting } from "@useatlas/types";
import { isEnterpriseEnabled } from "./enterprise-config";

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
    return isEnterpriseEnabled() ? "saas" : "self-hosted";
  }

  // "auto" — detect from environment
  return isEnterpriseEnabled() && hasInternalDBLocal()
    ? "saas"
    : "self-hosted";
}
