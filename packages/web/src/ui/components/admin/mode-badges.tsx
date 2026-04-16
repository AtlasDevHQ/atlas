"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * "Demo" pill shown on workspace-seeded demo resources (connections whose id
 * is `__demo__`, prompt collections whose `isBuiltin` flag is true, etc.).
 *
 * Neutral zinc coloring so demo content reads as "preset" rather than
 * "warning" — contrast with the amber "Draft" pill and the developer banner.
 */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-zinc-300 bg-zinc-50 px-1.5 py-0 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
        className,
      )}
      aria-label="Demo content"
      title="Part of the demo dataset"
    >
      Demo
    </Badge>
  );
}

/**
 * "Draft" pill shown on resources in `status === 'draft'`. Amber tint pairs
 * visually with the developer-mode banner so admins can quickly scan which
 * rows are unpublished edits.
 */
export function DraftBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
        className,
      )}
      aria-label="Draft — not yet published"
      title="Draft — not yet published"
    >
      Draft
    </Badge>
  );
}

/**
 * "Published" pill shown when developer-mode surfaces render live/published
 * items as read-only context (e.g. a demo connection shown while the admin
 * hasn't drafted anything yet). Emerald tint reads as "live", distinct from
 * the amber "Draft" pill and the neutral "Demo" pill.
 */
export function PublishedBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
        className,
      )}
      aria-label="Published — live in production"
      title="Published — live in production"
    >
      Published
    </Badge>
  );
}
