import { describe, test, expect } from "bun:test";
import { rowToCard, CardLayoutSchema } from "@atlas/api/lib/dashboards";

const baseRow = {
  id: "card-1",
  dashboard_id: "dash-1",
  position: 0,
  title: "Untitled",
  sql: "SELECT 1",
  chart_config: null,
  cached_columns: null,
  cached_rows: null,
  cached_at: null,
  connection_id: null,
  created_at: "2026-04-25T00:00:00Z",
  updated_at: "2026-04-25T00:00:00Z",
};

describe("rowToCard layout parsing", () => {
  test("accepts a valid layout object", () => {
    const card = rowToCard({ ...baseRow, layout: { x: 1, y: 2, w: 12, h: 6 } });
    expect(card.layout).toEqual({ x: 1, y: 2, w: 12, h: 6 });
  });

  test("accepts a JSON-string layout (driver may surface JSONB as text)", () => {
    const card = rowToCard({ ...baseRow, layout: '{"x":3,"y":0,"w":10,"h":5}' });
    expect(card.layout).toEqual({ x: 3, y: 0, w: 10, h: 5 });
  });

  test("discards a layout missing required fields", () => {
    const card = rowToCard({ ...baseRow, layout: { x: 1, y: 2, w: 12 } });
    expect(card.layout).toBeNull();
  });

  test("discards malformed JSON string", () => {
    const card = rowToCard({ ...baseRow, layout: "not json" });
    expect(card.layout).toBeNull();
  });

  test("discards out-of-bounds values that the route schema would reject", () => {
    const card = rowToCard({ ...baseRow, layout: { x: -5, y: 0, w: 12, h: 6 } });
    expect(card.layout).toBeNull();
  });

  test("discards layouts overflowing the 24-col grid via x + w", () => {
    const card = rowToCard({ ...baseRow, layout: { x: 23, y: 0, w: 24, h: 6 } });
    expect(card.layout).toBeNull();
  });

  test("discards NaN/Infinity numbers", () => {
    expect(rowToCard({ ...baseRow, layout: { x: Number.NaN, y: 0, w: 12, h: 6 } }).layout).toBeNull();
    expect(rowToCard({ ...baseRow, layout: { x: 1, y: Number.POSITIVE_INFINITY, w: 12, h: 6 } }).layout).toBeNull();
  });

  test("treats null layout as not-yet-placed", () => {
    expect(rowToCard({ ...baseRow, layout: null }).layout).toBeNull();
    expect(rowToCard({ ...baseRow }).layout).toBeNull();
  });
});

describe("CardLayoutSchema bounds", () => {
  test("accepts a typical layout", () => {
    expect(CardLayoutSchema.safeParse({ x: 0, y: 0, w: 12, h: 10 }).success).toBe(true);
  });

  test("rejects x at the right edge that overflows", () => {
    expect(CardLayoutSchema.safeParse({ x: 23, y: 0, w: 12, h: 10 }).success).toBe(false);
  });

  test("rejects w below minimum", () => {
    expect(CardLayoutSchema.safeParse({ x: 0, y: 0, w: 2, h: 10 }).success).toBe(false);
  });

  test("rejects h below minimum", () => {
    expect(CardLayoutSchema.safeParse({ x: 0, y: 0, w: 12, h: 3 }).success).toBe(false);
  });

  test("rejects fractional values", () => {
    expect(CardLayoutSchema.safeParse({ x: 0.5, y: 0, w: 12, h: 10 }).success).toBe(false);
  });

  test("rejects negative coordinates", () => {
    expect(CardLayoutSchema.safeParse({ x: -1, y: 0, w: 12, h: 10 }).success).toBe(false);
    expect(CardLayoutSchema.safeParse({ x: 0, y: -1, w: 12, h: 10 }).success).toBe(false);
  });
});
