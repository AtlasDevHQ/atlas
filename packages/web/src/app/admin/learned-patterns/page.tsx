"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import type { ColumnDef } from "@tanstack/react-table";
import type { LearnedPattern, LearnedPatternStatus } from "@/ui/lib/types";
import { learnedPatternsSearchParams } from "./search-params";
import { getLearnedPatternColumns, statusBadge } from "./columns";
import { useAtlasConfig } from "@/ui/context";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { bulkPartialSummary, RelativeTimestamp } from "@/ui/components/admin/queue";
import { extractFetchError, type FetchError } from "@/ui/lib/fetch-error";
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
const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Any type" },
  { value: "query_pattern", label: "Query Patterns" },
  { value: "semantic_amendment", label: "Amendments" },
];

export default function LearnedPatternsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [patterns, setPatterns] = useState<LearnedPattern[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const [params, setParams] = useQueryStates(learnedPatternsSearchParams);
  const offset = (params.page - 1) * LIMIT;

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

    async function fetchPatterns() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(offset),
        });
        if (params.status) qs.set("status", params.status);
        if (params.type) qs.set("type", params.type);
        if (params.source_entity) qs.set("source_entity", params.source_entity);

        const res = await fetch(`${apiUrl}/api/v1/admin/learned-patterns?${qs}`, { credentials });
        if (cancelled) return;
        if (!res.ok) {
          setError(await extractFetchError(res));
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setPatterns(data.patterns ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError({ message: err instanceof Error ? err.message : "Failed to load patterns" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchPatterns();
    return () => { cancelled = true; };
  }, [apiUrl, offset, params.status, params.type, params.source_entity, credentials, fetchKey]);

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

    fetchStats();
    fetchEntities();
    return () => { cancelled = true; };
  }, [apiUrl, credentials, fetchKey]);

  async function updatePatternStatus(id: string, status: LearnedPatternStatus) {
    setError(null);
    inProgress.start(id);

    // Capture the *original* row inside the functional setState so concurrent
    // updates can't pollute each other's snapshot via the closure.
    let originalRow: LearnedPattern | undefined;
    let originalDetail: LearnedPattern | null = null;
    const optimistic = (p: LearnedPattern) =>
      p.id === id ? { ...p, status, updatedAt: new Date().toISOString() } : p;
    setPatterns((prev) => {
      originalRow = prev.find((p) => p.id === id);
      return prev.map(optimistic);
    });
    setDetailPattern((prev) => {
      if (prev?.id !== id) return prev;
      originalDetail = prev;
      return optimistic(prev);
    });

    const result = await statusMutation.mutate({
      path: `/api/v1/admin/learned-patterns/${id}`,
      body: { status },
      onSuccess: (updated) => {
        if (!updated) return;
        setPatterns((prev) => prev.map((p) => (p.id === id ? updated : p)));
        setDetailPattern((prev) => (prev?.id === id ? updated : prev));
      },
    });

    if (!result.ok) {
      // Revert *only this row*, not the whole array — preserves any
      // optimistic state from a concurrent mutation on another row.
      setPatterns((curr) => curr.map((p) => (p.id === id && originalRow ? originalRow : p)));
      setDetailPattern((curr) => (curr?.id === id ? originalDetail : curr));
      setError({ message: result.error });
    }
    setFetchKey((k) => k + 1);
    inProgress.stop(id);
  }

  async function deletePattern(id: string) {
    setError(null);
    inProgress.start(id);

    const result = await deleteMutation.mutate({
      path: `/api/v1/admin/learned-patterns/${id}`,
    });

    if (result.ok) {
      if (detailPattern?.id === id) setDetailPattern(null);
      setFetchKey((k) => k + 1);
    } else {
      setError({ message: result.error });
    }
    setDeleteTarget(null);
    inProgress.stop(id);
  }

  async function bulkUpdateStatus(status: LearnedPatternStatus) {
    const selected = table.getSelectedRowModel().rows.map((r) => r.original.id);
    if (selected.length === 0) return;
    setError(null);

    const ids = new Set(selected);
    const optimistic = (p: LearnedPattern) =>
      ids.has(p.id) ? { ...p, status, updatedAt: new Date().toISOString() } : p;

    let originalRows = new Map<string, LearnedPattern>();
    let originalDetail: LearnedPattern | null = null;
    setPatterns((prev) => {
      originalRows = new Map(prev.filter((p) => ids.has(p.id)).map((p) => [p.id, p]));
      return prev.map(optimistic);
    });
    setDetailPattern((prev) => {
      if (!prev || !ids.has(prev.id)) return prev;
      originalDetail = prev;
      return optimistic(prev);
    });

    const result = await bulkMutation.mutate({ body: { ids: selected, status } });

    if (!result.ok) {
      // Whole-request failure: revert only the rows we touched (preserve any
      // concurrent single-row optimism on other rows) and keep selection so
      // operator can retry.
      setPatterns((curr) => curr.map((p) => originalRows.get(p.id) ?? p));
      setDetailPattern((curr) => (curr && ids.has(curr.id) ? originalDetail : curr));
      setError({ message: result.error });
      setFetchKey((k) => k + 1);
      return;
    }

    // Partial-success: server returns 200 with { updated, notFound, errors? }
    // even when individual rows fail. Detect and surface the discrepancy
    // before clearing selection.
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
      // Revert only the rows the server didn't actually update.
      setPatterns((curr) => curr.map((p) => (failedIds.has(p.id) && originalRows.has(p.id) ? originalRows.get(p.id)! : p)));
      setDetailPattern((curr) => (curr && failedIds.has(curr.id) ? originalDetail : curr));
      const noun = status === "approved" ? "approvals" : status === "rejected" ? "rejections" : "updates";
      setError({ message: bulkPartialSummary(data, ids.size, noun) });
      // Narrow selection to failed IDs so retry hits exactly the unfinished work.
      table.setRowSelection(Object.fromEntries([...failedIds].map((id) => [id, true])));
    } else {
      table.resetRowSelection();
    }

    setFetchKey((k) => k + 1);
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

  const pageCount = Math.max(1, Math.ceil(total / LIMIT));
  const { table } = useDataTable({
    data: patterns,
    columns,
    pageCount,
    initialState: {
      sorting: [{ id: "createdAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: LIMIT },
    },
    getRowId: (row) => row.id,
  });

  const selectedCount = table.getSelectedRowModel().rows.length;
  const hasFilters = !!params.status || !!params.type || !!params.source_entity;

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
                    setParams({ status: opt.value, page: 1 });
                  }}
                >
                  {opt.label}
                </Button>
              ))}
              <div className="mx-1 h-4 w-px bg-border" />
              {TYPE_FILTERS.map((opt) => (
                <Button
                  key={opt.value || "all-type"}
                  size="sm"
                  variant={params.type === opt.value ? "secondary" : "ghost"}
                  onClick={() => {
                    table.setPageIndex(0);
                    setParams({ type: opt.value, page: 1 });
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
                    setParams({ source_entity: v === "all" ? "" : v, page: 1 });
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
                    setParams({ status: "", type: "", source_entity: "", page: 1 });
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

            <AdminContentWrapper
              loading={loading}
              error={error}
              feature="Learned Patterns"
              onRetry={() => setFetchKey((k) => k + 1)}
              loadingMessage="Loading learned patterns..."
              emptyIcon={Brain}
              emptyTitle="No learned patterns"
              emptyDescription="Patterns will appear here when the agent or atlas learn CLI proposes new query patterns."
              isEmpty={patterns.length === 0}
              hasFilters={hasFilters}
              onClearFilters={() => setParams({ status: "", type: "", source_entity: "", page: 1 })}
            >
              <DataTable
                table={table}
                onRowClick={(row, e) => {
                  if ((e.target as HTMLElement).closest('[role="checkbox"], button')) return;
                  setDetailPattern(row.original);
                }}
              >
                <DataTableToolbar table={table}>
                  <DataTableSortList table={table} />
                </DataTableToolbar>
              </DataTable>
            </AdminContentWrapper>
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
                      const badge = statusBadge[detailPattern.status] ?? statusBadge.pending;
                      return <Badge variant={badge.variant} className={badge.className}>{badge.label}</Badge>;
                    })()}
                  </SheetTitle>
                  <SheetDescription>
                    {detailPattern.description ?? "No description"}
                  </SheetDescription>
                </SheetHeader>

                <div className="space-y-6 px-4">
                  {detailPattern.type === "semantic_amendment" && detailPattern.amendmentPayload ? (
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Proposed Change</h3>
                      {detailPattern.amendmentPayload.rationale && (
                        <p className="text-xs text-muted-foreground">{String(detailPattern.amendmentPayload.rationale)}</p>
                      )}
                      {detailPattern.amendmentPayload.diff ? (
                        <pre className="rounded-md border bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-96">
                          {String(detailPattern.amendmentPayload.diff).split("\n").map((line, i) => {
                            let className = "text-muted-foreground";
                            if (line.startsWith("+") && !line.startsWith("+++")) {
                              className = "text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/30";
                            } else if (line.startsWith("-") && !line.startsWith("---")) {
                              className = "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/30";
                            } else if (line.startsWith("@@")) {
                              className = "text-cyan-700 dark:text-cyan-400";
                            }
                            return (
                              <span key={i} className={className}>
                                {line}
                                {"\n"}
                              </span>
                            );
                          })}
                        </pre>
                      ) : (
                        <pre className="rounded-md border bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-64">
                          {detailPattern.patternSql}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Pattern SQL</h3>
                      <pre className="rounded-md border bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-64">
                        {detailPattern.patternSql}
                      </pre>
                    </div>
                  )}

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
                onClick={() => { if (deleteTarget) deletePattern(deleteTarget.id); }}
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

