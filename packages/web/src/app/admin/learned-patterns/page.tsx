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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "@/ui/components/admin/stat-card";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  useInProgressSet,
  friendlyError,
  type FetchError,
} from "@/ui/hooks/use-admin-fetch";
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

// ── Types ─────────────────────────────────────────────────────────

interface PatternStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

const LIMIT = 50;
const STATUS_TABS = ["", "pending", "approved", "rejected"] as const;
const STATUS_LABELS: Record<string, string> = {
  "": "All",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

// ── Page ──────────────────────────────────────────────────────────

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

  // Stats computed from full counts
  const [stats, setStats] = useState<PatternStats | null>(null);

  // Detail sheet
  const [detailPattern, setDetailPattern] = useState<LearnedPattern | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<LearnedPattern | null>(null);

  // Source entities for filter dropdown
  const [sourceEntities, setSourceEntities] = useState<string[]>([]);

  const inProgress = useInProgressSet();

  // ── Fetch patterns ──────────────────────────────────────────────

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
        if (params.source_entity) qs.set("source_entity", params.source_entity);

        const res = await fetch(`${apiUrl}/api/v1/admin/learned-patterns?${qs}`, { credentials });
        if (!res.ok) {
          if (!cancelled) {
            let msg = `HTTP ${res.status}`;
            try { msg = (await res.json()).message ?? msg; } catch { /* intentionally ignored: response may not be JSON */ }
            setError({ message: msg, status: res.status });
          }
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
  }, [apiUrl, offset, params.status, params.source_entity, credentials, fetchKey]);

  // ── Fetch stats (all statuses, no filter) ───────────────────────

  useEffect(() => {
    let cancelled = false;

    async function fetchStats() {
      try {
        // Fetch total counts for each status
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
      } catch {
        // Stats are non-critical — don't block the page
        console.debug("Failed to fetch learned pattern stats");
      }
    }

    // Collect unique source entities from a broader unfiltered fetch
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
      } catch {
        // Non-critical
        console.debug("Failed to fetch source entities");
      }
    }

    fetchStats();
    fetchEntities();
    return () => { cancelled = true; };
  }, [apiUrl, credentials, fetchKey]);

  // ── Actions ─────────────────────────────────────────────────────

  async function updatePatternStatus(id: string, status: LearnedPatternStatus) {
    setError(null);
    inProgress.start(id);

    // Optimistic update
    setPatterns((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status, updatedAt: new Date().toISOString() } : p)),
    );
    // Update detail sheet if viewing this pattern
    setDetailPattern((prev) =>
      prev?.id === id ? { ...prev, status, updatedAt: new Date().toISOString() } : prev,
    );

    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/learned-patterns/${id}`, {
        method: "PATCH",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).message ?? msg; } catch { /* intentionally ignored: response may not be JSON */ }
        setError({ message: msg, status: res.status });
        // Revert optimistic update
        setFetchKey((k) => k + 1);
        return;
      }
      // Update with server response
      const updated = await res.json();
      setPatterns((prev) => prev.map((p) => (p.id === id ? updated : p)));
      setDetailPattern((prev) => (prev?.id === id ? updated : prev));
      // Refresh stats
      setFetchKey((k) => k + 1);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Failed to update pattern" });
      setFetchKey((k) => k + 1);
    } finally {
      inProgress.stop(id);
    }
  }

  async function deletePattern(id: string) {
    setError(null);
    inProgress.start(id);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/learned-patterns/${id}`, {
        method: "DELETE",
        credentials,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).message ?? msg; } catch { /* intentionally ignored: response may not be JSON */ }
        setError({ message: msg, status: res.status });
        setDeleteTarget(null);
        return;
      }
      setDeleteTarget(null);
      if (detailPattern?.id === id) setDetailPattern(null);
      setFetchKey((k) => k + 1);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Failed to delete pattern" });
      setDeleteTarget(null);
    } finally {
      inProgress.stop(id);
    }
  }

  async function bulkUpdateStatus(status: LearnedPatternStatus) {
    const selected = table.getSelectedRowModel().rows.map((r) => r.original.id);
    if (selected.length === 0) return;
    setError(null);

    // Optimistic update
    const ids = new Set(selected);
    setPatterns((prev) =>
      prev.map((p) => (ids.has(p.id) ? { ...p, status, updatedAt: new Date().toISOString() } : p)),
    );

    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/learned-patterns/bulk`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selected, status }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).message ?? msg; } catch { /* intentionally ignored: response may not be JSON */ }
        setError({ message: msg, status: res.status });
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Failed to bulk update" });
    } finally {
      table.resetRowSelection();
      setFetchKey((k) => k + 1);
    }
  }

  // ── Column definitions with actions ─────────────────────────────

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

  // ── Data table ──────────────────────────────────────────────────

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

  // ── Auth/feature gate ───────────────────────────────────────────

  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Learned Patterns</h1>
          <p className="text-sm text-muted-foreground">Review and manage agent-proposed query patterns</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Learned Patterns" />
      </div>
    );
  }

  const hasFilters = !!params.status || !!params.source_entity;

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Learned Patterns</h1>
          <p className="text-sm text-muted-foreground">Review and manage agent-proposed query patterns</p>
        </div>
        {selectedCount > 0 && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => bulkUpdateStatus("approved")}
            >
              <Check className="mr-1.5 size-3.5" />
              Approve {selectedCount}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulkUpdateStatus("rejected")}
            >
              <X className="mr-1.5 size-3.5" />
              Reject {selectedCount}
            </Button>
          </div>
        )}
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {/* Stats */}
          {stats && (
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard title="Total Patterns" value={stats.total.toLocaleString()} icon={<Brain className="size-4" />} />
              <StatCard title="Pending Review" value={stats.pending.toLocaleString()} icon={<Clock className="size-4" />} />
              <StatCard title="Approved" value={stats.approved.toLocaleString()} icon={<CheckCircle2 className="size-4" />} />
              <StatCard title="Rejected" value={stats.rejected.toLocaleString()} icon={<XCircle className="size-4" />} />
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Tabs
                value={params.status}
                onValueChange={(v) => {
                  table.setPageIndex(0);
                  setParams({ status: v, page: 1 });
                }}
              >
                <TabsList>
                  {STATUS_TABS.map((s) => (
                    <TabsTrigger key={s || "all"} value={s}>
                      {STATUS_LABELS[s]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            {sourceEntities.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Entity</label>
                <Select
                  value={params.source_entity || "all"}
                  onValueChange={(v) => {
                    table.setPageIndex(0);
                    setParams({ source_entity: v === "all" ? "" : v, page: 1 });
                  }}
                >
                  <SelectTrigger className="h-9 w-44">
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
              </div>
            )}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  table.setPageIndex(0);
                  setParams({ status: "", source_entity: "", page: 1 });
                }}
              >
                <X className="mr-1.5 size-3.5" />
                Clear filters
              </Button>
            )}
          </div>

          {/* Content */}
          {error && (!error.status || ![401, 403, 404].includes(error.status)) ? (
            <ErrorBanner message={friendlyError(error)} onRetry={() => setFetchKey((k) => k + 1)} />
          ) : loading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading learned patterns..." />
            </div>
          ) : patterns.length === 0 && !hasFilters ? (
            <EmptyState
              icon={Brain}
              title="No learned patterns"
              description="Patterns will appear here when the agent or atlas learn CLI proposes new query patterns."
            />
          ) : patterns.length === 0 && hasFilters ? (
            <EmptyState
              icon={Brain}
              title="No matching patterns"
              description="Try adjusting your filters."
              action={{
                label: "Clear filters",
                onClick: () => setParams({ status: "", source_entity: "", page: 1 }),
              }}
            />
          ) : (
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
          )}
        </div>
      </ErrorBoundary>

      {/* Detail Sheet */}
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

              <div className="mt-6 space-y-6">
                {/* SQL */}
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Pattern SQL</h3>
                  <pre className="rounded-md border bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-64">
                    {detailPattern.patternSql}
                  </pre>
                </div>

                {/* Metadata */}
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
                    <span className="text-xs font-medium text-muted-foreground">Repetitions</span>
                    <p className="text-xs tabular-nums">{detailPattern.repetitionCount}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Calendar className="size-3" /> Created
                    </span>
                    <p className="text-xs">{new Date(detailPattern.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Last Updated</span>
                    <p className="text-xs">{new Date(detailPattern.updatedAt).toLocaleString()}</p>
                  </div>
                </div>

                {/* Review info */}
                {detailPattern.reviewedAt && (
                  <div className="space-y-2 border-t pt-4">
                    <h3 className="text-sm font-medium">Review History</h3>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>Reviewed by: {detailPattern.reviewedBy ?? "Unknown"}</p>
                      <p>Reviewed at: {new Date(detailPattern.reviewedAt).toLocaleString()}</p>
                    </div>
                  </div>
                )}

                {/* Source queries */}
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

                {/* Actions */}
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

      {/* Delete confirmation */}
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
  );
}
