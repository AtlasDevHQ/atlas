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

/**
 * Rejection carrying the server's user-facing message and its requestId as
 * separate fields. Callers in fan-out bulk flows should throw this instead
 * of `new Error("${message} (Request ID: ${requestId})")` — that embedded
 * form causes `bulkFailureSummary` to group every row into its own bucket
 * (one per unique requestId) instead of collapsing identical failures.
 */
export class BulkRequestError extends Error {
  readonly requestId?: string;
  constructor(message: string, requestId?: string) {
    super(message);
    this.name = "BulkRequestError";
    this.requestId = requestId;
  }
}

/** Indices of `results` that rejected, mapped back to their input ids. */
export function failedIdsFrom(
  results: PromiseSettledResult<unknown>[],
  ids: string[],
): string[] {
  return results.flatMap((r, i) => (r.status === "rejected" ? [ids[i]] : []));
}

/**
 * "3 of 5 denials failed: 2× Forbidden (IDs: abc, def); 1× Internal error (ID: ghi)"
 *
 * Groups by message (so N identical failures collapse to one line). When any
 * grouped rejection carries a requestId, appends a trailing `(ID: …)` slot
 * per group so on-call still has the correlation token without splintering
 * the grouping.
 */
export function bulkFailureSummary(
  results: PromiseSettledResult<unknown>[],
  ids: string[],
  noun: string,
): string {
  const groups = new Map<string, { count: number; requestIds: string[] }>();
  for (const r of results) {
    if (r.status !== "rejected") continue;
    const reason = r.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const requestId = reason instanceof BulkRequestError ? reason.requestId : undefined;
    const group = groups.get(msg) ?? { count: 0, requestIds: [] };
    group.count += 1;
    if (requestId) group.requestIds.push(requestId);
    groups.set(msg, group);
  }
  const failedCount = [...groups.values()].reduce((a, g) => a + g.count, 0);
  const summary = [...groups.entries()]
    .map(([msg, { count, requestIds }]) => {
      if (requestIds.length === 0) return `${count}× ${msg}`;
      const label = requestIds.length === 1 ? "ID" : "IDs";
      return `${count}× ${msg} (${label}: ${requestIds.join(", ")})`;
    })
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
