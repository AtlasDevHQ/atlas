"use client";

import { useEffect, useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import type { WorkspaceBrandingPublic } from "@/ui/lib/types";

export type { WorkspaceBrandingPublic } from "@/ui/lib/types";

/**
 * Fetch workspace branding from the public endpoint.
 * Each component instance fetches independently on mount.
 * Returns null while loading or if no custom branding is set.
 */
export function useBranding() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [branding, setBranding] = useState<WorkspaceBrandingPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
          console.warn(`useBranding: branding endpoint returned ${res.status} — falling back to defaults`);
          if (!controller.signal.aborted) {
            setError(`HTTP ${res.status}`);
          }
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
        const msg = err instanceof Error ? err.message : String(err);
        console.debug("useBranding: fetch failed", msg);
        if (!controller.signal.aborted) {
          setError(msg);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    fetchBranding();
    return () => controller.abort();
  }, [apiUrl, credentials]);

  return { branding, loading, error };
}
