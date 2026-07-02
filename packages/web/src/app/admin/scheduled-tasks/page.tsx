"use client";

import * as React from "react";
import { useState } from "react";
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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ServerDataTable } from "@/ui/components/admin/server-data-table";
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
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useServerDataTable } from "@/ui/hooks/use-server-data-table";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { DeliveryStatusBadge } from "@/ui/components/admin/delivery-status-badge";
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

  const [{ enabled: enabledFilter, expanded: expandedId }, setParams] = useQueryStates(scheduledTasksSearchParams);

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
    refetch();
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
      onSuccess: (data) => {
        if (data) setPreviewData(data);
      },
    });
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
    if (toggleMutation.isMutating(task.id)) return;
    // On success `useAdminMutation` invalidates admin-fetch queries, so the
    // module-owned task list refetches with the new `enabled` state.
    await toggleMutation.mutate({
      path: `/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`,
      body: { enabled: !task.enabled },
      itemId: task.id,
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
    // Delete auto-invalidates admin-fetch queries → the list refetches.
    await deleteMutation.mutate({
      path: `/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`,
      itemId: task.id,
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

  // The server-data-table module owns pagination, the task-list fetch,
  // pageCount, and the table instance; the page keeps its filter, row actions,
  // and the expanded-row detail fetch.
  const {
    table: tasksTable,
    rows: tasks,
    total,
    loading,
    error,
    refetch,
  } = useServerDataTable<ScheduledTask>({
    columns: taskColumns,
    getRowId: (row) => row.id,
    defaultPerPage: PAGE_SIZE,
    select: (r) => {
      const d = r as { tasks?: ScheduledTask[]; total?: number };
      return { rows: d.tasks ?? [], total: d.total ?? 0 };
    },
    buildPath: ({ offset, perPage }) => {
      const qs = new URLSearchParams({
        limit: String(perPage),
        offset: String(offset),
      });
      if (enabledFilter !== "all") qs.set("enabled", enabledFilter);
      return `/api/v1/scheduled-tasks?${qs}`;
    },
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
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between">
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

      <div className="mb-4 flex items-center gap-2">
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
      <div className="space-y-6">
        <MutationErrorSurface
          error={toggleMutation.error}
          feature="Scheduled Tasks"
          onRetry={toggleMutation.clearError}
        />
        <MutationErrorSurface
          error={triggerMutation.error}
          feature="Scheduled Tasks"
          onRetry={triggerMutation.clearError}
        />
        <MutationErrorSurface
          error={deleteMutation.error}
          feature="Scheduled Tasks"
          onRetry={deleteMutation.clearError}
        />

        <ServerDataTable
          table={tasksTable}
          loading={loading}
          error={error}
          isEmpty={tasks.length === 0}
          onRetry={refetch}
          feature="Scheduled Tasks"
          loadingMessage="Loading scheduled tasks..."
          emptyState={{
            icon: CalendarClock,
            title: "No scheduled tasks",
            description: "Create a task to automate recurring queries and reports",
            action: { label: "Create task", onClick: openCreate },
          }}
          expandable={{
            onRowClick: handleTaskRowClick,
            isRowExpanded: isTaskExpanded,
            renderExpandedRow: renderTaskExpandedRow,
          }}
        />
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
            <div className="py-4">
              <MutationErrorSurface
                error={previewMutation.error}
                feature="Scheduled Tasks"
                variant="inline"
              />
            </div>
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
