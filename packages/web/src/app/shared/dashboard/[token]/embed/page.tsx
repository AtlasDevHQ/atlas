import type { Metadata } from "next";
import { SharedDashboardView } from "../view";
import { fetchSharedDashboard } from "../fetch";
import { EmbedErrorView, resolveEmbedTheme } from "./embed";

// An embed is an iframe surface, not a page to index. The standalone
// `/shared/dashboard/[token]` route owns the OG/discovery metadata; this frame
// stays out of search results.
export const metadata: Metadata = { robots: { index: false, follow: false } };

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ theme?: string | string[] }>;
}

// Framable presentation of the shared dashboard view (#4564). SAME token, SAME
// data-only snapshot DTO (`fetchSharedDashboard` → `sharedDashboardViewSchema`),
// SAME revocation/expiry as the standalone page — the only differences are the
// any-origin `frame-ancestors *` header this route carries (next.config.ts /
// csp.ts `isEmbedRoute`) and the optional `?theme=` wrapper. The embed is a
// frame around the shared view, never a second sharing surface, so it renders
// the exact `SharedDashboardView` component the standalone page does.
export default async function SharedDashboardEmbedPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { theme: themeParam } = await searchParams;
  const theme = resolveEmbedTheme(themeParam);
  const result = await fetchSharedDashboard(token);

  // Tailwind's dark variant here is `&:is(.dark *)` — the element bearing `.dark`
  // doesn't match it, only descendants do — so the wrapper carries `.dark` and the
  // inner shell's `dark:` modifiers fire against the host-selected theme.
  return (
    <div className={theme === "dark" ? "dark" : ""} data-theme={theme}>
      {result.ok ? (
        <SharedDashboardView dashboard={result.data} />
      ) : (
        <EmbedErrorView reason={result.reason} />
      )}
    </div>
  );
}
