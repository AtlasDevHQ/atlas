/**
 * Shared residency infrastructure — error mapping and module loading
 * used by both admin-residency.ts (workspace) and onboarding.ts (signup).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { domainError, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";

const log = createLogger("residency-shared");

// ---------------------------------------------------------------------------
// Error mapping (lazy — @atlas/ee is an optional dependency)
// ---------------------------------------------------------------------------

export type ResidencyModule = typeof import("@atlas/ee/platform/residency");

let _residencyDomainError: DomainErrorMapping | undefined;

/**
 * Build or return cached residency domain error mapping.
 * Lazy because the ResidencyError class comes from the dynamically-loaded
 * @atlas/ee module — static import would break when @atlas/ee is not installed.
 */
export function getResidencyDomainError(mod: ResidencyModule): DomainErrorMapping {
  if (!_residencyDomainError) {
    _residencyDomainError = domainError(mod.ResidencyError, {
      not_configured: 404,
      invalid_region: 400,
      already_assigned: 409,
      workspace_not_found: 404,
      no_internal_db: 503,
    });
  }
  return _residencyDomainError;
}

// ---------------------------------------------------------------------------
// Module loader (lazy import — fail gracefully when ee is unavailable)
// ---------------------------------------------------------------------------

export async function loadResidency(): Promise<ResidencyModule | null> {
  try {
    return await import("@atlas/ee/platform/residency");
  } catch (err) {
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      return null;
    }
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load residency module — unexpected error",
    );
    throw err;
  }
}
