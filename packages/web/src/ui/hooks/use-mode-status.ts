"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtlasConfig } from "@/ui/context";
import type { ModeStatusResponse } from "@useatlas/types/mode";

/**
 * Fetches `GET /api/v1/mode` for the current session. Used by UI surfaces
 * that need to know the resolved mode, demo workspace state, or per-table
 * draft counts (chip indicator, banner, publish button, pending-changes UI).
 *
 * Returns null while loading or on error — callers render nothing in that
 * case. Errors are non-fatal: a failed fetch should never block chat.
 */
export function useModeStatus(): {
  data: ModeStatusResponse | null;
  loading: boolean;
} {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const query = useQuery<ModeStatusResponse>({
    queryKey: ["mode-status", apiUrl],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/v1/mode`, { credentials, signal });
      } catch (err) {
        // Unmount / refetch abort is expected — re-throw without logging so
        // devtools and the browser console stay quiet on normal navigation.
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        // Network failure (offline, DNS, CORS) — log at debug so developers
        // inspecting the browser console can correlate a missing chip to the
        // root cause, without spamming users' consoles for expected errors.
        console.debug("useModeStatus fetch failed:", err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (!res.ok) {
        // Read body best-effort to preserve server-provided requestId / error
        // code when surfacing via devtools. Parse failures are non-fatal.
        const body = await res.text().catch(() => "");
        console.debug(`useModeStatus HTTP ${res.status}:`, body);
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ModeStatusResponse;
    },
    retry: false,
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
  };
}
