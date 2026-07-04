"use client";

import { useCallback, useRef } from "react";
import { createAtlasFetch } from "../lib/fetch-client";

export interface UseStopHandlerOptions {
  /**
   * The chat's `stop` (from `useChat`). Aborts the client-side stream fetch and
   * flips `status` back to `ready`, unlocking the composer immediately.
   */
  stop: () => void;
  /**
   * The active turn's run id (captured from the `x-run-id` response header),
   * or `null` before any header has arrived. Read lazily at click time. The
   * chat clears its ref on each send, so in the pre-header sliver of a new
   * turn this is `null` (client-only stop) rather than the previous turn's id.
   */
  getRunId: () => string | null;
  apiUrl: string;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}

export interface UseStopHandlerReturn {
  /** Stop the in-flight turn. Safe to call when nothing is streaming. */
  stopTurn: () => void;
}

/**
 * #4294 — orchestrate the Stop button. Extracted from the chat component so the
 * sequence is unit-testable without the full `AtlasChat` harness:
 *
 *   1. `stop()` first — the composer unlocks NOW; the user never waits on the
 *      network for their own cancel;
 *   2. fire-and-forget `POST /chat/runs/:runId/stop` so generation stops
 *      server-side too (token spend ends at the abort, not the step cap).
 *      A 404 is the expected race (run already finished, or streaming on
 *      another instance) and is tolerated silently; any OTHER HTTP failure
 *      gets a console.warn — a persistent 401/500 means tokens burn on every
 *      stop and should not wear the benign-race label. Nothing is surfaced to
 *      the user either way: the visible outcome (stream stopped) already
 *      happened.
 *   3. no run id yet (stopped in the pre-header sliver) ⇒ client-only stop.
 */
export function useStopHandler(opts: UseStopHandlerOptions): UseStopHandlerReturn {
  const { stop, getRunId, apiUrl, getHeaders, getCredentials } = opts;
  // Latest-value refs so `stopTurn` stays referentially stable across renders
  // (it lands inside the composer's render tree) while always acting on the
  // current stream/auth state.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const getRunIdRef = useRef(getRunId);
  getRunIdRef.current = getRunId;
  const getHeadersRef = useRef(getHeaders);
  getHeadersRef.current = getHeaders;
  const getCredentialsRef = useRef(getCredentials);
  getCredentialsRef.current = getCredentials;

  const stopTurn = useCallback(() => {
    const runId = getRunIdRef.current();
    stopRef.current();
    if (!runId) return;
    const api = createAtlasFetch({
      apiUrl,
      getHeaders: () => getHeadersRef.current(),
      getCredentials: () => getCredentialsRef.current(),
    });
    api
      .raw("POST", `/api/v1/chat/runs/${runId}/stop`)
      .then((res) => {
        if (res.ok || res.status === 404) return; // 404 = expected race: already finished / other instance
        console.warn(`Server-side stop failed: HTTP ${res.status} — generation may run to its budget`);
      })
      .catch((err: unknown) => {
        // Network-level failure; the client-side stop already delivered the
        // user-visible outcome.
        console.debug(
          "Server-side stop skipped:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }, [apiUrl]);

  return { stopTurn };
}
