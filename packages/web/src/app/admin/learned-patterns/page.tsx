"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { useQueryStates } from "nuqs";
import type { ColumnDef } from "@tanstack/react-table";
import type { LearnedPattern, LearnedPatternStatus } from "@/ui/lib/types";
import { learnedPatternsSearchParams } from "./search-params";
import { getLearnedPatternColumns, statusBadge, autoApprovedBadge } from "./columns";
import { useAtlasConfig } from "@/ui/context";
import { ServerDataTable } from "@/ui/components/admin/server-data-table";
import { useServerDataTable } from "@/ui/hooks/use-server-data-table";
import { LearnedPatternsListResponseSchema } from "@/ui/lib/admin-schemas";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { bulkPartialSummary, RelativeTimestamp } from "@/ui/components/admin/queue";
import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";
import { useInProgressSet } from "@/ui/hooks/use-admin-fetch";
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
} from "lucide-react";

interface PatternStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

const LIMIT = 50;
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export default function LearnedPatternsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Mutation-error surface (list-load errors come from the module below). The
  // `fetchKey` cache-buster now refreshes only the aux stats/entities fetches;
  // the paginated list refetches through the module + admin-fetch invalidation.
  const [actionError, setActionError] = useState<FetchError | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const [params, setParams] = useQueryStates(learnedPatternsSearchParams);

  const [stats, setStats] = useState<PatternStats | null>(null);
  const [detailPattern, setDetailPattern] = useState<LearnedPattern | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LearnedPattern | null>(null);
  const [sourceEntities, setSourceEntities] = useState<string[]>([]);

  const inProgress = useInProgressSet();
  const statusMutation = useAdminMutation<LearnedPattern>({ method: "PATCH" });
  const deleteMutation = useAdminMutation({ method: "DELETE" });
  const bulkMutation = useAdminMutation({ path: "/api/v1/admin/learned-patterns/bulk", method: "POST" });

  useEffect(() => {
    let cancelled = false;

    async function fetchStats() {
      try {
        const [allRes, pendingRes, approvedRes, rejectedRes] = await Promise.all([
          fetch(`${apiUrl}/api/v1/admin/learned-patterns?limit=1&offset=0`, { credentials }),
          fetch(`${apiUrl}/api/v1/admin/learned-patterns?limit=1&offset=0&status=pending`, { credentials }),
          fetch(`${apiUrl}/api/v1/admin/learned-patterns?limit=1&offset=0&status=approved`, { credentials }),
          fetch(`${apiUrl}/api/v1/admin/learned-patterns?limit=1&offset=0&status=rejected`, { credentials }),
        ]);

        if (cancelled) return;

        if (allRes.ok && pendingRes.ok && approvedRes.ok && rejectedRes.ok) {
          const [all, pending, approved, rejected] = await Promise.all([
            allRes.json(), pendingRes.json(), approvedRes.json(), rejectedRes.json(),
          ]);
          if (!cancelled) {
            setStats({
              total: all.total ?? 0,
              pending: pending.total ?? 0,
              approved: approved.total ?? 0,
              rejected: rejected.total ?? 0,
            });
          }
        } else {
          console.debug("Some stats fetches failed:", {
            all: allRes.status, pending: pendingRes.status, approved: approvedRes.status, rejected: rejectedRes.status,
          });
        }
      } catch (err) {
        // Stats are non-critical — don't block the page.
        console.debug("Failed to fetch learned pattern stats", err);
      }
    }

    async function fetchEntities() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/learned-patterns?limit=200&offset=0`, { credentials });
        if (cancelled) return;
        if (!res.ok) {
          console.debug(`Failed to fetch source entities: HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        const entities = new Set<string>();
        for (const p of data.patterns ?? []) {
          if (p.sourceEntity) entities.add(p.sourceEntity);
        }
        if (!cancelled) setSourceEntities([...entities].toSorted());
      } catch (err) {
        console.debug("Failed to fetch source entities", err);
      }
    }

    // fire-and-forget: background loads guarded by the `cancelled` flag
    void fetchStats();
    void fetchEntities();
    return () => { cancelled = true; };
  }, [apiUrl, credentials, fetchKey]);

  async function updatePatternStatus(id: string, status: LearnedPatternStatus) {
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

    if (!result.ok) setActionError(result.error);
    setFetchKey((k) => k + 1); // refresh aux stats/entities counts
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
    } else {
      setActionError(result.error);
    }
    setFetchKey((k) => k + 1); // refresh aux stats/entities counts
    setDeleteTarget(null);
    inProgress.stop(id);
  }

  async function bulkUpdateStatus(status: LearnedPatternStatus) {
    const selected = table.getSelectedRowModel().rows.map((r) => r.original.id);
    if (selected.length === 0) return;
    setActionError(null);

    const result = await bulkMutation.mutate({ body: { ids: selected, status } });

    if (!result.ok) {
      // Whole-request failure — keep selection so the operator can retry.
      setActionError(result.error);
      setFetchKey((k) => k + 1);
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
      setActionError({ message: bulkPartialSummary(data, selected.length, noun) });
      // Narrow selection to failed IDs so retry hits exactly the unfinished work.
      table.setRowSelection(Object.fromEntries([...failedIds].map((id) => [id, true])));
    } else {
      table.resetRowSelection();
    }

    setFetchKey((k) => k + 1); // refresh aux stats/entities counts
  }

  const columns: ColumnDef<LearnedPattern>[] = (() => {
    const base = getLearnedPatternColumns();
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
                onClick={() => setDeleteTarget(pattern)}
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
    buildPath: ({ offset, perPage }) => {
      const qs = new URLSearchParams({
        limit: String(perPage),
        offset: String(offset),
      });
      if (params.status) qs.set("status", params.status);
      if (params.source_entity) qs.set("source_entity", params.source_entity);
      return `/api/v1/admin/learned-patterns?${qs}`;
    },
  });

  const selectedCount = table.getSelectedRowModel().rows.length;
  const hasFilters = !!params.status || !!params.source_entity;

  return (
    <TooltipProvider>
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Learned Patterns</h1>
          <p className="text-sm text-muted-foreground">Review and manage agent-proposed query patterns</p>
        </div>

        <ErrorBoundary>
          <div className="space-y-4">
            {stats && (
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
              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    table.setPageIndex(0);
                    // fire-and-forget: nuqs URL update
                    void setParams({ status: "", source_entity: "", page: 1 });
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

            {actionError && (
              <ErrorBanner
                message={friendlyError(actionError)}
                onRetry={() => setActionError(null)}
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
              onClearFilters={() => setParams({ status: "", source_entity: "", page: 1 })}
              onRowClick={(row, e) => {
                if ((e.target as HTMLElement).closest('[role="checkbox"], button')) return;
                setDetailPattern(row.original);
              }}
            />
          </div>
        </ErrorBoundary>

        <Sheet open={!!detailPattern} onOpenChange={(open) => { if (!open) setDetailPattern(null); }}>
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
                        <p>Reviewed by: {detailPattern.reviewedBy ?? "Unknown"}</p>
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

                  <div className="flex gap-2 border-t pt-4">
                    {detailPattern.status !== "approved" && (
                      <Button
                        size="sm"
                        onClick={() => updatePatternStatus(detailPattern.id, "approved")}
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
                        onClick={() => updatePatternStatus(detailPattern.id, "rejected")}
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
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete learned pattern?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete this pattern. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => { if (deleteTarget) void deletePattern(deleteTarget.id); }}
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

