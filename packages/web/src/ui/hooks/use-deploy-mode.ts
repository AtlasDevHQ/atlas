"use client";

import { useAdminFetch, type FetchError } from "@/ui/hooks/use-admin-fetch";
import type { DeployMode } from "@/ui/lib/types";

interface SettingsResponse {
  settings: unknown[];
  manageable: boolean;
  deployMode: DeployMode;
}

/**
 * Returns the resolved deploy mode from the admin settings API.
 *
 * Fetches from `/api/v1/admin/settings` and extracts the `deployMode` field.
 * Defaults to `"self-hosted"` while loading or on error. Exposes the error
 * so consumers can detect when the fallback is due to a fetch failure
 * (e.g., expired session) rather than an actual self-hosted deployment.
 */
export function useDeployMode(): {
  deployMode: DeployMode;
  loading: boolean;
  error: FetchError | null;
} {
  const { data, loading, error } = useAdminFetch<SettingsResponse>("/api/v1/admin/settings");

  if (error) {
    console.warn("useDeployMode: failed to fetch deploy mode, defaulting to self-hosted:", error);
  }

  return {
    deployMode: data?.deployMode ?? "self-hosted",
    loading,
    error,
  };
}
