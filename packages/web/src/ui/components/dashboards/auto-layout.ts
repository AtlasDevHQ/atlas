import type { DashboardCard, DashboardCardLayout } from "@/ui/lib/types";
import { COLS, DEFAULT_TILE_H, DEFAULT_TILE_W } from "./grid-constants";

/**
 * Cards with a stored layout keep it. The rest waterfall into a 2-col grid
 * below every already-placed tile (left/right halves share a row), never
 * overlapping a stored layout.
 */
export function withAutoLayout(cards: DashboardCard[]): Array<DashboardCard & { resolvedLayout: DashboardCardLayout }> {
  const sorted = cards.toSorted((a, b) => a.position - b.position);
  const placed: Array<DashboardCard & { resolvedLayout: DashboardCardLayout }> = [];
  const half = Math.floor(COLS / 2);
  let pairStartY = 0;
  let unplacedInRun = 0;

  for (const card of sorted) {
    if (card.layout) {
      placed.push({ ...card, resolvedLayout: card.layout });
      unplacedInRun = 0;
      continue;
    }

    let resolvedLayout: DashboardCardLayout;
    if (unplacedInRun % 2 === 0) {
      const taken = placed.map((p) => p.resolvedLayout);
      pairStartY = taken.length === 0 ? 0 : Math.max(...taken.map((l) => l.y + l.h));
      resolvedLayout = { x: 0, y: pairStartY, w: half, h: DEFAULT_TILE_H };
    } else {
      resolvedLayout = { x: half, y: pairStartY, w: half, h: DEFAULT_TILE_H };
    }
    unplacedInRun++;
    placed.push({ ...card, resolvedLayout });
  }

  return placed;
}

export function nextTileLayout(existing: DashboardCardLayout[]): DashboardCardLayout {
  if (existing.length === 0) return { x: 0, y: 0, w: DEFAULT_TILE_W, h: DEFAULT_TILE_H };
  const maxY = Math.max(...existing.map((l) => l.y + l.h));
  return { x: 0, y: maxY, w: DEFAULT_TILE_W, h: DEFAULT_TILE_H };
}
