"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

const RegionsResponseSchema = z.object({
  configured: z.boolean(),
  defaultRegion: z.string(),
  availableRegions: z.array(z.unknown()),
});

export interface SignupContext {
  /** Whether to display the region step in the indicator. */
  showRegion: boolean;
  /** True until the region availability check resolves. */
  loading: boolean;
}

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return isCrossOrigin() ? "include" : "same-origin";
}

/**
 * Determines whether the multi-region step is in play for this signup flow.
 * The check is best-effort: if the endpoint fails or is unreachable, we fall
 * back to hiding the region step (matches the auto-skip behavior of the
 * region page itself).
 */
export function useSignupContext(): SignupContext {
  const [showRegion, setShowRegion] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBase()}/api/v1/onboarding/regions`, { credentials: getCredentials() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((raw) => RegionsResponseSchema.parse(raw))
      .then((data) => {
        if (cancelled) return;
        setShowRegion(data.configured && data.availableRegions.length > 0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Hidden region by default — matches the region page's own auto-skip
        // behavior when the API is unreachable or returns configured=false.
        console.warn(
          "[signup] region availability check failed:",
          err instanceof Error ? err.message : String(err),
        );
        setShowRegion(false);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { showRegion, loading };
}
