"use client";

import { useLayoutEffect, useRef, useState } from "react";
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
import { timeAgo } from "./time-ago";
import type { DashboardCard, StagedChange } from "@/ui/lib/types";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/50" /> },
);

function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

type ViewMode = "chart" | "table";

interface DashboardTileProps {
  card: DashboardCard;
  editing: boolean;
  fullscreen: boolean;
  isRefreshing: boolean;
  /**
   * #2365 — pending destructive stage targeting this card, if any.
   *   - `remove_card` → renders strikethrough banner on top of the tile.
   *   - `edit_sql` → renders side-by-side SQL diff overlay.
   * `null` = no stage; tile renders normally. The actual Accept/Discard
   * affordance lives in the chat drawer (`<StageChangeCard>`), not on
   * the tile — the tile just signals "this is what's about to happen".
   */
  stage?: StagedChange | null;
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
  stage,
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

  // #2365 — discriminate the pending stage payload kind. The grid
  // already filters to PENDING stages; we trust the type here.
  const removeStage = stage?.kind === "remove_card" ? stage : null;
  const editSqlStage = stage?.kind === "edit_sql" ? stage : null;
  const editSqlPayload =
    editSqlStage && editSqlStage.payload.kind === "edit_sql" ? editSqlStage.payload : null;

  return (
    <div
      className={cn(
        "dash-tile relative flex h-full w-full flex-col rounded-xl border border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100",
        "hover:border-zinc-300 dark:hover:border-zinc-700",
        // Ring colour signals which kind of ghost change is staged.
        removeStage && "ring-2 ring-red-400/60 ring-offset-1",
        editSqlStage && "ring-2 ring-amber-400/60 ring-offset-1",
      )}
      data-stage-kind={stage?.kind ?? undefined}
      data-stage-id={stage?.id ?? undefined}
    >
      <div
        className={cn(
          "dash-tile-head group/head flex shrink-0 items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800/80",
          editing && "dash-drag-handle cursor-grab active:cursor-grabbing",
        )}
      >
        {editing && (
          <span
            aria-hidden
            className="flex shrink-0 items-center text-zinc-400 dark:text-zinc-500"
          >
            <GripVertical className="size-3.5" />
          </span>
        )}

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
              aria-label="Tile title"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={commitTitle}
              aria-label="Save title"
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setTitleEditing(false)}
              aria-label="Cancel rename"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <h3
            className={cn(
              "line-clamp-1 flex-1 text-sm font-semibold tracking-tight",
              removeStage && "line-through decoration-red-500 decoration-2 text-zinc-500",
            )}
            title={card.title}
            data-testid={removeStage ? "tile-title-strikethrough" : "tile-title"}
          >
            {card.title}
          </h3>
        )}

        {hasChartConfig && hasData && !titleEditing && (
          <div
            role="group"
            aria-label="View"
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-zinc-200 bg-zinc-100/60 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <button
              type="button"
              aria-pressed={viewMode === "chart"}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                viewMode === "chart"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100",
              )}
              onClick={() => setViewMode("chart")}
            >
              Chart
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "table"}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                viewMode === "table"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100",
              )}
              onClick={() => setViewMode("table")}
            >
              Table
            </button>
          </div>
        )}

        {!titleEditing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onRefresh(card.id)}
              disabled={isRefreshing}
              aria-label="Refresh tile"
            >
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onFullscreen(card.id)}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Tile actions">
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
            <ChartSlot
              cardId={card.id}
              columns={columns}
              stringRows={stringRows}
              dark={dark}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <DataTable columns={columns} rows={rows} />
            </div>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center px-2 text-center text-xs text-zinc-500 dark:text-zinc-400">
            No cached data — refresh to load results.
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-500">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Clock className="size-2.5" />
          {timeAgo(card.cachedAt)}
        </span>
        {hasData && <span className="tabular-nums">{rows.length} rows</span>}
      </div>

      {/* #2365 — remove_card ghost overlay: tinted scrim + banner. */}
      {removeStage && (
        <div
          aria-hidden="true"
          data-testid="ghost-overlay-remove"
          className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center rounded-xl bg-red-50/30 dark:bg-red-950/15"
        >
          <div className="pointer-events-auto m-3 inline-flex items-center gap-2 rounded-md bg-red-600/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
            <Trash2 className="size-3" />
            Staged for removal — accept in chat
          </div>
        </div>
      )}

      {/* #2365 — edit_sql ghost overlay: side-by-side SQL diff. Rendered
          as an absolute-positioned panel so the tile chart underneath
          isn't disturbed. */}
      {editSqlPayload && (
        <div
          data-testid="ghost-overlay-edit-sql"
          className="absolute inset-0 z-10 flex flex-col rounded-xl bg-amber-50/95 px-3 py-2.5 backdrop-blur-sm dark:bg-amber-950/85"
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-900 dark:text-amber-200">
            <Pencil className="size-3" />
            Staged SQL rewrite — accept in chat
          </div>
          <div className="grid min-h-0 flex-1 gap-2 sm:grid-cols-2">
            <div className="flex min-h-0 flex-col">
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Current
              </div>
              <pre
                data-testid="ghost-sql-current"
                className="min-h-0 flex-1 overflow-auto rounded border border-amber-200 bg-white px-1.5 py-1 font-mono text-[11px] text-zinc-800 dark:border-amber-900/40 dark:bg-zinc-950 dark:text-zinc-200"
              >
                {editSqlPayload.currentSql}
              </pre>
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Proposed
              </div>
              <pre
                data-testid="ghost-sql-proposed"
                className="min-h-0 flex-1 overflow-auto rounded border border-amber-200 bg-white px-1.5 py-1 font-mono text-[11px] text-zinc-800 dark:border-amber-900/40 dark:bg-zinc-950 dark:text-zinc-200"
              >
                {editSqlPayload.newSql}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Recharts' ResponsiveContainer renders bars/lines as zero-extent shapes when
// the parent reports 0 width on first measurement. Wait for a real bounding
// box before mounting ResultChart so the chart's first paint sees stable
// dimensions.
function ChartSlot({
  cardId,
  columns,
  stringRows,
  dark,
}: {
  cardId: string;
  columns: string[];
  stringRows: string[][];
  dark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const tryReady = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 80 && r.height > 80) {
        setReady(true);
        return true;
      }
      return false;
    };
    if (tryReady()) return;
    const ro = new ResizeObserver(() => {
      if (tryReady()) ro.disconnect();
    });
    ro.observe(el);
    raf = requestAnimationFrame(() => {
      if (tryReady()) ro.disconnect();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="min-h-0 flex-1 [&>div]:aspect-auto! [&>div]:h-full!">
      {ready && (
        <ResultChart
          key={cardId}
          headers={columns}
          rows={stringRows}
          dark={dark}
        />
      )}
    </div>
  );
}
