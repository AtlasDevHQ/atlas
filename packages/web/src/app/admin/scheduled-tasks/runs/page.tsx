"use client";

import { useEffect, useState } from "react";
import type { Row } from "@tanstack/react-table";
import Link from "next/link";
import { useQueryStates } from "nuqs";
import { runHistorySearchParams } from "./search-params";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import {
  History,
  ExternalLink,
  ArrowLeft,
} from "lucide-react";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { ExpandableDataTable } from "@/components/data-table/data-table-expandable";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { getRunHistoryColumns, formatTimestamp, formatDuration } from "./columns";
import type { ScheduledTask, ScheduledTaskRunWithTaskName } from "@/ui/lib/types";

// ── Page ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export default function RunHistoryPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [runs, setRuns] = useState<ScheduledTaskRunWithTaskName[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);

  // For task filter dropdown
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);

  const [refetchKey, setRefetchKey] = useState(0);

  const [{ page, task: taskFilter, status: statusFilter, dateFrom, dateTo, expandedRun }, setParams] =
    useQueryStates(runHistorySearchParams);
  const offset = (page - 1) * PAGE_SIZE;

  // ── Fetch task list for filter dropdown ─────────────────────────
  useEffect(() => {
    async function fetchTasks() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/scheduled-tasks?limit=100`, { credentials });
        if (!res.ok) return;
        const data = await res.json();
        setTasks(data.tasks ?? []);
      } catch {
        // Non-critical — filter will just lack task names
      }
    }
    fetchTasks();
  }, [apiUrl, credentials]);

  // ── Fetch runs ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function fetchRuns() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (taskFilter) qs.set("task_id", taskFilter);
        if (statusFilter && statusFilter !== "all") qs.set("status", statusFilter);
        if (dateFrom) qs.set("date_from", dateFrom);
        if (dateTo) qs.set("date_to", dateTo);

        const res = await fetch(
          `${apiUrl}/api/v1/scheduled-tasks/runs?${qs}`,
          { credentials },
        );
        if (!res.ok) {
          if (!cancelled) {
            setError({ message: `HTTP ${res.status}`, status: res.status });
            setRuns([]);
            setTotal(0);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setRuns(data.runs ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError({
            message: err instanceof Error ? err.message : "Failed to load run history",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchRuns();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, offset, taskFilter, statusFilter, dateFrom, dateTo, credentials, refetchKey]);

  // ── Data table ──────────────────────────────────────────────────
  const runColumns = getRunHistoryColumns({ expandedId: expandedRun });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { table: runsTable } = useDataTable({
    data: runs,
    columns: runColumns,
    pageCount,
    initialState: {
      sorting: [{ id: "startedAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: PAGE_SIZE },
    },
    getRowId: (row) => row.id,
  });

  const handleRunRowClick = (row: Row<ScheduledTaskRunWithTaskName>) =>
    setParams({ expandedRun: expandedRun === row.original.id ? null : row.original.id });

  const isRunExpanded = (row: Row<ScheduledTaskRunWithTaskName>) => expandedRun === row.original.id;

  const renderRunExpandedRow = (row: Row<ScheduledTaskRunWithTaskName>) => {
    const run = row.original;
    if (expandedRun !== run.id) return null;
    return (
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <span className="text-xs font-medium text-muted-foreground">Started</span>
            <p>{formatTimestamp(run.startedAt)}</p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Completed</span>
            <p>{run.completedAt ? formatTimestamp(run.completedAt) : "\u2014"}</p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Duration</span>
            <p>{formatDuration(run.startedAt, run.completedAt ?? null)}</p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Tokens used</span>
            <p>{run.tokensUsed?.toLocaleString() ?? "\u2014"}</p>
          </div>
        </div>
        {run.deliveryError && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Delivery error</span>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {run.deliveryError}
            </pre>
          </div>
        )}
        {run.error && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Error</span>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {run.error}
            </pre>
          </div>
        )}
        <div className="flex gap-3">
          {run.conversationId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/?conversationId=${run.conversationId}`}>
                <ExternalLink className="mr-1 size-3" />
                View conversation
              </Link>
            </Button>
          )}
          {run.actionId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/actions?expanded=${run.actionId}`}>
                <ExternalLink className="mr-1 size-3" />
                View action
              </Link>
            </Button>
          )}
        </div>
      </div>
    );
  };

  function resetFilters() {
    setParams({ page: 1, task: null, status: "all", dateFrom: null, dateTo: null, expandedRun: null });
  }

  const hasFilters = !!taskFilter || (statusFilter && statusFilter !== "all") || !!dateFrom || !!dateTo;

  return (
    <div className="p-6">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="size-8" asChild>
            <Link href="/admin/scheduled-tasks">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Run History</h1>
        </div>
        <p className="ml-10 text-sm text-muted-foreground">
          Execution history across all scheduled tasks
        </p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select
          value={taskFilter ?? "all"}
          onValueChange={(val) => setParams({ task: val === "all" ? null : val, page: 1, expandedRun: null })}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All tasks" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tasks</SelectItem>
            {tasks.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={statusFilter ?? "all"}
          onValueChange={(val) => setParams({ status: val as typeof statusFilter, page: 1, expandedRun: null })}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          className="w-40"
          placeholder="From"
          value={dateFrom ?? ""}
          onChange={(e) => setParams({ dateFrom: e.target.value || null, page: 1, expandedRun: null })}
        />
        <Input
          type="date"
          className="w-40"
          placeholder="To"
          value={dateTo ?? ""}
          onChange={(e) => setParams({ dateTo: e.target.value || null, page: 1, expandedRun: null })}
        />

        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            Clear filters
          </Button>
        )}

        {total > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {total} run{total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <ErrorBoundary>
      <div className="space-y-6">
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Scheduled Tasks"
          onRetry={() => setRefetchKey((k) => k + 1)}
          loadingMessage="Loading run history..."
          emptyIcon={History}
          emptyTitle="No runs found"
          isEmpty={runs.length === 0}
          hasFilters={!!hasFilters}
          onClearFilters={resetFilters}
        >
          <ExpandableDataTable
            table={runsTable}
            onRowClick={handleRunRowClick}
            isRowExpanded={isRunExpanded}
            renderExpandedRow={renderRunExpandedRow}
          >
            <DataTableToolbar table={runsTable}>
              <DataTableSortList table={runsTable} />
            </DataTableToolbar>
          </ExpandableDataTable>
        </AdminContentWrapper>
      </div>
      </ErrorBoundary>
    </div>
  );
}
