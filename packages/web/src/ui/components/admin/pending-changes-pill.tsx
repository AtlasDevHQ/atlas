"use client";

import { useState } from "react";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useModeStatus } from "@/ui/hooks/use-mode-status";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { ADMIN_ROLES } from "@/ui/lib/types";
import { draftSurfaceSegments, totalDrafts } from "@/ui/lib/content-surfaces";
import { PublishModal } from "./publish-modal";
import type { ModeDraftCounts, ModeDraftActivity } from "@useatlas/types/mode";

/**
 * Pending-changes pill in the admin top bar (#2177).
 *
 * Sits next to the user menu and surfaces the total number of drafts queued
 * for publish across every content-mode-tracked surface. Borrows the
 * LaunchDarkly outlined-pill aesthetic: neutral ring at 0 (hidden), amber
 * ring + count badge when there are pending changes.
 *
 * Clicking opens a popover with a per-surface breakdown ("prompts: 3 ·
 * semantic: 1") + relative timestamps; the "Review & publish" button opens
 * the {@link PublishModal} so the admin can confirm.
 *
 * Renders nothing for non-admins and for admins whose org has zero drafts —
 * the pill stays out of the way until there's something to publish.
 */
export function PendingChangesPill() {
  const role = useUserRole();
  const isAdmin = role !== undefined && (ADMIN_ROLES as ReadonlyArray<string>).includes(role);
  const { data } = useModeStatus();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  if (!isAdmin) return null;
  const counts = data?.draftCounts;
  if (!counts) return null;
  const total = totalDrafts(counts);
  if (total === 0) return null;

  const segments = perSurfaceSegments(counts, data?.draftActivity ?? null);
  const plural = total === 1 ? "change" : "changes";

  function openModal() {
    setPopoverOpen(false);
    setModalOpen(true);
  }

  return (
    <>
      <TooltipProvider delayDuration={250}>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`${total} pending ${plural}`}
                  className={cn(
                    "h-8 gap-1.5 rounded-full border-amber-500/40 bg-amber-500/5 px-2.5 text-xs font-medium text-amber-900",
                    "hover:bg-amber-500/10 hover:text-amber-950",
                    "dark:border-amber-400/40 dark:bg-amber-400/5 dark:text-amber-200 dark:hover:bg-amber-400/15",
                  )}
                >
                  <Layers className="size-3.5" aria-hidden />
                  <span>{total} pending</span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {total} pending {plural} ready to publish
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-72 p-0" sideOffset={8}>
            <div className="border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Pending changes</h3>
              <p className="text-xs text-muted-foreground">
                Staged drafts visible only to admins until published.
              </p>
            </div>
            <ul className="max-h-64 divide-y overflow-y-auto">
              {segments.length === 0 ? (
                <li className="px-4 py-3 text-xs text-muted-foreground">
                  {total} pending {plural}.
                </li>
              ) : (
                segments.map((s) => (
                  <li
                    key={s.key}
                    className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground">{s.label}</div>
                      {s.lastEditedRelative && (
                        <div className="truncate text-xs text-muted-foreground">
                          Last edit {s.lastEditedRelative}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
                      {s.count}
                    </span>
                  </li>
                ))
              )}
            </ul>
            <div className="border-t bg-muted/30 px-3 py-2">
              <Button
                size="sm"
                className="w-full"
                onClick={openModal}
              >
                Review & publish
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </TooltipProvider>
      <PublishModal open={modalOpen} onOpenChange={setModalOpen} />
    </>
  );
}

interface SurfaceSegment {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly lastEditedRelative: string | null;
}

/**
 * Build per-surface popover rows from the mode endpoint counts + activity.
 *
 * Ordering, labels, and the entity fold come from the shared content-surface
 * descriptors (`@/ui/lib/content-surfaces`), claim-checked against
 * `ModeDraftCounts` at compile time; the {@link PublishModal} surfaces the
 * precise entity-slice breakdown.
 *
 * Exported for tests so we can assert ordering / pluralization without
 * rendering a popover.
 */
export function perSurfaceSegments(
  counts: ModeDraftCounts,
  activity: ModeDraftActivity | null,
): SurfaceSegment[] {
  return draftSurfaceSegments(counts, activity).map((s) => ({
    key: s.key,
    label: s.label,
    count: s.count,
    lastEditedRelative: relativeOrNull(s.lastEditedAt),
  }));
}

/**
 * Format an ISO timestamp as a relative-time string (e.g. "5 minutes ago").
 * Falls back to a short absolute date when the value is more than a week
 * old to keep the popover line readable.
 *
 * Returns null for missing / unparseable input so the caller can omit the
 * "Last edit" line entirely.
 */
export function relativeOrNull(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
