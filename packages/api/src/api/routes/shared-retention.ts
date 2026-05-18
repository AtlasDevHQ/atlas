/**
 * Shared retention infrastructure — typed domain-error mapping used by
 * both `admin-audit-retention.ts` (audit_log governance) and
 * `admin-action-retention.ts` (admin_action_log governance + GDPR
 * erasure).
 *
 * Pre-#2594 each route file declared its own
 * `const retentionDomainError = domainError(RetentionError, ...)` with
 * identical statusMap. Promoting the constant prevents the two from
 * drifting (`domainError`'s `TCode` inference means a missing code is
 * already a `tsgo` error, but only at the call site — having two call
 * sites means a change must land in both).
 */

import { domainError, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { RetentionError } from "@atlas/api/lib/audit/retention-errors";

export const retentionDomainError: DomainErrorMapping = domainError(RetentionError, {
  validation: 400,
  not_found: 404,
});
