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
      const res = await fetch(`${apiUrl}/api/v1/mode`, { credentials, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ModeStatusResponse;
    },
    retry: false,
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
  };
}
