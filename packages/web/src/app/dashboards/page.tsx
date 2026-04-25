import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { getApiBaseUrl } from "../shared/lib";
import { DashboardsEmptyState } from "./empty-state";
import { selectMostRecentDashboardId } from "./select-recent";
import type { Dashboard } from "@/ui/lib/types";

interface DashboardsListResponse {
  dashboards: Dashboard[];
  total?: number;
}

type FetchResult =
  | { ok: true; data: DashboardsListResponse }
  | { ok: false; reason: "auth-required" | "server-error" | "network-error" };

async function fetchDashboardsList(): Promise<FetchResult> {
  const headerStore = await headers();
  const cookieHeader = headerStore.get("cookie") ?? "";

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/v1/dashboards`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth-required" };
    }
    if (!res.ok) {
      console.error(
        `[dashboards-redirect] API returned ${res.status} listing dashboards`,
      );
      return { ok: false, reason: "server-error" };
    }
    const data = (await res.json()) as DashboardsListResponse;
    if (!data || !Array.isArray(data.dashboards)) {
      console.error(
        "[dashboards-redirect] Unexpected response shape from /api/v1/dashboards",
      );
      return { ok: false, reason: "server-error" };
    }
    return { ok: true, data };
  } catch (err) {
    console.error(
      "[dashboards-redirect] Failed to fetch dashboards:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "network-error" };
  }
}

/**
 * /dashboards is no longer a list. The most-recently-updated dashboard *is* the
 * page — this component looks one up server-side and 307s into it. The list
 * view is preserved as a modal launchable from the detail topbar switcher (see
 * dashboard-switcher.tsx). Empty workspaces fall through to an inline
 * empty-state CTA so a brand-new user lands somewhere actionable.
 */
export default async function DashboardsPage() {
  const result = await fetchDashboardsList();

  if (!result.ok) {
    if (result.reason === "auth-required") redirect("/login?redirect=/dashboards");
    return (
      <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950">
        <NavBar isAdmin={false} />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 text-center">
          <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            Couldn&rsquo;t load your dashboards
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {result.reason === "network-error"
              ? "Could not reach the server. Check your connection and try again."
              : "The server encountered an error. Try refreshing the page."}
          </p>
          <Button asChild size="sm" variant="outline" className="mt-6">
            <Link href="/dashboards">Try again</Link>
          </Button>
        </main>
      </div>
    );
  }

  const targetId = selectMostRecentDashboardId(result.data.dashboards);
  if (!targetId) return <DashboardsEmptyState />;
  redirect(`/dashboards/${targetId}`);
}
