/**
 * Shared domain infrastructure — schemas, error mapping, and module loading
 * used by both admin-domains.ts (workspace) and platform-domains.ts (platform admin).
 * Infrastructure error sanitization happens in classifyError (hono.ts).
 */

import { z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { domainError } from "@atlas/api/lib/effect/hono";
import { DomainError } from "@atlas/ee/platform/domains";

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
  verificationToken: z.string().nullable(),
  domainVerified: z.boolean(),
  domainVerifiedAt: z.string().nullable(),
  domainVerificationStatus: z.enum(["pending", "verified", "failed"]),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export const DomainCheckResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
});

export const customDomainError = domainError(DomainError, {
  no_internal_db: 503,
  invalid_domain: 400,
  duplicate_domain: 409,
  domain_not_found: 404,
  railway_error: 502,
  railway_not_configured: 503,
  data_integrity: 500,
});

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

