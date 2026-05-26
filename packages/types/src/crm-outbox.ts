/**
 * CRM outbox wire types (#2735, slice 9 of 1.6.0).
 *
 * Shape of `crm_outbox` rows as surfaced to the platform-admin
 * `/platform/crm-outbox` UI. The table itself lives in core
 * (`packages/api/src/lib/lead-outbox/`); these types describe the
 * inspection surface, not the table.
 *
 * `OUTBOX_STATUSES` mirrors the `crm_outbox_status_chk` CHECK constraint
 * and the `OutboxStatus` union in `lib/lead-outbox/outbox.ts` —
 * `@useatlas/types` keeps the wire-format copy so `@useatlas/schemas`
 * can pin its `z.enum(...)` against the same tuple the API uses.
 */

export const OUTBOX_STATUSES = [
  "pending",
  "in_flight",
  "done",
  "dead",
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * List row — what the table view renders. `lastError` is truncated by
 * the API (full text is returned only by the detail endpoint) so the
 * list payload stays bounded even when a row carries a multi-KB stack
 * trace from a runaway upstream.
 */
export interface CrmOutboxRow {
  id: string;
  createdAt: string;
  eventType: string;
  status: OutboxStatus;
  attempts: number;
  /**
   * Truncated by the API in list responses; the detail endpoint
   * returns the full string under `fullLastError`. Null when the row
   * hasn't failed.
   */
  lastError: string | null;
  twentyPersonId: string | null;
  twentyNoteId: string | null;
  /** Stamped on terminal-state transitions (done / dead). Null otherwise. */
  processedAt: string | null;
  /** Upstream-supplied retry timestamp (Retry-After header). Null otherwise. */
  retryAfter: string | null;
  /** When the flusher last claimed this row. Null after a terminal write. */
  claimedAt: string | null;
}

/**
 * Detail row — what the row-detail view renders. Adds the full
 * untruncated payload + last_error so an operator can read the original
 * lead body and the upstream error verbatim.
 */
export interface CrmOutboxRowDetail extends CrmOutboxRow {
  /** Full, untruncated `last_error` text. */
  fullLastError: string | null;
  /** Untyped opaque event body — see EnqueueInput in lib/lead-outbox. */
  payload: unknown;
}
