"use client";

import { useEffect, useState } from "react";
import {
  GridLayout,
  useContainerWidth,
  verticalCompactor,
  type Layout,
  type LayoutItem,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { cn } from "@/lib/utils";
import type { DashboardCard, DashboardCardLayout, KpiComparisonResult, StagedChange } from "@/ui/lib/types";
import { COLS, ROW_H, GAP, MIN_W, MIN_H, MOBILE_BREAKPOINT } from "./grid-constants";
import { withAutoLayout } from "./auto-layout";
import { DashboardTile } from "./dashboard-tile";

interface DashboardGridProps {
  cards: DashboardCard[];
  editing: boolean;
  refreshingId: string | null;
  /**
   * #2365 — per-user pending destructive stages. Drives the ghost
   * overlay: cards with a `remove_card` stage render with a
   * strikethrough banner; cards with an `edit_sql` stage render a
   * side-by-side SQL diff overlay. Per-user list comes from
   * `/api/v1/dashboards/[id]/stage`.
   */
  stages?: StagedChange[];
  /**
   * #3137 — per-card KPI comparison query results, keyed by card id. Fed to a
   * `kpi` tile so it can render the delta chip. Non-KPI cards ignore it.
   */
  comparisons?: Record<string, KpiComparisonResult | null>;
  /**
   * #3212 — click-to-drilldown. Forwarded to each tile; called with a card's
   * drilldown target parameter key + the clicked category value. Undefined →
   * cards are inert on click.
   */
  onDrilldown?: (targetParam: string, value: string) => void;
  onLayoutChange: (cardId: string, layout: DashboardCardLayout) => void;
  onRefresh: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (card: DashboardCard) => void;
  onUpdateTitle: (cardId: string, title: string) => void;
  /**
   * #3210 — export a card's current parameter-bound result as CSV. Forwarded to
   * each SQL-backed tile's menu; text tiles never surface it.
   */
  onExportCsv?: (card: DashboardCard) => void;
}

export function DashboardGrid({
  cards,
  editing,
  refreshingId,
  stages,
  comparisons,
  onDrilldown,
  onLayoutChange,
  onRefresh,
  onDuplicate,
  onDelete,
  onUpdateTitle,
  onExportCsv,
}: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  // React Compiler memoizes pure derives; manual useMemo was forbidden
  // by CLAUDE.md for perf-only cases.
  const placed = withAutoLayout(cards);
  // Index stages by cardId. A single card can have multiple stages in
  // pathological cases (agent staged delete + the user clarified, agent
  // restaged a SQL edit). The most-recently-staged pending one wins
  // for overlay purposes — a definitive resolution flips one specific
  // stage, the rest stay visible until they're individually accepted
  // or discarded. The overlay reflects current intent.
  const stagesByCardId = new Map<string, StagedChange>();
  for (const s of stages ?? []) {
    if (s.status !== "pending") continue;
    const cardId = (s.payload as { cardId?: string }).cardId;
    if (!cardId) continue;
    const existing = stagesByCardId.get(cardId);
    if (!existing || existing.createdAt < s.createdAt) {
      stagesByCardId.set(cardId, s);
    }
  }

  // Esc must exit fullscreen *before* the page-level handler exits edit mode,
  // so the user gets one Esc per dialog-like layer.
  useEffect(() => {
    if (!fullscreenId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setFullscreenId(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [fullscreenId]);

  const layout: Layout = placed.map((p) => ({
    i: p.id,
    x: p.resolvedLayout.x,
    y: p.resolvedLayout.y,
    w: p.resolvedLayout.w,
    h: p.resolvedLayout.h,
    minW: MIN_W,
    minH: MIN_H,
    maxW: COLS,
  }));

  // Commit layout changes once per gesture (mouse-up / resize-stop) instead of
  // streaming every intermediate position through `onLayoutChange`. RGL handles
  // its own visual feedback during the drag via its internal placeholder, so
  // the parent only needs the final coordinates. This collapses N PATCHes per
  // drag down to 1 and removes the cascade that previously produced React
  // error #185 ("Maximum update depth exceeded") in production.
  function handleRGLDragOrResizeStop(
    _layout: Layout,
    _oldItem: LayoutItem | null,
    newItem: LayoutItem | null,
  ) {
    if (!newItem) return;
    const before = placed.find((p) => p.id === newItem.i);
    if (!before) return;
    const cur = before.resolvedLayout;
    if (
      newItem.x === cur.x
      && newItem.y === cur.y
      && newItem.w === cur.w
      && newItem.h === cur.h
    ) return;
    onLayoutChange(newItem.i, { x: newItem.x, y: newItem.y, w: newItem.w, h: newItem.h });
  }

  if (placed.length === 0) return null;

  const isMobile = mounted && width > 0 && width < MOBILE_BREAKPOINT;

  return (
    <div
      ref={containerRef}
      className={cn("dashboard-app relative flex-1", editing && "is-editing")}
    >
      {isMobile && (
        <div className="flex flex-col gap-3">
          {placed.map((card) => (
            <div
              key={card.id}
              className="dash-mobile-tile"
              style={{ height: card.resolvedLayout.h * ROW_H }}
            >
              <DashboardTile
                card={card}
                editing={false}
                fullscreen={fullscreenId === card.id}
                isRefreshing={refreshingId === card.id}
                stage={stagesByCardId.get(card.id) ?? null}
                comparison={comparisons?.[card.id] ?? null}
                onDrilldown={onDrilldown}
                onFullscreen={(id) => setFullscreenId((prev) => (prev === id ? null : id))}
                onRefresh={onRefresh}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onUpdateTitle={onUpdateTitle}
                onExportCsv={onExportCsv}
              />
            </div>
          ))}
        </div>
      )}
      {mounted && width > 0 && !isMobile && (
        <GridLayout
          layout={layout}
          width={width}
          gridConfig={{
            cols: COLS,
            rowHeight: ROW_H,
            margin: [GAP, GAP],
            containerPadding: [GAP / 2, GAP / 2],
            maxRows: Number.POSITIVE_INFINITY,
          }}
          dragConfig={{
            enabled: editing,
            bounded: false,
            handle: ".dash-drag-handle",
            cancel: "button, input, [role='button']",
          }}
          resizeConfig={{ enabled: editing, handles: ["e", "s", "se"] }}
          compactor={verticalCompactor}
          onDragStop={handleRGLDragOrResizeStop}
          onResizeStop={handleRGLDragOrResizeStop}
        >
          {placed.map((card) => (
            <div
              key={card.id}
              className={cn(
                "dash-tile-wrapper",
                fullscreenId === card.id && "is-fullscreen",
              )}
            >
              <DashboardTile
                card={card}
                editing={editing}
                fullscreen={fullscreenId === card.id}
                isRefreshing={refreshingId === card.id}
                stage={stagesByCardId.get(card.id) ?? null}
                comparison={comparisons?.[card.id] ?? null}
                onDrilldown={onDrilldown}
                onFullscreen={(id) => setFullscreenId((prev) => (prev === id ? null : id))}
                onRefresh={onRefresh}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onUpdateTitle={onUpdateTitle}
                onExportCsv={onExportCsv}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
