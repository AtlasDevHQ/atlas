"use client";

import { useCallback, useState } from "react";
import { ATLAS_RESUME_MARKER } from "./use-atlas-transport";

export interface UseResumeHandlerOptions {
  /**
   * The chat's `regenerate` (from `useChat`). Re-runs the last turn WITHOUT
   * adding a new user message — the marker body routes it to the resume endpoint
   * via the transport. Resolves/rejects when the stream settles.
   */
  regenerate: (opts: { body: Record<string, unknown> }) => Promise<void>;
  /** Clear the surfaced run-status banner (optimistic, on activate). */
  clearRunStatus: () => void;
  /** Re-fetch run status once the stream settles (clears/re-shows the banner). */
  refetchRunStatus: () => void | Promise<void>;
  /** True while a normal turn is streaming — resume is blocked then (one stream at a time). */
  isLoading: boolean;
  /** Drop any unattached warning frames before the resumed stream starts. */
  resetPendingWarnings: () => void;
  /**
   * #4297 — fires when a resume attempt actually begins, i.e. AFTER the
   * re-entrancy guard passes. Callers clear their resume-failure surface here
   * rather than before calling `resume()`, so a guarded no-op call can never
   * erase a failure banner without a retry actually happening.
   */
  onStart?: () => void;
  /**
   * Surface the failure to the user (rendered persistently — see #4297).
   * `detail` carries the narrowed underlying error message for the banner's
   * detail row, matching the pin/unpin failure surfaces.
   */
  onError: (message: string, detail?: string) => void;
}

export interface UseResumeHandlerReturn {
  /** True while a resume stream is in flight. */
  resuming: boolean;
  /** Activate the resume. Re-entrant calls (already resuming / streaming) are no-ops. */
  resume: () => void;
}

/**
 * #3749 — orchestrate a resume of an interrupted turn (user-initiated via the
 * banner, or auto-initiated on the parked→running poll flip). Extracted from
 * the chat component so the AC-bearing sequence is unit-testable without the
 * full `AtlasChat` harness:
 *
 *   1. re-entrancy guard — ignore while already resuming or a stream is live, so
 *      a double-click can't fork the turn or double-charge the step budget;
 *   2. set the in-flight flag, fire `onStart` (the caller's failure-banner
 *      supersede seam — #4297), and optimistically clear the run-status banner;
 *   3. `regenerate({ body: { [ATLAS_RESUME_MARKER]: true } })` — NOT `sendMessage`,
 *      so no phantom user message is appended; the marker routes it to the resume
 *      endpoint via the transport;
 *   4. on settle (resolve OR reject) clear the flag and re-fetch the status — a
 *      completed resume drops the banner, a re-interruption re-shows it, and a
 *      failed resume restores the still-resumable affordance (AC 1 & 3).
 */
export function useResumeHandler(opts: UseResumeHandlerOptions): UseResumeHandlerReturn {
  const {
    regenerate,
    clearRunStatus,
    refetchRunStatus,
    isLoading,
    resetPendingWarnings,
    onStart,
    onError,
  } = opts;
  const [resuming, setResuming] = useState(false);

  const resume = useCallback(() => {
    if (resuming || isLoading) return;
    setResuming(true);
    onStart?.();
    clearRunStatus();
    resetPendingWarnings();
    regenerate({ body: { [ATLAS_RESUME_MARKER]: true } })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("Failed to resume turn:", detail);
        onError("Failed to resume the interrupted turn. Please try again.", detail);
      })
      .finally(() => {
        setResuming(false);
        void refetchRunStatus();
      });
  }, [
    resuming,
    isLoading,
    regenerate,
    clearRunStatus,
    resetPendingWarnings,
    refetchRunStatus,
    onStart,
    onError,
  ]);

  return { resuming, resume };
}
