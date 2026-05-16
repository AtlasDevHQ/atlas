"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { DemoBadge, DraftBadge } from "@/ui/components/admin/mode-badges";
import { Fingerprint, Database, FileText, Activity, Clock, Layers } from "lucide-react";
import type { ConnectionHealth, ConnectionInfo } from "@/ui/lib/types";
import { stripGroupPrefix } from "@/ui/lib/strip-group-prefix";

/** Reserved connection id for the onboarding demo dataset. */
export const DEMO_CONNECTION_ID = "__demo__";

function mapHealthStatus(
  status?: ConnectionHealth["status"],
): "healthy" | "degraded" | "down" | "unknown" {
  if (!status) return "unknown";
  if (status === "unhealthy") return "down";
  return status;
}

export function getConnectionColumns(): ColumnDef<ConnectionInfo>[] {
  return [
    {
      id: "id",
      accessorKey: "id",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="ID" />
      ),
      cell: ({ row }) => {
        const id = row.getValue<string>("id");
        const status = row.original.status;
        return (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">{id}</span>
            {id === DEMO_CONNECTION_ID && <DemoBadge />}
            {status === "draft" && <DraftBadge />}
          </div>
        );
      },
      meta: { label: "ID", icon: Fingerprint },
      enableSorting: false,
    },
    {
      id: "dbType",
      accessorKey: "dbType",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Type" />
      ),
      cell: ({ row }) => (
        <Badge variant="secondary">{row.getValue<string>("dbType")}</Badge>
      ),
      meta: { label: "Type", icon: Database },
    },
    {
      id: "description",
      accessorKey: "description",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Description" />
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.getValue<string>("description") ?? "\u2014"}
        </span>
      ),
      meta: { label: "Description", icon: FileText },
      enableSorting: false,
    },
    {
      id: "environment",
      accessorFn: (row) => row.groupName ?? null,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Environment" />
      ),
      cell: ({ row }) => {
        const groupName = row.original.groupName;
        // Use explicit `== null` rather than `!groupName` \u2014 empty string is
        // not a documented state and falling through to the em-dash would
        // mask a corrupt `connection_groups.name = ''` row instead of
        // surfacing it. The backend invariant is `groupId !== null \u21d2
        // groupName !== null`; both are jointly null/non-null.
        if (groupName == null) {
          return <span className="text-sm text-muted-foreground">{"\u2014"}</span>;
        }
        return (
          <Link
            href="/admin/connections/groups"
            className="inline-flex items-center"
            aria-label={`View environment ${stripGroupPrefix(groupName)}`}
          >
            <Badge variant="outline">{stripGroupPrefix(groupName)}</Badge>
          </Link>
        );
      },
      meta: { label: "Environment", icon: Layers },
      enableSorting: false,
    },
    {
      id: "health",
      accessorFn: (row) => row.health?.status ?? "unknown",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Health" />
      ),
      cell: ({ row }) => (
        <HealthBadge status={mapHealthStatus(row.original.health?.status)} />
      ),
      meta: { label: "Health", icon: Activity },
    },
    {
      id: "latency",
      accessorFn: (row) => row.health?.latencyMs ?? null,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Latency" />
      ),
      cell: ({ row }) => {
        const latency = row.original.health?.latencyMs;
        return (
          <span className="text-xs text-muted-foreground">
            {latency != null ? `${latency}ms` : "\u2014"}
          </span>
        );
      },
      meta: { label: "Latency", icon: Clock },
    },
  ];
}
