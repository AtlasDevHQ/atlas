import { describe, expect, test } from "bun:test";
import type { DashboardCard, DashboardWithCards } from "@/ui/lib/types";
import { describeFieldChange, diffDashboards } from "../dashboard-diff";

const BASE_CARD: Omit<DashboardCard, "id" | "position"> = {
  dashboardId: "d1",
  title: "Card",
  sql: "SELECT 1",
  chartConfig: null,
  cachedColumns: null,
  cachedRows: null,
  cachedAt: null,
  connectionGroupId: null,
  layout: null,
  createdAt: "2026-05-17T00:00:00Z",
  updatedAt: "2026-05-17T00:00:00Z",
};

function card(overrides: Partial<DashboardCard> & { id: string; position?: number }): DashboardCard {
  return { ...BASE_CARD, position: 0, ...overrides };
}

function dashboard(cards: DashboardCard[], overrides?: Partial<DashboardWithCards>): DashboardWithCards {
  return {
    id: "d1",
    orgId: null,
    ownerId: "u1",
    title: "Dash",
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    shareMode: "public",
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    createdAt: "2026-05-17T00:00:00Z",
    updatedAt: "2026-05-17T00:00:00Z",
    cards,
    ...overrides,
  };
}

describe("diffDashboards", () => {
  test("identical dashboards produce an empty diff", () => {
    const p = dashboard([card({ id: "a", title: "A" })]);
    const d = dashboard([card({ id: "a", title: "A" })]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(true);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  test("detects cards added in the draft", () => {
    const p = dashboard([card({ id: "a", title: "A" })]);
    const d = dashboard([
      card({ id: "a", title: "A" }),
      card({ id: "b", title: "B", position: 1 }),
    ]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(false);
    expect(diff.added.map((c) => c.id)).toEqual(["b"]);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  test("detects cards removed from the draft", () => {
    const p = dashboard([
      card({ id: "a", title: "A" }),
      card({ id: "b", title: "B", position: 1 }),
    ]);
    const d = dashboard([card({ id: "a", title: "A" })]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(false);
    expect(diff.removed.map((c) => c.id)).toEqual(["b"]);
  });

  test("detects field-level changes on existing cards", () => {
    const p = dashboard([
      card({
        id: "a",
        title: "A",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
      }),
    ]);
    const d = dashboard([
      card({
        id: "a",
        title: "A renamed",
        sql: "SELECT 2",
        chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] },
      }),
    ]);
    const diff = diffDashboards(p, d);
    expect(diff.changed).toHaveLength(1);
    const fields = diff.changed[0].changes.map((c) => c.field);
    expect(fields).toContain("title");
    expect(fields).toContain("sql");
    expect(fields).toContain("chartType");
  });

  test("detects layout changes via JSON stringify", () => {
    const p = dashboard([
      card({ id: "a", layout: { x: 0, y: 0, w: 6, h: 4 } }),
    ]);
    const d = dashboard([
      card({ id: "a", layout: { x: 6, y: 0, w: 6, h: 4 } }),
    ]);
    const diff = diffDashboards(p, d);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes[0].field).toBe("layout");
  });

  test("layout-on-both-sides null is not a change", () => {
    const p = dashboard([card({ id: "a", layout: null })]);
    const d = dashboard([card({ id: "a", layout: null })]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(true);
  });

  test("detects meta title and description changes independently", () => {
    const p = dashboard([], { title: "Old", description: "Old desc" });
    const d = dashboard([], { title: "New", description: "New desc" });
    const diff = diffDashboards(p, d);
    expect(diff.meta.title.changed).toBe(true);
    expect(diff.meta.description.changed).toBe(true);
    expect(diff.empty).toBe(false);
  });

  test("description nullification surfaces as a change", () => {
    const p = dashboard([], { description: "had one" });
    const d = dashboard([], { description: null });
    const diff = diffDashboards(p, d);
    expect(diff.meta.description.changed).toBe(true);
    expect(diff.meta.description.after).toBeNull();
  });

  test("connection group change", () => {
    const p = dashboard([card({ id: "a", connectionGroupId: "g1" })]);
    const d = dashboard([card({ id: "a", connectionGroupId: "g2" })]);
    const diff = diffDashboards(p, d);
    expect(diff.changed[0].changes[0].field).toBe("connectionGroup");
  });
});

describe("describeFieldChange", () => {
  test("title change is fully spelled out", () => {
    expect(
      describeFieldChange({ field: "title", before: "Old", after: "New" }),
    ).toBe('Title: "Old" → "New"');
  });

  test("sql change is a generic label (queries are too long for inline)", () => {
    expect(
      describeFieldChange({ field: "sql", before: "SELECT 1", after: "SELECT 2" }),
    ).toBe("SQL query updated");
  });

  test("chart type change shows both sides", () => {
    expect(
      describeFieldChange({ field: "chartType", before: "table", after: "bar" }),
    ).toBe("Chart type: table → bar");
  });

  test("chart type cleared", () => {
    expect(
      describeFieldChange({ field: "chartType", before: "bar", after: null }),
    ).toBe("Chart type: bar → none");
  });

  test("connection group cleared", () => {
    expect(
      describeFieldChange({ field: "connectionGroup", before: "g1", after: null }),
    ).toBe("Connection group cleared");
  });

  test("layout change is a generic label", () => {
    expect(
      describeFieldChange({
        field: "layout",
        before: '{"x":0,"y":0,"w":6,"h":4}',
        after: '{"x":6,"y":0,"w":6,"h":4}',
      }),
    ).toBe("Moved or resized");
  });
});
