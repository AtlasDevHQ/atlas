"use client";

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
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
 * Defaults to `"self-hosted"` while loading or on error.
 */
export function useDeployMode(): { deployMode: DeployMode; loading: boolean } {
  const { data, loading } = useAdminFetch<SettingsResponse>("/api/v1/admin/settings");

  return {
    deployMode: data?.deployMode ?? "self-hosted",
    loading,
  };
}
