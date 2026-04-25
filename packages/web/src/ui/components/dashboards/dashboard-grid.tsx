"use client";

import { useMemo, useState } from "react";
import {
  GridLayout,
  useContainerWidth,
  noCompactor,
  type Layout,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardCard, DashboardCardLayout } from "@/ui/lib/types";
import { COLS, ROW_H, GAP, MIN_W, MIN_H } from "./grid-constants";
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

  function handleRGLLayoutChange(next: Layout) {
    for (const item of next) {
      const before = placed.find((p) => p.id === item.i);
      if (!before) continue;
      const cur = before.resolvedLayout;
      if (item.x !== cur.x || item.y !== cur.y || item.w !== cur.w || item.h !== cur.h) {
        onLayoutChange(item.i, { x: item.x, y: item.y, w: item.w, h: item.h });
      }
    }
  }

  return (
    <div ref={containerRef} className="dashboard-app relative flex-1">
      {placed.length === 0 ? (
        <EmptyCanvas editing={editing} />
      ) : mounted && width > 0 ? (
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
          onLayoutChange={handleRGLLayoutChange}
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
      ) : null}
    </div>
  );
}

function EmptyCanvas({ editing }: { editing: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
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
  );
}
