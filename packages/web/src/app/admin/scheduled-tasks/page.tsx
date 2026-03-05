"use client";

import { Fragment, useEffect, useState, useCallback } from "react";
import { useQueryStates } from "nuqs";
import { scheduledTasksSearchParams } from "./search-params";
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
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  CalendarClock,
  Mail,
  Hash,
  Globe,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useInProgressSet, type FetchError, friendlyError } from "@/ui/hooks/use-admin-fetch";

// ── Types ─────────────────────────────────────────────────────────

interface Recipient {
  type: string;
  value: string;
}

interface ScheduledTask {
  id: string;
  ownerId: string;
  name: string;
  question: string;
  cronExpression: string;
  deliveryChannel: "email" | "slack" | "webhook";
  recipients: Recipient[];
  connectionId: string | null;
  approvalMode: "auto" | "manual" | "admin-only";
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduledTaskRun {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "success" | "failed" | "skipped";
  conversationId: string | null;
  actionId: string | null;
  error: string | null;
  tokensUsed: number | null;
  createdAt: string;
}

interface TaskDetail extends ScheduledTask {
  recentRuns: ScheduledTaskRun[];
}

type EnabledFilter = "all" | "true" | "false";

// ── Helpers ───────────────────────────────────────────────────────

const CHANNEL_ICON = {
  email: Mail,
  slack: Hash,
  webhook: Globe,
} as const;

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);

  if (absDiffMs < 60_000) return diffMs > 0 ? "in <1m" : "<1m ago";
  if (absDiffMs < 3_600_000) {
    const mins = Math.round(absDiffMs / 60_000);
    return diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
  }
  if (absDiffMs < 86_400_000) {
    const hrs = Math.round(absDiffMs / 3_600_000);
    return diffMs > 0 ? `in ${hrs}h` : `${hrs}h ago`;
  }
  const days = Math.round(absDiffMs / 86_400_000);
  return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
}

function RunStatusBadge({ status }: { status: ScheduledTaskRun["status"] }) {
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
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

// ── Page ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export default function ScheduledTasksPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [{ page, enabled: enabledFilter, expanded: expandedId }, setParams] = useQueryStates(scheduledTasksSearchParams);
  const offset = (page - 1) * PAGE_SIZE;

  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggling = useInProgressSet();
  const triggering = useInProgressSet();

  // ── Fetch task list ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function fetchTasks() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (enabledFilter !== "all") qs.set("enabled", enabledFilter);

        const res = await fetch(
          `${apiUrl}/api/v1/scheduled-tasks?${qs}`,
          { credentials },
        );
        if (!res.ok) {
          if (!cancelled) setError({ message: `HTTP ${res.status}`, status: res.status });
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setTasks(data.tasks ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError({
            message: err instanceof Error ? err.message : "Failed to load scheduled tasks",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchTasks();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, offset, enabledFilter, credentials]);

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Scheduled Tasks</h1>
          <p className="text-sm text-muted-foreground">Manage recurring queries and delivery schedules</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Scheduled Tasks" />
      </div>
    );
  }

  // ── Fetch detail (with recent runs) ─────────────────────────────
  const handleRowClick = useCallback(
    async (taskId: string) => {
      if (expandedId === taskId) {
        setParams({ expanded: null });
        setSelectedTask(null);
        setDetailError(null);
        return;
      }
      setParams({ expanded: taskId });
      setSelectedTask(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}`,
          { credentials },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: TaskDetail = await res.json();
        setSelectedTask(data);
      } catch (err) {
        setDetailError(
          `Failed to load task details: ${err instanceof Error ? err.message : "Network error"}`
        );
      } finally {
        setDetailLoading(false);
      }
    },
    [apiUrl, expandedId, credentials, setParams],
  );

  // ── Toggle enabled ──────────────────────────────────────────────
  const handleToggle = useCallback(
    async (task: ScheduledTask, e: React.MouseEvent) => {
      e.stopPropagation();
      if (toggling.has(task.id)) return;
      toggling.start(task.id);
      setMutationError(null);
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`,
          {
            credentials,
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !task.enabled }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const updated: ScheduledTask = await res.json();
        setTasks((prev) =>
          prev.map((t) => (t.id === updated.id ? updated : t)),
        );
      } catch (err) {
        setMutationError(
          `Toggle failed: ${err instanceof Error ? err.message : "Network error"}`
        );
      } finally {
        toggling.stop(task.id);
      }
    },
    [apiUrl, toggling, credentials],
  );

  // ── Run now ─────────────────────────────────────────────────────
  const handleRunNow = useCallback(
    async (taskId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (triggering.has(taskId)) return;
      triggering.start(taskId);
      setMutationError(null);
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/run`,
          {
            credentials,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        setMutationError(
          `Run failed: ${err instanceof Error ? err.message : "Network error"}`
        );
      } finally {
        triggering.stop(taskId);
      }
    },
    [apiUrl, triggering, credentials],
  );

  // ── Filter change resets pagination ─────────────────────────────
  function changeFilter(filter: EnabledFilter) {
    setParams({ enabled: filter, page: 1, expanded: null });
    setSelectedTask(null);
  }

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Scheduled Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Manage recurring queries and delivery schedules
        </p>
      </div>

      <div className="flex items-center gap-2 border-b px-6 py-3">
        {(["all", "true", "false"] as const).map((value) => {
          const label =
            value === "all" ? "All" : value === "true" ? "Enabled" : "Disabled";
          return (
            <Button
              key={value}
              size="sm"
              variant={enabledFilter === value ? "secondary" : "ghost"}
              onClick={() => changeFilter(value)}
            >
              {label}
            </Button>
          );
        })}
        {total > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {total} task{total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={() => setError(null)} />}
        {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}

        {loading ? (
          <LoadingState message="Loading scheduled tasks..." />
        ) : tasks.length === 0 && !error ? (
          <EmptyState icon={CalendarClock} message="No scheduled tasks found" />
        ) : tasks.length > 0 ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Name</TableHead>
                  <TableHead>Question</TableHead>
                  <TableHead>Cron</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => {
                  const ChannelIcon = CHANNEL_ICON[task.deliveryChannel];
                  const isExpanded = expandedId === task.id;
                  return (
                    <Fragment key={task.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => handleRowClick(task.id)}
                      >
                        <TableCell>
                          {isExpanded ? (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">
                          {task.name}
                        </TableCell>
                        <TableCell
                          className="max-w-xs truncate text-muted-foreground"
                          title={task.question}
                        >
                          {task.question}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {task.cronExpression}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            <ChannelIcon className="size-3" />
                            {task.deliveryChannel}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelativeDate(task.nextRunAt)}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant={task.enabled ? "secondary" : "ghost"}
                            disabled={toggling.has(task.id)}
                            onClick={(e) => handleToggle(task, e)}
                          >
                            {toggling.has(task.id) ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : task.enabled ? (
                              "On"
                            ) : (
                              "Off"
                            )}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={triggering.has(task.id)}
                            onClick={(e) => handleRunNow(task.id, e)}
                          >
                            {triggering.has(task.id) ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <>
                                <Play className="mr-1 size-3" />
                                Run
                              </>
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/30 p-4">
                            {detailLoading ? (
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <Loader2 className="size-3 animate-spin" />
                                <span className="text-xs">
                                  Loading runs...
                                </span>
                              </div>
                            ) : detailError ? (
                              <p className="text-xs text-destructive">{detailError}</p>
                            ) : selectedTask &&
                              selectedTask.recentRuns.length > 0 ? (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Started</TableHead>
                                    <TableHead>Completed</TableHead>
                                    <TableHead>Tokens</TableHead>
                                    <TableHead>Error</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {selectedTask.recentRuns.map((run) => (
                                    <TableRow key={run.id}>
                                      <TableCell>
                                        <RunStatusBadge status={run.status} />
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {formatRelativeDate(run.startedAt)}
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {formatRelativeDate(run.completedAt)}
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {run.tokensUsed ?? "—"}
                                      </TableCell>
                                      <TableCell
                                        className="max-w-xs truncate text-xs text-muted-foreground"
                                        title={run.error ?? undefined}
                                      >
                                        {run.error ?? "—"}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                No recent runs
                              </p>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>

            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t px-6 py-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setParams((p) => ({ page: p.page - 1 }))}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setParams((p) => ({ page: p.page + 1 }))}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
