"use client";

/**
 * Member-visible trial status (#3434).
 *
 * Fetches `GET /api/v1/trial` — a standardAuth endpoint, so every workspace
 * member (not just admins) can read the trial clock instead of discovering
 * the trial via a hard 403 when enforcement cuts the workspace off.
 *
 * Failure posture: any fetch error (including 404 on deployments that
 * predate the route) resolves to `trial: null` — trial surfaces simply
 * hide. This endpoint only ever powers informational banners, so a broken
 * fetch must never block a page.
 */

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { TrialStatusSchema, type TrialStatus } from "@useatlas/schemas";

export type TrialInfo = NonNullable<TrialStatus["trial"]>;

export function useTrialStatus(opts?: { enabled?: boolean }): {
  trial: TrialInfo | null;
  loading: boolean;
} {
  const { data, loading, error } = useAdminFetch<TrialStatus>("/api/v1/trial", {
    schema: TrialStatusSchema,
    enabled: opts?.enabled ?? true,
  });

  // Errors deliberately collapse to "no trial" — see module doc. The hook
  // logs nothing extra here; useAdminFetch already console.warns network
  // failures.
  if (error || !data) {
    return { trial: null, loading };
  }
  return { trial: data.trial, loading };
}
