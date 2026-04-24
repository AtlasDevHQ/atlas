/**
 * Wire types for audit-log and admin-action-log retention policies.
 *
 * Single source for the retention-policy row shape returned by
 * `/api/v1/admin/audit/retention` (query audit) and
 * `/api/v1/admin/audit/admin-action-retention` (admin-action audit).
 * EE library, API route schemas, and the admin UI all refer to this
 * type so a column rename in the DB flows through the whole stack at
 * `tsc` time instead of requiring hand-aligned parallel interfaces.
 */

export interface AuditRetentionPolicy {
  orgId: string;
  /** Number of days to retain audit entries. null = unlimited. Minimum 7 when set. */
  retentionDays: number | null;
  /** Days after soft-delete before hard-delete. Default 30. */
  hardDeleteDelayDays: number;
  /** ISO-8601 timestamp of the last policy write. */
  updatedAt: string;
  /** User id that wrote the last policy update, or null for pre-migration rows. */
  updatedBy: string | null;
  /** ISO-8601 timestamp of the most recent purge cycle run, or null if never purged. */
  lastPurgeAt: string | null;
  /** Rows affected by the last purge cycle, or null if never purged. */
  lastPurgeCount: number | null;
}

/**
 * Origination label for `user.erase` admin-action audit rows.
 *
 * - `self_request` — the user invoked a self-serve erasure surface.
 * - `dsr_request` — an admin processed a formal DSR letter on the user's behalf.
 * - `scheduled_retention` — reserved for future background erasure automation
 *   (not currently triggerable from any HTTP surface).
 */
export const AUDIT_ANONYMIZE_INITIATED_BY = [
  "self_request",
  "dsr_request",
  "scheduled_retention",
] as const;

export type AnonymizeInitiatedBy = (typeof AUDIT_ANONYMIZE_INITIATED_BY)[number];
