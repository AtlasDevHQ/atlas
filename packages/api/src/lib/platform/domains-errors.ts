/**
 * Custom-domain error class — promoted to core in #2572 so the
 * `Domains` Tag in `lib/effect/services.ts` can type its failure
 * channel without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/platform/domains.ts` re-exports for back-compat. The
 * structural identity (`_tag` + payload) means existing `instanceof`
 * checks and `domainError(...)` mappings work unchanged.
 */

import { Data } from "effect";

export type DomainErrorCode =
  | "no_internal_db"
  | "invalid_domain"
  | "duplicate_domain"
  | "domain_not_found"
  | "railway_error"
  | "railway_not_configured"
  | "data_integrity";

export class DomainError extends Data.TaggedError("DomainError")<{
  message: string;
  code: DomainErrorCode;
}> {}
