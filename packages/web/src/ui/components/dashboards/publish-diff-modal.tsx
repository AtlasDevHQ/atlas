"use client";

/**
 * Publish diff modal (#2521).
 *
 * Renders a shadcn `Dialog` that shows the user what publishing their
 * draft will change: added cards, removed cards, changed cards (with a
 * field-level breakdown), and a meta diff for the dashboard title /
 * description. Confirm calls the supplied `onConfirm` (which the page
 * wires to `POST /:id/draft/publish`); Cancel preserves the draft.
 *
 * The diff itself is computed by `diffDashboards` against the published
 * `DashboardWithCards` and the materialized draft view returned by
 * `GET /:id/draft`. Both fetches happen in the parent — this component
 * is a pure presenter.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Minus, Pencil, FileText, AlertTriangle } from "lucide-react";
import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";
import {
  describeFieldChange,
  type DashboardDiff,
} from "./dashboard-diff";

interface PublishDiffModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diff: DashboardDiff | null;
  loading: boolean;
  /** Result of POST /:id/draft/publish. Modal stays open on error so the user can read it. */
  publishing: boolean;
  error: FetchError | null;
  /**
   * Error from the initial GET /:id/draft fetch that powers the diff.
   * Separate from `error` (which tracks the publish mutation) so an
   * empty modal doesn't leave the user wondering why there's no diff.
   */
  viewError?: string | null;
  onConfirm: () => Promise<void> | void;
}

export function PublishDiffModal({
  open,
  onOpenChange,
  diff,
  loading,
  publishing,
  error,
  viewError,
  onConfirm,
}: PublishDiffModalProps) {
  // Local "confirmed" guard avoids a double-submit when the user mashes
  // Confirm before the network round-trip resolves.
  const [confirming, setConfirming] = useState(false);

  async function handleConfirm() {
    if (confirming || publishing) return;
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block close-during-publish so the user doesn't dismiss the
        // modal mid-transaction. The publish promise still resolves and
        // the parent's `invalidates` refetches the dashboard, but
        // closing here would orphan the spinner state.
        if (publishing) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="publish-diff-modal"
      >
        <DialogHeader>
          <DialogTitle>Publish changes?</DialogTitle>
          <DialogDescription>
            Review what will be published to the live dashboard. Everyone with
            access will see these changes.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[55vh]">
          {loading && (
            <div className="px-1 py-2 text-sm text-zinc-500 dark:text-zinc-400">
              Computing diff…
            </div>
          )}

          {!loading && viewError && (
            <div
              role="alert"
              data-testid="publish-diff-view-error"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
            >
              {viewError}
            </div>
          )}

          {!loading && diff && diff.empty && (
            <div
              data-testid="publish-diff-empty"
              className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              Your draft matches the published dashboard. Nothing to publish.
            </div>
          )}

          {!loading && diff && !diff.empty && (
            <div className="space-y-4 py-1">
              {diff.meta.title.changed && (
                <DiffSection
                  icon={<FileText className="size-3.5" aria-hidden="true" />}
                  label="Title"
                  tone="changed"
                  count={1}
                  testId="publish-diff-meta-title"
                >
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">
                    <span className="line-through opacity-60">
                      {diff.meta.title.before}
                    </span>{" "}
                    →{" "}
                    <span className="font-medium">{diff.meta.title.after}</span>
                  </div>
                </DiffSection>
              )}

              {diff.meta.description.changed && (
                <DiffSection
                  icon={<FileText className="size-3.5" aria-hidden="true" />}
                  label="Description"
                  tone="changed"
                  count={1}
                  testId="publish-diff-meta-description"
                >
                  <div className="space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                    {diff.meta.description.before !== null && (
                      <div className="line-through opacity-60">
                        {diff.meta.description.before || <em>(empty)</em>}
                      </div>
                    )}
                    {diff.meta.description.after !== null ? (
                      <div className="font-medium">
                        {diff.meta.description.after || <em>(empty)</em>}
                      </div>
                    ) : (
                      <div className="italic text-zinc-400">
                        (description cleared)
                      </div>
                    )}
                  </div>
                </DiffSection>
              )}

              {diff.added.length > 0 && (
                <DiffSection
                  icon={<Plus className="size-3.5" aria-hidden="true" />}
                  label="Added"
                  tone="added"
                  count={diff.added.length}
                  testId="publish-diff-added"
                >
                  <ul className="space-y-1.5">
                    {diff.added.map((card) => (
                      <li
                        key={card.id}
                        className="rounded border border-emerald-200 bg-emerald-50/50 px-2.5 py-1.5 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/20"
                      >
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {card.title}
                        </div>
                        {card.chartConfig?.type && (
                          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            {card.chartConfig.type}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </DiffSection>
              )}

              {diff.changed.length > 0 && (
                <DiffSection
                  icon={<Pencil className="size-3.5" aria-hidden="true" />}
                  label="Changed"
                  tone="changed"
                  count={diff.changed.length}
                  testId="publish-diff-changed"
                >
                  <ul className="space-y-2">
                    {diff.changed.map((card) => (
                      <li
                        key={card.cardId}
                        className="rounded border border-amber-200 bg-amber-50/50 px-2.5 py-1.5 text-xs dark:border-amber-900/40 dark:bg-amber-950/20"
                      >
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {card.title}
                        </div>
                        <ul className="mt-1 space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                          {card.changes.map((change, idx) => (
                            <li key={`${card.cardId}-${idx}`}>
                              {describeFieldChange(change)}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </DiffSection>
              )}

              {diff.removed.length > 0 && (
                <DiffSection
                  icon={<Minus className="size-3.5" aria-hidden="true" />}
                  label="Removed"
                  tone="removed"
                  count={diff.removed.length}
                  testId="publish-diff-removed"
                >
                  <ul className="space-y-1.5">
                    {diff.removed.map((card) => (
                      <li
                        key={card.id}
                        className="rounded border border-red-200 bg-red-50/50 px-2.5 py-1.5 text-xs dark:border-red-900/40 dark:bg-red-950/20"
                      >
                        <div className="font-medium text-zinc-900 line-through dark:text-zinc-100">
                          {card.title}
                        </div>
                      </li>
                    ))}
                  </ul>
                </DiffSection>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              data-testid="publish-diff-error"
              className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{friendlyError(error)}</span>
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={publishing || confirming}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || publishing || confirming || !diff || diff.empty}
            data-testid="publish-diff-confirm"
          >
            {publishing || confirming ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffSection({
  icon,
  label,
  tone,
  count,
  children,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "added" | "removed" | "changed";
  count: number;
  children: React.ReactNode;
  testId?: string;
}) {
  const toneClasses: Record<typeof tone, string> = {
    added:
      "text-emerald-700 dark:text-emerald-400",
    removed: "text-red-700 dark:text-red-400",
    changed: "text-amber-700 dark:text-amber-400",
  };
  return (
    <section data-testid={testId}>
      <div
        className={`mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${toneClasses[tone]}`}
      >
        {icon}
        <span>{label}</span>
        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
          {count}
        </Badge>
      </div>
      {children}
    </section>
  );
}
