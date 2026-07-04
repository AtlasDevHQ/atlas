"use client";

/**
 * Draft status banner + control bar (#2521).
 *
 * Three responsibilities, condensed into one banner so the dashboard
 * page doesn't grow another chrome row per concept:
 *
 *   1. Surface that the editor has an unpublished draft (the "Draft"
 *      badge — only renders when `hasDraft` is true).
 *   2. Offer Publish + Discard controls. Publish opens the diff modal;
 *      Discard opens an AlertDialog confirm step.
 *   3. Surface the "your published baseline has changed" notice with
 *      a Rebase action when another editor published while this user
 *      had an open draft.
 *
 * The status itself is fetched by the parent page via the lightweight
 * `GET /:id/draft/status` endpoint added in #2521 (non-forking — opening
 * a dashboard never creates a draft row). Mutations (publish / discard
 * / rebase) go through `useAdminMutation` in the parent so the page's
 * own `refetch()` can invalidate the dashboard view in lock-step.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pencil, Send, Trash2, RotateCw, AlertTriangle } from "lucide-react";
import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";

interface DraftStatusBannerProps {
  hasDraft: boolean;
  staleBaseline: boolean;
  /**
   * #4315 — the page is in explicit edit mode. Makes this a PERSISTENT bar
   * shown for the whole editing session, not just a transient notice once a
   * draft exists. Two states: before the first edit forks a draft
   * (`editing && !hasDraft`) it renders a quiet "Editing your draft — no
   * changes yet" bar with only a Done control; once `hasDraft` flips true the
   * richer Draft block below (which owns the Publish / Discard controls) takes
   * over.
   */
  editing: boolean;
  /** Leave edit mode (used by the persistent bar's Done action). */
  onExitEditing?: () => void;
  /** Used by the parent to gate rendering — passed through so the discard confirm survives layout shifts. */
  discardOpen: boolean;
  onDiscardOpenChange: (open: boolean) => void;
  /** Open the Publish diff modal. */
  onPublish: () => void;
  /** Confirm the discard. */
  onDiscardConfirm: () => Promise<void> | void;
  /** Rebase onto the latest published baseline. */
  onRebase: () => Promise<void> | void;
  publishing: boolean;
  discarding: boolean;
  rebasing: boolean;
  /** Last error from any of publish / discard / rebase. */
  error: FetchError | null;
  onDismissError?: () => void;
}

export function DraftStatusBanner({
  hasDraft,
  staleBaseline,
  discardOpen,
  onDiscardOpenChange,
  onPublish,
  onDiscardConfirm,
  onRebase,
  publishing,
  discarding,
  rebasing,
  error,
  onDismissError,
  editing,
  onExitEditing,
}: DraftStatusBannerProps) {
  // Bail entirely when there's nothing to show — no draft, no error, and not
  // in edit mode. In edit mode the bar is PERSISTENT (#4315) so the user
  // always sees they're editing a private draft.
  if (!hasDraft && !error && !editing) return null;

  return (
    <div className="mx-4 mt-3 space-y-2 sm:mx-6">
      {/* #4315 — persistent editing bar BEFORE the first edit forks a draft.
          Once `hasDraft` flips true the richer Draft block below takes over. */}
      {editing && !hasDraft && (
        <div
          data-testid="editing-draft-bar"
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <Badge
            variant="outline"
            className="border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-100"
          >
            <Pencil className="mr-1 size-3" aria-hidden="true" />
            Editing your draft
          </Badge>
          <span className="min-w-0 flex-1">
            Changes are private to you until you Publish. No edits yet.
          </span>
          {onExitEditing && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-amber-300 bg-white text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-900 dark:text-amber-100 dark:hover:bg-amber-900/30"
              onClick={onExitEditing}
              data-testid="editing-done-button"
            >
              Done
            </Button>
          )}
        </div>
      )}

      {hasDraft && (
        <div
          data-testid="draft-status-banner"
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <Badge
            variant="outline"
            className="border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-100"
            data-testid="draft-badge"
          >
            <Pencil className="mr-1 size-3" aria-hidden="true" />
            Draft
          </Badge>
          <span className="min-w-0 flex-1">
            Editing your draft — unpublished changes only you can see until you
            Publish.
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-amber-300 bg-white text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-900 dark:text-amber-100 dark:hover:bg-amber-900/30"
              onClick={() => {
                // #4323 — clear any prior publish/rebase/discard error so the
                // dialog's in-place error surface opens clean, rather than
                // showing a stale message from an earlier attempt.
                onDismissError?.();
                onDiscardOpenChange(true);
              }}
              disabled={discarding || publishing}
              data-testid="draft-discard-button"
            >
              <Trash2 className="mr-1 size-3" aria-hidden="true" />
              Discard
            </Button>
            <Button
              size="sm"
              onClick={onPublish}
              disabled={publishing || discarding || staleBaseline}
              data-testid="draft-publish-button"
            >
              <Send className="mr-1 size-3" aria-hidden="true" />
              {publishing ? "Publishing…" : "Publish"}
            </Button>
          </div>
        </div>
      )}

      {staleBaseline && (
        <div
          role="alert"
          data-testid="baseline-changed-banner"
          className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-200"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Your published baseline has changed — another editor published
            while you were editing. Rebase to bring your draft up to date
            before publishing.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={onRebase}
            disabled={rebasing || publishing}
            className="h-7 border-blue-300 bg-white text-blue-900 hover:bg-blue-100 dark:border-blue-800 dark:bg-zinc-900 dark:text-blue-100 dark:hover:bg-blue-900/30"
            data-testid="draft-rebase-button"
          >
            <RotateCw
              className={`mr-1 size-3 ${rebasing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {rebasing ? "Rebasing…" : "Rebase"}
          </Button>
        </div>
      )}

      {/* While the discard confirm is open, its own inline error owns the
          failure surface (#4323) — don't also render it in the banner. */}
      {error && !discardOpen && (
        <div
          role="alert"
          data-testid="draft-error-banner"
          className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{friendlyError(error)}</span>
          {onDismissError && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onDismissError}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={discardOpen} onOpenChange={onDiscardOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes your unpublished changes. The
              published dashboard is unaffected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* #4323 — surface a discard FAILURE in place. The confirm below stays
              open until the request resolves (the parent closes it only on
              success), so a failed discard shows its reason right here instead
              of the dialog vanishing before the async settles. */}
          {error && (
            <div
              role="alert"
              data-testid="draft-discard-error"
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{friendlyError(error)}</span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discarding}>Cancel</AlertDialogCancel>
            {/* #4323 — `preventDefault` stops Radix from auto-dismissing the
                dialog on click (its default), so it survives the in-flight
                request; the parent dismisses it explicitly once the discard
                succeeds. Without this the dialog vanished before the async
                settled and a failure had nowhere to render. */}
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onDiscardConfirm();
              }}
              disabled={discarding}
              className="bg-red-600 text-white hover:bg-red-700"
              data-testid="draft-discard-confirm"
            >
              {discarding ? "Discarding…" : "Discard draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
