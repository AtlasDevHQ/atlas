"use client";

import { useEffect, useState } from "react";
import { useAtlasConfig } from "@/ui/context";

export interface WorkspaceBrandingPublic {
  logoUrl: string | null;
  logoText: string | null;
  primaryColor: string | null;
  faviconUrl: string | null;
  hideAtlasBranding: boolean;
}

/**
 * Fetch workspace branding from the public endpoint and cache it.
 * Returns null while loading or if no custom branding is set.
 */
export function useBranding() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [branding, setBranding] = useState<WorkspaceBrandingPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  useEffect(() => {
    const controller = new AbortController();

    async function fetchBranding() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/branding`, {
          credentials,
          signal: controller.signal,
        });
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const json: unknown = await res.json();
        if (
          typeof json === "object" &&
          json !== null &&
          "branding" in json
        ) {
          const data = (json as { branding: WorkspaceBrandingPublic | null }).branding;
          if (!controller.signal.aborted) {
            setBranding(data);
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // intentionally ignored: branding fetch failure is non-critical — use defaults
        console.debug("useBranding: fetch failed", err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    fetchBranding();
    return () => controller.abort();
  }, [apiUrl, credentials]);

  return { branding, loading };
}
