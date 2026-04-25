"use client";

import { useEffect, useMemo, useState } from "react";
import {
  GridLayout,
  useContainerWidth,
  noCompactor,
  type Layout,
  type LayoutItem,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { cn } from "@/lib/utils";
import type { DashboardCard, DashboardCardLayout } from "@/ui/lib/types";
import { COLS, ROW_H, GAP, MIN_W, MIN_H, MOBILE_BREAKPOINT } from "./grid-constants";
import { withAutoLayout } from "./auto-layout";
import { DashboardTile } from "./dashboard-tile";

interface DashboardGridProps {
  cards: DashboardCard[];
  editing: boolean;
  refreshingId: string | null;
  onLayoutChange: (cardId: string, layout: DashboardCardLayout) => void;
  onRefresh: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (card: DashboardCard) => void;
  onUpdateTitle: (cardId: string, title: string) => void;
}

export function DashboardGrid({
  cards,
  editing,
  refreshingId,
  onLayoutChange,
  onRefresh,
  onDuplicate,
  onDelete,
  onUpdateTitle,
}: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const placed = useMemo(() => withAutoLayout(cards), [cards]);

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
                onFullscreen={(id) => setFullscreenId((prev) => (prev === id ? null : id))}
                onRefresh={onRefresh}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onUpdateTitle={onUpdateTitle}
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
          compactor={noCompactor}
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
                onFullscreen={(id) => setFullscreenId((prev) => (prev === id ? null : id))}
                onRefresh={onRefresh}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onUpdateTitle={onUpdateTitle}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
