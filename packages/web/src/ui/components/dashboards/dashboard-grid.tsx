"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardCard, DashboardCardLayout } from "@/ui/lib/types";
import { COLS, ROW_H, GAP, MIN_W, MIN_H } from "./grid-constants";
import { withAutoLayout } from "./auto-layout";
import { DashboardTile } from "./dashboard-tile";

type Density = "compact" | "comfortable" | "spacious";

interface DashboardGridProps {
  cards: DashboardCard[];
  editing: boolean;
  density: Density;
  refreshingId: string | null;
  onLayoutChange: (cardId: string, layout: DashboardCardLayout) => void;
  onRefresh: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (card: DashboardCard) => void;
  onUpdateTitle: (cardId: string, title: string) => void;
}

interface PxRect { x: number; y: number; w: number; h: number }

interface DragState {
  cardId: string;
  startMouse: { x: number; y: number };
  startPx: PxRect;
}

interface ResizeState {
  cardId: string;
  dir: "e" | "s" | "se";
  startMouse: { x: number; y: number };
  startPx: PxRect;
}

function useGridMetrics(canvasRef: React.RefObject<HTMLDivElement | null>) {
  const [metrics, setMetrics] = useState({ colW: 60, width: 1200 });
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const update = () => {
      const w = node.getBoundingClientRect().width;
      setMetrics({ colW: w / COLS, width: w });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [canvasRef]);
  return metrics;
}

function toPx(layout: DashboardCardLayout, colW: number): PxRect {
  return {
    x: layout.x * colW + GAP / 2,
    y: layout.y * ROW_H + GAP / 2,
    w: layout.w * colW - GAP,
    h: layout.h * ROW_H - GAP,
  };
}

export function DashboardGrid({
  cards,
  editing,
  density,
  refreshingId,
  onLayoutChange,
  onRefresh,
  onDuplicate,
  onDelete,
  onUpdateTitle,
}: DashboardGridProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const metrics = useGridMetrics(canvasRef);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [livePx, setLivePx] = useState<Record<string, PxRect>>({});
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);

  const placed = useMemo(() => withAutoLayout(cards), [cards]);

  // Mouse-move + mouse-up handlers — only mounted while a drag/resize is active.
  useEffect(() => {
    if (!drag && !resize) return;

    const onMove = (e: MouseEvent) => {
      if (drag) {
        const dx = e.clientX - drag.startMouse.x;
        const dy = e.clientY - drag.startMouse.y;
        const nx = Math.max(GAP / 2, drag.startPx.x + dx);
        const ny = Math.max(GAP / 2, drag.startPx.y + dy);
        setLivePx((prev) => ({ ...prev, [drag.cardId]: { ...drag.startPx, x: nx, y: ny } }));
      }
      if (resize) {
        const dx = e.clientX - resize.startMouse.x;
        const dy = e.clientY - resize.startMouse.y;
        const { x, y } = resize.startPx;
        let { w, h } = resize.startPx;
        if (resize.dir.includes("e")) w = Math.max(metrics.colW * MIN_W - GAP, w + dx);
        if (resize.dir.includes("s")) h = Math.max(ROW_H * MIN_H - GAP, h + dy);
        setLivePx((prev) => ({ ...prev, [resize.cardId]: { x, y, w, h } }));
      }
    };

    const onUp = () => {
      if (drag) {
        const cur = livePx[drag.cardId] || drag.startPx;
        const card = placed.find((p) => p.id === drag.cardId);
        if (card) {
          const gx = Math.max(0, Math.min(COLS - 1, Math.round(cur.x / metrics.colW)));
          const gy = Math.max(0, Math.round(cur.y / ROW_H));
          const next: DashboardCardLayout = {
            ...card.resolvedLayout,
            x: Math.min(gx, COLS - card.resolvedLayout.w),
            y: gy,
          };
          if (next.x !== card.resolvedLayout.x || next.y !== card.resolvedLayout.y) {
            onLayoutChange(drag.cardId, next);
          }
        }
        setDrag(null);
      }
      if (resize) {
        const cur = livePx[resize.cardId] || resize.startPx;
        const card = placed.find((p) => p.id === resize.cardId);
        if (card) {
          const gw = Math.max(MIN_W, Math.round((cur.w + GAP) / metrics.colW));
          const gh = Math.max(MIN_H, Math.round((cur.h + GAP) / ROW_H));
          const next: DashboardCardLayout = {
            ...card.resolvedLayout,
            w: Math.min(gw, COLS - card.resolvedLayout.x),
            h: gh,
          };
          if (next.w !== card.resolvedLayout.w || next.h !== card.resolvedLayout.h) {
            onLayoutChange(resize.cardId, next);
          }
        }
        setResize(null);
      }
      setLivePx({});
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, resize, metrics, placed, livePx, onLayoutChange]);

  const onDragStart = (e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    const card = placed.find((p) => p.id === cardId);
    if (!card) return;
    const px = toPx(card.resolvedLayout, metrics.colW);
    setDrag({ cardId, startMouse: { x: e.clientX, y: e.clientY }, startPx: px });
  };

  const onResizeStart = (e: React.MouseEvent, cardId: string, dir: "e" | "s" | "se") => {
    e.preventDefault();
    e.stopPropagation();
    const card = placed.find((p) => p.id === cardId);
    if (!card) return;
    const px = toPx(card.resolvedLayout, metrics.colW);
    setResize({ cardId, dir, startMouse: { x: e.clientX, y: e.clientY }, startPx: px });
  };

  const onFullscreen = (cardId: string) =>
    setFullscreenId((prev) => (prev === cardId ? null : cardId));

  const totalRows = Math.max(18, ...placed.map((p) => p.resolvedLayout.y + p.resolvedLayout.h)) + 2;
  const canvasStyle = {
    height: totalRows * ROW_H,
    "--dash-row-h": `${ROW_H}px`,
  } as React.CSSProperties;

  return (
    <div
      className={cn(
        "dashboard-app relative flex-1",
        `dash-density-${density}`,
        drag && "is-dragging",
        resize && "is-resizing",
      )}
    >
      <div ref={canvasRef} className={cn("dash-canvas", editing && "editing")} style={canvasStyle}>
        {editing && <div className="dash-row-guides" />}

        {placed.map((card) => {
          const px = toPx(card.resolvedLayout, metrics.colW);
          const live = livePx[card.id];
          const rect = live ?? px;
          const isDragging = drag?.cardId === card.id;
          const isResizing = resize?.cardId === card.id;

          let ghost: { left: number; top: number; width: number; height: number } | null = null;
          if (isDragging) {
            const gx = Math.max(0, Math.min(COLS - 1, Math.round(rect.x / metrics.colW)));
            const gy = Math.max(0, Math.round(rect.y / ROW_H));
            const gw = Math.min(card.resolvedLayout.w, COLS - gx);
            ghost = {
              left: gx * metrics.colW + GAP / 2,
              top: gy * ROW_H + GAP / 2,
              width: gw * metrics.colW - GAP,
              height: card.resolvedLayout.h * ROW_H - GAP,
            };
          } else if (isResizing) {
            const gw = Math.max(MIN_W, Math.min(COLS - card.resolvedLayout.x, Math.round((rect.w + GAP) / metrics.colW)));
            const gh = Math.max(MIN_H, Math.round((rect.h + GAP) / ROW_H));
            ghost = {
              left: card.resolvedLayout.x * metrics.colW + GAP / 2,
              top: card.resolvedLayout.y * ROW_H + GAP / 2,
              width: gw * metrics.colW - GAP,
              height: gh * ROW_H - GAP,
            };
          }

          return (
            <div key={card.id}>
              {ghost && (
                <div
                  className="dash-drag-ghost"
                  style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}
                />
              )}
              <DashboardTile
                card={card}
                pxRect={rect}
                editing={editing}
                dragging={isDragging}
                resizing={isResizing}
                fullscreen={fullscreenId === card.id}
                isRefreshing={refreshingId === card.id}
                onDragStart={onDragStart}
                onResizeStart={onResizeStart}
                onFullscreen={onFullscreen}
                onRefresh={onRefresh}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onUpdateTitle={onUpdateTitle}
              />
            </div>
          );
        })}

        {placed.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              An empty canvas
            </div>
            <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
              Run a query in chat and click <span className="font-medium">Add to Dashboard</span> to drop your first tile here.
            </p>
            {editing && (
              <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                <Keyboard className="size-3" />
                Press <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:border-zinc-700 dark:bg-zinc-900">E</kbd> to exit edit mode
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
