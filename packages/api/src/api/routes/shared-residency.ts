/**
 * Shared residency infrastructure — typed domain-error mapping used by
 * both `admin-residency.ts` (workspace) and `onboarding.ts` (signup) +
 * the platform routes.
 *
 * Post-#2564 the dynamic `await import("@atlas/ee/platform/residency")`
 * loader is gone — routes yield the `ResidencyResolver` Tag directly
 * inside their `Effect.gen` block, and the Hono bridge
 * (`runEffect`/`runHandler`) automatically provides `EnterpriseLayer`
 * so the no-op default (or the real EE impl when enterprise is on)
 * resolves without each route threading the layer through.
 */

import { domainError, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { ResidencyError } from "@atlas/api/lib/residency/errors";

/**
 * `ResidencyError` is the core class post-#2564, so the mapping is a
 * top-level constant. `domainError`'s `TCode` inference makes a missing
 * code surface as a `tsgo` error — replacing the lazy-init pattern the
 * pre-#2564 dynamic-import path needed when the class was reachable
 * only through `await import("@atlas/ee/platform/residency")`.
 */
export const residencyDomainError: DomainErrorMapping = domainError(ResidencyError, {
  not_configured: 404,
  invalid_region: 400,
  already_assigned: 409,
  workspace_not_found: 404,
  no_internal_db: 503,
});
