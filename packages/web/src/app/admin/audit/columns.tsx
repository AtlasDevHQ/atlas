"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { Clock, User, Code, Timer, Rows3, CheckCircle, Table2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  user_id: string | null;
  sql: string;
  success: boolean;
  duration_ms: number;
  row_count: number | null;
  timestamp: string;
  user_email?: string | null;
  error?: string | null;
  source_id?: string | null;
  tables_accessed: string[] | null;
  columns_accessed: string[] | null;
}

// ── Columns ───────────────────────────────────────────────────────

export function getAuditColumns(): ColumnDef<AuditRow>[] {
  return [
    {
      id: "timestamp",
      accessorKey: "timestamp",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Timestamp" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {new Date(row.getValue<string>("timestamp")).toLocaleString(
            undefined,
            {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            },
          )}
        </span>
      ),
      meta: {
        label: "Timestamp",
        icon: Clock,
      },
      size: 176,
    },
    {
      id: "user",
      accessorFn: (row) => row.user_email ?? row.user_id ?? "Anonymous",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="User" />
      ),
      cell: ({ row }) => (
        <span className="text-sm">
          {row.getValue<string>("user")}
        </span>
      ),
      meta: {
        label: "User",
        placeholder: "Filter by user...",
        variant: "text",
        icon: User,
      },
      enableColumnFilter: true,
      enableSorting: false,
      size: 128,
    },
    {
      id: "sql",
      accessorKey: "sql",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="SQL" />
      ),
      cell: ({ row }) => (
        <span className="max-w-xs truncate font-mono text-xs block">
          {row.getValue<string>("sql")}
        </span>
      ),
      meta: {
        label: "SQL",
        icon: Code,
      },
      enableSorting: false,
    },
    {
      id: "tables_accessed",
      accessorFn: (row) => row.tables_accessed,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Tables" />
      ),
      cell: ({ row }) => {
        const tables = row.original.tables_accessed;
        if (!tables?.length) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex flex-wrap gap-1 max-w-[200px]">
            {tables.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">
                {t}
              </Badge>
            ))}
          </div>
        );
      },
      meta: {
        label: "Tables",
        icon: Table2,
      },
      enableSorting: false,
      size: 160,
    },
    {
      id: "duration_ms",
      accessorKey: "duration_ms",
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          label="Duration"
          className="justify-end"
        />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("duration_ms")}ms
        </span>
      ),
      meta: {
        label: "Duration",
        icon: Timer,
      },
      size: 96,
    },
    {
      id: "row_count",
      accessorKey: "row_count",
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          label="Rows"
          className="justify-end"
        />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number | null>("row_count") ?? "—"}
        </span>
      ),
      meta: {
        label: "Rows",
        icon: Rows3,
      },
      size: 80,
    },
    {
      id: "success",
      accessorKey: "success",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Status" />
      ),
      cell: ({ row }) =>
        row.getValue<boolean>("success") ? (
          <Badge
            variant="outline"
            className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
          >
            Success
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-red-300 text-red-700 dark:border-red-700 dark:text-red-400"
          >
            Error
          </Badge>
        ),
      meta: {
        label: "Status",
        variant: "select",
        options: [
          { label: "Success", value: "true" },
          { label: "Error", value: "false" },
        ],
        icon: CheckCircle,
      },
      enableColumnFilter: true,
      enableSorting: false,
      size: 96,
    },
  ];
}
