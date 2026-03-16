"use client";

import { useEffect, useState, useCallback } from "react";
import { useQueryStates } from "nuqs";
import { sessionsSearchParams } from "./search-params";
import { getSessionColumns, type SessionRow, type SessionActions } from "./columns";
import { useAtlasConfig } from "@/ui/context";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/ui/components/admin/stat-card";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Monitor, Search, X, Users, Activity, Trash2 } from "lucide-react";
import { useAdminFetch, useInProgressSet, friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// ── Types ─────────────────────────────────────────────────────────

interface SessionStats {
  total: number;
  active: number;
  uniqueUsers: number;
}

const LIMIT = 50;

export default function SessionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [rows, setRows] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const [params, setParams] = useQueryStates(sessionsSearchParams);
  const { search } = params;

  const inProgress = useInProgressSet();

  // Revoke a single session
  const revokeSession = useCallback(async (sessionId: string) => {
    inProgress.start(sessionId);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/sessions/${sessionId}`, {
        method: "DELETE",
        credentials,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).message ?? msg; } catch { /* ignore */ }
        setError({ message: msg, status: res.status });
        return;
      }
      setFetchKey((k) => k + 1);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Failed to revoke session" });
    } finally {
      inProgress.stop(sessionId);
    }
  }, [apiUrl, credentials, inProgress]);

  // Revoke all sessions for a user
  const revokeUserSessions = useCallback(async (userId: string) => {
    inProgress.start(`user:${userId}`);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/sessions/user/${userId}`, {
        method: "DELETE",
        credentials,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).message ?? msg; } catch { /* ignore */ }
        setError({ message: msg, status: res.status });
        return;
      }
      setFetchKey((k) => k + 1);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Failed to revoke sessions" });
    } finally {
      inProgress.stop(`user:${userId}`);
    }
  }, [apiUrl, credentials, inProgress]);

  // Column definitions with action callbacks
  const sessionActions: SessionActions = {
    onRevoke: revokeSession,
    onRevokeUser: revokeUserSessions,
    isRevoking: (id: string) => inProgress.has(id),
  };
  const columns = getSessionColumns(sessionActions);

  // Data table
  const pageCount = Math.max(1, Math.ceil(total / LIMIT));
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    initialState: {
      sorting: [{ id: "updatedAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: LIMIT },
    },
    getRowId: (row) => row.id,
  });

  // Stats
  const { data: stats } = useAdminFetch<SessionStats>(
    "/api/v1/admin/sessions/stats",
    { deps: [fetchKey] },
  );

  // Read pagination from table state
  const { pageIndex, pageSize } = table.getState().pagination;
  const offset = pageIndex * pageSize;

  // Fetch sessions
  useEffect(() => {
    let cancelled = false;

    async function fetchSessions() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(pageSize),
          offset: String(offset),
        });
        if (search) qs.set("search", search);

        const res = await fetch(`${apiUrl}/api/v1/admin/sessions?${qs}`, { credentials });
        if (!res.ok) {
          if (!cancelled) {
            let msg = `HTTP ${res.status}`;
            try { msg = (await res.json()).message ?? msg; } catch { /* ignore */ }
            setError({ message: msg, status: res.status });
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setRows(data.sessions ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError({ message: err instanceof Error ? err.message : "Failed to load sessions" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSessions();
    return () => { cancelled = true; };
  }, [apiUrl, offset, pageSize, search, credentials, fetchKey]);

  // Bulk revoke selected sessions
  const revokeSelected = useCallback(async () => {
    const selected = table.getSelectedRowModel().rows.map((r) => r.original.id);
    for (const id of selected) {
      await revokeSession(id);
    }
    table.resetRowSelection();
  }, [table, revokeSession]);

  // Auth/feature gate
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted-foreground">Manage active user sessions</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Sessions" />
      </div>
    );
  }

  const hasFilters = !!search;
  const selectedCount = table.getSelectedRowModel().rows.length;

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
            <p className="text-sm text-muted-foreground">Manage active user sessions</p>
          </div>
          {selectedCount > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="mr-1.5 size-3.5" />
                  Revoke {selectedCount} selected
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke {selectedCount} session(s)?</AlertDialogTitle>
                  <AlertDialogDescription>
                    These users will be signed out immediately. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={revokeSelected}>Revoke</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {/* Stats */}
          {stats && (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard title="Total Sessions" value={stats.total.toLocaleString()} icon={Monitor} />
              <StatCard title="Active Sessions" value={stats.active.toLocaleString()} icon={Activity} />
              <StatCard title="Unique Users" value={stats.uniqueUsers.toLocaleString()} icon={Users} />
            </div>
          )}

          {/* Search */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search by email or IP..."
                value={search}
                onChange={(e) => {
                  table.setPageIndex(0);
                  setParams({ search: e.target.value });
                }}
                className="h-9 pl-8"
              />
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  table.setPageIndex(0);
                  setParams({ search: "" });
                }}
              >
                <X className="mr-1.5 size-3.5" />
                Clear
              </Button>
            )}
          </div>

          {/* Content */}
          {error && !error.status ? (
            <ErrorBanner message={friendlyError(error)} onRetry={() => setFetchKey((k) => k + 1)} />
          ) : loading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading sessions..." />
            </div>
          ) : rows.length === 0 && !hasFilters ? (
            <EmptyState
              icon={Monitor}
              title="No active sessions"
              description="Sessions will appear here when users sign in."
            />
          ) : rows.length === 0 && hasFilters ? (
            <EmptyState
              icon={Search}
              title="No matching sessions"
              description="Try adjusting your search."
            />
          ) : (
            <DataTable table={table}>
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
              {/* Action column — rendered per-row via custom cell */}
            </DataTable>
          )}
        </div>
      </ErrorBoundary>
    </div>
  );
}
