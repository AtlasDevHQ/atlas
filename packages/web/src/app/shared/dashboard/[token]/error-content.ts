// Pure resolver mapping a shared-dashboard fetch failure to the standalone
// page's error-shell content (heading, message, and which actions to offer).
// Extracted from `page.tsx` for the same extract-for-testability motive as
// `fetch.ts`: the copy + CTA choice per reason is unit-tested directly, without
// rendering the async RSC. The embed surface (`embed.tsx`) keeps its own
// navigation-free copy and does not consume this.

import type { FailReason } from "./share-result";
import type { ErrorContent } from "../../error-shell";

// The content/CTA shape lives with the shared `ErrorShell` (`../../error-shell`,
// #4719); re-exported so this surface's consumers keep one import site.
export type { ErrorContent, PrimaryAction } from "../../error-shell";

/**
 * Resolve the error shell's content for a failed shared-dashboard fetch.
 *
 * The `login-required` / `membership-required` split is the crux of #4690: a
 * logged-in viewer who is not a member of the sharing org is told about the
 * membership requirement and pointed at Atlas, NOT dead-ended on a "Log in" CTA
 * they already satisfy. A viewer with no session still gets the login redirect.
 */
export function resolveErrorContent(reason: FailReason): ErrorContent {
  switch (reason) {
    case "login-required":
      return {
        heading: "Sign in to view this dashboard",
        message:
          "This dashboard is shared within an organization. Sign in with an account in that organization to view it.",
        primaryAction: "login",
        showTryAgain: false,
      };
    case "membership-required":
      return {
        heading: "You don’t have access to this dashboard",
        message:
          "This dashboard is shared within an organization you’re not a member of. Ask the owner to share it with you, or switch to an account in that organization.",
        primaryAction: "home",
        showTryAgain: false,
      };
    case "expired":
      return {
        heading: "Dashboard link expired",
        message: "This share link has expired. Ask the dashboard owner to create a new one.",
        primaryAction: "home",
        showTryAgain: true,
      };
    case "not-found":
      return {
        heading: "Dashboard not found",
        message: "This dashboard may have been removed or the link may be invalid.",
        primaryAction: "home",
        showTryAgain: false,
      };
    case "network-error":
      return {
        heading: "Connection failed",
        message: "We couldn’t reach Atlas. Check your connection and try again.",
        primaryAction: "home",
        showTryAgain: true,
      };
    case "server-error":
      return {
        heading: "Unable to load dashboard",
        message: "Something went wrong on our end loading this dashboard. Please try again in a moment.",
        primaryAction: "home",
        showTryAgain: true,
      };
    default:
      // Exhaustiveness: a future `FetchResult` reason fails the build here rather
      // than silently rendering a generic shell.
      reason satisfies never;
      return {
        heading: "Unable to load dashboard",
        message: "Something went wrong loading this dashboard. Please try again in a moment.",
        primaryAction: "home",
        showTryAgain: true,
      };
  }
}
