import type { Metadata } from "next";
import { truncate } from "../../lib";
import { SharedDashboardView } from "./view";
import { fetchSharedDashboard } from "./fetch";
import { isAuthWallReason } from "./share-result";
import { resolveErrorContent } from "./error-content";
import { ErrorShell } from "./error-shell";
import { OrgShareResolver } from "./org-share-resolver";

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

export default async function SharedDashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchSharedDashboard(token);

  if (!result.ok) {
    // The org-share auth wall. Under the SaaS cookie topology (ADR-0024) the
    // session cookie is host-only on the per-region API domain, so the RSC
    // fetch's cookie forward is structurally empty cross-origin and this SSR
    // verdict may be a false negative for a logged-in viewer. Hand off to the
    // client resolver, which retries with the viewer's browser credentials and
    // renders the same view — the #4690 login/membership split re-evaluated
    // against the viewer's REAL session (#4718). Every other failure (and the
    // public-share success path) stays pure SSR, unchanged.
    if (isAuthWallReason(result.reason)) {
      return <OrgShareResolver token={token} />;
    }
    return <ErrorShell token={token} content={resolveErrorContent(result.reason)} />;
  }

  return <SharedDashboardView dashboard={result.data} />;
}
