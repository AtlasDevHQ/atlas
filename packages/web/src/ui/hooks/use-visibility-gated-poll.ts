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
 * `refetch` may return `void` (sync) or a Promise (e.g.
 * TanStack Query's `refetch` returns a `Promise<QueryObserverResult>`).
 * The hook accepts both shapes and routes any rejection through
 * `console.warn` — without that, a flaky endpoint would surface as an
 * unhandled-promise-rejection in the browser console with no
 * actionable signal, and the chip would silently freeze on its last
 * good value. The TanStack error state is still available to callers
 * via the `useAdminFetch` `error` field; this hook's logging is the
 * second-line backstop.
 */
export type VisibilityGatedRefetch = () => void | Promise<unknown>;

export function useVisibilityGatedPoll(
  refetch: VisibilityGatedRefetch,
  intervalMs: number,
): void {
  useEffect(() => {
    if (typeof document === "undefined") return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    // Centralized refetch invocation — guards against synchronous
    // throws AND promise rejections so the visibility listener / the
    // setInterval callback can never abort the loop. A regression
    // that fires a sync throw without this guard would deregister the
    // listener on its own, leaving the chip stuck after one bad
    // refetch. The `console.warn` is structured so a future log
    // pivot can recognize the source.
    const safeRefetch = () => {
      try {
        const ret = refetch();
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          (ret as Promise<unknown>).catch((err) => {
            console.warn(
              "[useVisibilityGatedPoll] refetch rejected — chip may be stale",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      } catch (err) {
        console.warn(
          "[useVisibilityGatedPoll] refetch threw synchronously — chip may be stale",
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    const start = () => {
      if (intervalId !== null) return;
      // We do NOT fire `refetch` here — the parent hook already fetched
      // on mount. Calling refetch immediately on every visibility change
      // would double-fire (once for visibilitychange, once more on the
      // first interval tick when the user returns within `intervalMs`).
      intervalId = setInterval(safeRefetch, intervalMs);
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
        safeRefetch();
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
