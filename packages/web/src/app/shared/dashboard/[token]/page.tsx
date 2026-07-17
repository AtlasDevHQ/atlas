import type { Metadata } from "next";
import { truncate } from "../../lib";
import { SharedDashboardView } from "./view";
import { fetchSharedDashboard } from "./fetch";
import { resolveErrorContent } from "./error-content";
import { ErrorShell } from "./error-shell";

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
    return <ErrorShell token={token} content={resolveErrorContent(result.reason)} />;
  }

  return <SharedDashboardView dashboard={result.data} />;
}
