import { describe, expect, test } from "bun:test";
import {
  dashboardCardsEqual,
  type DashboardCardEqualityInput,
} from "../dashboard-card-equality";

const BASE: DashboardCardEqualityInput = {
  title: "Card",
  position: 0,
  sql: "SELECT 1",
  chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] },
  content: null,
  annotations: [],
  connectionGroupId: null,
  layout: null,
};

function card(overrides: Partial<DashboardCardEqualityInput>): DashboardCardEqualityInput {
  return { ...BASE, ...overrides };
}

describe("dashboardCardsEqual", () => {
  test("identical cards are equal", () => {
    expect(dashboardCardsEqual(card({}), card({}))).toBe(true);
  });

  test("title change is not equal", () => {
    expect(dashboardCardsEqual(card({}), card({ title: "Other" }))).toBe(false);
  });

  // #4325 — a pure reorder (position-only) must NOT read as equal, or the client
  // marks the draft empty and disables Publish on a real reorder.
  test("position change alone is not equal", () => {
    expect(dashboardCardsEqual(card({ position: 0 }), card({ position: 3 }))).toBe(false);
  });

  test("sql change is not equal", () => {
    expect(dashboardCardsEqual(card({}), card({ sql: "SELECT 2" }))).toBe(false);
  });

  // #4325 — a chartConfig change BEYOND `type` (thresholds / colours / columns)
  // must read as changed. The old client diff compared only `chartConfig.type`.
  test("chartConfig thresholds change (same type) is not equal", () => {
    const before = card({
      chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] },
    });
    const after = card({
      chartConfig: {
        type: "bar",
        categoryColumn: "x",
        valueColumns: ["y"],
        thresholds: [{ value: 100, label: "Goal" }],
      },
    });
    expect(dashboardCardsEqual(before, after)).toBe(false);
  });

  test("chartConfig type change is not equal", () => {
    const before = card({ chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] } });
    const after = card({ chartConfig: { type: "line", categoryColumn: "x", valueColumns: ["y"] } });
    expect(dashboardCardsEqual(before, after)).toBe(false);
  });

  test("same chartConfig object shape is equal", () => {
    const cfg = { type: "bar" as const, categoryColumn: "x", valueColumns: ["y"] };
    expect(dashboardCardsEqual(card({ chartConfig: { ...cfg } }), card({ chartConfig: { ...cfg } }))).toBe(true);
  });

  test("layout change is not equal", () => {
    expect(
      dashboardCardsEqual(
        card({ layout: { x: 0, y: 0, w: 6, h: 4 } }),
        card({ layout: { x: 6, y: 0, w: 6, h: 4 } }),
      ),
    ).toBe(false);
  });

  test("both-null layout is equal", () => {
    expect(dashboardCardsEqual(card({ layout: null }), card({ layout: null }))).toBe(true);
  });

  test("connection group change is not equal", () => {
    expect(dashboardCardsEqual(card({ connectionGroupId: "g1" }), card({ connectionGroupId: "g2" }))).toBe(false);
  });

  test("annotations change is not equal", () => {
    expect(
      dashboardCardsEqual(
        card({ annotations: [] }),
        card({ annotations: [{ x: "2026-01-15", label: "Launch" }] }),
      ),
    ).toBe(false);
  });

  test("absent annotations normalizes to [] (equal)", () => {
    expect(dashboardCardsEqual(card({ annotations: undefined }), card({ annotations: [] }))).toBe(true);
  });

  // #3138 — kind is derived from `content` presence; a chart↔text flip differs.
  test("chart vs text (content presence) is not equal", () => {
    const chart = card({ content: null, sql: "SELECT 1" });
    const text = card({ content: "## Header", sql: "" });
    expect(dashboardCardsEqual(chart, text)).toBe(false);
  });

  test("two text cards with same markdown are equal (sql/chartConfig ignored)", () => {
    const a = card({ content: "## Same", sql: "", chartConfig: null });
    const b = card({ content: "## Same", sql: "ignored", chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] } });
    expect(dashboardCardsEqual(a, b)).toBe(true);
  });

  test("text content change is not equal", () => {
    const a = card({ content: "## A", sql: "", chartConfig: null });
    const b = card({ content: "## B", sql: "", chartConfig: null });
    expect(dashboardCardsEqual(a, b)).toBe(false);
  });

  test("absent vs null content both read as chart (equal)", () => {
    expect(dashboardCardsEqual(card({ content: undefined }), card({ content: null }))).toBe(true);
  });
});
