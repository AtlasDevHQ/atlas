/**
 * Progress notifications + cancellation for long-running MCP dispatches
 * (#3500, spec 2025-11-25).
 *
 * The shared wrapper threads the client's `progressToken` (from the
 * `tools/call` `_meta`) into `notifications/progress`, and races the work
 * against `extra.signal` — aborted when the client sends
 * `notifications/cancelled` — so a cancelled dispatch stops awaiting
 * immediately and frees the MCP layer. `executeSQL` / `runMetric` are the
 * first consumers; the long-running profiling / semantic-gen tool (a later
 * tier) is the reason this is a shared seam rather than per-tool code.
 *
 * Cancellation scope: `work` also receives the `AbortSignal`, so an op that
 * natively honors it (profiling) aborts end to end. `executeSQL` does not yet
 * thread the signal into the driver, so a cancelled query is cut loose at the
 * MCP boundary and capped datasource-side by the existing statement timeout
 * (`ATLAS_QUERY_TIMEOUT`).
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

/** The `extra` arg every MCP request handler receives from the SDK. */
export type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Thrown when the client cancels an in-flight dispatch
 * (`notifications/cancelled`). The SDK suppresses the response for a
 * cancelled request, so this propagates only to stop the dispatch and is not
 * surfaced to the (already-gone) caller.
 */
export class OperationCancelledError extends Error {
  override readonly name = "OperationCancelledError";
  constructor() {
    super("operation cancelled by client");
  }
}

export interface ProgressReporter {
  /**
   * Emit an interim progress update. No-op when the client supplied no
   * `progressToken`. `progress` must increase monotonically across a call.
   */
  report(progress: number, opts?: { total?: number; message?: string }): Promise<void>;
}

export interface ProgressOptions {
  /** Known total units of work, if any (a determinate progress bar). */
  readonly total?: number;
  /** Message on the initial (0) progress notification. */
  readonly startMessage?: string;
  /** Message on the final progress notification. */
  readonly endMessage?: string;
}

/**
 * Run `work` with progress reporting + cancellation.
 *
 * - When the `tools/call` carried a `progressToken`, an initial progress (0)
 *   is emitted, `reporter.report` forwards interim updates, and a final
 *   progress (`total`, or `1`) is emitted on success. Without a token every
 *   emit is a no-op (zero overhead for clients that don't ask).
 * - `extra.signal` races the work; on cancellation the wrapper rejects with
 *   {@link OperationCancelledError} so the dispatch stops awaiting at once.
 */
export async function withProgressAndCancellation<T>(
  extra: McpRequestExtra,
  opts: ProgressOptions,
  work: (reporter: ProgressReporter, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;

  const emit = (progress: number, message?: string, total?: number): Promise<void> => {
    if (progressToken == null) return Promise.resolve();
    const effectiveTotal = total ?? opts.total;
    // Best-effort: a failed progress emit must never fail the underlying op.
    return extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          ...(effectiveTotal != null ? { total: effectiveTotal } : {}),
          ...(message ? { message } : {}),
        },
      })
      .catch(() => {});
  };

  const reporter: ProgressReporter = {
    report: (progress, o) => emit(progress, o?.message, o?.total),
  };

  if (extra.signal.aborted) throw new OperationCancelledError();
  await emit(0, opts.startMessage);

  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(new OperationCancelledError());
    extra.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const result = await Promise.race([work(reporter, extra.signal), cancellation]);
    await emit(opts.total ?? 1, opts.endMessage);
    return result;
  } finally {
    if (onAbort) extra.signal.removeEventListener("abort", onAbort);
  }
}
