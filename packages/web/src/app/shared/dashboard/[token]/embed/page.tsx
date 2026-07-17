import type { Metadata } from "next";
import { headers } from "next/headers";
import { SharedDashboardView } from "../view";
import { fetchSharedDashboard } from "../fetch";
import { EmbedErrorView, buildEmbedThemeForceScript, resolveEmbedTheme } from "./embed";

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
  // `undefined` → no `?theme=` param: the embed follows the visitor's own system
  // preference (the root `theme-init` script stamps `documentElement`, and the
  // tiles read `useDarkMode()`). Otherwise the param forces a fixed theme.
  const theme = resolveEmbedTheme(themeParam);
  const forcedDark = theme === undefined ? undefined : theme === "dark";
  const result = await fetchSharedDashboard(token);

  // The proxy mints a per-request CSP nonce on `x-nonce`; stamp it onto our inline
  // theme-force script so it executes under the nonce-based `script-src` (mirrors
  // the root layout's no-flash theme script).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  if (!nonce && forcedDark !== undefined && process.env.NODE_ENV !== "production") {
    // No x-nonce means the CSP proxy didn't run for this render. Under a
    // nonce-based `script-src` (no 'unsafe-inline') the inline theme-force
    // script below is then silently CSP-blocked → the forced `?theme=` embed
    // renders with the WRONG chrome theme (the #4686 bug) and no other
    // breadcrumb. Surface it loudly in dev, exactly as RootLayout does; prod
    // stays resilient (React omits the nonce and the static next.config.ts CSP
    // still permits the inline script).
    console.warn(
      "[shared-dashboard/embed] no x-nonce header — the CSP proxy may not have run; the inline theme-force script may be CSP-blocked.",
    );
  }

  // Tailwind's dark variant here is `&:is(.dark *)` — the element bearing `.dark`
  // doesn't match it, only descendants do — so the wrapper carries `.dark` and the
  // inner shell's `dark:` modifiers fire against the forced theme. The forced
  // theme is ALSO threaded into the tiles (`forcedDark`) so the JS-themed charts
  // agree with the chrome, and pushed onto `documentElement` (via the inline
  // theme-force script) so a forced `?theme=light` can override a dark-OS visitor.
  return (
    <>
      {forcedDark !== undefined && (
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: buildEmbedThemeForceScript(forcedDark) }}
        />
      )}
      <div className={forcedDark ? "dark" : undefined} data-theme={theme ?? "system"}>
        {result.ok ? (
          <SharedDashboardView dashboard={result.data} forcedDark={forcedDark} />
        ) : (
          <EmbedErrorView reason={result.reason} />
        )}
      </div>
    </>
  );
}
