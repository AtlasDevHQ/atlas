// Pure resolver mapping a shared-conversation fetch failure to the standalone
// page's error-shell content (heading, message, and which actions to offer) —
// mirror of the dashboard's `dashboard/[token]/error-content.ts` (#4719). The
// copy is conversation-specific; the CTA policy it feeds (`login-required` and
// only it gets the login redirect, #4690) is enforced by the shared
// `ErrorShell` (`../error-shell.tsx`). The embed surface (`embed/view.tsx`)
// keeps its own navigation-free copy and does not consume this.

import type { FailReason } from "./share-result";
import type { ErrorContent } from "../error-shell";

export type { ErrorContent, PrimaryAction } from "../error-shell";

/**
 * Resolve the error shell's content for a failed shared-conversation fetch.
 *
 * The `login-required` / `membership-required` split is the crux of #4690: a
 * logged-in viewer who is not a member of the sharing org is told about the
 * membership requirement and pointed at Atlas, NOT dead-ended on a "Log in" CTA
 * they already satisfy. A viewer with no session still gets the login redirect.
 */
export function resolveConversationErrorContent(reason: FailReason): ErrorContent {
  switch (reason) {
    case "login-required":
      return {
        heading: "Sign in to view this conversation",
        message:
          "This conversation is shared within an organization. Sign in with an account in that organization to view it.",
        primaryAction: "login",
        showTryAgain: false,
      };
    case "membership-required":
      return {
        heading: "You don’t have access to this conversation",
        message:
          "This conversation is shared within an organization you’re not a member of. Ask the owner to share it with you, or switch to an account in that organization.",
        primaryAction: "home",
        showTryAgain: false,
      };
    case "expired":
      return {
        heading: "Conversation link expired",
        message: "This share link has expired. Ask the conversation owner to create a new one.",
        primaryAction: "home",
        showTryAgain: true,
      };
    case "not-found":
      return {
        heading: "Conversation not found",
        message: "This conversation may have been removed or the link may be invalid.",
        primaryAction: "home",
        showTryAgain: false,
      };
    case "network-error":
      return {
        heading: "Connection failed",
        message: "Could not reach the server. Check your connection and try again.",
        primaryAction: "home",
        showTryAgain: true,
      };
    case "server-error":
      return {
        heading: "Unable to load conversation",
        message:
          "Something went wrong on our end loading this conversation. Please try again in a moment.",
        primaryAction: "home",
        showTryAgain: true,
      };
    default:
      // Exhaustiveness: a future `FailReason` fails the build here rather than
      // silently rendering a generic shell.
      reason satisfies never;
      return {
        heading: "Unable to load conversation",
        message: "Something went wrong loading this conversation. Please try again in a moment.",
        primaryAction: "home",
        showTryAgain: true,
      };
  }
}
