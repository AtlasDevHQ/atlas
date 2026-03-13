"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { auditSearchParams } from "./search-params";
import { AnalyticsPanel } from "./analytics-panel";
import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
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

interface AuditRow {
  id: string;
  user_id: string;
  query: string;
  success: boolean;
  duration_ms: number;
  row_count: number;
  created_at: string;
  error?: string;
}

interface AuditStats {
  totalQueries: number;
  totalErrors: number;
  errorRate: number;
  queriesPerDay: { day: string; count: number }[];
}

interface Filters {
  user: string;
  from: string;
  to: string;
  errorOnly: boolean;
}

const LIMIT = 50;

export default function AuditPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);

  const [params, setParams] = useQueryStates(auditSearchParams);
  const offset = (params.page - 1) * LIMIT;

  // Local form state — pushed to URL on "Apply"
  const [filters, setFilters] = useState<Filters>({
    user: params.user,
    from: params.from,
    to: params.to,
    errorOnly: params.errorOnly,
  });

  // Stats — non-critical, shown when available
  const { data: stats, error: statsError } = useAdminFetch<AuditStats>(
    "/api/v1/admin/audit/stats",
  );

  // Clear stale error when switching tabs
  useEffect(() => {
    setError(null);
  }, [params.tab]);

  // Fetch rows on mount and when URL params change (only for log tab)
  useEffect(() => {
    if (params.tab === "analytics") return;
    let cancelled = false;
    async function fetchRows() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(offset),
        });
        if (params.user) qs.set("user", params.user);
        if (params.from) qs.set("from", params.from);
        if (params.to) qs.set("to", params.to);
        if (params.errorOnly) qs.set("success", "false");

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
  }, [apiUrl, offset, params.user, params.from, params.to, params.errorOnly, params.tab, credentials]);

  function handleApply() {
    setParams({ ...filters, page: 1 });
  }

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

  const page = params.page;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <ErrorBoundary>
      <Tabs
        value={params.tab}
        onValueChange={(v) => setParams({ tab: v as "log" | "analytics" })}
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
              <label className="text-xs font-medium text-muted-foreground">From</label>
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                className="h-9 w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">To</label>
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                className="h-9 w-40"
              />
            </div>
            <Button size="sm" className="h-9" onClick={handleApply}>
              <Search className="mr-1.5 size-3.5" />
              Apply
            </Button>
          </div>
          <AnalyticsPanel from={params.from} to={params.to} />
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

          {/* Filter row */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">From</label>
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                className="h-9 w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">To</label>
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                className="h-9 w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">User</label>
              <Input
                type="text"
                placeholder="Filter by user..."
                value={filters.user}
                onChange={(e) => setFilters((f) => ({ ...f, user: e.target.value }))}
                className="h-9 w-48"
              />
            </div>
            <Button
              variant={filters.errorOnly ? "default" : "outline"}
              size="sm"
              className="h-9"
              onClick={() => setFilters((f) => ({ ...f, errorOnly: !f.errorOnly }))}
            >
              <AlertTriangle className="mr-1.5 size-3.5" />
              Errors only
            </Button>
            <Button size="sm" className="h-9" onClick={handleApply}>
              <Search className="mr-1.5 size-3.5" />
              Apply
            </Button>
          </div>

          {/* Content */}
          {error ? (
            <ErrorBanner message={friendlyError(error)} onRetry={() => { setParams({ page: 1 }); }} />
          ) : loading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading audit log..." />
            </div>
          ) : rows.length === 0 ? (
            params.user || params.from || params.to || params.errorOnly ? (
              <EmptyState
                icon={Search}
                title="No results match your filters"
                description="Try adjusting your date range or clearing filters"
                action={{ label: "Clear filters", onClick: () => { setFilters({ user: "", from: "", to: "", errorOnly: false }); setParams({ user: "", from: "", to: "", errorOnly: false, page: 1 }); } }}
              />
            ) : (
              <EmptyState
                icon={ScrollText}
                title="No query activity recorded yet"
                description="Query activity will appear here once users start asking questions"
              />
            )
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-44">Timestamp</TableHead>
                      <TableHead className="w-32">User</TableHead>
                      <TableHead>SQL</TableHead>
                      <TableHead className="w-24 text-right">Duration</TableHead>
                      <TableHead className="w-20 text-right">Rows</TableHead>
                      <TableHead className="w-24">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(row.created_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </TableCell>
                        <TableCell className="text-sm">{row.user_id}</TableCell>
                        <TableCell className="max-w-xs truncate font-mono text-xs">
                          {row.query}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {row.duration_ms}ms
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {row.row_count}
                        </TableCell>
                        <TableCell>
                          {row.success ? (
                            <Badge variant="outline" className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-400">
                              Success
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-red-300 text-red-700 dark:border-red-700 dark:text-red-400">
                              Error
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Page {page} of {totalPages} ({total} total)
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setParams((p) => ({ page: p.page - 1 }))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setParams((p) => ({ page: p.page + 1 }))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
      </ErrorBoundary>
    </div>
  );
}
