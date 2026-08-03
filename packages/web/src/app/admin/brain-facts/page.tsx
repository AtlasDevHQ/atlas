"use client";

import { useState } from "react";
import type { z } from "zod";
import { useQueryStates } from "nuqs";
import type { ColumnDef } from "@tanstack/react-table";
import type { BrainFactCandidate } from "@/ui/lib/types";
import { brainFactsSearchParams } from "./search-params";
import { buildBrainFactsPath, hasBrainFactFilters } from "./list-query";
import { getBrainFactColumns, type BrainFactCandidateRow } from "./columns";
import { CandidateDetail } from "./candidate-detail";
import { OversightPanel } from "./oversight-panel";
import { ServerDataTable } from "@/ui/components/admin/server-data-table";
import { useServerDataTable } from "@/ui/hooks/use-server-data-table";
import {
  BrainFactCandidateListResponseSchema,
  BrainFactCandidateSummarySchema,
  BrainFactRetractResponseSchema,
} from "@/ui/lib/admin-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueueFilterRow } from "@/ui/components/admin/queue";
import { PublishModal } from "@/ui/components/admin/publish-modal";
import { useAdminFetch, useInProgressSet } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  AlertTriangle,
  Brain,
  Check,
  Link2,
  Search,
  Split,
  Upload,
  X,
} from "lucide-react";

const LIMIT = 50;

// Every value the URL parser admits has a chip. A documented `?status=` with
// no chip renders a filter row that claims "Awaiting review" over a queue of
// something else.
const STATUS_FILTERS = [
  { value: "draft", label: "Awaiting review" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;

/**
 * The fact review gate (#4772, ADR-0036) — the human end of the company-brain
 * wedge.
 *
 * ## Why there is no per-row Approve button
 *
 * `brain_facts.status` has exactly one writer: the atomic publish endpoint,
 * which applies no-provenance-no-promotion and no-grant-no-promotion inside its
 * own transaction. A per-fact approve here would be a second gate writer that
 * bypassed both, so the reviewer's loop is inverted instead — REJECT what you
 * do not trust, then publish, and what survived the queue gets promoted.
 *
 * Publishing goes through the shared {@link PublishModal}, which lists the
 * pending drafts across every content class and renders any `refusedDrafts[]`
 * with their prose `detail`. That last part is the reason not to hand-roll a
 * publish button here: a publish that half-worked must never be reported as an
 * unqualified success.
 */
export default function BrainFactsPage() {
  const [params, setParams] = useQueryStates(brainFactsSearchParams);
  const [detail, setDetail] = useState<BrainFactCandidate | null>(null);
  const [rejectTarget, setRejectTarget] = useState<BrainFactCandidate | null>(null);
  // Pinned to the confirmation dialog, which is the only surface that rejects.
  const [rejectError, setRejectError] = useState<string | null>(null);
  // Survives the dialog on purpose (#4939). Rejecting is the `retract`
  // correction verb, and it FLAGS every claim derived from the one withdrawn.
  // The dialog closes on success, so a notice rendered inside it would be
  // destroyed at the moment it had something to say; this sits above the queue
  // until the reviewer dismisses it.
  const [flaggedNotice, setFlaggedNotice] = useState<{
    readonly claim: string;
    readonly count: number;
  } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // Search is a local draft until submitted: keystroke-per-request against a
  // queue built for connector scale is the wrong trade, and the URL should
  // carry a term the reviewer meant rather than every prefix of it.
  const [searchDraft, setSearchDraft] = useState(params.q);

  const inProgress = useInProgressSet();
  const retractMutation = useAdminMutation({ method: "POST" });

  const { data: summary, error: summaryError } = useAdminFetch<
    z.infer<typeof BrainFactCandidateSummarySchema>
  >("/api/v1/admin/brain-facts/summary", { schema: BrainFactCandidateSummarySchema });

  const columns: ColumnDef<BrainFactCandidateRow>[] = (() => {
    const base = getBrainFactColumns({ showStatus: params.status !== "draft" });
    const actionsCol: ColumnDef<BrainFactCandidateRow> = {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={inProgress.has(row.original.id)}
          onClick={(e) => {
            e.stopPropagation();
            setRejectError(null);
            setRejectTarget(row.original);
          }}
        >
          <X className="mr-1.5 size-3.5" aria-hidden />
          Reject
        </Button>
      ),
      enableSorting: false,
      enableHiding: false,
      size: 112,
    };
    return [...base, actionsCol];
  })();

  const {
    table,
    rows: candidates,
    data: listResponse,
    loading,
    error,
    refetch,
  } = useServerDataTable<
    BrainFactCandidateRow,
    z.infer<typeof BrainFactCandidateListResponseSchema>
  >({
    columns,
    getRowId: (row) => row.id,
    defaultPerPage: LIMIT,
    schema: BrainFactCandidateListResponseSchema,
    // The page-level truncation flag is stamped onto every row here, where the
    // whole validated response is in hand. `columns` is built ABOVE this call
    // and cannot read `listResponse`, so the flags cell has no other way to
    // learn that its rival list may be partial — and it must, or the "Conflict
    // resolved" badge would read a capped list as an arbitration (#4995).
    //
    // This re-derives per render BY DESIGN, and is the one `select` in the
    // admin app that maps rather than handing back the response's own array.
    // The cost is row-reference stability, which the hook's Proxy memo uses to
    // skip re-renders; the benefit is that rows and the `tensionsTruncated`
    // banner below read the same response object on the same render, so they
    // cannot disagree mid-refetch. On a page of at most `LIMIT` rows that is
    // the right trade — read the churn as intentional, not a missing `useMemo`.
    select: (r) => ({
      rows: r.candidates.map((c) => ({ ...c, pageTensionsTruncated: r.tensionsTruncated })),
      total: r.total,
    }),
    buildPath: ({ offset, perPage }) =>
      buildBrainFactsPath(
        { offset, perPage },
        {
          status: params.status,
          provisional: params.provisional,
          tension: params.tension,
          q: params.q,
        },
      ),
  });

  async function rejectCandidate(candidate: BrainFactCandidate) {
    setRejectError(null);
    // Cleared before, not after: the notice names the claim that caused it, so
    // a stale one standing over a DIFFERENT rejection invites exactly the
    // misattribution it exists to prevent. Nothing is lost — it is only ever
    // rewritten by a rejection that has something of its own to report.
    setFlaggedNotice(null);
    inProgress.start(candidate.id);

    const result = await retractMutation.mutate({
      path: `/api/v1/admin/brain-facts/${candidate.id}/retract`,
    });

    if (result.ok) {
      // The list is server-owned — `useAdminMutation` invalidates the
      // admin-fetch namespace, so the queue and the stats bar refetch together.
      if (detail?.id === candidate.id) setDetail(null);
      setRejectTarget(null);

      // Parsed, not cast. `useAdminMutation` is untyped at the wire, and a
      // hand-cast reads `.length` off whatever arrived — a `flaggedForReReview`
      // that came back as a string would render a fabricated count, and one
      // that came back as a number would render nothing while claiming the
      // shape was fine. `web` and `api` are separate Railway services, so a
      // rolling deploy makes wire skew a real window rather than a hypothetical.
      //
      // `.pick()`, so the notice depends only on the field it renders: an API
      // that skewed on `correctionEpisodeId` alone would otherwise suppress a
      // disclosure whose own input arrived intact.
      const parsed = BrainFactRetractResponseSchema.pick({ flaggedForReReview: true }).safeParse(
        result.data,
      );
      if (!parsed.success) {
        // Never silent (CLAUDE.md). `console.warn`, not `debug` — the default
        // log level filters `debug`, which would hide exactly this bug class.
        console.warn(
          "brain-facts: the retract response did not carry a readable `flaggedForReReview` — the flagged-dependent disclosure was dropped for this rejection",
          parsed.error.issues,
        );
      } else if (parsed.data.flaggedForReReview.length > 0) {
        setFlaggedNotice({
          claim: `${candidate.subject} ${candidate.predicate} ${candidate.object}`,
          count: parsed.data.flaggedForReReview.length,
        });
      }
    } else {
      // Keep the dialog open with the failure inside it: a rejection that
      // silently didn't happen would leave a claim in the publish set while the
      // reviewer believed they had pulled it.
      // `friendlyError`, not `.message`: it appends the request id on every
      // branch, which is the whole point of the API emitting one.
      setRejectError(friendlyError(result.error));
    }
    inProgress.stop(candidate.id);
  }

  // Page-level, not per-candidate: the cap is applied across the whole page in
  // endpoint-fact-id order, so loss is concentrated at the tail rather than
  // spread evenly — a candidate can lose every hint it originated while keeping
  // the ones pointed at it. Either way an incomplete list is indistinguishable
  // from a complete one, which is why the flag exists.
  //
  // The cap is not the only thing that raises it: an edge row the walk could
  // not use is dropped and also marks the page incomplete (`lib/brain/
  // tensions.ts`). Same meaning to a reader — some conflict lists here are
  // partial — which is why it is one flag and not two.
  const tensionsTruncated = listResponse?.tensionsTruncated ?? false;

  function applyFilters(next: Partial<typeof params>) {
    table.setPageIndex(0);
    // fire-and-forget: nuqs URL update
    void setParams({ ...next, page: 1 });
  }

  const filters = {
    status: params.status,
    provisional: params.provisional,
    tension: params.tension,
    q: params.q,
  };
  const hasFilters = hasBrainFactFilters(filters);

  function clearFilters() {
    setSearchDraft("");
    applyFilters({ status: "draft", provisional: false, tension: false, q: "" });
  }

  return (
    <TooltipProvider>
      <div className="p-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Brain Facts</h1>
            <p className="text-sm text-muted-foreground">
              Review what Atlas has learned before it becomes something the agent will repeat
            </p>
            {/* States the consequence of each action before the reviewer takes
                it. The inverted loop (reject, then publish) is not obvious, and
                a reviewer who assumes a missing Approve button is a bug will
                publish claims they meant to hold. */}
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Rejecting a claim withdraws it — it leaves this queue and is never published, but
              stays on the record so past answers still make sense. Publishing promotes{" "}
              <strong>every remaining draft in the workspace</strong> — including any this
              queue cannot show you — so reject what you don&apos;t trust first.
            </p>
          </div>
          {/* Gated on a queue that actually loaded. Publishing is workspace-wide
              and completely independent of this ACL read, so an enabled button
              above a red banner would let a reviewer promote every draft in the
              workspace precisely when they have been shown none of them — the
              failure the read model now throws to prevent, one layer up. */}
          <Button
            onClick={() => setPublishOpen(true)}
            disabled={!!error || !!summaryError}
            title={
              error || summaryError
                ? "The review queue couldn't be loaded, so there is nothing to review against. Publishing now would promote drafts you haven't seen."
                : undefined
            }
          >
            <Upload className="mr-1.5 size-3.5" aria-hidden />
            Review &amp; publish
          </Button>
        </div>

        <ErrorBoundary>
          <div className="space-y-4">
            {summaryError ? (
              <p role="alert" className="text-sm text-destructive">
                Couldn&apos;t load queue totals: {friendlyError(summaryError)}
              </p>
            ) : (
              summary && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Brain className="size-3.5" aria-hidden />
                    <span className="font-medium tabular-nums text-foreground">
                      {summary.draftTotal.toLocaleString()}
                    </span>{" "}
                    awaiting review
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5" aria-hidden />
                    <span className="font-medium tabular-nums text-foreground">
                      {summary.provisionalTotal.toLocaleString()}
                    </span>{" "}
                    provisional
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Split className="size-3.5" aria-hidden />
                    <span className="font-medium tabular-nums text-foreground">
                      {summary.inTensionTotal.toLocaleString()}
                    </span>{" "}
                    in tension
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Link2 className="size-3.5" aria-hidden />
                    <span className="font-medium tabular-nums text-foreground">
                      {summary.publishedTotal.toLocaleString()}
                    </span>{" "}
                    published
                  </span>
                </div>
              )
            )}

            {/* Above the queue, not below it: the queue is this reader's
                subset, and the fact that it IS a subset has to be readable
                before the rows are, not after scrolling past them. */}
            <OversightPanel />

            <QueueFilterRow
              options={STATUS_FILTERS}
              value={params.status}
              onChange={(status) => applyFilters({ status })}
              trailing={
                <>
                  <Button
                    size="sm"
                    variant={params.provisional ? "secondary" : "ghost"}
                    aria-pressed={params.provisional}
                    onClick={() => applyFilters({ provisional: !params.provisional })}
                  >
                    <AlertTriangle className="mr-1.5 size-3.5" aria-hidden />
                    Provisional only
                  </Button>
                  <Button
                    size="sm"
                    variant={params.tension ? "secondary" : "ghost"}
                    aria-pressed={params.tension}
                    onClick={() => applyFilters({ tension: !params.tension })}
                  >
                    <Split className="mr-1.5 size-3.5" aria-hidden />
                    In tension only
                  </Button>
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      applyFilters({ q: searchDraft });
                    }}
                  >
                    <Input
                      value={searchDraft}
                      onChange={(e) => setSearchDraft(e.target.value)}
                      placeholder="Search claims"
                      aria-label="Search claims"
                      className="h-8 w-44 text-sm"
                    />
                    <Button type="submit" size="sm" variant="ghost">
                      <Search className="size-3.5" aria-hidden />
                      <span className="sr-only">Search</span>
                    </Button>
                  </form>
                  {hasFilters && (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                      <X className="mr-1.5 size-3.5" aria-hidden />
                      Clear
                    </Button>
                  )}
                </>
              }
            />

            {flaggedNotice && (
              <Alert>
                <Link2 className="size-4" aria-hidden />
                <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    Rejecting &ldquo;{flaggedNotice.claim}&rdquo; flagged{" "}
                    <strong>
                      {flaggedNotice.count} other claim{flaggedNotice.count === 1 ? "" : "s"}
                    </strong>{" "}
                    derived from it for re-review. Nothing was withdrawn automatically — a
                    conclusion can outlive one of its premises. No queue lists them: the ids
                    are kept on this rejection&apos;s row in Audit &rarr; Admin actions, and
                    the CSV export there is what carries them in full.
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setFlaggedNotice(null)}
                  >
                    Dismiss
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {tensionsTruncated && (
              <Alert>
                <Split className="size-4" aria-hidden />
                <AlertDescription>
                  This page has more conflicting claims than Atlas can show at once, so some
                  candidates&apos; conflicts are missing here. Narrow the queue with a filter, or
                  use a smaller page, before treating any row as conflict-free.
                </AlertDescription>
              </Alert>
            )}

            <ServerDataTable
              table={table}
              loading={loading}
              error={error}
              isEmpty={candidates.length === 0}
              onRetry={refetch}
              feature="Brain Facts"
              loadingMessage="Loading fact candidates..."
              emptyState={{
                icon: Brain,
                title: "Nothing to review",
                description:
                  "Facts appear here once a connector ingests episodes and extraction is enabled. Claims Atlas refused outright — no evidence, no usable grant, or an unattributable author — never reach this queue.",
              }}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
              onRowClick={(row, e) => {
                if ((e.target as HTMLElement).closest('[role="checkbox"], button')) return;
                setDetail(row.original);
              }}
            />
          </div>
        </ErrorBoundary>

        <Sheet
          open={!!detail}
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
        >
          <SheetContent className="overflow-y-auto sm:max-w-xl">
            {detail && (
              <>
                <SheetHeader>
                  <SheetTitle>Fact candidate</SheetTitle>
                  <SheetDescription>
                    Everything Atlas recorded behind this claim. You decide whether to trust it.
                  </SheetDescription>
                </SheetHeader>

                <CandidateDetail candidate={detail} />

                <div className="flex gap-2 border-t px-4 py-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={inProgress.has(detail.id)}
                    onClick={() => {
                      setRejectError(null);
                      setRejectTarget(detail);
                    }}
                  >
                    <X className="mr-1.5 size-3.5" aria-hidden />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setDetail(null);
                      setPublishOpen(true);
                    }}
                  >
                    <Check className="mr-1.5 size-3.5" aria-hidden />
                    Keep &amp; publish queue
                  </Button>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

        <AlertDialog
          open={!!rejectTarget}
          onOpenChange={(open) => {
            if (!open) {
              setRejectTarget(null);
              setRejectError(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reject this claim?</AlertDialogTitle>
              <AlertDialogDescription>
                {rejectTarget && (
                  <>
                    &ldquo;{rejectTarget.subject} {rejectTarget.predicate} {rejectTarget.object}
                    &rdquo; will be withdrawn. It leaves this queue and is never published. Nothing
                    is deleted — the claim stays on the record, so questions about what Atlas
                    believed in the past still answer correctly.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {rejectError && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" aria-hidden />
                <AlertDescription>{rejectError}</AlertDescription>
              </Alert>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={!!rejectTarget && inProgress.has(rejectTarget.id)}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={!!rejectTarget && inProgress.has(rejectTarget.id)}
                // preventDefault stops Radix auto-closing: a failed rejection
                // must keep the dialog open to show why, and `rejectCandidate`
                // closes it itself only on success.
                onClick={(e) => {
                  e.preventDefault();
                  if (rejectTarget) void rejectCandidate(rejectTarget);
                }}
              >
                Reject
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <PublishModal open={publishOpen} onOpenChange={setPublishOpen} />
      </div>
    </TooltipProvider>
  );
}
