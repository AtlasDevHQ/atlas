import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { getApiBaseUrl, truncate } from "../../lib";
import { SharedDashboardView } from "./view";
import type { SharedDashboard } from "./types";

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

type FetchResult =
  | { ok: true; data: SharedDashboard }
  | { ok: false; reason: "not-found" | "expired" | "auth-required" | "server-error" | "network-error" };

async function fetchSharedDashboard(token: string): Promise<FetchResult> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/api/public/dashboards/${encodeURIComponent(token)}`,
      // No cache — dashboard data may be sensitive; revoked links should be dead immediately
      { cache: "no-store" },
    );
    if (!res.ok) {
      if (res.status === 404) return { ok: false, reason: "not-found" };
      if (res.status === 410) return { ok: false, reason: "expired" };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth-required" };
      console.error(`[shared-dashboard] API returned ${res.status} for token=${token}`);
      return { ok: false, reason: "server-error" };
    }
    const data = await res.json();
    if (!data || !data.title) {
      console.error(`[shared-dashboard] Unexpected response shape for token=${token}`);
      return { ok: false, reason: "server-error" };
    }
    return { ok: true, data: data as SharedDashboard };
  } catch (err) {
    console.error(
      `[shared-dashboard] Failed to fetch token=${token}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "network-error" };
  }
}

// ---------------------------------------------------------------------------
// Metadata (OG tags)
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const result = await fetchSharedDashboard(token);

  const fallbackTitle = "Atlas \u2014 Shared Dashboard";
  const fallbackDescription = "A shared dashboard from Atlas, the text-to-SQL data analyst.";

  if (!result.ok) {
    return {
      title: fallbackTitle,
      description: fallbackDescription,
      openGraph: { title: fallbackTitle, description: fallbackDescription, type: "article", siteName: "Atlas" },
      twitter: { card: "summary", title: fallbackTitle, description: fallbackDescription },
    };
  }

  const dash = result.data;
  const title = `Atlas: ${truncate(dash.title, 60)}`;
  const cardCount = dash.cards.length;
  const description = dash.description
    ? truncate(dash.description, 160)
    : `Dashboard with ${cardCount} card${cardCount !== 1 ? "s" : ""} — shared from Atlas.`;

  return {
    title,
    description,
    openGraph: { title, description, type: "article", siteName: "Atlas" },
    twitter: { card: "summary", title, description },
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SharedDashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchSharedDashboard(token);

  if (!result.ok) {
    const heading =
      result.reason === "auth-required" ? "Authentication required"
        : result.reason === "expired" ? "Dashboard link expired"
        : result.reason === "not-found" ? "Dashboard not found"
        : result.reason === "network-error" ? "Connection failed"
        : "Unable to load dashboard";
    const message =
      result.reason === "auth-required" ? "This dashboard is shared within an organization. Please log in to view it."
        : result.reason === "expired" ? "This share link has expired. Ask the dashboard owner to create a new one."
        : result.reason === "not-found" ? "This dashboard may have been removed or the link may be invalid."
        : result.reason === "network-error" ? "Could not reach the server. Check your connection and try again."
        : "The server encountered an error loading this dashboard. Try refreshing the page.";

    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">{message}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            {result.reason === "auth-required" ? (
              <Link
                href={`/login?redirect=${encodeURIComponent(`/shared/dashboard/${token}`)}`}
                className={buttonVariants()}
              >
                Log in
              </Link>
            ) : (
              <Link href="/" className={buttonVariants()}>Go to Atlas</Link>
            )}
            {result.reason !== "not-found" && result.reason !== "auth-required" && (
              <Link
                href={`/shared/dashboard/${token}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Try again
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <SharedDashboardView dashboard={result.data} />;
}
