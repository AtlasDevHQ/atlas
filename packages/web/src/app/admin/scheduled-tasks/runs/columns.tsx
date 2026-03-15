"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { DeliveryStatusBadge } from "@/ui/components/admin/delivery-status-badge";
import { ChevronDown, ChevronRight, Loader2, FileText, Activity, Truck, Clock, Timer, Coins, AlertTriangle } from "lucide-react";
import type { ScheduledTaskRunWithTaskName } from "@/ui/lib/types";

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

export function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "\u2014";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "\u2014";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function getRunHistoryColumns(opts: {
  expandedId: string | null;
}): ColumnDef<ScheduledTaskRunWithTaskName>[] {
  return [
    {
      id: "expand",
      header: () => null,
      cell: ({ row }) => {
        const isExpanded = opts.expandedId === row.original.id;
        return isExpanded ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 32,
    },
    {
      id: "taskName",
      accessorKey: "taskName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Task" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">{row.getValue<string>("taskName")}</span>
      ),
      meta: { label: "Task", icon: FileText },
      enableSorting: false,
    },
    {
      id: "status",
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Status" />
      ),
      cell: ({ row }) => <RunStatusBadge status={row.getValue<string>("status")} />,
      meta: { label: "Status", icon: Activity },
      enableSorting: false,
    },
    {
      id: "delivery",
      accessorKey: "deliveryStatus",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Delivery" />
      ),
      cell: ({ row }) => (
        <DeliveryStatusBadge
          status={row.original.deliveryStatus}
          error={row.original.deliveryError}
        />
      ),
      meta: { label: "Delivery", icon: Truck },
      enableSorting: false,
    },
    {
      id: "startedAt",
      accessorKey: "startedAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Started" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {formatTimestamp(row.getValue<string>("startedAt"))}
        </span>
      ),
      meta: { label: "Started", icon: Clock },
    },
    {
      id: "duration",
      accessorFn: (row) => {
        if (!row.completedAt) return null;
        return new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime();
      },
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Duration" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {formatDuration(row.original.startedAt, row.original.completedAt ?? null)}
        </span>
      ),
      meta: { label: "Duration", icon: Timer },
    },
    {
      id: "tokensUsed",
      accessorKey: "tokensUsed",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Tokens" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.tokensUsed?.toLocaleString() ?? "\u2014"}
        </span>
      ),
      meta: { label: "Tokens", icon: Coins },
    },
    {
      id: "error",
      accessorKey: "error",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Error" />
      ),
      cell: ({ row }) => (
        <span
          className="max-w-xs truncate text-xs text-muted-foreground block"
          title={row.original.error ?? undefined}
        >
          {row.original.error ? row.original.error.slice(0, 80) : "\u2014"}
        </span>
      ),
      meta: { label: "Error", icon: AlertTriangle },
      enableSorting: false,
    },
  ];
}
