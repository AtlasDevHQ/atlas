"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type {
  BrainFactCandidate,
  BrainFactDecayLevel,
  BrainFactReviewStatus,
} from "@/ui/lib/types";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { AlertTriangle, Clock, HelpCircle, Link2, ShieldAlert, Split } from "lucide-react";
import { isFullyArbitrated, isTensionOpen } from "./tension-state";

/**
 * Review-queue columns, and the badge vocabulary the sheet shares with them —
 * `candidate-detail.tsx` imports these tokens so one claim cannot wear two
 * spellings of the same state on two surfaces. (Not yet total: the sheet's own
 * per-rival "Withdrawn"/"Superseded" badges still spell the muted classes
 * inline rather than importing `resolvedTensionBadge`'s.) The lifecycle predicate behind
 * the "In tension" count is the same idea one file over, in `tension-state.ts`.
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

/**
 * A candidate plus the one PAGE-level fact a row cell cannot otherwise reach:
 * did the tension fan-out cap bite on this page (#4995)?
 *
 * Carried on the row rather than passed to `getBrainFactColumns`, because the
 * flag arrives with the list response and the columns are built BEFORE that
 * response exists — `page.tsx` hands `columns` to `useServerDataTable` and gets
 * `listResponse` back. Threading it through the factory would mean reading the
 * value a render too early; stamping it in the hook's `select`, which already
 * holds the whole validated response, means every row carries a value that was
 * true of the page it came from.
 *
 * The other candidate route, TanStack's `meta`, was rejected because it turns a
 * compile-time obligation into a runtime one: `TableMeta` is globally augmented
 * across every admin table, so a one-page fact has to be declared OPTIONAL
 * there, and a page that forgot to pass it would simply read `undefined`.
 * (`useServerDataTable` does not forward a `meta` option at all today, so that
 * route would have meant widening the shared hook first.)
 * (Which `isFullyArbitrated`'s `!== false` guard would then suppress, so it
 * fails safe either way — the objection is that the mistake is silent, not that
 * it is dangerous.) Widening the row type instead makes a missing stamp a
 * compile error: `TData` is `BrainFactCandidateRow`, whose extra required field
 * the raw response elements lack, so `select` cannot hand back `r.candidates`.
 *
 * `pageTensionsTruncated`, not `tensionsTruncated`: the value is a fact about
 * the PAGE riding on a row, and the un-prefixed spelling both reads as a
 * per-row claim at the use site and would silently shadow a future per-candidate
 * field of that name on the wire type — collapsing the intersection to one
 * boolean with no error anywhere.
 *
 * Only the "Conflict resolved" badge reads it, and only to STAY SILENT. The
 * "In tension (N)" count deliberately does not: understating a count is the
 * direction this surface has always accepted, while asserting an arbitration
 * that a dropped rival may contradict is the direction `TENSION_FANOUT_CAP`'s
 * own comment says it must never take.
 */
export interface BrainFactCandidateRow extends BrainFactCandidate {
  readonly pageTensionsTruncated: boolean;
}

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
 * The arbitrated counterpart of `tensionBadge` (#4995) — this claim WAS
 * contested and every rival is now settled.
 *
 * MUTED, not violet, and that is the whole design: it reports history, not
 * work. A reviewer scanning for what still needs deciding must be able to skip
 * it at a glance, which is why it does not share the live badge's hue. It takes
 * the same `border-muted-foreground/40 text-muted-foreground` the detail
 * sheet's "Withdrawn"/"Superseded" rival badges carry, because it is the
 * row-level summary of exactly those and the two surfaces should read as one
 * statement. (Those two spell the classes inline rather than importing a token,
 * as `decayBadge.unknown` and `statusBadge.archived` here do too — the muted
 * treatment is this file's convention, not yet a shared constant.)
 *
 * It keeps the `Split` icon so the two badges read as one family: a reviewer
 * learns the glyph means "contradiction" and the colour tells them whether it
 * is still theirs to resolve.
 *
 * Still a LABEL, not a verdict — #4935's invariant is untouched. It introduces
 * no ordering key, sorts nothing, and picks no winner.
 */
export const resolvedTensionBadge = {
  variant: "outline" as const,
  className: "border-muted-foreground/40 text-muted-foreground",
  label: "Conflict resolved",
};

/**
 * Read-time staleness decay (#4914). One informational hue for the three aged
 * levels (`unknown` goes muted — it is a data gap, not an age) — decay is
 * advisory temporal metadata, never a demotion and never an alarm: a
 * stale fact is still the reviewed record, its trust tier and status
 * untouched. The label carries the distinction; the color only says "this is
 * about age, not about trust".
 *
 * Keyed on the closed union for `statusBadge`'s reason — a fifth level is a
 * compile error here, not a silently unstyled chip.
 */
export const decayBadge: Record<
  BrainFactDecayLevel,
  { variant: "outline"; className: string; label: string }
> = {
  fresh: {
    variant: "outline",
    className: "border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-400",
    label: "Fresh",
  },
  aging: {
    variant: "outline",
    className: "border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-400",
    label: "Aging",
  },
  stale: {
    variant: "outline",
    className: "border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-400",
    label: "Stale",
  },
  unknown: {
    variant: "outline",
    className: "border-muted-foreground/40 text-muted-foreground",
    label: "Age unknown",
  },
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
): ColumnDef<BrainFactCandidateRow>[] {
  const columns: ColumnDef<BrainFactCandidateRow>[] = [
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
            {/* A DIFFERENT withholding from the one above — that one is the
                episode's own grant, this one the fact's pre-widening grant
                (#4836) — and on a widened fact the two will nearly ALWAYS fire
                together, because a fact's provenance names the very episode
                whose grant it was widened out of. Labelled separately anyway:
                they carry the same icon, and the remedies differ (join the
                channel vs. ask the original audience), so collapsing them
                would leave a reviewer inferring that a missing author and a
                missing message are one fact. */}
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
        // OPEN rivals only. A counterpart somebody already retracted or
        // superseded is still listed in the detail sheet — it is still why this
        // claim was contested — but it is not work, and counting it made a
        // fully arbitrated row read as unresolved (#4961).
        //
        // Deliberately NARROWER than the server-side signals around it: the
        // stats tile's "N in tension", the "In tension only" filter, and the
        // oversight panel's per-audience column all ask edge EXISTENCE
        // (`TENSION_EXISTS_SELECT`), i.e. "has this claim ever been contested",
        // and all are unchanged. So the tile can still read a number no row's
        // "In tension" count corroborates, and the filter can still return a
        // row wearing no VIOLET badge — but as of #4995 those rows are no
        // longer silent, and the two reasons no longer look alike:
        //
        //   - every rival is settled → the muted "Conflict resolved" badge
        //     below, which is what the tile's count is pointing at;
        //   - the page's tension fan-out cap bit → NEITHER badge renders, and
        //     the `tensionsTruncated` banner is still the only explanation
        //     there is. Its "before treating any row as conflict-free" is
        //     exactly why the resolved badge suppresses itself there rather
        //     than reading a partial rival list as an arbitration.
        const contested = c.tensions.filter(isTensionOpen);
        // The settled case, restored to the list (#4995). #4961 was right to
        // stop COUNTING an arbitrated rival, but the row it left behind wore no
        // badge at all — indistinguishable from a claim nothing ever
        // contradicted, so the arbitration disappeared from the list and the
        // tile's "N in tension" had no row to point at. This badge is the
        // difference between "resolved" and "never contested"; the sheet has
        // drawn it per rival since #4935, this is its row-level equivalent.
        //
        // Mutually exclusive with the count above BY CONSTRUCTION, not by two
        // conditions kept in step: `isFullyArbitrated` negates the same
        // `some(isTensionOpen)` over the same list, in the same module. Not a
        // complement — with no rivals, or under the cap, neither badge renders.
        //
        // ⚠️ And SILENT on a truncated page, which is the one place the two
        // badges are not symmetric — the whole ROW goes in, not `c.tensions`,
        // because the cap check is the predicate's own precondition and it
        // takes it rather than trusting each call site to remember. The cap is
        // applied page-wide in endpoint fact-id order, so a row can arrive
        // holding only some of its rivals; if the ones that arrived happen to
        // be settled, "Conflict resolved" would assert an arbitration that a
        // dropped rival contradicts. Understating the violet COUNT under the
        // cap is the long-accepted direction here; asserting a resolution that
        // is not established is not, and `TENSION_FANOUT_CAP`'s own comment
        // names it as the one thing this surface must never imply. So the row
        // falls back to the pre-#4995 silence, and the banner explains it — for
        // both causes now, since the flag stopped meaning only "the cap bit"
        // and the copy was widened with it rather than left asserting a
        // diagnosis one arm falsifies.
        const arbitrated = isFullyArbitrated(c);
        return (
          <div className="flex flex-wrap gap-1">
            {c.provenance.provisional && (
              <Badge variant={provisionalBadge.variant} className={provisionalBadge.className}>
                <AlertTriangle className="mr-1 size-3" aria-hidden />
                {provisionalBadge.label}
              </Badge>
            )}
            {contested.length > 0 && (
              <Badge variant={tensionBadge.variant} className={tensionBadge.className}>
                <Split className="mr-1 size-3" aria-hidden />
                {contested.length === 1
                  ? tensionBadge.label
                  : `${tensionBadge.label} (${contested.length})`}
              </Badge>
            )}
            {arbitrated && (
              <Badge
                variant={resolvedTensionBadge.variant}
                className={resolvedTensionBadge.className}
              >
                <Split className="mr-1 size-3" aria-hidden />
                {resolvedTensionBadge.label}
              </Badge>
            )}
            {c.promotionBlock && (
              <Badge variant={blockedBadge.variant} className={blockedBadge.className}>
                {blockedBadge.label}
              </Badge>
            )}
            {/* The decay signal, rendered where a reviewer decides whether to
                open — advisory only. `stale`/`aging` get a chip; `fresh` is
                the queue's default state and stays quiet, and `unknown` is
                surfaced in the detail sheet where there is room to say why.
                The read model floats stale claims to the top of the queue
                (a surfacing hint, not a re-ranking — see `candidates.ts`). */}
            {(c.decay.level === "stale" || c.decay.level === "aging") && (
              <Badge
                variant={decayBadge[c.decay.level].variant}
                className={decayBadge[c.decay.level].className}
              >
                <Clock className="mr-1 size-3" aria-hidden />
                {decayBadge[c.decay.level].label}
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
