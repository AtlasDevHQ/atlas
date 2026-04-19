/**
 * Bulk-action result summarizers. Two shapes of bulk response exist:
 *
 *  1. **Client-side fan-out** — caller `Promise.allSettled`s N requests
 *     and feeds rejections into `bulkFailureSummary`. Used where no
 *     atomic bulk endpoint exists server-side.
 *  2. **Server-side partial success** — `POST /bulk` returns 200 even when
 *     individual rows fail, with `{ updated, notFound, errors? }`. Feed
 *     the parsed body to `bulkPartialSummary`.
 *
 * Both return a single banner-friendly string.
 */

export interface BulkPartialResult {
  updated?: string[];
  notFound?: string[];
  errors?: Array<{ id: string; error: string }>;
}

/** Indices of `results` that rejected, mapped back to their input ids. */
export function failedIdsFrom(
  results: PromiseSettledResult<unknown>[],
  ids: string[],
): string[] {
  return results.flatMap((r, i) => (r.status === "rejected" ? [ids[i]] : []));
}

/** "3 of 5 denials failed: 2× Forbidden; 1× Internal error" — counts per reason. */
export function bulkFailureSummary(
  results: PromiseSettledResult<unknown>[],
  ids: string[],
  noun: string,
): string {
  const reasonCounts = new Map<string, number>();
  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      reasonCounts.set(msg, (reasonCounts.get(msg) ?? 0) + 1);
    }
  }
  const failedCount = [...reasonCounts.values()].reduce((a, b) => a + b, 0);
  const summary = [...reasonCounts.entries()]
    .map(([msg, n]) => `${n}× ${msg}`)
    .join("; ");
  return `${failedCount} of ${ids.length} ${noun} failed: ${summary}`;
}

/**
 * Summarize a partial-success bulk response.
 * "3 of 10 approvals failed: 2 not found; 1× db timeout"
 *
 * `total` is the number of rows originally requested (so the ratio shows
 * "failed / requested", not "failed / touched").
 */
export function bulkPartialSummary(
  data: BulkPartialResult,
  total: number,
  noun: string,
): string {
  const notFoundCount = data.notFound?.length ?? 0;
  const errorCount = data.errors?.length ?? 0;
  const failed = notFoundCount + errorCount;

  const parts: string[] = [];
  if (notFoundCount > 0) parts.push(`${notFoundCount} not found`);
  if (errorCount > 0) {
    const errReasons = new Map<string, number>();
    for (const e of data.errors ?? []) {
      errReasons.set(e.error, (errReasons.get(e.error) ?? 0) + 1);
    }
    parts.push(
      [...errReasons.entries()].map(([msg, n]) => `${n}× ${msg}`).join("; "),
    );
  }
  return `${failed} of ${total} ${noun} failed: ${parts.join("; ")}`;
}
