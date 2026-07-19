/**
 * SSE stream-liveness tracking shared by the MCP transports (sse.ts +
 * hosted.ts).
 *
 * ── Why this exists (#3492 review follow-up) ───────────────────────
 *
 * The idle-session sweep evicts sessions whose `lastSeenAt` is older than
 * the idle timeout. But `lastSeenAt` is refreshed per *dispatch*, and the
 * standalone GET SSE notification stream is a single dispatch that then
 * stays open for the whole life of the connection. A client that opens the
 * notification channel and then sits quiet (no POST frames) would age out
 * of `lastSeenAt` and could be swept mid-stream under cap-pressure —
 * dropping a still-connected listener.
 *
 * The MCP SDK's `WebStandardStreamableHTTPServerTransport` exposes no
 * public "stream closed" event (its stream bookkeeping is private), so the
 * transport-agnostic way to learn when the notification stream actually
 * ends is to wrap the streamed Response body and observe its close / cancel
 * / error. While the stream is open the owning session is marked active and
 * the sweep skips it; when it closes we release the mark and reset the idle
 * clock from the moment the client actually disconnected.
 *
 * Only the GET notification stream is wrapped: it's the one stream that can
 * stay open while *quiet*, so it's the only one a `lastSeenAt`-based sweep can
 * wrongly age out. A POST response can also be `text/event-stream` (a
 * long-running tool call streams its result), but it's actively producing and
 * closes once the result is sent — and `lastSeenAt` was just refreshed at
 * dispatch — so it's never the eviction target. Wrapping POSTs would add
 * per-chunk overhead on the hot path for no idle-eviction benefit.
 */

export interface StreamLifetimeHooks {
  /** Fires synchronously when a long-lived SSE stream is handed to the client. */
  readonly onOpen: () => void;
  /** Fires once when that stream ends — client disconnect, server end, or error. */
  readonly onClose: () => void;
  /**
   * Fires if the underlying source stream throws mid-flight, just before the
   * error is propagated to the client via `controller.error`. The wrapper is
   * transport-agnostic and has no logger of its own, so this is the seam a
   * caller uses to log the failure server-side — `controller.error` only ever
   * reaches the client, which on a disconnecting SSE socket is often already
   * gone, so without this the fault would be operator-invisible.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * Fires on each successfully-enqueued chunk (after `controller.enqueue`).
   * Used by POST event-stream tracking (#3576) to keep `lastSeenAt` current
   * during long-running streaming tool calls so the idle sweep never sweeps a
   * session mid-flight.
   *
   * Not fired on the final "done" frame (use `onClose` for that). Optional —
   * GET notification streams don't need per-chunk activity updates since their
   * liveness is tracked via `activeStreams`.
   */
  readonly onActivity?: () => void;
}

/** SSE comment frame (#4734). A line starting with `:` is a comment — the SSE
 * spec requires conformant parsers (incl. the MCP client's) to ignore it — so
 * it puts bytes on the wire without ever surfacing as a JSON-RPC message. */
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

export interface TrackStreamOptions {
  /**
   * #4734 — transport-agnostic keepalive. When set, the POST tool-call SSE
   * stream emits an SSE comment frame ({@link SSE_KEEPALIVE_FRAME}) whenever the
   * source produces nothing for `keepaliveMs`, so an intermediary idle-timeout
   * (Railway edge/LB, ~120s) can't drop a long agent run before its result is
   * sent. Unlike the progress-notification heartbeat (`progress.ts`), this works
   * for EVERY client — it doesn't require the client to have sent a
   * `progressToken`. Omit (GET notification streams) to skip the keepalive.
   */
  readonly keepaliveMs?: number;
}

/**
 * If `res` is an SSE (`text/event-stream`) streaming response, wrap its body
 * so `hooks.onOpen` fires now and `hooks.onClose` fires exactly once when the
 * stream completes, is cancelled by the client, or errors. Non-SSE or
 * body-less responses are returned untouched (nothing to track).
 *
 * The wrapper is a pull-driven byte-for-byte pass-through: it preserves SSE
 * ordering and backpressure (an idle stream parks in `reader.read()` rather
 * than spinning), so the client sees an identical stream. With
 * `opts.keepaliveMs` (#4734) it additionally injects an SSE comment frame each
 * time the source idles that long — see {@link TrackStreamOptions}.
 */
export function trackResponseStreamLifetime(
  res: Response,
  hooks: StreamLifetimeHooks,
  opts?: TrackStreamOptions,
): Response {
  const body = res.body;
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!body || !contentType.includes("text/event-stream")) {
    return res;
  }

  hooks.onOpen();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    hooks.onClose();
  };

  const reader = body.getReader();
  const keepaliveMs = opts?.keepaliveMs;
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;

  // A SINGLE in-flight read is retained across `pull` calls (`pendingRead`) so
  // the keepalive race never abandons — and thus never drops — a chunk: when
  // the timer wins we emit a comment frame and re-race the SAME still-pending
  // read on the next pull, so `reader.read()` is called exactly once per chunk.
  let pendingRead: Promise<ReadResult> | null = null;

  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!pendingRead) pendingRead = reader.read();

        if (keepaliveMs !== undefined) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = new Promise<"__keepalive__">((resolve) => {
            timer = setTimeout(() => resolve("__keepalive__"), keepaliveMs);
          });
          let raced: ReadResult | "__keepalive__";
          try {
            raced = await Promise.race([pendingRead, tick]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (raced === "__keepalive__") {
            // Source idled past the keepalive window — keep the connection warm
            // (pendingRead is retained so its eventual chunk is not lost). A
            // keepalive counts as liveness so the idle sweep doesn't evict a
            // session that is mid-run but quiet.
            controller.enqueue(SSE_KEEPALIVE_FRAME);
            hooks.onActivity?.();
            return;
          }
          pendingRead = null;
          if (raced.done) {
            controller.close();
            finish();
            return;
          }
          controller.enqueue(raced.value);
          hooks.onActivity?.();
          return;
        }

        const { done, value } = await pendingRead;
        pendingRead = null;
        if (done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(value);
        // Notify the caller that a chunk was successfully delivered. Used by
        // POST event-stream tracking (#3576) to keep `lastSeenAt` current
        // during long streaming tool calls so the idle sweep never evicts a
        // session that is actively producing output.
        hooks.onActivity?.();
      } catch (err) {
        // The source stream errored. Surface it to the caller for server-side
        // logging (controller.error only reaches the client), release the
        // liveness mark, then propagate. Normalize per the repo's caught-error
        // rule.
        pendingRead = null;
        hooks.onError?.(err);
        finish();
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
    cancel(reason) {
      // Client disconnected (Bun cancels the response body on socket close).
      finish();
      return reader.cancel(reason);
    },
  });

  return new Response(tracked, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
