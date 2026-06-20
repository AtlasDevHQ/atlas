"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatusResponse, RunStatusValue } from "../lib/types";
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

/**
 * Consecutive poll-tick failures before the parked poll gives up (#3749). A
 * transient blip must not abandon the poll (it would defeat the auto-resume), so
 * a poll error is tolerated and retried — but a genuinely-down endpoint must not
 * busy-poll forever. After this many back-to-back failures the poll stops; the
 * last-known `parked` banner stays up so the user can still resume / reload.
 */
export const MAX_CONSECUTIVE_POLL_ERRORS = 5;

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
  // The currently-mounted conversation, so a `refetch()` issued for one
  // conversation drops its result if the conversation changed before it resolved
  // (the effect/poll have their own cleanup-flag guard; `refetch` has no closure
  // to hang one on, so it compares against this live ref instead).
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  // Last committed status, to detect the `parked → running` re-arm transition.
  const prevStatusRef = useRef<RunStatusValue | null>(null);
  // Consecutive poll-tick failures, so a transient blip retries but a hard-down
  // endpoint eventually gives up (see the poll effect). Reset on any success.
  const pollErrorCountRef = useRef(0);

  // Commit a freshly-read status AND detect the approval-park re-arm: a
  // `parked → running` flip means a reviewer RESOLVED the parked action — approve
  // OR deny both re-arm the run server-side (`resolveApprovalPark`; a denial
  // resumes to surface the rejection), and the server doesn't push to the
  // browser, so fire `onParkedResolved` once. Only that exact transition triggers
  // it — an initial `running` on load (prev was null) or a `parked → done/failed`
  // sweep do not.
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
  // setState).
  //
  // `clearOnError` governs the failure posture. The INITIAL load passes the
  // default `true`: a fetch error collapses to `null` (no affordance) so a
  // load-time enhancement never blocks opening a conversation. A POLL tick passes
  // `false`: a transient blip must NOT clear the last-known `parked` status —
  // doing so would tear down the poll and hide the auto-resume banner forever
  // (the exact AC3 behavior this exists to deliver fails on the first network
  // hiccup of a long park). On a poll error we keep the status, leave the
  // transition baseline untouched (an error commits nothing, so the next good
  // tick still detects `parked → running`), and let the caller retry. Returns
  // whether the fetch succeeded so the poll can count consecutive failures.
  const fetchInto = useCallback(
    async (isStale: () => boolean = () => false, clearOnError = true): Promise<boolean> => {
      if (!enabled || !conversationId) {
        if (!isStale()) {
          prevStatusRef.current = null;
          setRunStatus(null);
        }
        return true;
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
        return true;
      } catch (err: unknown) {
        if (!isStale()) {
          console.warn(
            "Failed to load run status:",
            err instanceof Error ? err.message : String(err),
          );
          if (clearOnError) {
            prevStatusRef.current = null;
            setRunStatus(null);
          }
          // else: keep the last-known status + transition baseline so a poll
          // survives a transient blip and still catches the later re-arm.
        }
        return false;
      }
    },
    [apiUrl, conversationId, enabled, commitStatus],
  );

  // Fetch on conversation change. A stale in-flight response for a previous
  // conversation must not commit over the current one, so the cleanup flag is
  // threaded through `fetchInto` as `isStale`. Reset the transition baseline +
  // poll-error count so a newly-opened conversation doesn't inherit the prior
  // one's status or its accumulated failures.
  useEffect(() => {
    let cancelled = false;
    prevStatusRef.current = null;
    pollErrorCountRef.current = 0;
    void fetchInto(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchInto]);

  // Poll while the latest run is `parked`. The server re-arms a resolved park
  // `parked → running` (approve OR deny) without pushing to the browser, so
  // polling is how a passively-waiting user's turn auto-resumes (AC3). Runs ONLY
  // while `parked`: a terminal/`running`/`none`/null status tears the interval
  // down (the effect re-runs when `runStatus.status` changes), so there is no
  // busy-poll on a settled run. Each tick passes `clearOnError: false` so a
  // transient blip doesn't clear the parked banner / kill the poll; consecutive
  // failures are counted, and after MAX_CONSECUTIVE_POLL_ERRORS the poll gives up
  // (leaving the last-known banner up) rather than busy-polling a down endpoint.
  useEffect(() => {
    if (runStatus?.status !== "parked") return;
    let cancelled = false;
    pollErrorCountRef.current = 0;
    const id = setInterval(() => {
      void fetchInto(() => cancelled, false).then((ok) => {
        if (cancelled) return;
        if (ok) {
          pollErrorCountRef.current = 0;
          return;
        }
        pollErrorCountRef.current += 1;
        if (pollErrorCountRef.current >= MAX_CONSECUTIVE_POLL_ERRORS) {
          console.warn(
            `Run-status poll giving up after ${MAX_CONSECUTIVE_POLL_ERRORS} consecutive failures; last-known status kept.`,
          );
          cancelled = true;
          clearInterval(id);
        }
      });
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runStatus?.status, fetchInto, pollIntervalMs]);

  // Discard `fetchInto`'s success boolean (only the poll's failure-ceiling uses
  // it) so `refetch` keeps its `Promise<void>` contract. Guard against staleness:
  // snapshot the conversation at call time and drop the result if the mounted
  // conversation changed before it resolved — otherwise a `refetch()` in flight
  // across a conversation switch (e.g. fired from a resume's `.finally`) could
  // commit the old conversation's status over the new one and corrupt the
  // `parked → running` baseline.
  const refetch = useCallback(async () => {
    const issuedFor = conversationIdRef.current;
    await fetchInto(() => conversationIdRef.current !== issuedFor);
  }, [fetchInto]);
  const clear = useCallback(() => {
    prevStatusRef.current = null;
    setRunStatus(null);
  }, []);

  return { runStatus, refetch, clear };
}
