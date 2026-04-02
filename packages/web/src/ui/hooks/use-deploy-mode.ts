"use client";

import { useEffect } from "react";
import { useAdminFetch, type FetchError } from "@/ui/hooks/use-admin-fetch";
import { setRegionalApiUrl, getApiUrl } from "@/lib/api-url";
import type { DeployMode } from "@/ui/lib/types";

interface SettingsResponse {
  settings: unknown[];
  manageable: boolean;
  deployMode: DeployMode;
  regionApiUrl?: string;
}

/**
 * Returns the resolved deploy mode from the admin settings API.
 *
 * Fetches from `/api/v1/admin/settings` and extracts the `deployMode` field.
 * Defaults to `"self-hosted"` while loading or on error. Exposes the error
 * so consumers can detect when the fallback is due to a fetch failure
 * (e.g., expired session) rather than an actual self-hosted deployment.
 *
 * Also applies the regional API URL override when the settings response
 * includes a `regionApiUrl` (tier-2 data residency).
 */
export function useDeployMode(): {
  deployMode: DeployMode;
  loading: boolean;
  error: FetchError | null;
} {
  const { data, loading, error } = useAdminFetch<SettingsResponse>("/api/v1/admin/settings");

  useEffect(() => {
    if (error) {
      console.warn("useDeployMode: failed to fetch deploy mode, defaulting to self-hosted:", error);
    }
  }, [error]);

  // Apply or clear regional API URL override based on settings response
  useEffect(() => {
    if (!data) return;
    if (data.regionApiUrl) {
      if (data.regionApiUrl !== getApiUrl()) {
        setRegionalApiUrl(data.regionApiUrl);
      }
    } else {
      setRegionalApiUrl(null);
    }
  }, [data?.regionApiUrl]);

  return {
    deployMode: data?.deployMode ?? "self-hosted",
    loading,
    error,
  };
}
