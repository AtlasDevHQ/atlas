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
 * Falls back to a hostname-based guess while loading or on error (localhost
 * and private-network hosts → "self-hosted"; public-internet hosts → "saas")
 * so a slow fetch on `app.useatlas.dev` doesn't briefly lie to the user that
 * they're on a self-hosted deploy. Exposes the error so consumers can still
 * detect when the resolution is a guess rather than an authoritative answer.
 *
 * Also applies the regional API URL override when the settings response
 * includes a `regionApiUrl` (tier-2 data residency).
 */
function guessDeployModeFromHost(): DeployMode {
  if (typeof window === "undefined") return "self-hosted";
  const host = window.location?.hostname;
  if (!host) return "self-hosted";
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return "self-hosted";
  // Bare IPv4 → almost always a private/private-network self-host
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return "self-hosted";
  return "saas";
}

export function useDeployMode(opts?: { enabled?: boolean }): {
  deployMode: DeployMode;
  loading: boolean;
  error: FetchError | null;
} {
  // `enabled: false` skips the network call so non-admins don't 403 on
  // `/api/v1/admin/settings`. The returned `deployMode` then comes from
  // the hostname guess instead of the server — callers that need
  // authoritative truth should not pass `enabled: false`.
  const { data, loading, error } = useAdminFetch<SettingsResponse>(
    "/api/v1/admin/settings",
    { enabled: opts?.enabled },
  );

  useEffect(() => {
    if (error) {
      console.warn("useDeployMode: settings fetch failed — using hostname-based deploy mode guess:", error);
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
    deployMode: data?.deployMode ?? guessDeployModeFromHost(),
    loading,
    error,
  };
}
