"use client";

import { useEffect, useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/ui/components/admin/stat-card";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { ScrollText, Search, AlertTriangle, Database } from "lucide-react";
import { useAdminFetch, friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";

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

const emptyFilters: Filters = { user: "", from: "", to: "", errorOnly: false };

export default function AuditPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [offset, setOffset] = useState(0);

  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(emptyFilters);

  // Stats — non-critical, shown when available
  const { data: stats, error: statsError } = useAdminFetch<AuditStats>(
    "/api/v1/admin/audit/stats",
  );

  // Fetch rows on mount and when offset/appliedFilters change
  useEffect(() => {
    let cancelled = false;
    async function fetchRows() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(offset),
        });
        if (appliedFilters.user) params.set("user", appliedFilters.user);
        if (appliedFilters.from) params.set("from", appliedFilters.from);
        if (appliedFilters.to) params.set("to", appliedFilters.to);
        if (appliedFilters.errorOnly) params.set("success", "false");

        const res = await fetch(`${apiUrl}/api/v1/admin/audit?${params}`, { credentials });
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
  }, [apiUrl, offset, appliedFilters, credentials]);

  function handleApply() {
    setAppliedFilters({ ...filters });
    setOffset(0);
  }

  // Gate: 401/403/404
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

  const page = Math.floor(offset / LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground">View query history and access logs</p>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-6">
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
          <ErrorBanner message={friendlyError(error)} onRetry={() => { setOffset(0); setAppliedFilters({ ...appliedFilters }); }} />
        ) : loading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingState message="Loading audit log..." />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={ScrollText} message="No audit log entries found" />
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
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + LIMIT >= total}
                  onClick={() => setOffset((o) => o + LIMIT)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
