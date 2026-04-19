/**
 * Admin queue/moderation primitives.
 *
 * Shared vocabulary for the admin queue pages (/admin/actions,
 * /admin/learned-patterns, /admin/approval). Extracted per the #1551 rule
 * (extract on 3rd adopter) when /admin/approval joined the pattern.
 *
 * See individual module files for design rationale.
 */

export {
  bulkFailureSummary,
  bulkPartialSummary,
  failedIdsFrom,
  type BulkPartialResult,
} from "./bulk-summary";
export { useQueueRow } from "./use-queue-row";
export { RelativeTimestamp } from "./relative-timestamp";
export { ReasonDialog } from "./reason-dialog";
export { QueueFilterRow } from "./queue-filter-row";
