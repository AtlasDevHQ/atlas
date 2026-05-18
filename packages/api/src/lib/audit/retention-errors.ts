/**
 * Audit-retention error class — promoted to core in #2569 so the
 * `AuditRetention` Tag in `lib/effect/services.ts` can type its failure
 * channel without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/audit/retention.ts` re-exports for back-compat. The
 * structural identity (`_tag` + payload) means existing `instanceof`
 * checks and `domainError(...)` mappings work unchanged.
 */

import { Data } from "effect";

export type RetentionErrorCode = "validation" | "not_found";

export class RetentionError extends Data.TaggedError("RetentionError")<{
  message: string;
  code: RetentionErrorCode;
}> {}
