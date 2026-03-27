/**
 * Shared domain infrastructure — schemas, error mapping, module loading,
 * and error sanitization used by both admin-domains.ts (workspace) and
 * platform-domains.ts (platform admin).
 */

import { z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import type { DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { DomainError, type DomainErrorCode } from "@atlas/ee/platform/domains";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const log = createLogger("domains-shared");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CustomDomainSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  domain: z.string(),
  status: z.enum(["pending", "verified", "failed"]),
  railwayDomainId: z.string().nullable(),
  cnameTarget: z.string().nullable(),
  certificateStatus: z.enum(["PENDING", "ISSUED", "FAILED"]).nullable(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Infrastructure error codes whose messages may contain internal details. */
const SANITIZED_CODES = new Set<DomainErrorCode>([
  "railway_error",
  "railway_not_configured",
  "data_integrity",
]);

const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, ContentfulStatusCode> = {
  no_internal_db: 503,
  invalid_domain: 400,
  duplicate_domain: 409,
  domain_not_found: 404,
  railway_error: 502,
  railway_not_configured: 503,
  data_integrity: 500,
};

export const domainErrors: DomainErrorMapping[] = [
  [DomainError, DOMAIN_ERROR_STATUS],
];

// ---------------------------------------------------------------------------
// Module loader (lazy import — fail gracefully when ee is unavailable)
// ---------------------------------------------------------------------------

export type DomainsModule = typeof import("@atlas/ee/platform/domains");

export async function loadDomains(): Promise<DomainsModule | null> {
  try {
    return await import("@atlas/ee/platform/domains");
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      return null;
    }
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load domains module — unexpected error",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize DomainError messages for infrastructure errors before they
 * reach the client. Railway errors and data integrity errors may contain
 * internal infrastructure details that should not be exposed.
 *
 * User-facing errors (invalid_domain, duplicate_domain, domain_not_found)
 * pass through unmodified.
 */
export function sanitizeDomainError(err: unknown, requestId: string): void {
  if (err instanceof DomainError && SANITIZED_CODES.has(err.code)) {
    log.error({ err, code: err.code, requestId }, "Infrastructure domain error");
    err.message = `Domain service error (ref: ${requestId.slice(0, 8)})`;
  }
}
