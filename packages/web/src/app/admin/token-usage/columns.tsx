"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { User, ArrowRight, ArrowLeft, Coins, MessageSquare } from "lucide-react";

export interface UserTokenRow {
  userId: string;
  userEmail?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function getTokenUsageColumns(): ColumnDef<UserTokenRow>[] {
  return [
    {
      id: "user",
      accessorFn: (row) => row.userEmail ?? row.userId,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="User" />
      ),
      cell: ({ row }) => (
        <span className="text-sm">{row.getValue<string>("user")}</span>
      ),
      meta: { label: "User", icon: User },
      enableSorting: false,
    },
    {
      id: "promptTokens",
      accessorKey: "promptTokens",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Prompt" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {formatNumber(row.getValue<number>("promptTokens"))}
        </span>
      ),
      meta: { label: "Prompt", icon: ArrowRight },
      size: 112,
    },
    {
      id: "completionTokens",
      accessorKey: "completionTokens",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Completion" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {formatNumber(row.getValue<number>("completionTokens"))}
        </span>
      ),
      meta: { label: "Completion", icon: ArrowLeft },
      size: 112,
    },
    {
      id: "totalTokens",
      accessorKey: "totalTokens",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Total" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums font-medium block">
          {formatNumber(row.getValue<number>("totalTokens"))}
        </span>
      ),
      meta: { label: "Total", icon: Coins },
      size: 112,
    },
    {
      id: "requestCount",
      accessorKey: "requestCount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Requests" className="justify-end" />
      ),
      cell: ({ row }) => (
        <span className="text-right text-xs tabular-nums block">
          {row.getValue<number>("requestCount")}
        </span>
      ),
      meta: { label: "Requests", icon: MessageSquare },
      size: 80,
    },
  ];
}
