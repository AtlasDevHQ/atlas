/**
 * Deploy mode resolution — promoted to core in #2572 so
 * `lib/config.ts:applyDeployMode` can resolve `"saas" | "self-hosted"`
 * without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/deploy-mode.ts` is now a thin re-export for back-compat —
 * the resolution logic lives here. Behavior is identical: `"saas"` mode
 * requires enterprise to be enabled, otherwise falls back to
 * `"self-hosted"`. `"auto"` returns `"saas"` only when BOTH enterprise
 * is enabled AND an internal database is configured.
 *
 * Reads the enterprise flag via the canonical `enterprise-config.ts`
 * helper (#2594 retired the local `isEnterpriseEnabledLocal` fork).
 * `hasInternalDBLocal` stays lazy-`require`'d to keep `lib/db/internal`
 * out of this file's eager dep graph.
 */

import type { DeployMode, DeployModeSetting } from "@useatlas/types";
import { isEnterpriseEnabled } from "./enterprise-config";

function hasInternalDBLocal(): boolean {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
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
 * - `"auto"` (default): returns `"self-hosted"` whenever
 *   `ATLAS_DEPLOY_ENV=development` (the local-dev short-circuit, below);
 *   otherwise `"saas"` when both enterprise is enabled AND an internal
 *   database is configured, else `"self-hosted"`
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

  // "auto" — detect from environment.
  //
  // Local-dev short-circuit: `ATLAS_DEPLOY_ENV=development` always resolves to
  // self-hosted. This monorepo always has `@atlas/ee` present and (once
  // `bun run db:up` runs) an internal DB configured, so the heuristic below
  // would otherwise auto-resolve every dev checkout to "saas" and hard-fail
  // boot on the SaaS-only guards — the #1 local-dev face-plant. A real SaaS
  // region never runs `development` (it sets deployMode explicitly in
  // deploy/api/atlas.config.ts, #3702), so this only ever rescues local dev.
  // An operator who genuinely wants SaaS locally sets `ATLAS_DEPLOY_MODE=saas`
  // explicitly, which takes the `saas` branch above and bypasses this.
  if (process.env.ATLAS_DEPLOY_ENV === "development") {
    return "self-hosted";
  }

  return isEnterpriseEnabled() && hasInternalDBLocal()
    ? "saas"
    : "self-hosted";
}
