"use client";

import { useEffect } from "react";

/**
 * Repeatedly fire `refetch` while the page is foregrounded; stop when
 * the tab moves to the background; refetch immediately on the
 * background → foreground transition so the user sees fresh state on
 * return without waiting for the next interval tick.
 *
 * Used by Settings → AI Agents (#2216) to keep the per-OAuth-client
 * live MCP usage chip current. Polling a backgrounded tab burns
 * batteries and rate-limit budget for no visible benefit — every
 * pollable surface in the app should default to the visibility gate.
 *
 * Why a custom hook instead of TanStack Query's `refetchInterval`:
 * the page's `useAdminFetch` wrapper does not pass through the
 * underlying TanStack options today. Adding the option to the wrapper
 * would push refetch-interval semantics onto every consumer that
 * doesn't need them; a focused hook keeps the contract narrow and
 * keeps the wrapper's signature stable for the rest of the app.
 *
 * Tests: e2e covers the visibility-gated path end-to-end (the chip
 * stops fetching when the tab hides, resumes on visibility change).
 */
export function useVisibilityGatedPoll(
  refetch: () => void,
  intervalMs: number,
): void {
  useEffect(() => {
    if (typeof document === "undefined") return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      // We do NOT fire `refetch` here — the parent hook already fetched
      // on mount. Calling refetch immediately on every visibility change
      // would double-fire (once for visibilitychange, once more on the
      // first interval tick when the user returns within `intervalMs`).
      intervalId = setInterval(refetch, intervalMs);
    };

    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        // Refetch *before* (re)starting the interval so the user sees
        // fresh state immediately on return — the visible interval
        // tick after a long invisibility could otherwise show stale
        // data for up to `intervalMs`.
        refetch();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refetch, intervalMs]);
}
