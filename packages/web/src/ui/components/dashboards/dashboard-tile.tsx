"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import {
  GripVertical,
  RefreshCw,
  Maximize2,
  Minimize2,
  Copy,
  Trash2,
  MoreHorizontal,
  Pencil,
  Check,
  X,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DataTable } from "@/ui/components/chat/data-table";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { cn } from "@/lib/utils";
import type { DashboardCard } from "@/ui/lib/types";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/50" /> },
);

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

type ViewMode = "chart" | "table";

interface DashboardTileProps {
  card: DashboardCard;
  editing: boolean;
  fullscreen: boolean;
  isRefreshing: boolean;
  onFullscreen: (cardId: string) => void;
  onRefresh: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (card: DashboardCard) => void;
  onUpdateTitle: (cardId: string, title: string) => void;
}

export function DashboardTile({
  card,
  editing,
  fullscreen,
  isRefreshing,
  onFullscreen,
  onRefresh,
  onDuplicate,
  onDelete,
  onUpdateTitle,
}: DashboardTileProps) {
  const dark = useDarkMode();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(card.title);

  const hasChartConfig = !!card.chartConfig && card.chartConfig.type !== "table";
  const [viewMode, setViewMode] = useState<ViewMode>(hasChartConfig ? "chart" : "table");

  const columns = card.cachedColumns ?? [];
  const rows = (card.cachedRows ?? []) as Record<string, unknown>[];
  const hasData = columns.length > 0 && rows.length > 0;
  const stringRows = hasData ? toStringRows(columns, rows) : [];

  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== card.title) onUpdateTitle(card.id, next);
    setTitleEditing(false);
  }

  return (
    <div
      className={cn(
        "dash-tile flex h-full w-full flex-col rounded-xl border border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100",
        "hover:border-zinc-300 dark:hover:border-zinc-700",
      )}
    >
      <div
        className={cn(
          "dash-tile-head group/head flex shrink-0 items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800/80",
          editing && "dash-drag-handle cursor-grab active:cursor-grabbing",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 items-center text-zinc-400 transition-opacity dark:text-zinc-500",
            editing ? "opacity-60 group-hover/head:opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <GripVertical className="size-3.5" />
        </span>

        {titleEditing ? (
          <div className="flex flex-1 items-center gap-1.5">
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") setTitleEditing(false);
              }}
              className="h-7 text-sm"
              autoFocus
            />
            <Button variant="ghost" size="icon" className="size-7" onClick={commitTitle}>
              <Check className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setTitleEditing(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <h3 className="line-clamp-1 flex-1 text-sm font-medium tracking-tight" title={card.title}>
            {card.title}
          </h3>
        )}

        {hasChartConfig && hasData && !titleEditing && (
          <div className="flex shrink-0 items-center gap-0 rounded-md p-0.5">
            <button
              type="button"
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                viewMode === "chart"
                  ? "bg-primary/12 text-primary"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200",
              )}
              onClick={() => setViewMode("chart")}
            >
              Chart
            </button>
            <button
              type="button"
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                viewMode === "table"
                  ? "bg-primary/12 text-primary"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200",
              )}
              onClick={() => setViewMode("table")}
            >
              Table
            </button>
          </div>
        )}

        {!titleEditing && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover/head:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onRefresh(card.id)}
              disabled={isRefreshing}
              title="Refresh data"
            >
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onFullscreen(card.id)}
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" title="More">
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="text-xs">
                <DropdownMenuItem onSelect={() => { setTitleDraft(card.title); setTitleEditing(true); }}>
                  <Pencil className="mr-2 size-3.5" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDuplicate(card.id)}>
                  <Copy className="mr-2 size-3.5" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete(card)}
                  className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                >
                  <Trash2 className="mr-2 size-3.5" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="dash-tile-body flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-2.5">
        {hasData ? (
          viewMode === "chart" && hasChartConfig ? (
            <div className="min-h-0 flex-1 [&>div]:aspect-auto! [&>div]:h-full!">
              <ResultChart headers={columns} rows={stringRows} dark={dark} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <DataTable columns={columns} rows={rows} />
            </div>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center px-2 text-center text-xs text-zinc-500 dark:text-zinc-400">
            No cached data. Click <RefreshCw className="mx-1 inline size-3" /> to load results.
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-zinc-100 px-3 py-1.5 font-mono text-[10px] text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-2.5" />
          {timeAgo(card.cachedAt)}
        </span>
        {hasData && <span>{rows.length} rows</span>}
      </div>
    </div>
  );
}
