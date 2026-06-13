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
}

/**
 * If `res` is an SSE (`text/event-stream`) streaming response, wrap its body
 * so `hooks.onOpen` fires now and `hooks.onClose` fires exactly once when the
 * stream completes, is cancelled by the client, or errors. Non-SSE or
 * body-less responses are returned untouched (nothing to track).
 *
 * The wrapper is a pull-driven byte-for-byte pass-through: it preserves SSE
 * ordering and backpressure (an idle stream parks in `reader.read()` rather
 * than spinning), so the client sees an identical stream.
 */
export function trackResponseStreamLifetime(
  res: Response,
  hooks: StreamLifetimeHooks,
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
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // The source stream errored. Surface it to the caller for server-side
        // logging (controller.error only reaches the client), release the
        // liveness mark, then propagate. Normalize per the repo's caught-error
        // rule.
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
