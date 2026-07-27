"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { BrainFactCandidate, BrainFactReviewStatus } from "@/ui/lib/types";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { AlertTriangle, HelpCircle, Link2, ShieldAlert, Split } from "lucide-react";

/**
 * Review-queue columns.
 *
 * The list is where a reviewer decides whether a claim is worth OPENING, so
 * every signal that could stop them approving is visible without a click:
 * the claim itself, how much evidence backs it, whether entity resolution was
 * provisional, whether anything contradicts it, and whether publish would
 * refuse it outright.
 *
 * Nothing here is sortable. `list-query.ts` explains why — the ordering a
 * reviewer would reach for first ("most contested") is exactly the ranking
 * ADR-0036 refuses to perform.
 */

/** Badge for a claim publish would refuse. Not a status — a pre-flight verdict. */
export const blockedBadge = {
  variant: "outline" as const,
  className: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400",
  label: "Won't publish",
};

/** Provisional entity resolution — THE quality queue. */
export const provisionalBadge = {
  variant: "outline" as const,
  className: "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
  label: "Provisional",
};

/** Advisory contradiction. Deliberately neutral, never alarming — see below. */
export const tensionBadge = {
  variant: "outline" as const,
  className: "border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-400",
  label: "In tension",
};

/**
 * Keyed on the closed union, not `string`: a fourth review status becomes a
 * compile error here instead of a silent "Draft" badge, and the `?? draft`
 * fallbacks at the two call sites become provably unnecessary (Zod already
 * rejects an off-vocabulary status at the fetch boundary).
 */
export const statusBadge: Record<
  BrainFactReviewStatus,
  { variant: "outline"; className: string; label: string }
> = {
  draft: {
    variant: "outline",
    className: "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
    label: "Draft",
  },
  published: {
    variant: "outline",
    className: "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400",
    label: "Published",
  },
  archived: {
    variant: "outline",
    className: "border-muted-foreground/40 text-muted-foreground",
    label: "Archived",
  },
};

/** Column set. `showStatus` only for a queue not already pinned to one status. */
export function getBrainFactColumns(
  opts: { showStatus?: boolean } = {},
): ColumnDef<BrainFactCandidate>[] {
  const columns: ColumnDef<BrainFactCandidate>[] = [
    {
      id: "claim",
      accessorFn: (row) => `${row.subject} ${row.predicate} ${row.object}`,
      header: ({ column }) => <DataTableColumnHeader column={column} label="Claim" />,
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="min-w-0 max-w-md">
            <p className="truncate text-sm">
              <span className="font-medium">{c.subject}</span>{" "}
              <span className="text-muted-foreground">{c.predicate}</span>{" "}
              <span className="font-medium">{c.object}</span>
            </p>
            {/* The grant, not a summary of it — "who can see this" is half the
                trust call, and paraphrasing tokens would hide a malformed one.
                An unreadable grant says so rather than rendering an empty list,
                which would read as "visible to nobody" — i.e. harmless. */}
            <p className="truncate font-mono text-xs text-muted-foreground">
              {!c.grantReadable
                ? "grant unreadable"
                : c.visibleTo.length > 0
                  ? c.visibleTo.join(", ")
                  : "—"}
            </p>
          </div>
        );
      },
      enableSorting: false,
    },
    {
      id: "evidence",
      accessorFn: (row) => row.provenance.source ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Evidence" />,
      cell: ({ row }) => {
        const { provenance, episode } = row.original;
        return (
          <div className="min-w-0">
            <p className="truncate text-xs">
              {provenance.source ?? <span className="text-muted-foreground">unknown source</span>}
              {provenance.attribution.visible && provenance.attribution.actor && (
                <span className="text-muted-foreground"> · {provenance.attribution.actor}</span>
              )}
            </p>
            {/* Evidence withheld is stated, never blank: a reviewer who cannot
                read the episode must know that is WHY they see nothing. */}
            {episode && !episode.visible && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldAlert className="size-3" aria-hidden />
                Evidence restricted
              </span>
            )}
            {/* A DIFFERENT withholding from the one above, and they co-occur
                only by coincidence: that one is the episode's own grant, this
                one is the fact's pre-widening grant (#4836). Labelled
                separately so a reviewer is not left inferring that a missing
                author is the same fact as a missing message. */}
            {!provenance.attribution.visible && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldAlert className="size-3" aria-hidden />
                Attribution restricted
              </span>
            )}
            {!provenance.payloadComplete && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <HelpCircle className="size-3" aria-hidden />
                Incomplete provenance
              </span>
            )}
          </div>
        );
      },
      enableSorting: false,
    },
    {
      id: "corroboration",
      accessorFn: (row) => row.corroborationCount,
      header: ({ column }) => <DataTableColumnHeader column={column} label="Sources" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1 text-sm tabular-nums">
          <Link2 className="size-3.5 text-muted-foreground" aria-hidden />
          {row.original.corroborationCount}
        </span>
      ),
      enableSorting: false,
      size: 96,
    },
    {
      id: "flags",
      header: () => "Flags",
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="flex flex-wrap gap-1">
            {c.provenance.provisional && (
              <Badge variant={provisionalBadge.variant} className={provisionalBadge.className}>
                <AlertTriangle className="mr-1 size-3" aria-hidden />
                {provisionalBadge.label}
              </Badge>
            )}
            {c.tensions.length > 0 && (
              <Badge variant={tensionBadge.variant} className={tensionBadge.className}>
                <Split className="mr-1 size-3" aria-hidden />
                {c.tensions.length === 1
                  ? tensionBadge.label
                  : `${tensionBadge.label} (${c.tensions.length})`}
              </Badge>
            )}
            {c.promotionBlock && (
              <Badge variant={blockedBadge.variant} className={blockedBadge.className}>
                {blockedBadge.label}
              </Badge>
            )}
            {c.malformedGrantIndices.length > 0 && !c.promotionBlock && (
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400"
              >
                Grant has junk
              </Badge>
            )}
          </div>
        );
      },
      enableSorting: false,
    },
    {
      id: "ingestedAt",
      accessorFn: (row) => row.ingestedAt,
      header: ({ column }) => <DataTableColumnHeader column={column} label="Learned" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {/* `ingestedAt` is NOT NULL at rest, so a dash here means the column
              did not decode — an honest blank beats a fabricated 1970. */}
          {row.original.ingestedAt ? (
            <RelativeTimestamp iso={row.original.ingestedAt} />
          ) : (
            "—"
          )}
        </span>
      ),
      enableSorting: false,
      size: 128,
    },
  ];

  if (opts.showStatus) {
    columns.splice(1, 0, {
      id: "status",
      accessorFn: (row) => row.status,
      header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
      cell: ({ row }) => {
        const badge = statusBadge[row.original.status];
        return (
          <Badge variant={badge.variant} className={badge.className}>
            {badge.label}
          </Badge>
        );
      },
      enableSorting: false,
      size: 112,
    });
  }

  return columns;
}
