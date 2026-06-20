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
  /** Surface a transient failure message to the user. */
  onError: (message: string) => void;
}

export interface UseResumeHandlerReturn {
  /** True while a user-initiated resume stream is in flight. */
  resuming: boolean;
  /** Activate the resume. Re-entrant calls (already resuming / streaming) are no-ops. */
  resume: () => void;
}

/**
 * #3749 — orchestrate a user-initiated resume of an interrupted turn. Extracted
 * from the chat component so the AC-bearing sequence is unit-testable without the
 * full `AtlasChat` harness:
 *
 *   1. re-entrancy guard — ignore while already resuming or a stream is live, so
 *      a double-click can't fork the turn or double-charge the step budget;
 *   2. optimistic clear of the banner + set the in-flight flag;
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
    onError,
  } = opts;
  const [resuming, setResuming] = useState(false);

  const resume = useCallback(() => {
    if (resuming || isLoading) return;
    setResuming(true);
    clearRunStatus();
    resetPendingWarnings();
    regenerate({ body: { [ATLAS_RESUME_MARKER]: true } })
      .catch((err: unknown) => {
        console.error(
          "Failed to resume turn:",
          err instanceof Error ? err.message : String(err),
        );
        onError("Failed to resume the interrupted turn. Please try again.");
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
    onError,
  ]);

  return { resuming, resume };
}
