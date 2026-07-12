import type { LearnedPatternStatus } from "@/ui/lib/types";
import type { FetchError } from "@/ui/lib/fetch-error";

/**
 * Failure-honesty state for the learned-patterns cockpit (#4574).
 *
 * A mutation error is pinned to the *action* the admin took, and where it
 * renders is *derived* at render time from that action plus which overlays are
 * currently on screen (`renderSurface`) — never stored. Deriving it is what
 * keeps a late-arriving failure honest: if the admin dismissed the sheet /
 * dialog while the request was in flight, the error can't pin to an unmounted
 * overlay (invisible) or bleed into a *different* item's sheet (and mis-retry
 * from it). It falls back to the page banner, which is always mounted.
 */

/** Surface an error can render in, so it lands where the admin acted. */
export type ErrorSurface = "page" | "sheet" | "delete";

/** A status change fires from the row menu (page) or inside the detail sheet. */
export type StatusSurface = "page" | "sheet";

/**
 * The failed action, replayable by the honest "Retry". A descriptor (not a
 * captured closure) so retry always runs through the current-render handler and
 * can't fire a stale mutation.
 */
export type RetryableAction =
  | { kind: "status"; id: string; status: LearnedPatternStatus; surface: StatusSurface }
  | { kind: "delete"; id: string }
  | { kind: "bulk"; status: LearnedPatternStatus };

export interface ActionError {
  error: FetchError;
  action: RetryableAction;
}

/**
 * Where an error actually renders. Normally its own surface, but a sheet or
 * delete error whose target overlay is no longer the one on screen (dismissed
 * mid-flight, or a different item opened) falls back to the always-mounted page
 * banner — so a late failure stays visible and can never render into, or retry
 * from, the wrong overlay.
 *
 * @param openSheetId  id of the pattern whose detail sheet is open, or null
 * @param openDeleteId id of the pattern whose delete dialog is open, or null
 */
export function renderSurface(
  actionError: ActionError | null,
  openSheetId: string | null,
  openDeleteId: string | null,
): ErrorSurface | null {
  if (!actionError) return null;
  const { action } = actionError;
  switch (action.kind) {
    case "status":
      return action.surface === "sheet" && openSheetId === action.id ? "sheet" : "page";
    case "delete":
      return openDeleteId === action.id ? "delete" : "page";
    case "bulk":
      return "page";
  }
}
