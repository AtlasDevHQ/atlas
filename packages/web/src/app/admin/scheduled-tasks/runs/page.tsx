"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useQueryStates } from "nuqs";
import { runHistorySearchParams } from "./search-params";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  History,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ArrowLeft,
  Loader2,
} from "lucide-react";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";
import { friendlyError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { DeliveryStatusBadge } from "@/ui/components/admin/delivery-status-badge";
import type { ScheduledTask, ScheduledTaskRunWithTaskName } from "@/ui/lib/types";

// ── Helpers ───────────────────────────────────────────────────────

function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "success":
      return (
        <Badge
          variant="secondary"
          className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
        >
          {status}
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">{status}</Badge>;
    case "running":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          {status}
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

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

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Run History</h1>
          <p className="text-sm text-muted-foreground">Scheduled task execution history</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Scheduled Tasks" />
      </div>
    );
  }

  function resetFilters() {
    setParams({ page: 1, task: null, status: "all", dateFrom: null, dateTo: null, expandedRun: null });
  }

  const hasFilters = !!taskFilter || (statusFilter && statusFilter !== "all") || !!dateFrom || !!dateTo;

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex items-start justify-between border-b px-6 py-4">
        <div>
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
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border-b px-6 py-3">
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
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={() => setRefetchKey((k) => k + 1)} />}

        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingState message="Loading run history..." />
          </div>
        ) : runs.length === 0 && !error ? (
          <EmptyState icon={History} title="No runs found" />
        ) : runs.length > 0 ? (
          <>
            <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Task</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const isExpanded = expandedRun === run.id;
                  return (
                    <Fragment key={run.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setParams({ expandedRun: isExpanded ? null : run.id })
                        }
                      >
                        <TableCell>
                          {isExpanded ? (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{run.taskName}</TableCell>
                        <TableCell>
                          <RunStatusBadge status={run.status} />
                        </TableCell>
                        <TableCell>
                          <DeliveryStatusBadge
                            status={run.deliveryStatus}
                            error={run.deliveryError}
                          />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTimestamp(run.startedAt)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDuration(run.startedAt, run.completedAt)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {run.tokensUsed?.toLocaleString() ?? "—"}
                        </TableCell>
                        <TableCell
                          className="max-w-xs truncate text-xs text-muted-foreground"
                          title={run.error ?? undefined}
                        >
                          {run.error ? run.error.slice(0, 80) : "—"}
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/30 p-4">
                            <div className="space-y-3 text-sm">
                              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                                <div>
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Started
                                  </span>
                                  <p>{formatTimestamp(run.startedAt)}</p>
                                </div>
                                <div>
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Completed
                                  </span>
                                  <p>
                                    {run.completedAt
                                      ? formatTimestamp(run.completedAt)
                                      : "—"}
                                  </p>
                                </div>
                                <div>
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Duration
                                  </span>
                                  <p>{formatDuration(run.startedAt, run.completedAt)}</p>
                                </div>
                                <div>
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Tokens used
                                  </span>
                                  <p>{run.tokensUsed?.toLocaleString() ?? "—"}</p>
                                </div>
                              </div>

                              {run.deliveryError && (
                                <div>
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Delivery error
                                  </span>
                                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                                    {run.deliveryError}
                                  </pre>
                                </div>
                              )}

                              {run.error && (
                                <div>
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Error
                                  </span>
                                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                                    {run.error}
                                  </pre>
                                </div>
                              )}

                              <div className="flex gap-3">
                                {run.conversationId && (
                                  <Button variant="outline" size="sm" asChild>
                                    <Link
                                      href={`/?conversationId=${run.conversationId}`}
                                    >
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
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            </div>

            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))} ({total} total)
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
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setParams((p) => ({ page: p.page + 1 }))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
      </ErrorBoundary>
    </div>
  );
}
