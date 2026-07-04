"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { Clock, User, Code, Timer, Rows3, CheckCircle, Table2, Bot } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

// SSOT: `AuditRow` is derived from `AuditRowSchema` (`admin-schemas.ts`) via
// `z.infer` and re-exported here for the table's consumers. Keeping the shape
// in the schema means the Zod parse and this type can't drift (#4278).
export type { AuditRow } from "@/ui/lib/admin-schemas";
import type { AuditRow } from "@/ui/lib/admin-schemas";

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
          <RelativeTimestamp iso={row.getValue<string>("timestamp")} />
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
      id: "source",
      accessorFn: (row) => row.actor_kind ?? "",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Source" />
      ),
      // Surfaces the MCP attribution the row already carries (actor kind /
      // OAuth client / dispatched tool) so an admin can tell an agent/MCP
      // query from a human one — and which tool produced it — without raw SQL.
      cell: ({ row }) => {
        const { actor_kind, client_id, tool_name } = row.original;
        if (!actor_kind) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex flex-col gap-0.5 max-w-[160px]">
            <Badge variant="secondary" className="w-fit text-[10px] px-1.5 py-0 capitalize">
              {actor_kind}
            </Badge>
            {client_id && (
              <span className="truncate text-[10px] text-muted-foreground" title={client_id}>
                {client_id}
              </span>
            )}
            {tool_name && (
              <span className="truncate font-mono text-[10px] text-muted-foreground" title={tool_name}>
                {tool_name}
              </span>
            )}
          </div>
        );
      },
      meta: {
        label: "Source",
        icon: Bot,
      },
      enableSorting: false,
      size: 160,
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
