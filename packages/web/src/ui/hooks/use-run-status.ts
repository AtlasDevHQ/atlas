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
}

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
  const [runStatus, setRunStatus] = useState<RunStatusResponse | null>(null);

  // Stable getters via refs so the fetch callback identity doesn't churn every
  // render (the parent passes fresh getHeaders/getCredentials closures).
  const getHeadersRef = useRef(getHeaders);
  getHeadersRef.current = getHeaders;
  const getCredentialsRef = useRef(getCredentials);
  getCredentialsRef.current = getCredentials;

  // Single fetch-and-commit path shared by the on-change effect and `refetch`.
  // `isStale` lets the caller drop a late response: the effect passes its
  // cleanup-driven `cancelled` flag so a previous conversation's in-flight load
  // can't commit over the current one (and an unmount can't setState). A bare
  // `refetch()` passes the always-fresh default. Fail-soft: any error collapses
  // to `null` (no affordance) — a load-time enhancement must never block opening
  // a conversation.
  const fetchInto = useCallback(
    async (isStale: () => boolean = () => false): Promise<void> => {
      if (!enabled || !conversationId) {
        if (!isStale()) setRunStatus(null);
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
        if (!isStale()) setRunStatus(data);
      } catch (err: unknown) {
        if (!isStale()) {
          console.warn(
            "Failed to load run status:",
            err instanceof Error ? err.message : String(err),
          );
          setRunStatus(null);
        }
      }
    },
    [apiUrl, conversationId, enabled],
  );

  // Fetch on conversation change. A stale in-flight response for a previous
  // conversation must not commit over the current one, so the cleanup flag is
  // threaded through `fetchInto` as `isStale`.
  useEffect(() => {
    let cancelled = false;
    void fetchInto(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchInto]);

  const refetch = useCallback(() => fetchInto(), [fetchInto]);
  const clear = useCallback(() => setRunStatus(null), []);

  return { runStatus, refetch, clear };
}
