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
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DashboardCard, DashboardCardLayout, KpiComparisonResult, StagedChange } from "@/ui/lib/types";
import type { TileRenderPhase } from "./tile-status";
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
  /**
   * #3213 — cross-filter affordances forwarded per card:
   *   - `incompatibleCardIds`: cards an active filter can't touch — rendered
   *     "Not filtered" + dimmed.
   *   - `selectedValues`: cardId → the active value of that card's drilldown
   *     param, so its matching bar / slice / row renders "selected".
   */
  incompatibleCardIds?: Set<string>;
  selectedValues?: Record<string, string>;
  /**
   * #4321 — per-card render phase for the current parameter / cross-filter
   * batch (or a single-tile retry). Drives each tile's own status (loading /
   * stale / errored). Absent for a card → no render attempted; the tile
   * reflects its persisted snapshot.
   */
  renderPhases?: Record<string, TileRenderPhase>;
  /**
   * #4325 — ids of cards whose post-publish async refresh is still in flight.
   * Each such tile reads `stale` (holding its pre-publish data, labeled with its
   * age) until the refresh lands and the id drops out. Absent → nothing pending.
   */
  pendingRefreshIds?: ReadonlySet<string>;
  /** #4321 — retry a single tile's parameter-bound render (stale / errored). */
  onRetryCard?: (cardId: string) => void;
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
  incompatibleCardIds,
  selectedValues,
  renderPhases,
  pendingRefreshIds,
  onRetryCard,
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

  // #4323 — the fullscreen tile is now a real modal dialog (focus trap + return,
  // backdrop / click-away, aria-modal via Radix). This capture-phase Esc handler
  // still runs FIRST (window capture) so one Esc closes the fullscreen layer and
  // `stopPropagation` keeps the page-level handler from ALSO exiting edit mode —
  // one Esc per layer. Because it stops propagation before Radix's own document
  // listener sees the key, closing stays single-sourced through `setFullscreenId`.
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

  // The card shown in the fullscreen dialog (if any). Resolved from `placed` so
  // it tracks layout/data updates while open.
  const fullscreenCard = fullscreenId
    ? (placed.find((p) => p.id === fullscreenId) ?? null)
    : null;

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
                fullscreen={false}
                isRefreshing={refreshingId === card.id}
                stage={stagesByCardId.get(card.id) ?? null}
                comparison={comparisons?.[card.id] ?? null}
                onDrilldown={onDrilldown}
                incompatible={incompatibleCardIds?.has(card.id)}
                selectedValue={selectedValues?.[card.id]}
                renderPhase={renderPhases?.[card.id]}
                pendingRefresh={pendingRefreshIds?.has(card.id)}
                onRetry={onRetryCard}
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
            <div key={card.id} className="dash-tile-wrapper">
              <DashboardTile
                card={card}
                editing={editing}
                fullscreen={false}
                isRefreshing={refreshingId === card.id}
                stage={stagesByCardId.get(card.id) ?? null}
                comparison={comparisons?.[card.id] ?? null}
                onDrilldown={onDrilldown}
                incompatible={incompatibleCardIds?.has(card.id)}
                selectedValue={selectedValues?.[card.id]}
                renderPhase={renderPhases?.[card.id]}
                pendingRefresh={pendingRefreshIds?.has(card.id)}
                onRetry={onRetryCard}
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

      {/* #4323 — fullscreen tile as a REAL dialog: Radix gives focus trap +
          return, an opaque backdrop with click-away, and aria-modal. The tile
          renders again here (not moved) so the grid underneath keeps its place;
          a Maximize button opens it, the tile's own Exit-fullscreen button /
          Esc / backdrop close it. The dialog is shared — reachable from BOTH
          the desktop grid and the mobile stack, since each wires its tile's
          Maximize to `setFullscreenId`. */}
      <Dialog
        open={!!fullscreenCard}
        onOpenChange={(open) => {
          if (!open) setFullscreenId(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-0 p-3 sm:max-w-[96vw]"
          data-testid="tile-fullscreen-dialog"
        >
          {/* Titles the modal for screen readers without duplicating the tile's
              own visible header. */}
          <DialogTitle className="sr-only">
            {fullscreenCard?.title ?? "Tile"}
          </DialogTitle>
          {fullscreenCard && (
            <div className="min-h-0 flex-1">
              <DashboardTile
                card={fullscreenCard}
                editing={false}
                fullscreen
                isRefreshing={refreshingId === fullscreenCard.id}
                stage={stagesByCardId.get(fullscreenCard.id) ?? null}
                comparison={comparisons?.[fullscreenCard.id] ?? null}
                onDrilldown={onDrilldown}
                incompatible={incompatibleCardIds?.has(fullscreenCard.id)}
                selectedValue={selectedValues?.[fullscreenCard.id]}
                renderPhase={renderPhases?.[fullscreenCard.id]}
                pendingRefresh={pendingRefreshIds?.has(fullscreenCard.id)}
                onRetry={onRetryCard}
                onFullscreen={(id) => setFullscreenId((prev) => (prev === id ? null : id))}
                onRefresh={onRefresh}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onUpdateTitle={onUpdateTitle}
                onExportCsv={onExportCsv}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
