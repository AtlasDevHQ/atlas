import {
  bulkFailureSummary,
  failedIdsFrom,
} from "@/ui/components/admin/queue";

export interface BulkResult {
  /** Banner copy when any request rejected. Null when nothing failed. */
  summary: string | null;
  /** Ids of requests that failed — caller narrows its selection to these. */
  remainingIds: Set<string>;
}

/**
 * Pure summary of a client-side bulk fan-out. Callers route `summary` to
 * their banner state and use `remainingIds` to narrow row selection so a
 * retry click targets exactly the rows that still need action.
 *
 * Index pairing between `results` and `ids` is compliance-sensitive — a
 * reorder bug would narrow selection to the wrong rows. Covered in
 * `bulk-result.test.ts`.
 */
export function summarizeBulkResult(
  results: PromiseSettledResult<unknown>[],
  ids: string[],
  noun: string,
): BulkResult {
  const failedIds = failedIdsFrom(results, ids);
  if (failedIds.length === 0) {
    return { summary: null, remainingIds: new Set() };
  }
  return {
    summary: bulkFailureSummary(results, ids, noun),
    remainingIds: new Set(failedIds),
  };
}
