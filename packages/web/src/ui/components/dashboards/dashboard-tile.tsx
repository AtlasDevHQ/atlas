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
  FilterX,
  Download,
  AlertTriangle,
  Inbox,
  CircleDashed,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DataTable } from "@/ui/components/chat/data-table";
import { Markdown } from "@/ui/components/chat/markdown";
import { KpiCard } from "./kpi-card";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { cn } from "@/lib/utils";
import { timeAgo } from "./time-ago";
import {
  resolveTileStatus,
  tileCaptionTone,
  statusShowsData,
  statusCanRetry,
  type TileStatus,
  type TileRenderPhase,
  type CaptionTone,
} from "./tile-status";
import type { DashboardCard, DashboardChartConfig, KpiComparisonResult, StagedChange } from "@/ui/lib/types";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/50" /> },
);

function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

/** #4321 — text colour for the age caption per tone. Muted → amber → red. */
const TONE_TEXT: Record<CaptionTone, string> = {
  muted: "text-zinc-500 dark:text-zinc-500",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

/**
 * #4321 — the distinct body placeholders for the non-data tile states. `errored`,
 * `empty`, and `never-run` are three visually distinct treatments (icon + copy +
 * colour) so a blank tile always explains WHY it's blank; `loading` is a spinner.
 * `onRetry` (present for `errored`) offers a one-click re-render.
 */
function TileStatePlaceholder({
  status,
  onRetry,
}: {
  status: TileStatus;
  onRetry?: () => void;
}) {
  if (status === "loading") {
    return (
      <div
        className="flex flex-1 items-center justify-center gap-2 px-2 text-center text-xs text-zinc-500 dark:text-zinc-400"
        data-testid="tile-state-loading"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }
  if (status === "errored") {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-2 text-center text-xs text-red-600 dark:text-red-400"
        data-testid="tile-state-errored"
      >
        <AlertTriangle className="size-5" aria-hidden="true" />
        <span>Couldn&rsquo;t load this tile.</span>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 border-red-300 px-2 text-[11px] text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30"
            onClick={onRetry}
            data-testid="tile-state-errored-retry"
          >
            <RefreshCw className="size-2.5" aria-hidden="true" />
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (status === "empty") {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-1.5 px-2 text-center text-xs text-zinc-500 dark:text-zinc-400"
        data-testid="tile-state-empty"
      >
        <Inbox className="size-5" aria-hidden="true" />
        <span>No rows match.</span>
      </div>
    );
  }
  // never-run
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-1.5 px-2 text-center text-xs text-zinc-400 dark:text-zinc-500"
      data-testid="tile-state-never-run"
    >
      <CircleDashed className="size-5" aria-hidden="true" />
      <span>Never run — refresh to load results.</span>
    </div>
  );
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
  /**
   * #3137 — KPI comparison query result for a `kpi` card, fetched view-time via
   * the `/render` endpoint. `null`/undefined → the delta chip is omitted.
   * Ignored by non-KPI tiles.
   */
  comparison?: KpiComparisonResult | null;
  /**
   * #3212 — click-to-drilldown. Called with the card's drilldown target
   * parameter key + the clicked category value when a data point (bar / line /
   * area / pie slice, or a table row) is clicked on a card that declares
   * `chartConfig.drilldown`. Omitted / unset → the card is inert on click.
   */
  onDrilldown?: (targetParam: string, value: string) => void;
  /**
   * #3213 — cross-filter affordances.
   *   - `incompatible`: an active cross-filter binds none of this card's SQL
   *     params, so the filter can't change it — the tile is marked "Not filtered"
   *     and dimmed so the unchanged result reads as intentional.
   *   - `selectedValue`: the active value of THIS card's drilldown target param,
   *     so the matching bar / slice / row renders "selected" (re-clicking it
   *     deselects). Undefined → nothing is marked.
   */
  incompatible?: boolean;
  selectedValue?: string;
  /**
   * #4321 — phase of this tile's CURRENT parameter / cross-filter render (or a
   * single-tile retry). Drives the tile's own status: `loading` while a render
   * is in flight, `error` when a parameter update FAILED (the tile then stays
   * labeled-stale with its data's age instead of silently reverting to the old
   * unfiltered number), `ok` once a fresh render lands. Undefined → no render
   * attempted this session; the tile reflects its persisted snapshot.
   */
  renderPhase?: TileRenderPhase;
  /**
   * #4325 — a publish just promoted this card's new SQL/config and an async
   * refresh is in flight; the tile still holds its pre-publish cache. While true
   * the tile reads `stale` (old data, labeled with its age) instead of `fresh`,
   * until the refreshed data lands. Undefined/false → not awaiting a refresh.
   */
  pendingRefresh?: boolean;
  /**
   * #4321 — one-click retry for a `stale` / `errored` tile: re-runs THIS card's
   * render with the current parameters. Distinct from `onRefresh` (which
   * re-executes and persists the card cache when not editing) — retry is the
   * ephemeral, parameter-aware re-render. Undefined → the retry affordance is
   * hidden.
   */
  onRetry?: (cardId: string) => void;
  onFullscreen: (cardId: string) => void;
  onRefresh: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (card: DashboardCard) => void;
  onUpdateTitle: (cardId: string, title: string) => void;
  /**
   * #3210 — export this card's current parameter-bound result as CSV. Wired
   * only on SQL-backed tiles (chart / table / kpi); a text card never receives
   * it (it has no tabular data). Undefined → the menu item is hidden.
   */
  onExportCsv?: (card: DashboardCard) => void;
}

/**
 * #3212 — pull the drilldown value out of a clicked table row: the cell in the
 * card's configured `categoryColumn`. Returns null when the column is unset or
 * the cell is empty (the row is then inert), so a table card without a usable
 * category column can't fire a no-op drilldown.
 */
function drilldownValueFromRow(
  row: Record<string, unknown> | unknown[],
  categoryColumn: string,
): string | null {
  if (!categoryColumn || Array.isArray(row)) return null;
  const value = row[categoryColumn];
  if (value == null || value === "") return null;
  return String(value);
}

/**
 * Tile dispatcher (#3138). A `text` / section-block card renders markdown with
 * no chart, data fetch, or refresh chrome; everything else is a SQL-backed
 * chart tile. Kept hook-free so each concrete tile owns a stable hook order.
 */
export function DashboardTile(props: DashboardTileProps) {
  if (props.card.kind === "text") return <TextTile {...props} />;
  return <ChartTile {...props} />;
}

function ChartTile({
  card,
  editing,
  fullscreen,
  isRefreshing,
  stage,
  comparison,
  onDrilldown,
  incompatible,
  selectedValue,
  renderPhase,
  pendingRefresh,
  onRetry,
  onFullscreen,
  onRefresh,
  onDuplicate,
  onDelete,
  onUpdateTitle,
  onExportCsv,
}: DashboardTileProps) {
  const dark = useDarkMode();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(card.title);

  // #3137 — a KPI card renders the compact <KpiCard> body instead of a
  // chart/table; it has no Chart/Table toggle (the big number IS the view).
  const isKpi = card.chartConfig?.type === "kpi";
  const hasChartConfig = !!card.chartConfig && card.chartConfig.type !== "table" && !isKpi;
  const [viewMode, setViewMode] = useState<ViewMode>(hasChartConfig ? "chart" : "table");

  const columns = card.cachedColumns ?? [];
  const rows = (card.cachedRows ?? []) as Record<string, unknown>[];
  const hasData = columns.length > 0 && rows.length > 0;
  const stringRows = hasData ? toStringRows(columns, rows) : [];

  // #4321 — the tile is the unit of trust: resolve THIS tile's own status from
  // its render phase + the data it currently holds, and drive the age caption's
  // colour + a subtle body dim off it. A failed parameter update surfaces as
  // `stale` (keep the old data, labeled with its age, + retry) or `errored`
  // (never had data) — never a silent revert, never a page banner.
  const everRun = card.cachedAt != null || renderPhase === "ok";
  const status: TileStatus = resolveTileStatus({ renderPhase, hasData, everRun, pendingRefresh });
  const captionTone = tileCaptionTone(status, card.cachedAt);
  // `stale`/`loading` keep rendering the retained data body, but dimmed so the
  // viewer reads it as "not the current filtered result".
  const showData = hasData && (statusShowsData(status) || status === "loading");
  const dimBody = incompatible || status === "stale" || status === "loading";
  // `canRetry` gates the errored PLACEHOLDER's retry (its body is the error
  // state); the footer retry is for `stale` only — a stale tile shows its data
  // body, so its retry lives in the footer. Split so an errored tile never
  // renders two retry buttons (placeholder + footer).
  const canRetry = statusCanRetry(status) && !!onRetry;
  const footerRetry = status === "stale" && !!onRetry;

  // #3212 — click-to-drilldown. A card that declares `chartConfig.drilldown`
  // forwards the clicked category value to its target parameter. Disabled while
  // editing (the chart body is a drag surface then) and on KPI cards (a single
  // number has no category to drill into). The inline `drilldownParam !== null`
  // and `onDrilldown` checks narrow both — `const` narrowing flows into the
  // handler closures, so no non-null assertions are needed.
  const drilldownParam = card.chartConfig?.drilldown?.targetParam ?? null;
  const categoryColumn = card.chartConfig?.categoryColumn ?? "";
  const drillEnabled = !editing && !isKpi;
  const onCategoryClick =
    drillEnabled && drilldownParam !== null && onDrilldown
      ? (value: string, categoryKey: string) => {
          // Only bind when the clicked chart axis IS the card's configured
          // drilldown column. ResultChart re-detects the chart from the data, so
          // a divergent category axis would otherwise set the parameter from the
          // wrong column; gating keeps the chart path consistent with the table
          // path (which reads `categoryColumn` directly). (#3212, Codex review.)
          if (categoryColumn && categoryKey === categoryColumn) {
            onDrilldown(drilldownParam, value);
          }
        }
      : undefined;
  const onRowClick =
    drillEnabled && drilldownParam !== null && onDrilldown && categoryColumn
      ? (row: Record<string, unknown> | unknown[]) => {
          const value = drilldownValueFromRow(row, categoryColumn);
          if (value != null) onDrilldown(drilldownParam, value);
        }
      : undefined;

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
      data-filter-incompatible={incompatible ? "true" : undefined}
      data-tile-status={status}
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

        {incompatible && !titleEditing && (
          <Badge
            variant="outline"
            data-testid="tile-not-filtered"
            className="shrink-0 gap-1 border-zinc-200 px-1.5 py-0 text-[10px] font-normal text-zinc-400 dark:border-zinc-700 dark:text-zinc-500"
            title="No active filter binds this card's query"
          >
            <FilterX className="size-3" aria-hidden="true" />
            Not filtered
          </Badge>
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
                {/* #3210 — export the card's current parameter-bound result as
                    CSV. Disabled until the tile has rendered rows to export. */}
                {onExportCsv && (
                  <DropdownMenuItem onSelect={() => onExportCsv(card)} disabled={!hasData}>
                    <Download className="mr-2 size-3.5" />
                    Download CSV
                  </DropdownMenuItem>
                )}
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

      <div
        className={cn(
          "dash-tile-body relative flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-2.5",
          // #3213 / #4321 — dim the body when the shown data is NOT the current
          // filtered result: an active cross-filter that can't touch this card
          // (incompatible), a failed update we're keeping labeled-stale, or a
          // render in flight. A subtle dim, never a full-tile overlay.
          dimBody && "opacity-60",
        )}
      >
        {showData ? (
          isKpi ? (
            <KpiCard card={card} comparison={comparison} />
          ) : viewMode === "chart" && hasChartConfig ? (
            <ChartSlot
              cardId={card.id}
              columns={columns}
              stringRows={stringRows}
              dark={dark}
              onCategoryClick={onCategoryClick}
              selectedCategory={selectedValue}
              thresholds={card.chartConfig?.thresholds}
              annotations={card.annotations}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <DataTable
                columns={columns}
                rows={rows}
                onRowClick={onRowClick}
                selectedColumn={categoryColumn || undefined}
                selectedValue={selectedValue}
              />
            </div>
          )
        ) : (
          // #4321 — errored ≠ empty ≠ never-run ≠ loading: three (four) visually
          // distinct placeholders, so a blank tile always says WHY it's blank.
          <TileStatePlaceholder status={status} onRetry={canRetry ? () => onRetry?.(card.id) : undefined} />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-100 px-3 py-1.5 text-[11px] dark:border-zinc-800/80">
        {/* #4321 — the color-shifting age caption: muted → amber → red as the
            shown data ages, plus a `Stale` / `Failed` label so a board with one
            stale tile reads as one amber caption. */}
        <span
          className={cn("inline-flex items-center gap-1 tabular-nums", TONE_TEXT[captionTone])}
          data-testid="tile-age-caption"
          data-caption-tone={captionTone}
        >
          <Clock className="size-2.5" aria-hidden="true" />
          {status === "stale" && <span className="font-medium">Stale · </span>}
          {status === "errored" && <span className="font-medium">Failed</span>}
          {status !== "errored" && timeAgo(card.cachedAt)}
        </span>
        <span className="flex items-center gap-2">
          {footerRetry && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-5 gap-1 px-1.5 text-[11px]",
                captionTone === "red"
                  ? "text-red-600 hover:text-red-700 dark:text-red-400"
                  : "text-amber-600 hover:text-amber-700 dark:text-amber-400",
              )}
              onClick={() => onRetry?.(card.id)}
              data-testid="tile-retry"
            >
              <RefreshCw className="size-2.5" aria-hidden="true" />
              Retry
            </Button>
          )}
          {hasData && !isKpi && (
            <span className="tabular-nums text-zinc-500 dark:text-zinc-500">{rows.length} rows</span>
          )}
        </span>
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

/**
 * #3138 — a text / section-block tile. Renders the card's markdown SANITIZED
 * via the shared chat `<Markdown>` (react-markdown, no `rehype-raw`, so raw
 * HTML is never evaluated). No data fetch, no chart, no refresh/fullscreen
 * chrome — just a drag handle + remove/duplicate in edit mode. Participates in
 * the same 24-col grid as every other tile.
 */
function TextTile({ card, editing, onDelete }: DashboardTileProps) {
  return (
    <div
      data-card-kind="text"
      className={cn(
        "dash-tile dash-text-tile group/text relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100",
        "hover:border-zinc-300 dark:hover:border-zinc-700",
      )}
    >
      {editing && (
        // Section blocks support drag-to-reorder + remove in edit mode. They
        // intentionally omit Duplicate: copying a card POSTs to the chart-only
        // REST `addCard` endpoint (sql + chartConfig), which a text card has
        // neither of — text-card duplication is a separate follow-up.
        <div className="dash-drag-handle flex shrink-0 cursor-grab items-center gap-2 border-b border-zinc-100 px-3 py-1.5 active:cursor-grabbing dark:border-zinc-800/80">
          <span aria-hidden className="flex items-center text-zinc-400 dark:text-zinc-500">
            <GripVertical className="size-3.5" />
          </span>
          <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Text
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
            onClick={() => onDelete(card)}
            aria-label="Remove tile"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}

      <div className="dash-text-tile-body min-h-0 flex-1 overflow-auto px-4 py-3 text-sm leading-relaxed">
        {/* disallowImages: a section header has no need for images, and blocking
            them closes the same tracking-pixel vector as the shared view. */}
        <Markdown content={card.content ?? ""} disallowImages />
      </div>
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
  onCategoryClick,
  selectedCategory,
  thresholds,
  annotations,
}: {
  cardId: string;
  columns: string[];
  stringRows: string[][];
  dark: boolean;
  /** #3212 — forwarded to ResultChart; undefined → chart is inert on click. */
  onCategoryClick?: (value: string, categoryKey: string) => void;
  /** #3213 — forwarded to ResultChart; the active cross-filter's category value. */
  selectedCategory?: string;
  /** #3208 — goal lines from the card's chartConfig; undefined → none drawn. */
  thresholds?: DashboardChartConfig["thresholds"];
  /** #3209 — event annotations from the card; vertical markers on line/area only. */
  annotations?: DashboardCard["annotations"];
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
          onCategoryClick={onCategoryClick}
          selectedCategory={selectedCategory}
          thresholds={thresholds}
          annotations={annotations}
        />
      )}
    </div>
  );
}
