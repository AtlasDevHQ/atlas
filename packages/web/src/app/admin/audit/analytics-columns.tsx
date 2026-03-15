"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";

// ── Types ─────────────────────────────────────────────────────────

export interface SlowQuery {
  query: string;
  avgDuration: number;
  maxDuration: number;
  count: number;
}

export interface FrequentQuery {
  query: string;
  count: number;
  avgDuration: number;
  errorCount: number;
}

export interface AuditUserStats {
  userId: string;
  userEmail?: string | null;
  count: number;
  avgDuration: number;
  errorCount: number;
  errorRate: number;
}

// ── Slowest queries ──────────────────────────────────────────────

export function getSlowQueryColumns(): ColumnDef<SlowQuery>[] {
  return [
    {
      id: "query",
      accessorKey: "query",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Query" />,
      cell: ({ row }) => (
        <span className="max-w-xs truncate font-mono text-xs block">
          {row.getValue<string>("query")}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: "avgDuration",
      accessorKey: "avgDuration",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Avg" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("avgDuration")}ms
        </span>
      ),
      meta: { label: "Avg" },
      size: 80,
    },
    {
      id: "maxDuration",
      accessorKey: "maxDuration",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Max" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("maxDuration")}ms
        </span>
      ),
      meta: { label: "Max" },
      size: 80,
    },
    {
      id: "count",
      accessorKey: "count",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Runs" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("count")}
        </span>
      ),
      meta: { label: "Runs" },
      size: 64,
    },
  ];
}

// ── Most frequent queries ────────────────────────────────────────

export function getFrequentQueryColumns(): ColumnDef<FrequentQuery>[] {
  return [
    {
      id: "query",
      accessorKey: "query",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Query" />,
      cell: ({ row }) => (
        <span className="max-w-xs truncate font-mono text-xs block">
          {row.getValue<string>("query")}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: "count",
      accessorKey: "count",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Runs" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("count")}
        </span>
      ),
      meta: { label: "Runs" },
      size: 64,
    },
    {
      id: "avgDuration",
      accessorKey: "avgDuration",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Avg" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("avgDuration")}ms
        </span>
      ),
      meta: { label: "Avg" },
      size: 80,
    },
    {
      id: "errorCount",
      accessorKey: "errorCount",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Errors" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("errorCount")}
        </span>
      ),
      meta: { label: "Errors" },
      size: 64,
    },
  ];
}

// ── User activity ────────────────────────────────────────────────

export function getUserActivityColumns(): ColumnDef<AuditUserStats>[] {
  return [
    {
      id: "user",
      accessorFn: (row) => row.userEmail ?? row.userId,
      header: ({ column }) => <DataTableColumnHeader column={column} label="User" />,
      cell: ({ row }) => <span className="text-sm">{row.getValue<string>("user")}</span>,
      enableSorting: false,
    },
    {
      id: "count",
      accessorKey: "count",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Queries" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("count").toLocaleString()}
        </span>
      ),
      meta: { label: "Queries" },
      size: 80,
    },
    {
      id: "avgDuration",
      accessorKey: "avgDuration",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Avg Duration" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("avgDuration")}ms
        </span>
      ),
      meta: { label: "Avg Duration" },
      size: 96,
    },
    {
      id: "errorCount",
      accessorKey: "errorCount",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Errors" className="justify-end" />,
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("errorCount")}
        </span>
      ),
      meta: { label: "Errors" },
      size: 64,
    },
    {
      id: "errorRate",
      accessorKey: "errorRate",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Error Rate" className="justify-end" />,
      cell: ({ row }) => (
        <Badge
          variant="outline"
          className={
            row.getValue<number>("errorRate") > 0.1
              ? "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400"
              : "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
          }
        >
          {(row.getValue<number>("errorRate") * 100).toFixed(1)}%
        </Badge>
      ),
      meta: { label: "Error Rate" },
      size: 96,
    },
  ];
}
