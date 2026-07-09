"use client";

import { useEffect, useState } from "react";
import type { Row } from "@tanstack/react-table";
import Link from "next/link";
import { useQueryStates } from "nuqs";
import { runHistorySearchParams } from "./search-params";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { formatISODate, parseISODate } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ServerDataTable } from "@/ui/components/admin/server-data-table";
import {
  History,
  ExternalLink,
  ArrowLeft,
} from "lucide-react";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useServerDataTable } from "@/ui/hooks/use-server-data-table";
import { getRunHistoryColumns, formatTimestamp, formatDuration } from "./columns";
import type { ScheduledTask, ScheduledTaskRunWithTaskName } from "@/ui/lib/types";

// ── Page ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export default function RunHistoryPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // For task filter dropdown
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);

  const [{ task: taskFilter, status: statusFilter, dateFrom, dateTo, expandedRun }, setParams] =
    useQueryStates(runHistorySearchParams);

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
    void fetchTasks(); // fire-and-forget: effect-scoped async loader
  }, [apiUrl, credentials]);

  // ── Data table ──────────────────────────────────────────────────
  const runColumns = getRunHistoryColumns({ expandedId: expandedRun });

  // The server-data-table module owns pagination, the runs fetch, pageCount,
  // and the table instance; the page keeps only its filters + expanded-row UI.
  const {
    table: runsTable,
    rows: runs,
    total,
    loading,
    error,
    refetch,
  } = useServerDataTable<ScheduledTaskRunWithTaskName>({
    columns: runColumns,
    getRowId: (row) => row.id,
    defaultPerPage: PAGE_SIZE,
    defaultSorting: [{ id: "startedAt", desc: true }],
    select: (r) => {
      const d = r as { runs?: ScheduledTaskRunWithTaskName[]; total?: number };
      return { rows: d.runs ?? [], total: d.total ?? 0 };
    },
    buildPath: ({ offset, perPage }) => {
      const qs = new URLSearchParams({
        limit: String(perPage),
        offset: String(offset),
      });
      if (taskFilter) qs.set("task_id", taskFilter);
      if (statusFilter && statusFilter !== "all") qs.set("status", statusFilter);
      if (dateFrom) qs.set("date_from", dateFrom);
      if (dateTo) qs.set("date_to", dateTo);
      return `/api/v1/scheduled-tasks/runs?${qs}`;
    },
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
    void setParams({ page: 1, task: null, status: "all", dateFrom: null, dateTo: null, expandedRun: null }); // fire-and-forget: URL state setter
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

        <DatePicker
          placeholder="From"
          aria-label="From date"
          value={parseISODate(dateFrom)}
          onChange={(d) => setParams({ dateFrom: formatISODate(d) || null, page: 1, expandedRun: null })}
        />
        <DatePicker
          placeholder="To"
          aria-label="To date"
          value={parseISODate(dateTo)}
          onChange={(d) => setParams({ dateTo: formatISODate(d) || null, page: 1, expandedRun: null })}
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
        <ServerDataTable
          table={runsTable}
          loading={loading}
          error={error}
          isEmpty={runs.length === 0}
          onRetry={refetch}
          feature="Scheduled Tasks"
          loadingMessage="Loading run history..."
          emptyState={{ icon: History, title: "No runs found" }}
          hasFilters={!!hasFilters}
          onClearFilters={resetFilters}
          expandable={{
            onRowClick: handleRunRowClick,
            isRowExpanded: isRunExpanded,
            renderExpandedRow: renderRunExpandedRow,
          }}
        />
      </div>
      </ErrorBoundary>
    </div>
  );
}
