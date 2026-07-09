import { describe, expect, test } from "bun:test";
import type { DashboardCard, DashboardWithCards } from "@/ui/lib/types";
import { describeFieldChange, diffDashboards } from "../dashboard-diff";

const BASE_CARD: Omit<DashboardCard, "id" | "position"> = {
  dashboardId: "d1",
  title: "Card",
  kind: "chart",
  sql: "SELECT 1",
  chartConfig: null,
  content: null,
  annotations: [],
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
    parameters: [],
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

  // #4325 — a chartConfig change BEYOND `type` (thresholds/colours/columns) must
  // be shown + publishable. The old diff compared only `chartConfig.type`, so a
  // thresholds edit read as "no change" and disabled Publish on a real edit.
  test("a chartConfig-only change (same type) is shown and publishable", () => {
    const p = dashboard([
      card({ id: "a", chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] } }),
    ]);
    const d = dashboard([
      card({
        id: "a",
        chartConfig: {
          type: "bar",
          categoryColumn: "x",
          valueColumns: ["y"],
          thresholds: [{ value: 100, label: "Goal" }],
        },
      }),
    ]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(false);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.map((c) => c.field)).toEqual(["chartConfig"]);
    expect(describeFieldChange(diff.changed[0].changes[0])).toBe("Chart configuration updated");
  });

  // #4325 — a pure reorder (position-only) must be shown + publishable. The old
  // diff never compared `position`, so a reorder read as "no change".
  test("a pure reorder (position change) is shown and publishable", () => {
    const p = dashboard([
      card({ id: "a", position: 0 }),
      card({ id: "b", position: 1 }),
    ]);
    const d = dashboard([
      card({ id: "a", position: 1 }),
      card({ id: "b", position: 0 }),
    ]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(false);
    // Both cards moved.
    expect(diff.changed.map((c) => c.cardId).sort()).toEqual(["a", "b"]);
    for (const c of diff.changed) {
      expect(c.changes.map((x) => x.field)).toEqual(["position"]);
      expect(describeFieldChange(c.changes[0])).toBe("Reordered");
    }
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

  // #3209 — an annotations-only edit must NOT read as empty, or the Publish gate
  // would disable the button and an annotations-only draft change could never
  // ship (keeps the client gate aligned with the server's cardEquals).
  test("detects an annotations-only change so Publish stays enabled", () => {
    const p = dashboard([card({ id: "a", annotations: [] })]);
    const d = dashboard([card({ id: "a", annotations: [{ x: "2026-01-15", label: "Launch" }] })]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(false);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.map((c) => c.field)).toEqual(["annotations"]);
    expect(describeFieldChange(diff.changed[0].changes[0])).toBe("Event annotations updated");
  });

  test("identical annotations on both sides is not a change", () => {
    const anns = [{ x: "2026-01-15", label: "Launch" }];
    const p = dashboard([card({ id: "a", annotations: anns })]);
    const d = dashboard([card({ id: "a", annotations: [...anns] })]);
    expect(diffDashboards(p, d).empty).toBe(true);
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

  // #3138 — a text card's only substantive field is its markdown `content`.
  // sql ("") and chartType (null) never move, so without the content arm a
  // content-only edit would be invisible and the Publish gate would block it.
  test("a text card's content edit surfaces as a change (not empty)", () => {
    const textCard = { kind: "text" as const, sql: "", chartConfig: null };
    const p = dashboard([card({ id: "t", ...textCard, content: "## Top of funnel" })]);
    const d = dashboard([card({ id: "t", ...textCard, content: "## Top of funnel (rev)" })]);
    const diff = diffDashboards(p, d);
    expect(diff.empty).toBe(false);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.map((c) => c.field)).toEqual(["content"]);
  });

  test("an unchanged text card produces no diff", () => {
    const textCard = { kind: "text" as const, sql: "", chartConfig: null, content: "## Same" };
    const diff = diffDashboards(dashboard([card({ id: "t", ...textCard })]), dashboard([card({ id: "t", ...textCard })]));
    expect(diff.empty).toBe(true);
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

  test("text content change is a generic label", () => {
    expect(
      describeFieldChange({ field: "content", before: "## A", after: "## B" }),
    ).toBe("Section text updated");
  });
});
