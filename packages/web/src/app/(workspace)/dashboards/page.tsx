"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { friendlyError } from "@/ui/lib/fetch-error";
import { DashboardsEmptyState } from "./empty-state";
import { DashboardListSkeleton } from "@/ui/components/dashboards/dashboard-skeleton";
import { selectMostRecentDashboardId } from "./select-recent";
import type { Dashboard } from "@/ui/lib/types";

/**
 * /dashboards is a redirect-only index: it lists the workspace's dashboards
 * and forwards to the most-recently-updated one (or shows the empty state when
 * there are none).
 *
 * This is a CLIENT component on purpose. The previous server component read the
 * incoming request's `cookie` header and forwarded it to the cross-origin API
 * (`api.useatlas.dev`). Under ADR-0024 §5 the session cookie is host-only to
 * the API origin, so the browser never sends it to `app.useatlas.dev` — the SSR
 * fetch saw no session, 401'd, and bounced *logged-in* users to /login (#4089).
 * Fetching from the browser (like /notebook and /admin) lets the host-only
 * cookie attach automatically via `useAdminFetch`'s credentialed fetch — the
 * same browser-side credential path every other workspace route already uses.
 */
export default function DashboardsPage() {
  const router = useRouter();
  const { data, loading, error, refetch } = useAdminFetch<{
    dashboards: Dashboard[];
  }>("/api/v1/dashboards");

  // 401/403 is the genuine auth gate. Preserve the original /login bounce so an
  // unauthenticated visitor still lands on sign-in. (AuthGuard also recovers
  // unauthenticated users globally in managed mode; keeping this explicit makes
  // the gate mode-agnostic and independent of that backstop.)
  const isAuthError = error?.status === 401 || error?.status === 403;

  const targetId = data
    ? selectMostRecentDashboardId(data.dashboards ?? [])
    : null;

  useEffect(() => {
    if (isAuthError) {
      router.replace("/login?redirect=/dashboards");
      return;
    }
    if (targetId) {
      router.replace(`/dashboards/${targetId}`);
    }
  }, [isAuthError, targetId, router]);

  // Auth bounce or dashboard redirect in flight — show the layout-matching
  // skeleton (not a blank frame) so the redirect never flashes an empty screen
  // (#4323). The empty/error chrome is still gated below so it can't flash
  // before navigation lands.
  if (isAuthError || targetId) return <DashboardListSkeleton />;

  if (error) {
    return (
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 text-center">
        <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          Couldn&rsquo;t load your dashboards
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          {friendlyError(error)}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-6"
          onClick={() => refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  // Still loading the list (no data yet) — show the skeleton rather than a
  // blank frame while the fetch is in flight.
  if (loading || !data) return <DashboardListSkeleton />;

  // Loaded with no dashboards.
  return <DashboardsEmptyState />;
}
