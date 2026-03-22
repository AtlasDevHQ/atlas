"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { User, MessageSquare, Coins, LogIn } from "lucide-react";
import { formatNumber } from "./format";

export interface UserUsageRow {
  user_id: string;
  query_count: number;
  token_count: number;
  login_count: number;
}

export function getUserUsageColumns(): ColumnDef<UserUsageRow>[] {
  return [
    {
      id: "user",
      accessorKey: "user_id",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="User" />
      ),
      cell: ({ row }) => (
        <span className="text-sm font-mono truncate max-w-48 block">
          {row.getValue<string>("user")}
        </span>
      ),
      meta: { label: "User", icon: User },
      enableSorting: false,
    },
    {
      id: "query_count",
      accessorKey: "query_count",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Queries" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {formatNumber(row.getValue<number>("query_count"))}
        </span>
      ),
      meta: { label: "Queries", icon: MessageSquare },
      size: 112,
    },
    {
      id: "token_count",
      accessorKey: "token_count",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Tokens" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {formatNumber(row.getValue<number>("token_count"))}
        </span>
      ),
      meta: { label: "Tokens", icon: Coins },
      size: 112,
    },
    {
      id: "login_count",
      accessorKey: "login_count",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Logins" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("login_count")}
        </span>
      ),
      meta: { label: "Logins", icon: LogIn },
      size: 80,
    },
  ];
}
