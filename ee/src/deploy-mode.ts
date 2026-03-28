/**
 * Deploy mode detection for Atlas Enterprise.
 *
 * Resolves `ATLAS_DEPLOY_MODE` (env var or settings) to a binary
 * `"saas" | "self-hosted"` value. The `"saas"` mode requires enterprise
 * to be enabled — without it, deploy mode always resolves to `"self-hosted"`.
 *
 * Computed once at import time and cached for the lifetime of the process.
 */

import { isEnterpriseEnabled } from "./index";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import type { DeployMode, DeployModeSetting } from "@useatlas/types";

/**
 * Resolve the effective deploy mode from the raw setting value.
 *
 * Logic:
 * - `"saas"`: requires enterprise enabled, otherwise falls back to `"self-hosted"`
 * - `"self-hosted"`: always returns `"self-hosted"`
 * - `"auto"` (default): returns `"saas"` when both enterprise is enabled AND
 *   an internal database is configured, otherwise `"self-hosted"`
 */
export function resolveDeployMode(raw?: DeployModeSetting): DeployMode {
  const setting: DeployModeSetting = raw ?? (process.env.ATLAS_DEPLOY_MODE as DeployModeSetting) ?? "auto";

  if (setting === "self-hosted") {
    return "self-hosted";
  }

  if (setting === "saas") {
    return isEnterpriseEnabled() ? "saas" : "self-hosted";
  }

  // "auto" — detect from environment
  return isEnterpriseEnabled() && hasInternalDB() ? "saas" : "self-hosted";
}
