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
  // #3584 — attach a no-op .catch to the cancellation promise so that if
  // work wins the race and abort fires AFTER the listener is removed in
  // `finally`, the resulting rejection has a handler and does not surface
  // as an unhandled promise rejection in the process. The rejection is
  // swallowed deliberately: by the time abort fires post-work, the caller
  // has already received the successful result.
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(new OperationCancelledError());
    extra.signal.addEventListener("abort", onAbort, { once: true });
  });
  // intentionally ignored: defuse the post-work abort race described above
  cancellation.catch(() => {});

  try {
    const result = await Promise.race([work(reporter, extra.signal), cancellation]);
    await emit(opts.total ?? 1, opts.endMessage);
    return result;
  } finally {
    if (onAbort) extra.signal.removeEventListener("abort", onAbort);
  }
}

/** Default keepalive cadence (#4734) — comfortably under the ~120s edge idle window. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Drive a keepalive heartbeat on a long-running dispatch (#4734).
 *
 * During a server-side agent run the POST Streamable-HTTP `text/event-stream`
 * emits ZERO application bytes, so an intermediary idle-timeout (Railway
 * edge/LB, ~120s) closes it before the run finishes → the client sees
 * `transport dropped`. Emitting periodic `notifications/progress` puts bytes on
 * the wire (they route onto the request stream via `relatedRequestId`) and keeps
 * it warm. Pair with {@link withProgressAndCancellation}: call this inside the
 * `work` callback with its `reporter`, and stop it in a `finally`.
 *
 * Progress is a bounded, strictly-increasing sequence (0.5, 0.667, 0.75, …)
 * that approaches — but never reaches — 1, so the wrapper's final
 * `progress(total ?? 1)` stays monotonic after any number of heartbeats. It is
 * indeterminate (no `total`): a blind timer, not real agent-step progress
 * (threading a step callback is a documented follow-up).
 *
 * NOTE: `reporter.report` only puts bytes on the wire when the client supplied
 * a `progressToken` (see {@link withProgressAndCancellation} — no-op otherwise).
 * Common hosted clients (Claude, Cursor) do, which covers the reported case; a
 * transport-agnostic `: ping` frame would cover the rest but needs an
 * SDK/transport hook (follow-up, out of scope).
 *
 * @returns a stop function — call it in a `finally` so the timer can never
 *   outlive the work.
 */
export function startHeartbeat(
  reporter: ProgressReporter,
  opts?: { readonly intervalMs?: number; readonly message?: string },
): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    // Bounded below 1 so a later final `progress(1)` is still monotonic.
    // Fire-and-forget: `reporter.report` swallows emit failures (see `emit`
    // above), so a failed keepalive never rejects here or fails the work.
    void reporter.report(1 - 1 / (ticks + 1), {
      ...(opts?.message ? { message: opts.message } : {}),
    });
  }, intervalMs);
  // Don't let the keepalive timer, on its own, hold the runtime open — the
  // work's promise is what the dispatch awaits. `unref` is Node/Bun-only.
  timer.unref?.();
  return () => clearInterval(timer);
}
