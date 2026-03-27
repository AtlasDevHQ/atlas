"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { LearnedPattern } from "@/ui/lib/types";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { Progress } from "@/components/ui/progress";
import {
  CircleDot,
  Code,
  FileText,
  Database,
  TrendingUp,
  Hash,
  Bot,
  Calendar,
} from "lucide-react";
import { formatDate } from "@/lib/format";

// ── Badge styles ──────────────────────────────────────────────────

export const statusBadge: Record<string, { variant: "outline"; className: string; label: string }> = {
  pending: {
    variant: "outline",
    className: "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
    label: "Pending",
  },
  approved: {
    variant: "outline",
    className: "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400",
    label: "Approved",
  },
  rejected: {
    variant: "outline",
    className: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400",
    label: "Rejected",
  },
};

const sourceBadge: Record<string, { variant: "outline"; className: string; label: string }> = {
  agent: {
    variant: "outline",
    className: "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400",
    label: "Agent",
  },
  "atlas-learn": {
    variant: "outline",
    className: "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400",
    label: "CLI",
  },
};

// ── Columns ───────────────────────────────────────────────────────

export function getLearnedPatternColumns(): ColumnDef<LearnedPattern>[] {
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
      id: "status",
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Status" />
      ),
      cell: ({ row }) => {
        const status = row.getValue<string>("status");
        const badge = statusBadge[status] ?? statusBadge.pending;
        return <Badge variant={badge.variant} className={badge.className}>{badge.label}</Badge>;
      },
      meta: { label: "Status", icon: CircleDot },
      enableSorting: false,
      size: 100,
    },
    {
      id: "patternSql",
      accessorKey: "patternSql",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Pattern SQL" />
      ),
      cell: ({ row }) => {
        const sql = row.getValue<string>("patternSql");
        const truncated = sql.length > 80 ? sql.slice(0, 80) + "\u2026" : sql;
        return (
          <span
            className="text-xs font-mono text-muted-foreground truncate max-w-[300px] block"
            title={sql}
          >
            {truncated}
          </span>
        );
      },
      meta: { label: "Pattern SQL", icon: Code },
      enableSorting: false,
      size: 320,
    },
    {
      id: "description",
      accessorKey: "description",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Description" />
      ),
      cell: ({ row }) => {
        const desc = row.getValue<string | null>("description");
        if (!desc) return <span className="text-xs text-muted-foreground">{"\u2014"}</span>;
        const truncated = desc.length > 60 ? desc.slice(0, 60) + "\u2026" : desc;
        return (
          <span className="text-sm text-muted-foreground truncate max-w-[200px] block" title={desc}>
            {truncated}
          </span>
        );
      },
      meta: { label: "Description", icon: FileText },
      enableSorting: false,
      size: 220,
    },
    {
      id: "sourceEntity",
      accessorKey: "sourceEntity",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Entity" />
      ),
      cell: ({ row }) => {
        const entity = row.getValue<string | null>("sourceEntity");
        return (
          <span className="text-xs font-mono text-muted-foreground">
            {entity ?? "\u2014"}
          </span>
        );
      },
      meta: { label: "Entity", icon: Database },
      enableSorting: false,
      size: 140,
    },
    {
      id: "confidence",
      accessorKey: "confidence",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Confidence" />
      ),
      cell: ({ row }) => {
        const val = row.getValue<number>("confidence");
        const pct = Math.round(val * 100);
        return (
          <div className="flex items-center gap-2 min-w-[80px]">
            <Progress value={pct} className="h-1.5 w-12" />
            <span className="text-xs text-muted-foreground">{pct}%</span>
          </div>
        );
      },
      meta: { label: "Confidence", icon: TrendingUp },
      size: 120,
    },
    {
      id: "repetitionCount",
      accessorKey: "repetitionCount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Reps" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          {row.getValue<number>("repetitionCount")}
        </span>
      ),
      meta: { label: "Repetitions", icon: Hash },
      size: 72,
    },
    {
      id: "proposedBy",
      accessorKey: "proposedBy",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Source" />
      ),
      cell: ({ row }) => {
        const source = row.getValue<string | null>("proposedBy");
        if (!source) return <span className="text-xs text-muted-foreground">{"\u2014"}</span>;
        const badge = sourceBadge[source] ?? sourceBadge.agent;
        return <Badge variant={badge.variant} className={badge.className}>{badge.label}</Badge>;
      },
      meta: { label: "Source", icon: Bot },
      enableSorting: false,
      size: 88,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Created" />
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(row.getValue<string>("createdAt"))}
        </span>
      ),
      meta: { label: "Created", icon: Calendar },
      size: 120,
    },
  ];
}
