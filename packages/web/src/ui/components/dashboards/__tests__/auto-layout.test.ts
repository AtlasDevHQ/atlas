import { describe, expect, test } from "bun:test";
import type { DashboardCard } from "@/ui/lib/types";
import { nextTileLayout, withAutoLayout } from "../auto-layout";

const DEFAULT_CARD: Omit<DashboardCard, "id" | "position" | "layout"> = {
  dashboardId: "d1",
  title: "Untitled",
  sql: "SELECT 1",
  chartConfig: null,
  cachedColumns: null,
  cachedRows: null,
  cachedAt: null,
  connectionId: null,
  createdAt: "2026-04-25T00:00:00Z",
  updatedAt: "2026-04-25T00:00:00Z",
};

function card(overrides: Partial<DashboardCard> & { id: string; position: number }): DashboardCard {
  return { ...DEFAULT_CARD, layout: null, ...overrides };
}

describe("withAutoLayout", () => {
  test("preserves existing layouts verbatim", () => {
    const result = withAutoLayout([
      card({ id: "a", position: 0, layout: { x: 5, y: 7, w: 8, h: 9 } }),
    ]);
    expect(result[0].resolvedLayout).toEqual({ x: 5, y: 7, w: 8, h: 9 });
  });

  test("places never-positioned cards into a 2-col waterfall", () => {
    const result = withAutoLayout([
      card({ id: "a", position: 0 }),
      card({ id: "b", position: 1 }),
      card({ id: "c", position: 2 }),
    ]);
    expect(result.map((r) => r.resolvedLayout)).toEqual([
      { x: 0, y: 0, w: 12, h: 10 },
      { x: 12, y: 0, w: 12, h: 10 },
      { x: 0, y: 10, w: 12, h: 10 },
    ]);
  });

  test("auto-placed cards never collide with stored layouts", () => {
    const result = withAutoLayout([
      card({ id: "stored", position: 0, layout: { x: 0, y: 0, w: 24, h: 12 } }),
      card({ id: "new", position: 1 }),
    ]);
    // Stored tile reserves rows 0..11 → newcomer must start at y >= 12.
    expect(result[1].resolvedLayout.y).toBeGreaterThanOrEqual(12);
  });

  test("respects position order regardless of input order", () => {
    const result = withAutoLayout([
      card({ id: "second", position: 5 }),
      card({ id: "first", position: 1 }),
    ]);
    expect(result.map((r) => r.id)).toEqual(["first", "second"]);
  });
});

describe("nextTileLayout", () => {
  test("places the very first tile at the origin at default size", () => {
    expect(nextTileLayout([])).toEqual({ x: 0, y: 0, w: 12, h: 10 });
  });

  test("appends below the lowest existing tile", () => {
    const next = nextTileLayout([
      { x: 0, y: 0, w: 12, h: 10 },
      { x: 12, y: 0, w: 12, h: 14 },
    ]);
    expect(next.y).toBe(14);
    expect(next.x).toBe(0);
  });
});
