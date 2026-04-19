"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { Clock, User, Globe, Monitor, Trash2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  userId: string;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Extract a short browser/OS label from a full user-agent string. */
function shortUA(ua: string | null): string {
  if (!ua) return "—";
  // Try to extract browser name + version
  const match = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Brave)\/[\d.]+/);
  if (match) return match[0];
  if (ua.length > 50) return ua.slice(0, 50) + "…";
  return ua;
}

// ── Columns ───────────────────────────────────────────────────────

export interface SessionActions {
  onRevoke: (sessionId: string) => void;
  isRevoking: (id: string) => boolean;
}

export function getSessionColumns(actions?: SessionActions): ColumnDef<SessionRow>[] {
  return [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
          className="translate-y-0.5"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
          className="translate-y-0.5"
        />
      ),
      enableSorting: false,
      size: 40,
    },
    {
      id: "userEmail",
      accessorFn: (row) => row.userEmail ?? row.userId,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="User" />
      ),
      cell: ({ row }) => (
        <span className="text-sm truncate max-w-[200px]" title={row.original.userEmail ?? row.original.userId}>
          {row.original.userEmail ?? row.original.userId}
        </span>
      ),
      meta: { label: "User", icon: User },
      size: 220,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Created" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          <RelativeTimestamp iso={row.getValue<string>("createdAt")} />
        </span>
      ),
      meta: { label: "Created", icon: Clock },
      size: 140,
    },
    {
      id: "updatedAt",
      accessorKey: "updatedAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Last Active" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          <RelativeTimestamp iso={row.getValue<string>("updatedAt")} />
        </span>
      ),
      meta: { label: "Last Active", icon: Clock },
      size: 140,
    },
    {
      id: "ipAddress",
      accessorKey: "ipAddress",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="IP Address" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground font-mono">
          {row.getValue<string | null>("ipAddress") ?? "—"}
        </span>
      ),
      meta: { label: "IP Address", icon: Globe },
      size: 140,
    },
    {
      id: "userAgent",
      accessorKey: "userAgent",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="User Agent" />
      ),
      cell: ({ row }) => (
        <span
          className="text-xs text-muted-foreground truncate max-w-[200px]"
          title={row.original.userAgent ?? undefined}
        >
          {shortUA(row.original.userAgent)}
        </span>
      ),
      meta: { label: "User Agent", icon: Monitor },
      size: 200,
    },
    ...(actions
      ? [
          {
            id: "actions",
            header: "Actions",
            cell: ({ row }: { row: { original: SessionRow } }) => {
              const s = row.original;
              const revoking = actions.isRevoking(s.id);
              const who = s.userEmail ?? s.userId;
              return (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      disabled={revoking}
                    >
                      <Trash2 className="mr-1 size-3" />
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke session?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {who} will be signed out immediately. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => actions.onRevoke(s.id)}>
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              );
            },
            enableSorting: false,
            size: 100,
          } satisfies ColumnDef<SessionRow>,
        ]
      : []),
  ];
}
