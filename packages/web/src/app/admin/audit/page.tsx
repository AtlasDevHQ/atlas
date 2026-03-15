"use client";

import { useEffect, useState } from "react";
import { useQueryState } from "nuqs";
import { parseAsStringLiteral } from "nuqs";
import { AnalyticsPanel } from "./analytics-panel";
import { getAuditColumns, type AuditRow } from "./columns";
import { useAtlasConfig } from "@/ui/context";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/ui/components/admin/stat-card";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { ScrollText, Search, AlertTriangle, Database, BarChart3 } from "lucide-react";
import { useAdminFetch, friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";

// ── Types ─────────────────────────────────────────────────────────

interface AuditStats {
  totalQueries: number;
  totalErrors: number;
  errorRate: number;
  queriesPerDay: { day: string; count: number }[];
}

const LIMIT = 50;
const auditTabs = ["log", "analytics"] as const;

export default function AuditPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);

  const [tab, setTab] = useQueryState(
    "tab",
    parseAsStringLiteral(auditTabs).withDefault("log"),
  );

  // Analytics date range (separate from data-table filters)
  const [analyticsFrom, setAnalyticsFrom] = useState("");
  const [analyticsTo, setAnalyticsTo] = useState("");

  // Column definitions
  const columns = getAuditColumns();

  // Data table with nuqs-managed pagination, sorting, column visibility
  const pageCount = Math.max(1, Math.ceil(total / LIMIT));
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    initialState: {
      sorting: [{ id: "timestamp", desc: true }],
      pagination: { pageSize: LIMIT },
    },
    getRowId: (row) => row.id,
  });

  // Stats — non-critical, shown when available
  const { data: stats, error: statsError } = useAdminFetch<AuditStats>(
    "/api/v1/admin/audit/stats",
  );

  // Clear stale error when switching tabs
  useEffect(() => {
    setError(null);
  }, [tab]);

  // Read pagination from table state for fetching
  const { pageIndex, pageSize } = table.getState().pagination;
  const offset = pageIndex * pageSize;

  // Read filters from table state
  const columnFilters = table.getState().columnFilters;
  const userFilter = columnFilters.find((f) => f.id === "user")?.value as string | undefined;
  const successFilter = columnFilters.find((f) => f.id === "success")?.value as string[] | undefined;

  // Derive errorOnly from success filter
  const errorOnly = successFilter?.length === 1 && successFilter[0] === "false";

  // Read sorting from table state
  const sorting = table.getState().sorting;
  const sortId = sorting[0]?.id;
  const sortDesc = sorting[0]?.desc;

  // Fetch rows on mount and when table state changes (only for log tab)
  useEffect(() => {
    if (tab === "analytics") return;
    let cancelled = false;
    async function fetchRows() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(pageSize),
          offset: String(offset),
        });
        if (userFilter) qs.set("user", String(userFilter));
        if (errorOnly) qs.set("success", "false");
        if (sortId) {
          qs.set("sort", sortId);
          qs.set("order", sortDesc ? "desc" : "asc");
        }

        const res = await fetch(`${apiUrl}/api/v1/admin/audit?${qs}`, { credentials });
        if (!res.ok) {
          if (!cancelled) setError({ message: `HTTP ${res.status}`, status: res.status });
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setRows(data.rows ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError({
            message: err instanceof Error ? err.message : "Failed to load audit log",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchRows();
    return () => { cancelled = true; };
  }, [apiUrl, offset, pageSize, userFilter, errorOnly, sortId, sortDesc, tab, credentials]);

  // Gate: 401/403/404 (applies to both tabs via stats endpoint)
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-sm text-muted-foreground">View query history and access logs</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Audit Log" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <ErrorBoundary>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "log" | "analytics")}
      >
        {/* Header */}
        <div className="border-b px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
              <p className="text-sm text-muted-foreground">View query history and access logs</p>
            </div>
            <TabsList>
              <TabsTrigger value="log">
                <ScrollText className="mr-1.5 size-3.5" />
                Log
              </TabsTrigger>
              <TabsTrigger value="analytics">
                <BarChart3 className="mr-1.5 size-3.5" />
                Analytics
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="analytics" className="flex-1 overflow-auto p-6 space-y-6">
          {/* Date range for analytics */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor="analytics-from" className="text-xs font-medium text-muted-foreground">From</label>
              <Input
                id="analytics-from"
                type="date"
                value={analyticsFrom}
                onChange={(e) => setAnalyticsFrom(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="analytics-to" className="text-xs font-medium text-muted-foreground">To</label>
              <Input
                id="analytics-to"
                type="date"
                value={analyticsTo}
                onChange={(e) => setAnalyticsTo(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <Button size="sm" className="h-9">
              <Search className="mr-1.5 size-3.5" />
              Apply
            </Button>
          </div>
          <AnalyticsPanel from={analyticsFrom} to={analyticsTo} />
        </TabsContent>

        <TabsContent value="log" className="flex-1 overflow-auto p-6 space-y-6">
          {/* Stats row */}
          {statsError && !statsError.status ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard title="Total Queries" value="unavailable" icon={<Database className="size-4" />} />
              <StatCard title="Total Errors" value="unavailable" icon={<AlertTriangle className="size-4" />} />
              <StatCard title="Error Rate" value="unavailable" icon={<ScrollText className="size-4" />} />
            </div>
          ) : stats ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                title="Total Queries"
                value={stats.totalQueries.toLocaleString()}
                icon={<Database className="size-4" />}
              />
              <StatCard
                title="Total Errors"
                value={stats.totalErrors.toLocaleString()}
                icon={<AlertTriangle className="size-4" />}
              />
              <StatCard
                title="Error Rate"
                value={`${stats.errorRate.toFixed(1)}%`}
                icon={<ScrollText className="size-4" />}
              />
            </div>
          ) : null}

          {/* Content */}
          {error ? (
            <ErrorBanner message={friendlyError(error)} onRetry={() => { table.setPageIndex(0); }} />
          ) : loading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading audit log..." />
            </div>
          ) : rows.length === 0 && !table.getState().columnFilters.length ? (
            <EmptyState
              icon={ScrollText}
              title="No query activity recorded yet"
              description="Query activity will appear here once users start asking questions"
            />
          ) : (
            <DataTable table={table}>
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
            </DataTable>
          )}
        </TabsContent>
      </Tabs>
      </ErrorBoundary>
    </div>
  );
}
