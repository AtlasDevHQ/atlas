"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Plus,
  Pencil,
  Trash2,
  History,
  Eye,
} from "lucide-react";
import { useInProgressSet, type FetchError, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { DeliveryStatusBadge } from "@/ui/components/admin/delivery-status-badge";
import { TaskFormDialog } from "./task-form-dialog";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskWithRuns,
} from "@/ui/lib/types";

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

  const [selectedTask, setSelectedTask] = useState<ScheduledTaskWithRuns | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggling = useInProgressSet();
  const triggering = useInProgressSet();

  // ── Form dialog state ──────────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  // ── Delete confirmation state ──────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const deleting = useInProgressSet();

  // ── Preview state ─────────────────────────────────────────────
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{ channel: string; email?: { subject: string; body: string }; slack?: { text: string; blocks: unknown[] }; webhook?: unknown } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function openCreate() {
    setEditingTask(null);
    setFormOpen(true);
  }

  function openEdit(task: ScheduledTask, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingTask(task);
    setFormOpen(true);
  }

  function handleFormSuccess() {
    setRefetchKey((k) => k + 1);
  }

  // ── Preview delivery ──────────────────────────────────────────
  async function handlePreview(taskId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/preview`,
        { credentials, method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPreviewData(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to generate preview");
    } finally {
      setPreviewLoading(false);
    }
  }

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
  }, [apiUrl, offset, enabledFilter, credentials, refetchKey]);

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
  async function handleRowClick(taskId: string) {
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
      const data: ScheduledTaskWithRuns = await res.json();
      setSelectedTask(data);
    } catch (err) {
      setDetailError(
        `Failed to load task details: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setDetailLoading(false);
    }
  }

  // ── Toggle enabled ──────────────────────────────────────────────
  async function handleToggle(task: ScheduledTask, e: React.MouseEvent) {
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
  }

  // ── Run now ─────────────────────────────────────────────────────
  async function handleRunNow(taskId: string, e: React.MouseEvent) {
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
  }

  // ── Delete task ──────────────────────────────────────────────────
  async function handleDelete(task: ScheduledTask) {
    if (deleting.has(task.id)) return;
    deleting.start(task.id);
    setMutationError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`,
        { credentials, method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }
      setDeleteTarget(null);
      setRefetchKey((k) => k + 1);
    } catch (err) {
      setMutationError(
        `Delete failed: ${err instanceof Error ? err.message : "Network error"}`
      );
      setDeleteTarget(null);
    } finally {
      deleting.stop(task.id);
    }
  }

  // ── Filter change resets pagination ─────────────────────────────
  function changeFilter(filter: EnabledFilter) {
    setParams({ enabled: filter, page: 1, expanded: null });
    setSelectedTask(null);
  }

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex items-start justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Scheduled Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Manage recurring queries and delivery schedules
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href="/admin/scheduled-tasks/runs">
              <History className="mr-1 size-4" />
              Run History
            </Link>
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 size-4" />
            Create task
          </Button>
        </div>
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

      <ErrorBoundary fallback={<div className="flex items-center justify-center p-6 text-sm text-red-600 dark:text-red-400">This section encountered an error.</div>}>
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
                  <TableHead className="w-36" />
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
                          <div className="flex items-center gap-1">
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
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              title="Preview delivery"
                              onClick={(e) => handlePreview(task.id, e)}
                            >
                              <Eye className="size-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              onClick={(e) => openEdit(task, e)}
                            >
                              <Pencil className="size-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 text-destructive hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(task);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
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
                                    <TableHead>Delivery</TableHead>
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
                                      <TableCell>
                                        <DeliveryStatusBadge
                                          status={run.deliveryStatus}
                                          error={run.deliveryError}
                                        />
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
      </ErrorBoundary>

      <TaskFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        task={editingTask}
        apiUrl={apiUrl}
        credentials={credentials}
        onSuccess={handleFormSuccess}
      />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delivery Preview</DialogTitle>
          </DialogHeader>
          {previewLoading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Generating preview...
            </div>
          ) : previewError ? (
            <p className="text-sm text-destructive py-4">{previewError}</p>
          ) : previewData ? (
            <div className="space-y-4">
              <Badge variant="outline" className="capitalize">{previewData.channel}</Badge>
              {previewData.email && (
                <div className="space-y-2">
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Subject</span>
                    <p className="text-sm font-medium">{previewData.email.subject}</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Body</span>
                    <iframe
                      sandbox=""
                      srcDoc={previewData.email.body}
                      className="mt-1 w-full rounded-md border"
                      style={{ minHeight: 200 }}
                      title="Email preview"
                    />
                  </div>
                </div>
              )}
              {previewData.slack && (
                <div className="space-y-2">
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Text</span>
                    <p className="text-sm">{previewData.slack.text}</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Blocks</span>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                      {JSON.stringify(previewData.slack.blocks, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
              {previewData.webhook != null ? (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Webhook Payload</span>
                  <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                    {JSON.stringify(previewData.webhook, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteTarget ? deleting.has(deleteTarget.id) : false}
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              {deleteTarget && deleting.has(deleteTarget.id) ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
