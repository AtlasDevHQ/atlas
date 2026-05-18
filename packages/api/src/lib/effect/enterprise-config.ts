/**
 * Core-side resolver for whether enterprise features are enabled.
 *
 * Mirrors `ee/src/index.ts:isEnterpriseEnabled` resolution order:
 *   1. `enterprise.enabled` in atlas.config.ts
 *   2. `ATLAS_ENTERPRISE_ENABLED` env var
 *
 * Promoted to core in #2571 (slice 9/11 of #2017) so `lib/auth/server.ts`
 * — which assembles the Better Auth plugin set before EE has a chance to
 * register a Layer — can decide whether to include the SCIM plugin
 * without statically importing `@atlas/ee/index`. The static EE import
 * was the "worst offender" called out in #2017: every other core →
 * `@atlas/ee` reference was lazy/dynamic.
 *
 * Kept as a tiny standalone module (not folded into `enterprise-layer.ts`
 * or `errors.ts`) so consumers don't transitively pull in Layer
 * machinery or Better Auth bindings — `server.ts` already sits at a
 * crowded crossroads of the dep graph.
 */

import { getConfig } from "@atlas/api/lib/config";

/**
 * Read whether enterprise features are enabled. Pure — no DB or Layer
 * dependencies.
 *
 * The matching helper in `enterprise-layer.ts:isEnterpriseEnabledLocal`
 * predates this module (slice 2/11 carved it out before the broader
 * extraction was scoped). Both implementations resolve identically; the
 * separate copy stays so `enterprise-layer.ts` keeps its self-contained
 * note about being the single permitted runtime EE reference.
 */
export function isEnterpriseEnabled(): boolean {
  const config = getConfig();
  if (config?.enterprise?.enabled !== undefined) {
    return config.enterprise.enabled;
  }
  return process.env.ATLAS_ENTERPRISE_ENABLED === "true";
}
