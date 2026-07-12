"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";

/**
 * Cockpit failure-honesty surface for approve / reject / delete mutations.
 *
 * The shared `ErrorBanner` (what the old cockpit banner used) exposes a single
 * action button with one caller-supplied `onRetry` — which is exactly how the
 * old banner shipped a "Retry" that only called `setActionError(null)`, a
 * dismiss wearing a retry's clothes (#4574). This surface spells the two
 * affordances apart so neither can lie:
 *
 * - **Retry** genuinely re-runs the failed mutation (`onRetry`).
 * - **Dismiss** clears the error and does nothing else (`onDismiss`).
 *
 * Rendered directly inside the surface the admin acted in — the detail sheet,
 * the delete confirmation dialog, or the page body — so a failed review is seen
 * where the click happened instead of behind the open overlay. `friendlyError`
 * (the shared copy idiom) keeps the server message + requestId intact.
 */
export function ActionErrorAlert({
  error,
  onRetry,
  onDismiss,
  className,
}: {
  error: FetchError;
  onRetry: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3",
        className,
      )}
    >
      <p className="text-sm text-red-800 dark:text-red-300">{friendlyError(error)}</p>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
