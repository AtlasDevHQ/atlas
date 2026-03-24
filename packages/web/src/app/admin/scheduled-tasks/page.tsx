"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import type { ColumnDef, Row } from "@tanstack/react-table";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import {
  CalendarClock,
  Play,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  History,
  Eye,
} from "lucide-react";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { DeliveryStatusBadge } from "@/ui/components/admin/delivery-status-badge";
import { ExpandableDataTable } from "@/components/data-table/data-table-expandable";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { getScheduledTaskColumns, formatRelativeDate } from "./columns";
import { TaskFormDialog } from "./task-form-dialog";
import type {
  ScheduledTask,
  ScheduledTaskWithRuns,
} from "@/ui/lib/types";

type EnabledFilter = "all" | "true" | "false";

// ── Page ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export default function ScheduledTasksPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);

  const [{ page, enabled: enabledFilter, expanded: expandedId }, setParams] = useQueryStates(scheduledTasksSearchParams);
  const offset = (page - 1) * PAGE_SIZE;

  const [selectedTask, setSelectedTask] = useState<ScheduledTaskWithRuns | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Mutation hooks for per-item actions
  const toggleMutation = useAdminMutation<ScheduledTask>({ method: "PUT" });
  const triggerMutation = useAdminMutation({ method: "POST" });
  const deleteMutation = useAdminMutation({
    method: "DELETE",
  });
  const previewMutation = useAdminMutation<{ channel: string; email?: { subject: string; body: string }; slack?: { text: string; blocks: unknown[] }; webhook?: unknown }>({
    method: "POST",
  });

  // ── Form dialog state ──────────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  // ── Delete confirmation state ──────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);

  // ── Preview state ─────────────────────────────────────────────
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ channel: string; email?: { subject: string; body: string }; slack?: { text: string; blocks: unknown[] }; webhook?: unknown } | null>(null);

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
    previewMutation.reset();
    setPreviewOpen(true);
    await previewMutation.mutate({
      path: `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/preview`,
      body: {},
      onSuccess: (data) => setPreviewData(data),
    });
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
    if (toggleMutation.isMutating(task.id)) return;
    await toggleMutation.mutate({
      path: `/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`,
      body: { enabled: !task.enabled },
      itemId: task.id,
      onSuccess: (updated) => {
        setTasks((prev) =>
          prev.map((t) => (t.id === updated.id ? updated : t)),
        );
      },
    });
  }

  // ── Run now ─────────────────────────────────────────────────────
  async function handleRunNow(taskId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (triggerMutation.isMutating(taskId)) return;
    await triggerMutation.mutate({
      path: `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/run`,
      body: {},
      itemId: taskId,
    });
  }

  // ── Delete task ──────────────────────────────────────────────────
  async function handleDelete(task: ScheduledTask) {
    if (deleteMutation.isMutating(task.id)) return;
    await deleteMutation.mutate({
      path: `/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`,
      itemId: task.id,
      onSuccess: () => {
        setRefetchKey((k) => k + 1);
      },
    });
    setDeleteTarget(null);
  }

  // ── Filter change resets pagination ─────────────────────────────
  function changeFilter(filter: EnabledFilter) {
    setParams({ enabled: filter, page: 1, expanded: null });
    setSelectedTask(null);
  }

  // ── Data table ──────────────────────────────────────────────────
  const taskColumns: ColumnDef<ScheduledTask>[] = (() => {
    const base = getScheduledTaskColumns({ expandedId });
    const enabledCol: ColumnDef<ScheduledTask> = {
      id: "enabled",
      accessorKey: "enabled",
      header: () => "Enabled",
      cell: ({ row }) => {
        const task = row.original;
        return (
          <Button
            size="sm"
            variant={task.enabled ? "secondary" : "ghost"}
            disabled={toggleMutation.isMutating(task.id)}
            onClick={(e) => handleToggle(task, e)}
          >
            {toggleMutation.isMutating(task.id) ? (
              <Loader2 className="size-3 animate-spin" />
            ) : task.enabled ? "On" : "Off"}
          </Button>
        );
      },
      enableSorting: false,
      enableHiding: false,
    };
    const actionsCol: ColumnDef<ScheduledTask> = {
      id: "actions",
      header: () => null,
      cell: ({ row }) => {
        const task = row.original;
        return (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={triggerMutation.isMutating(task.id)}
              onClick={(e) => handleRunNow(task.id, e)}
            >
              {triggerMutation.isMutating(task.id) ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <>
                  <Play className="mr-1 size-3" />
                  Run
                </>
              )}
            </Button>
            <Button size="icon" variant="ghost" className="size-8" title="Preview delivery" onClick={(e) => handlePreview(task.id, e)}>
              <Eye className="size-3" />
            </Button>
            <Button size="icon" variant="ghost" className="size-8" onClick={(e) => openEdit(task, e)}>
              <Pencil className="size-3" />
            </Button>
            <Button size="icon" variant="ghost" className="size-8 text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteTarget(task); }}>
              <Trash2 className="size-3" />
            </Button>
          </div>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 144,
    };
    return [...base, enabledCol, actionsCol];
  })();

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { table: tasksTable } = useDataTable({
    data: tasks,
    columns: taskColumns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: PAGE_SIZE } },
    getRowId: (row) => row.id,
  });

  const handleTaskRowClick = (row: Row<ScheduledTask>) => handleRowClick(row.original.id);

  const isTaskExpanded = (row: Row<ScheduledTask>) => expandedId === row.original.id;

  const renderTaskExpandedRow = (row: Row<ScheduledTask>) => {
    if (expandedId !== row.original.id) return null;
    if (detailLoading) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <span className="text-xs">Loading runs...</span>
        </div>
      );
    }
    if (detailError) {
      return <p className="text-xs text-destructive">{detailError}</p>;
    }
    if (selectedTask && selectedTask.recentRuns.length > 0) {
      return (
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
                  <Badge
                    variant={run.status === "failed" ? "destructive" : run.status === "success" ? "secondary" : "outline"}
                    className={run.status === "success" ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" : undefined}
                  >
                    {run.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DeliveryStatusBadge status={run.deliveryStatus} error={run.deliveryError} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelativeDate(run.startedAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelativeDate(run.completedAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {run.tokensUsed ?? "\u2014"}
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={run.error ?? undefined}>
                  {run.error ?? "\u2014"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }
    return <p className="text-xs text-muted-foreground">No recent runs</p>;
  };

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

      <ErrorBoundary>
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {toggleMutation.error && <ErrorBanner message={toggleMutation.error} onRetry={toggleMutation.clearError} />}
        {triggerMutation.error && <ErrorBanner message={triggerMutation.error} onRetry={triggerMutation.clearError} />}
        {deleteMutation.error && <ErrorBanner message={deleteMutation.error} onRetry={deleteMutation.clearError} />}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Scheduled Tasks"
          onRetry={() => setError(null)}
          emptyIcon={CalendarClock}
          emptyTitle="No scheduled tasks"
          emptyDescription="Create a task to automate recurring queries and reports"
          emptyAction={{ label: "Create task", onClick: openCreate }}
          isEmpty={tasks.length === 0}
        >
          <ExpandableDataTable
            table={tasksTable}
            onRowClick={handleTaskRowClick}
            isRowExpanded={isTaskExpanded}
            renderExpandedRow={renderTaskExpandedRow}
          >
            <DataTableToolbar table={tasksTable}>
              <DataTableSortList table={tasksTable} />
            </DataTableToolbar>
          </ExpandableDataTable>
        </AdminContentWrapper>
      </div>
      </ErrorBoundary>

      <TaskFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        task={editingTask}
        onSuccess={handleFormSuccess}
      />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delivery Preview</DialogTitle>
          </DialogHeader>
          {previewMutation.saving ? (
            <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Generating preview...
            </div>
          ) : previewMutation.error ? (
            <p className="text-sm text-destructive py-4">{previewMutation.error}</p>
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
              disabled={deleteTarget ? deleteMutation.isMutating(deleteTarget.id) : false}
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              {deleteTarget && deleteMutation.isMutating(deleteTarget.id) ? (
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
