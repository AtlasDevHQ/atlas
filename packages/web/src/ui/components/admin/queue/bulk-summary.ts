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
 * separate fields so `bulkFailureSummary` groups rejections by message
 * alone. Embedding the requestId into `message` would splinter each group
 * into a bucket of one, since no two requestIds repeat.
 */
export class BulkRequestError extends Error {
  readonly requestId?: string;
  constructor(message: string, requestId?: string) {
    super(message);
    this.name = "BulkRequestError";
    this.requestId = requestId;
  }
}

/**
 * Extract a correlated requestId from a Promise-rejection value. Accepts
 * BulkRequestError instances, `useAdminMutation`-style `{ fetchError:
 * { requestId } }` attachments, and direct `.requestId` string properties.
 * Returns undefined when no recognizable id is present. Exported so tests
 * can pin the union of accepted shapes.
 */
export function extractBulkRequestId(reason: unknown): string | undefined {
  if (reason instanceof BulkRequestError) return reason.requestId;
  if (reason != null && typeof reason === "object") {
    const fetchError = (reason as { fetchError?: unknown }).fetchError;
    if (fetchError != null && typeof fetchError === "object") {
      const id = (fetchError as { requestId?: unknown }).requestId;
      if (typeof id === "string") return id;
    }
    const direct = (reason as { requestId?: unknown }).requestId;
    if (typeof direct === "string") return direct;
  }
  return undefined;
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
 * Groups rejections by message; appends requestIds per group so identical
 * failures stay collapsed. RequestIds are extracted via
 * `extractBulkRequestId` so any rejection shape carrying a correlated id
 * (BulkRequestError, mutation fetchError attachment, direct .requestId)
 * contributes it.
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
    const requestId = extractBulkRequestId(reason);
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
 * `total` is the caller-supplied request count — pass in the input size,
 * not the server's touched count.
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
