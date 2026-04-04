"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtlasContext } from "./provider";
import { AUTH_MODES, type AuthMode } from "../lib/types";

export interface HealthData {
  authMode: AuthMode;
  brandColor?: string;
}

/**
 * Shared health check query. Used by both `useAtlasAuth` and `AtlasChatInner`
 * via the same `["atlas", "health"]` query key — TanStack deduplicates to
 * a single request.
 */
export function useHealthQuery() {
  const { apiUrl, isCrossOrigin } = useAtlasContext();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  return useQuery<HealthData>({
    queryKey: ["atlas", "health"],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/health`, { credentials, signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[Atlas] Health check failed:", msg);
        throw new Error(`Health check failed: ${msg}`, { cause: err });
      }

      if (!res.ok) {
        console.warn(`[Atlas] Health check returned HTTP ${res.status}`);
        throw new Error(`Health check failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      const mode = data?.checks?.auth?.mode;
      if (typeof mode === "string" && AUTH_MODES.includes(mode as AuthMode)) {
        return { authMode: mode as AuthMode, brandColor: data?.brandColor };
      }
      console.warn("[Atlas] Health check returned no valid auth mode:", data);
      throw new Error("Health check returned no valid auth mode — server may be misconfigured");
    },
    // Match original retry behavior: 3 total attempts, 2s delay
    retry: 2,
    retryDelay: 2000,
  });
}
