"use client";

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import type { WorkspaceBrandingPublic } from "@/ui/lib/types";

export type { WorkspaceBrandingPublic } from "@/ui/lib/types";

/**
 * Fetch workspace branding from the public endpoint.
 * Returns null while loading or if no custom branding is set.
 */
export function useBranding() {
  const { data, loading, error } = useAdminFetch<WorkspaceBrandingPublic | null>(
    "/api/v1/branding",
    {
      transform: (json) => {
        if (typeof json === "object" && json !== null && "branding" in json) {
          return (json as { branding: WorkspaceBrandingPublic | null }).branding;
        }
        return null;
      },
    },
  );

  return { branding: data ?? null, loading, error: error?.message ?? null };
}
