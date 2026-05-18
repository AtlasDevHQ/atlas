/**
 * Shared `RetentionError`-to-HTTP mapping. `domainError`'s `TCode`
 * inference enforces exhaustiveness per call site; promoting prevents
 * the two retention route families (audit_log + admin_action_log) from
 * drifting on the statusMap. Mirrors `shared-residency.ts` /
 * `shared-domains.ts`.
 */

import { domainError, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { RetentionError } from "@atlas/api/lib/audit/retention-errors";

export const retentionDomainError: DomainErrorMapping = domainError(RetentionError, {
  validation: 400,
  not_found: 404,
});
