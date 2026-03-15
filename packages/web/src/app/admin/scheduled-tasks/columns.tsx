"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { ChevronDown, ChevronRight, Mail, Hash, Globe, FileText, Clock, Code, Radio } from "lucide-react";
import type { ScheduledTask } from "@/ui/lib/types";

const CHANNEL_ICON = {
  email: Mail,
  slack: Hash,
  webhook: Globe,
} as const;

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return "\u2014";
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

export { formatRelativeDate };

export function getScheduledTaskColumns(opts: {
  expandedId: string | null;
}): ColumnDef<ScheduledTask>[] {
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
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Name" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">{row.getValue<string>("name")}</span>
      ),
      meta: { label: "Name", icon: FileText },
    },
    {
      id: "question",
      accessorKey: "question",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Question" />
      ),
      cell: ({ row }) => (
        <span
          className="max-w-xs truncate text-muted-foreground block"
          title={row.getValue<string>("question")}
        >
          {row.getValue<string>("question")}
        </span>
      ),
      meta: { label: "Question" },
      enableSorting: false,
    },
    {
      id: "cronExpression",
      accessorKey: "cronExpression",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Cron" />
      ),
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.getValue<string>("cronExpression")}
        </span>
      ),
      meta: { label: "Cron", icon: Code },
      enableSorting: false,
    },
    {
      id: "deliveryChannel",
      accessorKey: "deliveryChannel",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Channel" />
      ),
      cell: ({ row }) => {
        const channel = row.getValue<keyof typeof CHANNEL_ICON>("deliveryChannel");
        const Icon = CHANNEL_ICON[channel] ?? Globe;
        return (
          <Badge variant="outline" className="gap-1">
            <Icon className="size-3" />
            {channel}
          </Badge>
        );
      },
      meta: { label: "Channel", icon: Radio },
      enableSorting: false,
    },
    {
      id: "nextRunAt",
      accessorKey: "nextRunAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Next Run" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {formatRelativeDate(row.getValue<string | null>("nextRunAt"))}
        </span>
      ),
      meta: { label: "Next Run", icon: Clock },
    },
  ];
}
