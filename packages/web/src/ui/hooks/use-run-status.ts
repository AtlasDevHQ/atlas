"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatusResponse } from "../lib/types";
import { createAtlasFetch } from "../lib/fetch-client";

export interface UseRunStatusOptions {
  apiUrl: string;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
  /**
   * The conversation whose latest run status to fetch, or `null` to disable
   * (a fresh/unsaved chat has no persisted run to surface). The hook refetches
   * whenever this changes.
   */
  conversationId: string | null;
  /** Gate the fetch off until auth has resolved (avoids a pre-auth 401). */
  enabled: boolean;
  /**
   * #3749 — fired exactly once when a poll observes the latest run flip
   * `parked → running` (an admin approved the parked action, so the server
   * re-armed the turn via `resolveApprovalPark`). The chat wires this to its
   * resume handler so a passively-waiting user's turn continues without a manual
   * reload (AC3). Not fired for any other transition (e.g. an initial `running`
   * on load, or `parked → done/failed`). Omitted by callers that don't auto-resume.
   */
  onParkedResolved?: () => void;
  /**
   * #3749 — poll interval (ms) while the latest run is `parked`. The server's
   * `parked → running` re-arm is not pushed to the browser, so the hook polls to
   * catch it. Polling runs ONLY while `parked` and stops at a terminal/`running`/
   * `none` status. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}; omit to use it.
   */
  pollIntervalMs?: number;
}

/** Default poll cadence while a run is parked (#3749). 8s balances latency vs. load. */
export const DEFAULT_POLL_INTERVAL_MS = 8000;

export interface UseRunStatusReturn {
  /**
   * The latest run's status, or `null` while loading / when disabled. `none`
   * means "no run to surface" (no affordance). A fetch failure degrades to
   * `null` (treated as "no affordance") — a non-critical load-time enhancement
   * must never block opening a conversation.
   */
  runStatus: RunStatusResponse | null;
  /** Re-fetch the status (e.g. after an approval resolves, to clear a parked state). */
  refetch: () => Promise<void>;
  /** Locally clear the surfaced status (e.g. once the user activates resume). */
  clear: () => void;
}

/**
 * #3749 — read a conversation's latest durable-run status so the chat surface
 * can offer to resume an interrupted turn (`running`), show a waiting-on-approval
 * state (`parked`), or render nothing (`done`/`failed`/`none`). Fetched on
 * conversation change and re-fetchable on demand (`refetch`, e.g. after a resume
 * stream settles). Fail-soft: any error collapses to `null` (no affordance shown).
 */
export function useRunStatus(opts: UseRunStatusOptions): UseRunStatusReturn {
  const { apiUrl, getHeaders, getCredentials, conversationId, enabled } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [runStatus, setRunStatus] = useState<RunStatusResponse | null>(null);

  // Stable getters via refs so the fetch callback identity doesn't churn every
  // render (the parent passes fresh getHeaders/getCredentials closures).
  const getHeadersRef = useRef(getHeaders);
  getHeadersRef.current = getHeaders;
  const getCredentialsRef = useRef(getCredentials);
  getCredentialsRef.current = getCredentials;
  // The auto-resume callback via ref so the poll fires the latest one without
  // re-arming the interval each render.
  const onParkedResolvedRef = useRef(opts.onParkedResolved);
  onParkedResolvedRef.current = opts.onParkedResolved;
  // Last committed status, to detect the `parked → running` re-arm transition.
  const prevStatusRef = useRef<RunStatusResponse["status"] | null>(null);

  // Commit a freshly-read status AND detect the approval-park re-arm: a
  // `parked → running` flip means an admin approved the parked action (the
  // server re-armed the turn but doesn't push to the browser), so fire
  // `onParkedResolved` once. Only that exact transition triggers it — an initial
  // `running` on load (prev was null) or a `parked → done/failed` sweep do not.
  const commitStatus = useCallback((data: RunStatusResponse) => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = data.status;
    setRunStatus(data);
    if (prev === "parked" && data.status === "running") {
      onParkedResolvedRef.current?.();
    }
  }, []);

  // Single fetch-and-commit path shared by the on-change effect, the poll, and
  // `refetch`. `isStale` lets the caller drop a late response: the effect/poll
  // pass their cleanup-driven `cancelled` flag so a previous conversation's
  // in-flight load can't commit over the current one (and an unmount can't
  // setState). A bare `refetch()` passes the always-fresh default. Fail-soft: any
  // error collapses to `null` (no affordance) — a load-time enhancement must
  // never block opening a conversation.
  const fetchInto = useCallback(
    async (isStale: () => boolean = () => false): Promise<void> => {
      if (!enabled || !conversationId) {
        if (!isStale()) {
          prevStatusRef.current = null;
          setRunStatus(null);
        }
        return;
      }
      const api = createAtlasFetch({
        apiUrl,
        getHeaders: () => getHeadersRef.current(),
        getCredentials: () => getCredentialsRef.current(),
      });
      try {
        const data = await api.get<RunStatusResponse>(
          `/api/v1/chat/${conversationId}/run-status`,
        );
        if (!isStale()) commitStatus(data);
      } catch (err: unknown) {
        if (!isStale()) {
          console.warn(
            "Failed to load run status:",
            err instanceof Error ? err.message : String(err),
          );
          prevStatusRef.current = null;
          setRunStatus(null);
        }
      }
    },
    [apiUrl, conversationId, enabled, commitStatus],
  );

  // Fetch on conversation change. A stale in-flight response for a previous
  // conversation must not commit over the current one, so the cleanup flag is
  // threaded through `fetchInto` as `isStale`. Reset the transition baseline so a
  // newly-opened parked conversation doesn't inherit the prior one's status.
  useEffect(() => {
    let cancelled = false;
    prevStatusRef.current = null;
    void fetchInto(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchInto]);

  // Poll while the latest run is `parked`. The server re-arms an approved park
  // `parked → running` without pushing to the browser, so polling is how a
  // passively-waiting user's turn auto-resumes (AC3). Runs ONLY while `parked`:
  // a terminal/`running`/`none`/null status tears the interval down (the effect
  // re-runs on every `runStatus` change), so there is no busy-poll on a settled
  // run. Each tick reuses `fetchInto` with the interval's own `cancelled` guard.
  useEffect(() => {
    if (runStatus?.status !== "parked") return;
    let cancelled = false;
    const id = setInterval(() => {
      void fetchInto(() => cancelled);
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runStatus?.status, fetchInto, pollIntervalMs]);

  const refetch = useCallback(() => fetchInto(), [fetchInto]);
  const clear = useCallback(() => {
    prevStatusRef.current = null;
    setRunStatus(null);
  }, []);

  return { runStatus, refetch, clear };
}
