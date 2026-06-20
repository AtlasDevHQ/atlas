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
 * conversation change and re-fetchable on demand (poll after an approval
 * resolves). Fail-soft: any error collapses to `null` (no affordance shown).
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

  const fetchStatus = useCallback(async (): Promise<void> => {
    if (!enabled || !conversationId) {
      setRunStatus(null);
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
      setRunStatus(data);
    } catch (err: unknown) {
      // Non-critical: degrade to no affordance rather than surfacing an error.
      console.warn(
        "Failed to load run status:",
        err instanceof Error ? err.message : String(err),
      );
      setRunStatus(null);
    }
  }, [apiUrl, conversationId, enabled]);

  // Fetch on conversation change. A stale in-flight response for a previous
  // conversation must not commit over the current one, so a cancelled flag
  // gates the setState.
  useEffect(() => {
    let cancelled = false;
    if (!enabled || !conversationId) {
      setRunStatus(null);
      return;
    }
    const api = createAtlasFetch({
      apiUrl,
      getHeaders: () => getHeadersRef.current(),
      getCredentials: () => getCredentialsRef.current(),
    });
    api
      .get<RunStatusResponse>(`/api/v1/chat/${conversationId}/run-status`)
      .then((data) => {
        if (!cancelled) setRunStatus(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn(
            "Failed to load run status:",
            err instanceof Error ? err.message : String(err),
          );
          setRunStatus(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, conversationId, enabled]);

  const clear = useCallback(() => setRunStatus(null), []);

  return { runStatus, refetch: fetchStatus, clear };
}
