"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { PromptCollection } from "@/ui/lib/types";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import {
  FileText,
  Tag,
  Hash,
  Calendar,
  BookOpen,
} from "lucide-react";
import { formatDate } from "@/lib/format";

// -- Badge styles -------------------------------------------------------------

export const industryBadge: Record<
  string,
  { variant: "outline"; className: string; label: string }
> = {
  saas: {
    variant: "outline",
    className:
      "border-primary/50 text-primary dark:border-primary/50 dark:text-primary",
    label: "SaaS",
  },
  ecommerce: {
    variant: "outline",
    className:
      "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400",
    label: "E-commerce",
  },
  cybersecurity: {
    variant: "outline",
    className:
      "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400",
    label: "Cybersecurity",
  },
};

function getIndustryBadge(industry: string) {
  return (
    industryBadge[industry] ?? {
      variant: "outline" as const,
      className:
        "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-400",
      label: industry,
    }
  );
}

// -- Columns ------------------------------------------------------------------

export function getPromptCollectionColumns(
  itemCounts: Map<string, number>,
): ColumnDef<PromptCollection>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Name" />
      ),
      cell: ({ row }) => {
        const name = row.getValue<string>("name");
        const isBuiltin = row.original.isBuiltin;
        return (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {isBuiltin && (
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 text-[10px] px-1.5 py-0"
              >
                Built-in
              </Badge>
            )}
          </div>
        );
      },
      meta: { label: "Name", icon: BookOpen },
      size: 240,
    },
    {
      id: "industry",
      accessorKey: "industry",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Industry" />
      ),
      cell: ({ row }) => {
        const industry = row.getValue<string>("industry");
        const badge = getIndustryBadge(industry);
        return (
          <Badge variant={badge.variant} className={badge.className}>
            {badge.label}
          </Badge>
        );
      },
      meta: { label: "Industry", icon: Tag },
      enableSorting: false,
      size: 120,
    },
    {
      id: "description",
      accessorKey: "description",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Description" />
      ),
      cell: ({ row }) => {
        const desc = row.getValue<string>("description");
        if (!desc)
          return (
            <span className="text-xs text-muted-foreground">{"\u2014"}</span>
          );
        const truncated = desc.length > 60 ? desc.slice(0, 60) + "\u2026" : desc;
        return (
          <span
            className="text-sm text-muted-foreground truncate max-w-[240px] block"
            title={desc}
          >
            {truncated}
          </span>
        );
      },
      meta: { label: "Description", icon: FileText },
      enableSorting: false,
      size: 260,
    },
    {
      id: "itemCount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} label="Items" />
      ),
      cell: ({ row }) => {
        const count = itemCounts.get(row.original.id) ?? 0;
        return (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        );
      },
      meta: { label: "Items", icon: Hash },
      enableSorting: false,
      size: 72,
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
