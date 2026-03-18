"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { Mail, UserIcon, Shield, Activity, Calendar } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string | null;
  invited_by_email: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

// ── Shared badge styles ──────────────────────────────────────────

const roleBadge: Record<string, { variant: "outline"; className: string }> = {
  owner: { variant: "outline", className: "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400" },
  admin: { variant: "outline", className: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400" },
  member: { variant: "outline", className: "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400" },
};

const inviteStatusBadge: Record<string, { variant: "outline"; className: string }> = {
  pending: { variant: "outline", className: "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400" },
  accepted: { variant: "outline", className: "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400" },
  revoked: { variant: "outline", className: "border-zinc-300 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400" },
  expired: { variant: "outline", className: "border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-500" },
};

// ── User columns ─────────────────────────────────────────────────

export function getUserColumns(): ColumnDef<User>[] {
  return [
    {
      id: "email",
      accessorKey: "email",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Email" />
      ),
      cell: ({ row }) => (
        <span className="text-sm font-medium">{row.getValue<string>("email")}</span>
      ),
      meta: { label: "Email", icon: Mail },
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Name" />
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.getValue<string>("name") || "\u2014"}
        </span>
      ),
      meta: { label: "Name", icon: UserIcon },
      enableSorting: false,
      size: 128,
    },
    {
      id: "role",
      accessorKey: "role",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Role" />
      ),
      cell: ({ row }) => {
        const role = row.getValue<string>("role");
        return (
          <Badge {...(roleBadge[role] ?? roleBadge.member)}>
            {role}
          </Badge>
        );
      },
      meta: { label: "Role", icon: Shield },
      enableSorting: false,
      size: 128,
    },
    {
      id: "status",
      accessorFn: (row) => (row.banned ? "banned" : "active"),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Status" />
      ),
      cell: ({ row }) =>
        row.original.banned ? (
          <Badge
            variant="outline"
            className="border-yellow-300 text-yellow-700 dark:border-yellow-700 dark:text-yellow-400"
          >
            Banned
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
          >
            Active
          </Badge>
        ),
      meta: { label: "Status", icon: Activity },
      enableSorting: false,
      size: 96,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Created" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.getValue<string>("createdAt")).toLocaleDateString(
            undefined,
            { month: "short", day: "numeric", year: "numeric" },
          )}
        </span>
      ),
      meta: { label: "Created", icon: Calendar },
      size: 144,
    },
  ];
}

// ── Invitation columns ───────────────────────────────────────────

export function getInvitationColumns(): ColumnDef<Invitation>[] {
  return [
    {
      id: "email",
      accessorKey: "email",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Email" />
      ),
      cell: ({ row }) => (
        <span className="text-sm font-medium">{row.getValue<string>("email")}</span>
      ),
      meta: { label: "Email", icon: Mail },
    },
    {
      id: "role",
      accessorKey: "role",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Role" />
      ),
      cell: ({ row }) => {
        const role = row.getValue<string>("role");
        return (
          <Badge {...(roleBadge[role] ?? roleBadge.member)}>
            {role}
          </Badge>
        );
      },
      meta: { label: "Role", icon: Shield },
      enableSorting: false,
      size: 128,
    },
    {
      id: "status",
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Status" />
      ),
      cell: ({ row }) => {
        const status = row.getValue<string>("status");
        return (
          <Badge {...(inviteStatusBadge[status] ?? inviteStatusBadge.pending)}>
            {status}
          </Badge>
        );
      },
      meta: { label: "Status", icon: Activity },
      enableSorting: false,
      size: 112,
    },
    {
      id: "expires_at",
      accessorKey: "expires_at",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Expires" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.getValue<string>("expires_at")).toLocaleDateString(
            undefined,
            { month: "short", day: "numeric", year: "numeric" },
          )}
        </span>
      ),
      meta: { label: "Expires", icon: Calendar },
      size: 144,
    },
    {
      id: "created_at",
      accessorKey: "created_at",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Sent" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.getValue<string>("created_at")).toLocaleDateString(
            undefined,
            { month: "short", day: "numeric", year: "numeric" },
          )}
        </span>
      ),
      meta: { label: "Sent", icon: Calendar },
      size: 144,
    },
  ];
}
