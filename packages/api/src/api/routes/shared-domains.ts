/**
 * Shared domain infrastructure — schemas + error mapping used by both
 * admin-domains.ts (workspace) and platform-domains.ts (platform admin).
 * Infrastructure error sanitization happens in classifyError (hono.ts).
 *
 * Slice 10/11 of #2017 (#2572) inverted both routers to yield the
 * `Domains` Tag (`@atlas/api/lib/effect/services`) instead of
 * dynamic-importing `@atlas/ee/platform/domains`. The error class lives
 * in core (`@atlas/api/lib/platform/domains-errors`) post-#2572 so the
 * Tag can type its failure channel without core importing from
 * `@atlas/ee`. `loadDomains` was removed in the same slice — callers
 * now use `yield* Domains` and check `.available` to decide between the
 * EE-enabled path and the 404 fallback.
 */

import { z } from "@hono/zod-openapi";
import { domainError } from "@atlas/api/lib/effect/hono";
import { DomainError } from "@atlas/api/lib/platform/domains-errors";

// Re-export the shared wire shape so existing callers (admin-domains,
// platform-domains) keep their `./shared-domains` import path. The single
// source of truth lives in @useatlas/schemas — this module now owns only
// the domain-error mapping.
export { CustomDomainSchema } from "@useatlas/schemas";

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

