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

  const fallbackTitle = "Atlas — Shared Dashboard";
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
    : `Dashboard with ${cardCount} tile${cardCount !== 1 ? "s" : ""} — shared from Atlas.`;

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

type FailReason = Extract<FetchResult, { ok: false }>["reason"];

function ErrorShell({
  token,
  heading,
  message,
  reason,
}: {
  token: string;
  heading: string;
  message: string;
  reason: FailReason;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 focus:outline-none"
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">{message}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            {reason === "auth-required" ? (
              <Link
                href={`/login?redirect=${encodeURIComponent(`/shared/dashboard/${token}`)}`}
                className={buttonVariants()}
              >
                Log in
              </Link>
            ) : (
              <Link href="/" className={buttonVariants()}>Go to Atlas</Link>
            )}
            {reason !== "not-found" && reason !== "auth-required" && (
              <Link
                href={`/shared/dashboard/${token}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Try again
              </Link>
            )}
          </div>
        </div>
      </main>
      <footer className="border-t border-zinc-200 px-4 py-4 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}

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
      <ErrorShell
        token={token}
        heading={heading}
        message={message}
        reason={result.reason}
      />
    );
  }

  return <SharedDashboardView dashboard={result.data} />;
}
