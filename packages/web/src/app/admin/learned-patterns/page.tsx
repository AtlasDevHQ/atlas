"use client";

import { useState } from "react";
import type { z } from "zod";
import { useQueryStates } from "nuqs";
import type { ColumnDef } from "@tanstack/react-table";
import type { LearnedPattern, LearnedPatternStatus } from "@/ui/lib/types";
import { learnedPatternsSearchParams } from "./search-params";
import { buildLearnedPatternsPath } from "./list-query";
import { ConfidenceFilter } from "./confidence-filter";
import { getLearnedPatternColumns, statusBadge, autoApprovedBadge } from "./columns";
import { ServerDataTable } from "@/ui/components/admin/server-data-table";
import { useServerDataTable } from "@/ui/hooks/use-server-data-table";
import {
  LearnedPatternsListResponseSchema,
  LearnedPatternsSummaryResponseSchema,
} from "@/ui/lib/admin-schemas";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActionErrorAlert } from "./action-error";
import { renderSurface, type ActionError, type StatusSurface } from "./action-error-state";
import { bulkPartialSummary, RelativeTimestamp } from "@/ui/components/admin/queue";
import { buildFetchError } from "@/ui/lib/fetch-error";
import { useAdminFetch, useInProgressSet } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Brain,
  Clock,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  Check,
  X,
  Trash2,
  Database,
  Bot,
  Calendar,
  Layers,
} from "lucide-react";

const LIMIT = 50;
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export default function LearnedPatternsPage() {
  // A mutation failure is pinned to the surface the admin acted in — the detail
  // `sheet`, the `delete` confirmation dialog, or the `page` body (row-menu /
  // bulk actions) — so the error renders where the click happened instead of in
  // a page banner behind the open overlay (#4574). The `action` descriptor lets
  // the honest "Retry" re-run the exact failed mutation via the current-render
  // handlers, so there are no stale-closure surprises.
  const [actionError, setActionError] = useState<ActionError | null>(null);

  const [params, setParams] = useQueryStates(learnedPatternsSearchParams);

  const [detailPattern, setDetailPattern] = useState<LearnedPattern | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LearnedPattern | null>(null);

  const inProgress = useInProgressSet();
  const statusMutation = useAdminMutation<LearnedPattern>({ method: "PATCH" });
  const deleteMutation = useAdminMutation({ method: "DELETE" });
  const bulkMutation = useAdminMutation({ path: "/api/v1/admin/learned-patterns/bulk", method: "POST" });

  // The stats bar, entity dropdown, and multi-group column toggle all read one
  // schema-validated summary (#4578) — replacing four per-status stats fetches
  // and a truncated `limit=200` entity scrape with one request, and adding the
  // multi-group flag. A 403/500/schema-mismatch is consumed via `summaryError`
  // and rendered in place of the stats bar, so an auth or version failure is
  // visible instead of a silently vanished stats row. `useAdminMutation`
  // invalidates the `admin-fetch` namespace on every approve/reject/delete, so
  // these counts refetch in lockstep with the table.
  const { data: summary, error: summaryError } = useAdminFetch<
    z.infer<typeof LearnedPatternsSummaryResponseSchema>
  >("/api/v1/admin/learned-patterns/summary", {
    schema: LearnedPatternsSummaryResponseSchema,
  });
  const stats = summary?.stats ?? null;
  const sourceEntities = summary?.entities ?? [];
  const multiGroup = summary?.multiGroup ?? false;

  // `surface` decides where a failure renders: "sheet" when the admin clicked
  // Approve/Reject inside the detail sheet, "page" when from the row menu.
  async function updatePatternStatus(
    id: string,
    status: LearnedPatternStatus,
    surface: StatusSurface = "page",
  ) {
    setActionError(null);
    inProgress.start(id);

    // The list is server-owned: `useAdminMutation` invalidates admin-fetch
    // queries on success, so the module refetches with the new status. Only the
    // detail sheet (local UI state) is updated in place from the server row.
    const result = await statusMutation.mutate({
      path: `/api/v1/admin/learned-patterns/${id}`,
      body: { status },
      onSuccess: (updated) => {
        if (updated) setDetailPattern((prev) => (prev?.id === id ? updated : prev));
      },
    });

    if (!result.ok) {
      setActionError({ error: result.error, action: { kind: "status", id, status, surface } });
    }
    inProgress.stop(id);
  }

  async function deletePattern(id: string) {
    setActionError(null);
    inProgress.start(id);

    const result = await deleteMutation.mutate({
      path: `/api/v1/admin/learned-patterns/${id}`,
    });

    if (result.ok) {
      if (detailPattern?.id === id) setDetailPattern(null);
      setDeleteTarget(null); // close the confirm dialog only on success
    } else {
      // Keep the confirm dialog open and surface the error inside it so a failed
      // delete can't be mistaken for a completed one.
      setActionError({ error: result.error, action: { kind: "delete", id } });
    }
    inProgress.stop(id);
  }

  async function bulkUpdateStatus(status: LearnedPatternStatus) {
    const selected = table.getSelectedRowModel().rows.map((r) => r.original.id);
    if (selected.length === 0) return;
    setActionError(null);

    const result = await bulkMutation.mutate({ body: { ids: selected, status } });

    if (!result.ok) {
      // Whole-request failure — keep selection so the operator can retry.
      setActionError({ error: result.error, action: { kind: "bulk", status } });
      return;
    }

    // Partial-success: server returns 200 with { updated, notFound, errors? }
    // even when individual rows fail. Surface the discrepancy and keep only the
    // failed rows selected; the module refetches the list via invalidation.
    const data = (result.data ?? {}) as {
      updated?: string[];
      notFound?: string[];
      errors?: Array<{ id: string; error: string }>;
    };
    const failedIds = new Set<string>([
      ...(data.notFound ?? []),
      ...(data.errors ?? []).map((e) => e.id),
    ]);

    if (failedIds.size > 0) {
      const noun = status === "approved" ? "approvals" : status === "rejected" ? "rejections" : "updates";
      setActionError({
        error: buildFetchError({ message: bulkPartialSummary(data, selected.length, noun) }),
        action: { kind: "bulk", status },
      });
      // Narrow selection to failed IDs so retry hits exactly the unfinished work.
      table.setRowSelection(Object.fromEntries([...failedIds].map((id) => [id, true])));
    } else {
      table.resetRowSelection();
    }
  }

  // Honest "Retry" — re-run the exact failed mutation through the current-render
  // handlers (each clears `actionError` at its start). "Dismiss" is a separate,
  // truthfully-labelled affordance that just clears the error.
  function retryAction() {
    const action = actionError?.action;
    if (!action) return;
    switch (action.kind) {
      case "status":
        void updatePatternStatus(action.id, action.status, action.surface);
        break;
      case "delete":
        void deletePattern(action.id);
        break;
      case "bulk":
        void bulkUpdateStatus(action.status);
        break;
      default: {
        // Exhaustiveness guard — a new RetryableAction kind is a compile error
        // here rather than silently replaying as a bulk op.
        const _never: never = action;
        void _never;
      }
    }
  }

  function dismissError() {
    setActionError(null);
  }

  // Opening a detail sheet or the delete dialog drops any lingering error from a
  // prior action, so it can't sit behind — or bleed into — the new overlay (the
  // exact "error hidden behind the modal" anti-pattern this cockpit fixes). A
  // fresh action clears its own slot at the start anyway, so nothing in-flight
  // is lost.
  function clearActionError() {
    setActionError(null);
  }

  const columns: ColumnDef<LearnedPattern>[] = (() => {
    const base = getLearnedPatternColumns({ showGroup: multiGroup });
    const actionsCol: ColumnDef<LearnedPattern> = {
      id: "actions",
      header: () => null,
      cell: ({ row }) => {
        const pattern = row.original;
        const busy = inProgress.has(pattern.id);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="size-8 p-0" disabled={busy}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {pattern.status !== "approved" && (
                <DropdownMenuItem onClick={() => updatePatternStatus(pattern.id, "approved")}>
                  <Check className="mr-2 size-4" />
                  Approve
                </DropdownMenuItem>
              )}
              {pattern.status !== "rejected" && (
                <DropdownMenuItem onClick={() => updatePatternStatus(pattern.id, "rejected")}>
                  <X className="mr-2 size-4" />
                  Reject
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => { clearActionError(); setDeleteTarget(pattern); }}
              >
                <Trash2 className="mr-2 size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 64,
    };
    return [...base, actionsCol];
  })();

  // The server-data-table module owns pagination, the patterns fetch,
  // pageCount, and the table instance; the page keeps its filters, aux stats,
  // detail sheet, and bulk/row actions.
  const {
    table,
    rows: patterns,
    loading,
    error,
    refetch,
  } = useServerDataTable<
    LearnedPattern,
    z.infer<typeof LearnedPatternsListResponseSchema>
  >({
    columns,
    getRowId: (row) => row.id,
    defaultPerPage: LIMIT,
    defaultSorting: [{ id: "createdAt", desc: true }],
    schema: LearnedPatternsListResponseSchema,
    select: (r) => ({ rows: r.patterns, total: r.total }),
    buildPath: ({ offset, perPage, sortId, sortDesc }) =>
      buildLearnedPatternsPath(
        { offset, perPage, sortId, sortDesc },
        {
          status: params.status,
          source_entity: params.source_entity,
          min_confidence: params.min_confidence,
          max_confidence: params.max_confidence,
        },
      ),
  });

  const selectedCount = table.getSelectedRowModel().rows.length;
  // Where the pinned error renders — derived at render time from the action plus
  // which overlays are open, never stored. A sheet/delete error whose overlay
  // was dismissed mid-flight (or replaced by a different item) falls back to the
  // page banner instead of vanishing behind or into the wrong surface.
  const errorSurface = renderSurface(
    actionError,
    detailPattern?.id ?? null,
    deleteTarget?.id ?? null,
  );
  const hasFilters =
    !!params.status ||
    !!params.source_entity ||
    !!params.min_confidence ||
    !!params.max_confidence;

  return (
    <TooltipProvider>
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Learned Patterns</h1>
          <p className="text-sm text-muted-foreground">Review and manage agent-proposed query patterns</p>
          {/* States approval's consequence so an admin knows what a click does
              before making it (#4578): approval is an eligibility grant, not a
              confidence write — it takes effect immediately regardless of the
              machine's confidence score (CONTEXT.md § Learned query patterns). */}
          <p className="mt-2 text-sm text-muted-foreground">
            Approving a pattern injects it into the agent whenever it&apos;s
            relevant — immediately, regardless of its confidence score.
          </p>
        </div>

        <ErrorBoundary>
          <div className="space-y-4">
            {/* A failed summary load is shown here, not swallowed — an auth
                (403) or version (schema-mismatch) failure must be visible, never
                a silently vanished stats row (#4578). */}
            {summaryError ? (
              <p role="alert" className="text-sm text-destructive">
                Couldn&apos;t load pattern summary: {summaryError.message}
              </p>
            ) : stats && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-3.5" />
                  <span className="font-medium tabular-nums text-foreground">{stats.pending.toLocaleString()}</span> pending
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5" />
                  <span className="font-medium tabular-nums text-foreground">{stats.approved.toLocaleString()}</span> approved
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <XCircle className="size-3.5" />
                  <span className="font-medium tabular-nums text-foreground">{stats.rejected.toLocaleString()}</span> rejected
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Brain className="size-3.5" />
                  <span className="font-medium tabular-nums text-foreground">{stats.total.toLocaleString()}</span> total
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {STATUS_FILTERS.map((opt) => (
                <Button
                  key={opt.value || "all"}
                  size="sm"
                  variant={params.status === opt.value ? "secondary" : "ghost"}
                  onClick={() => {
                    table.setPageIndex(0);
                    // fire-and-forget: nuqs URL update
                    void setParams({ status: opt.value, page: 1 });
                  }}
                >
                  {opt.label}
                </Button>
              ))}
              {sourceEntities.length > 0 && (
                <Select
                  value={params.source_entity || "all"}
                  onValueChange={(v) => {
                    table.setPageIndex(0);
                    // fire-and-forget: nuqs URL update
                    void setParams({ source_entity: v === "all" ? "" : v, page: 1 });
                  }}
                >
                  <SelectTrigger className="h-8 w-44 text-sm">
                    <SelectValue placeholder="All entities" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All entities</SelectItem>
                    {sourceEntities.map((e) => (
                      <SelectItem key={e} value={e}>
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <ConfidenceFilter
                min={params.min_confidence}
                max={params.max_confidence}
                onApply={({ min, max }) => {
                  table.setPageIndex(0);
                  // fire-and-forget: nuqs URL update
                  void setParams({ min_confidence: min, max_confidence: max, page: 1 });
                }}
              />
              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    table.setPageIndex(0);
                    // fire-and-forget: nuqs URL update
                    void setParams({ status: "", source_entity: "", min_confidence: "", max_confidence: "", page: 1 });
                  }}
                >
                  <X className="mr-1.5 size-3.5" />
                  Clear
                </Button>
              )}

              {selectedCount > 0 && (
                <>
                  <div className="mx-1 h-4 w-px bg-border" />
                  <span className="text-sm text-muted-foreground">{selectedCount} selected</span>
                  <Button
                    size="sm"
                    onClick={() => bulkUpdateStatus("approved")}
                  >
                    <Check className="mr-1.5 size-3.5" />
                    Approve {selectedCount}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => bulkUpdateStatus("rejected")}
                  >
                    <X className="mr-1.5 size-3.5" />
                    Reject {selectedCount}
                  </Button>
                </>
              )}
            </div>

            {actionError && errorSurface === "page" && (
              <ActionErrorAlert
                error={actionError.error}
                onRetry={retryAction}
                onDismiss={dismissError}
              />
            )}

            <ServerDataTable
              table={table}
              loading={loading}
              error={error}
              isEmpty={patterns.length === 0}
              onRetry={refetch}
              feature="Learned Patterns"
              loadingMessage="Loading learned patterns..."
              emptyState={{
                icon: Brain,
                title: "No learned patterns",
                description: "Patterns will appear here when the agent or atlas learn CLI proposes new query patterns.",
              }}
              hasFilters={hasFilters}
              onClearFilters={() => setParams({ status: "", source_entity: "", min_confidence: "", max_confidence: "", page: 1 })}
              onRowClick={(row, e) => {
                if ((e.target as HTMLElement).closest('[role="checkbox"], button')) return;
                clearActionError();
                setDetailPattern(row.original);
              }}
            />
          </div>
        </ErrorBoundary>

        <Sheet
          open={!!detailPattern}
          onOpenChange={(open) => {
            if (!open) setDetailPattern(null);
            // A lingering in-sheet error isn't cleared here: `renderSurface`
            // reroutes it to the page banner once the sheet is gone, so a late
            // failure stays visible instead of silently vanishing on close.
          }}
        >
          <SheetContent className="sm:max-w-lg overflow-y-auto">
            {detailPattern && (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    Learned Pattern
                    {(() => {
                      if (detailPattern.status === "approved" && detailPattern.autoPromoted) {
                        return (
                          <Badge variant={autoApprovedBadge.variant} className={autoApprovedBadge.className}>
                            {autoApprovedBadge.label}
                          </Badge>
                        );
                      }
                      const badge = statusBadge[detailPattern.status] ?? statusBadge.pending;
                      return <Badge variant={badge.variant} className={badge.className}>{badge.label}</Badge>;
                    })()}
                  </SheetTitle>
                  <SheetDescription>
                    {detailPattern.description ?? "No description"}
                  </SheetDescription>
                </SheetHeader>

                <div className="space-y-6 px-4">
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Pattern SQL</h3>
                    <pre className="rounded-md border bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-64">
                      {detailPattern.patternSql}
                    </pre>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <Database className="size-3" /> Entity
                      </span>
                      <p className="font-mono text-xs">{detailPattern.sourceEntity ?? "\u2014"}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <Bot className="size-3" /> Source
                      </span>
                      <p className="text-xs">{detailPattern.proposedBy ?? "\u2014"}</p>
                    </div>
                    {/* Connection group \u2014 shown only for multi-group workspaces, so
                        an admin confirms which group they're approving into (#4578). */}
                    {multiGroup && (
                      <div className="space-y-1">
                        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                          <Layers className="size-3" /> Group
                        </span>
                        <p className="font-mono text-xs">{detailPattern.connectionGroupId ?? "default"}</p>
                      </div>
                    )}
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Confidence</span>
                      <p className="text-xs">{Math.round(detailPattern.confidence * 100)}%</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Times seen</span>
                      <p className="text-xs tabular-nums">{detailPattern.repetitionCount}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Avg latency</span>
                      <p className="text-xs tabular-nums">
                        {detailPattern.avgDurationMs === null
                          ? "—"
                          : `${Math.round(detailPattern.avgDurationMs).toLocaleString()}ms`}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <Calendar className="size-3" /> Created
                      </span>
                      <p className="text-xs"><RelativeTimestamp iso={detailPattern.createdAt} /></p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Last Updated</span>
                      <p className="text-xs"><RelativeTimestamp iso={detailPattern.updatedAt} /></p>
                    </div>
                  </div>

                  {detailPattern.reviewedAt && (
                    <div className="space-y-2 border-t pt-4">
                      <h3 className="text-sm font-medium">Review History</h3>
                      <div className="text-xs text-muted-foreground space-y-1">
                        {/* Resolved name/email — never the raw reviewer UUID (#4578). */}
                        <p>Reviewed by: {detailPattern.reviewedByLabel ?? "Unknown"}</p>
                        <p><RelativeTimestamp iso={detailPattern.reviewedAt} label="Reviewed" /></p>
                      </div>
                    </div>
                  )}

                  {detailPattern.sourceQueries && detailPattern.sourceQueries.length > 0 && (
                    <div className="space-y-2 border-t pt-4">
                      <h3 className="text-sm font-medium">Source Queries</h3>
                      <div className="space-y-2">
                        {detailPattern.sourceQueries.map((q, i) => (
                          <pre
                            key={i}
                            className="rounded-md border bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all"
                          >
                            {q}
                          </pre>
                        ))}
                      </div>
                    </div>
                  )}

                  {actionError && errorSurface === "sheet" && (
                    <ActionErrorAlert
                      error={actionError.error}
                      onRetry={retryAction}
                      onDismiss={dismissError}
                    />
                  )}

                  <div className="flex gap-2 border-t pt-4">
                    {detailPattern.status !== "approved" && (
                      <Button
                        size="sm"
                        onClick={() => updatePatternStatus(detailPattern.id, "approved", "sheet")}
                        disabled={inProgress.has(detailPattern.id)}
                      >
                        <Check className="mr-1.5 size-3.5" />
                        Approve
                      </Button>
                    )}
                    {detailPattern.status !== "rejected" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updatePatternStatus(detailPattern.id, "rejected", "sheet")}
                        disabled={inProgress.has(detailPattern.id)}
                      >
                        <X className="mr-1.5 size-3.5" />
                        Reject
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setActionError(null);
                        setDetailPattern(null);
                        setDeleteTarget(detailPattern);
                      }}
                      disabled={inProgress.has(detailPattern.id)}
                    >
                      <Trash2 className="mr-1.5 size-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            // Cancel / Escape / outside-click closes; `renderSurface` reroutes any
            // lingering in-dialog error to the page banner so it stays visible.
            if (!open) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete learned pattern?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete this pattern. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>

            {actionError && errorSurface === "delete" && (
              <ActionErrorAlert
                error={actionError.error}
                onRetry={retryAction}
                onDismiss={dismissError}
              />
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={!!deleteTarget && inProgress.has(deleteTarget.id)}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={!!deleteTarget && inProgress.has(deleteTarget.id)}
                // preventDefault stops Radix from auto-closing the dialog: a
                // failed delete must keep the dialog open to show the error, and
                // `deletePattern` closes it itself only on success (#4574).
                onClick={(e) => {
                  e.preventDefault();
                  if (deleteTarget) void deletePattern(deleteTarget.id);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

