"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, Key, Trash2 } from "lucide-react";

// -- Types --

// Subset of Better Auth API key response — only fields rendered in the table.
export interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
}

// -- Helpers --

function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Never";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function maskedKey(prefix: string | null, start: string | null): string {
  const p = prefix ?? "key";
  const s = start ? `${start}...` : "...";
  return `${p}_${s}`;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

// -- Column builder --

export interface ApiKeyActions {
  onRevoke: (apiKey: ApiKeyRow) => void;
}

export function getApiKeyColumns(actions: ApiKeyActions): ColumnDef<ApiKeyRow>[] {
  return [
    {
      id: "name",
      accessorFn: (row) => row.name ?? "Unnamed key",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Name" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.name ?? "Unnamed key"}
        </span>
      ),
      meta: { label: "Name", icon: Key },
    },
    {
      id: "key",
      accessorFn: (row) => maskedKey(row.prefix, row.start),
      header: "Key",
      cell: ({ row }) => (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {maskedKey(row.original.prefix, row.original.start)}
        </code>
      ),
      enableSorting: false,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Created" />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate(row.getValue<string>("createdAt"))}
        </span>
      ),
      meta: { label: "Created", icon: Clock },
    },
    {
      id: "lastRequest",
      accessorKey: "lastRequest",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Last Used" />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDateTime(row.getValue<string | null>("lastRequest"))}
        </span>
      ),
      meta: { label: "Last Used", icon: Clock },
    },
    {
      id: "expiresAt",
      accessorKey: "expiresAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Expires" />
      ),
      cell: ({ row }) => {
        const expiresAt = row.original.expiresAt;
        if (isExpired(expiresAt)) {
          return <Badge variant="destructive">Expired</Badge>;
        }
        return (
          <span className="text-muted-foreground">
            {expiresAt ? formatDate(expiresAt) : "Never"}
          </span>
        );
      },
      meta: { label: "Expires", icon: Clock },
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => actions.onRevoke(row.original)}
          title="Revoke API key"
        >
          <Trash2 className="size-4" />
        </Button>
      ),
      enableSorting: false,
      enableHiding: false,
      size: 64,
    },
  ];
}
