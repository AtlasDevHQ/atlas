// Helpers for the shared-dashboard EMBED route. Kept out of `page.tsx` so the
// theme resolver and the compact error view are unit-testable without rendering
// the async RSC. The embed is a frame around the same shared view
// (`../view.tsx`) — this file adds only the framable chrome (theme wrapper +
// iframe-appropriate error states), never a second data surface. No server-only
// imports may land here: `EmbedErrorView` also renders client-side via
// `OrgShareResolver` on the org-share auth-wall branch (#4718).

import type { FailReason } from "../share-result";

export type EmbedTheme = "light" | "dark";

/**
 * Resolve the optional `?theme=` query param into an explicit forced theme, or
 * `undefined` when the host wants the embed to follow the visitor's own system
 * preference. An iframe on a foreign origin has no reliable system-theme signal,
 * so the host opts into a fixed theme via the URL; omitting the param (the
 * default snippet) lets the visitor's `prefers-color-scheme` drive both chrome
 * and charts. Anything unrecognized follows the system with a warning rather
 * than silently forcing a guess.
 */
export function resolveEmbedTheme(raw: string | string[] | undefined): EmbedTheme | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "dark") return "dark";
  if (value === "light") return "light";
  if (value == null || value === "") return undefined;
  console.warn(
    `[shared-dashboard/embed] Unrecognized ?theme= value (got ${JSON.stringify(value)}); following the visitor's system theme.`,
  );
  return undefined;
}

/**
 * Pre-paint inline script for a forced-theme embed. It toggles `documentElement`'s
 * `.dark` to the resolved theme so a `?theme=` param OVERRIDES the visitor's own
 * system/localStorage preference — which the root `theme-init` script would
 * otherwise stamp onto `documentElement`. Without this, the project's
 * `&:is(.dark *)` dark variant fires off any `.dark` ancestor, so a forced
 * `?theme=light` embed loaded by a dark-OS visitor would still render dark chrome.
 * Emitted only when a theme is forced; a no-param embed keeps following the
 * visitor. Runs before the framed content paints, so there is no theme flash.
 */
export function buildEmbedThemeForceScript(dark: boolean): string {
  return `try{document.documentElement.classList.toggle("dark",${dark})}catch(e){}`;
}

/**
 * Compact, navigation-free error state for the embed. Unlike the standalone
 * page's `ErrorShell`, it never renders login/retry links — a link inside a
 * partner's iframe would either dead-end or hijack their frame. Revoked/expired
 * shares surface here, which is how the embed "dies" when the link does.
 */
export function EmbedErrorView({ reason }: { reason: FailReason }) {
  // Exhaustive switch (not a ternary chain) so a future `FetchResult` reason
  // fails the build here instead of silently rendering the generic message.
  let message: string;
  switch (reason) {
    // The embed is navigation-free (no in-frame login), so both auth reasons
    // resolve to explanatory copy rather than a CTA — but they stay DISTINCT so a
    // signed-in wrong-org viewer isn't told to "sign in" (#4690).
    case "login-required":
      message = "This dashboard is shared within an organization. Sign in to Atlas to view it.";
      break;
    case "membership-required":
      message =
        "This dashboard is shared within an organization you’re not a member of. Open it in Atlas with an account that has access.";
      break;
    case "expired":
      message = "This dashboard share link has expired.";
      break;
    case "not-found":
      message = "This dashboard could not be found.";
      break;
    case "network-error":
      message = "Could not reach Atlas. Please try again later.";
      break;
    case "server-error":
      message = "Could not load this dashboard. Please try again later.";
      break;
    default:
      reason satisfies never;
      message = "Could not load this dashboard. Please try again later.";
  }

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 focus:outline-none"
      >
        <div className="text-center">
          <h1 className="sr-only">Atlas dashboard embed unavailable</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
        </div>
      </main>
      <footer className="border-t border-zinc-200 px-4 py-3 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}
