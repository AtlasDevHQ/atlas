"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { auditSearchParams } from "./search-params";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatCard } from "@/ui/components/admin/stat-card";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ScrollText, Search, AlertTriangle, Database, BarChart3, Download, X, Shield } from "lucide-react";
import { RetentionPanel } from "./retention-panel";
import { useAdminFetch, type FetchError } from "@/ui/hooks/use-admin-fetch";
import { extractFetchError } from "@/ui/lib/fetch-error";
import { AuditStatsSchema, AuditFacetsSchema, AuditConnectionMetaSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";

const LIMIT = 50;

interface AuditQueryParams {
  pageSize: number;
  offset: number;
  search: string;
  connection: string;
  tableFilter: string;
  columnFilter: string;
  status: string;
  from: string;
  to: string;
  sortId?: string;
  sortDesc?: boolean;
}

function buildQueryString(p: AuditQueryParams, opts?: { noPagination?: boolean }): URLSearchParams {
  const qs = new URLSearchParams();
  if (!opts?.noPagination) {
    qs.set("limit", String(p.pageSize));
    qs.set("offset", String(p.offset));
  }
  if (p.search) qs.set("search", p.search);
  if (p.connection) qs.set("connection", p.connection);
  if (p.tableFilter) qs.set("table", p.tableFilter);
  if (p.columnFilter) qs.set("column", p.columnFilter);
  if (p.status === "success") qs.set("success", "true");
  if (p.status === "error") qs.set("success", "false");
  if (p.from) qs.set("from", p.from);
  if (p.to) qs.set("to", p.to);
  if (p.sortId) {
    qs.set("sort", p.sortId);
    qs.set("order", p.sortDesc ? "desc" : "asc");
  }
  return qs;
}

export default function AuditPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [params, setParams] = useQueryStates(auditSearchParams);
  const { tab, search, connection, table: tableFilter, column: columnFilter, status, from, to } = params;

  // Analytics date range (separate from log tab filters)
  const [analyticsFrom, setAnalyticsFrom] = useState("");
  const [analyticsTo, setAnalyticsTo] = useState("");

  // Connection list for filter dropdown
  const { data: connectionsData, error: connectionsError } = useAdminFetch(
    "/api/v1/admin/connections",
    { schema: AuditConnectionMetaSchema },
  );
  const connectionList = connectionsData?.connections ?? [];

  // Facets for table/column filter dropdowns
  const { data: facetsData, error: facetsError } = useAdminFetch(
    "/api/v1/admin/audit/facets",
    { schema: AuditFacetsSchema },
  );
  if (facetsError && !facetsError.status) {
    // Log client-side so devs can diagnose why dropdowns fell back to text inputs
    console.warn("Audit facets fetch failed:", facetsError.message);
  }
  const tableFacets = facetsData?.tables ?? [];
  const columnFacets = facetsData?.columns ?? [];

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
      pagination: { pageIndex: 0, pageSize: LIMIT },
    },
    getRowId: (row) => row.id,
  });

  // Stats — non-critical, shown when available
  const { data: stats, error: statsError } = useAdminFetch(
    "/api/v1/admin/audit/stats",
    { schema: AuditStatsSchema },
  );

  // Clear stale errors when switching tabs
  useEffect(() => {
    setError(null);
    setExportError(null);
  }, [tab]);

  // Read pagination from table state for fetching
  const { pageIndex, pageSize } = table.getState().pagination;
  const offset = pageIndex * pageSize;

  // Read sorting from table state
  const sorting = table.getState().sorting;
  const sortId = sorting[0]?.id;
  const sortDesc = sorting[0]?.desc;

  const queryParams: AuditQueryParams = {
    pageSize, offset, search, connection, tableFilter, columnFilter, status, from, to, sortId, sortDesc,
  };

  // Fetch rows on mount and when table state changes (only for log tab)
  useEffect(() => {
    if (tab === "analytics") return;
    let cancelled = false;
    async function fetchRows() {
      setLoading(true);
      setError(null);
      try {
        const qs = buildQueryString(queryParams);
        const res = await fetch(`${apiUrl}/api/v1/admin/audit?${qs}`, { credentials });
        if (!res.ok) {
          if (!cancelled) {
            setError(await extractFetchError(res));
          }
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
  }, [apiUrl, offset, pageSize, search, connection, tableFilter, columnFilter, status, from, to, sortId, sortDesc, tab, credentials]);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const qs = buildQueryString(queryParams, { noPagination: true });
      const res = await fetch(`${apiUrl}/api/v1/admin/audit/export?${qs}`, { credentials });
      if (!res.ok) {
        const e = await extractFetchError(res);
        setExportError(e.message);
        return;
      }

      // Check for truncation
      const truncated = res.headers.get("X-Export-Truncated") === "true";
      const exportTotal = res.headers.get("X-Export-Total");
      const exportLimit = res.headers.get("X-Export-Limit");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      if (truncated) {
        setExportError(
          `Export limited to ${Number(exportLimit).toLocaleString()} rows out of ${Number(exportTotal).toLocaleString()} total. Apply filters to narrow results.`,
        );
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const hasFilters = !!(search || connection || tableFilter || columnFilter || status || from || to);

  function clearFilters() {
    setParams({ search: "", connection: "", table: "", column: "", status: "", from: "", to: "" });
  }

  return (
    <TooltipProvider>
    <div className="p-6">
      <ErrorBoundary>
      <Tabs
        value={tab}
        onValueChange={(v) => setParams({ tab: v as "log" | "analytics" | "retention" })}
      >
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
              <p className="text-sm text-muted-foreground">View query history and access logs</p>
            </div>
            <div className="flex items-center gap-2">
              {tab === "log" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={handleExport}
                  disabled={exporting || loading}
                >
                  <Download className="mr-1.5 size-3.5" />
                  {exporting ? "Exporting..." : "Export CSV"}
                </Button>
              )}
              <TabsList>
                <TabsTrigger value="log">
                  <ScrollText className="mr-1.5 size-3.5" />
                  Log
                </TabsTrigger>
                <TabsTrigger value="analytics">
                  <BarChart3 className="mr-1.5 size-3.5" />
                  Analytics
                </TabsTrigger>
                <TabsTrigger value="retention">
                  <Shield className="mr-1.5 size-3.5" />
                  Retention
                </TabsTrigger>
              </TabsList>
            </div>
          </div>
        </div>

        <TabsContent value="analytics" className="space-y-6 pt-6">
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

        <TabsContent value="log" className="space-y-6 pt-6">
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

          {/* Export error (separate from list error) */}
          {exportError && (
            <ErrorBanner
              message={exportError}
              onRetry={() => { setExportError(null); handleExport(); }}
            />
          )}

          {/* Search + Filters */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search SQL, users, errors..."
                value={search}
                onChange={(e) => setParams({ search: e.target.value })}
                className="h-9 pl-8"
              />
            </div>

            {connectionList.length > 1 ? (
              <Select
                value={connection || "__all__"}
                onValueChange={(v) => setParams({ connection: v === "__all__" ? "" : v })}
              >
                <SelectTrigger className="h-9 w-44" aria-label="Filter by connection">
                  <SelectValue placeholder="All connections" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All connections</SelectItem>
                  {connectionList.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.description || c.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : connectionsError && !connectionsError.status ? (
              <Select disabled>
                <SelectTrigger className="h-9 w-44 opacity-50" aria-label="Filter by connection">
                  <SelectValue placeholder="Connections unavailable" />
                </SelectTrigger>
                <SelectContent />
              </Select>
            ) : null}

            {tableFacets.length > 0 ? (
              <Select
                value={tableFilter || "__all__"}
                onValueChange={(v) => setParams({ table: v === "__all__" ? "" : v })}
              >
                <SelectTrigger className="h-9 w-40" aria-label="Filter by table">
                  <SelectValue placeholder="All tables" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All tables</SelectItem>
                  {tableFacets.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                placeholder="Filter by table..."
                value={tableFilter}
                onChange={(e) => setParams({ table: e.target.value })}
                className="h-9 w-40"
              />
            )}

            {columnFacets.length > 0 ? (
              <Select
                value={columnFilter || "__all__"}
                onValueChange={(v) => setParams({ column: v === "__all__" ? "" : v })}
              >
                <SelectTrigger className="h-9 w-40" aria-label="Filter by column">
                  <SelectValue placeholder="All columns" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All columns</SelectItem>
                  {columnFacets.map((col) => (
                    <SelectItem key={col} value={col}>{col}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                placeholder="Filter by column..."
                value={columnFilter}
                onChange={(e) => setParams({ column: e.target.value })}
                className="h-9 w-40"
              />
            )}

            <Select
              value={status || "__all__"}
              onValueChange={(v) => setParams({ status: v === "__all__" ? "" : v as "success" | "error" | "" })}
            >
              <SelectTrigger className="h-9 w-32" aria-label="Filter by status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All statuses</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>

            <div className="space-y-0">
              <Input
                type="date"
                value={from}
                onChange={(e) => setParams({ from: e.target.value })}
                className="h-9 w-36"
                aria-label="From date"
              />
            </div>
            <div className="space-y-0">
              <Input
                type="date"
                value={to}
                onChange={(e) => setParams({ to: e.target.value })}
                className="h-9 w-36"
                aria-label="To date"
              />
            </div>

            {hasFilters && (
              <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
                <X className="mr-1.5 size-3.5" />
                Clear
              </Button>
            )}
          </div>

          {/* Content */}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Audit Log"
            onRetry={() => { table.setPageIndex(0); }}
            loadingMessage="Loading audit log..."
            emptyIcon={ScrollText}
            emptyTitle="No query activity recorded yet"
            emptyDescription="Query activity will appear here once users start asking questions"
            isEmpty={rows.length === 0}
            hasFilters={hasFilters}
            onClearFilters={clearFilters}
          >
            <DataTable table={table}>
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
            </DataTable>
          </AdminContentWrapper>
        </TabsContent>

        <TabsContent value="retention" className="pt-6">
          <RetentionPanel />
        </TabsContent>
      </Tabs>
      </ErrorBoundary>
    </div>
    </TooltipProvider>
  );
}
