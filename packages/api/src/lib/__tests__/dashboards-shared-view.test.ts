/**
 * #4316 — the shared-view projection. `projectSharedDashboardView` /
 * `buildSharedParameterSummary` turn a full `DashboardWithCards` into the
 * minimal, data-only snapshot the public / org share endpoint serializes. These
 * tests prove the STRIPPING (no `sql`, no internal ids, no parameter
 * definitions) against a full card + dashboard, and the frozen `{ label,
 * displayValue }` parameter summary — plus a round-trip through the SSOT Zod
 * schema (`sharedDashboardViewSchema`, `.strict()`), which fails if a projected
 * field escapes the DTO shape.
 */
import { describe, it, expect } from "bun:test";
import {
  projectSharedDashboardView,
  buildSharedParameterSummary,
} from "../dashboards";
import { sharedDashboardViewSchema } from "@useatlas/schemas";
import type { DashboardWithCards, DashboardCard } from "../dashboard-types";

const fullCard: DashboardCard = {
  id: "card-1",
  dashboardId: "dash-1",
  position: 0,
  title: "Total Revenue",
  kind: "chart",
  sql: "SELECT SUM(amount) FROM orders WHERE region = :region",
  chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["total"] },
  content: null,
  annotations: [{ x: "2026-01-15", label: "Launch" }],
  cachedColumns: ["month", "total"],
  cachedRows: [{ month: "Jan", total: 1000 }],
  cachedAt: "2026-04-04T00:00:00.000Z",
  connectionGroupId: "cg-secret-123",
  layout: { x: 0, y: 0, w: 12, h: 6 },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-02T00:00:00.000Z",
};

const fullDashboard: DashboardWithCards = {
  id: "dash-1",
  orgId: "org-secret",
  ownerId: "owner-secret",
  title: "Revenue",
  description: "Quarterly revenue",
  shareToken: "tok-secret",
  shareExpiresAt: null,
  shareMode: "public",
  refreshSchedule: "0 * * * *",
  lastRefreshAt: "2026-04-04T01:00:00.000Z",
  nextRefreshAt: "2026-04-04T02:00:00.000Z",
  parameters: [
    { key: "date_from", type: "date", default: "2026-06-01", label: "Date" },
    { key: "region", type: "text", default: null, label: "Region" },
    { key: "limit", type: "number", default: 10, label: "Top N" },
  ],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-03T00:00:00.000Z",
  cards: [fullCard],
};

describe("projectSharedDashboardView (#4316)", () => {
  it("strips sql and internal ids from cards", () => {
    const view = projectSharedDashboardView(fullDashboard);
    const [card] = view.cards;
    expect(card).not.toHaveProperty("sql");
    expect(card).not.toHaveProperty("connectionGroupId");
    expect(card).not.toHaveProperty("dashboardId");
    expect(card).not.toHaveProperty("createdAt");
    expect(card).not.toHaveProperty("updatedAt");
    // Present, data-only fields survive.
    expect(card.title).toBe("Total Revenue");
    expect(card.kind).toBe("chart");
    expect(card.chartConfig).toEqual({ type: "bar", categoryColumn: "month", valueColumns: ["total"] });
    expect(card.annotations).toEqual([{ x: "2026-01-15", label: "Launch" }]);
    expect(card.cachedRows).toEqual([{ month: "Jan", total: 1000 }]);
    expect(card.layout).toEqual({ x: 0, y: 0, w: 12, h: 6 });
  });

  it("omits owner/org ids, share token, refresh cron, and parameter definitions", () => {
    const view = projectSharedDashboardView(fullDashboard);
    expect(view).not.toHaveProperty("orgId");
    expect(view).not.toHaveProperty("ownerId");
    expect(view).not.toHaveProperty("shareToken");
    expect(view).not.toHaveProperty("refreshSchedule");
    expect(view).not.toHaveProperty("nextRefreshAt");
    // The parameter DEFINITION list is gone — only the frozen summary remains.
    expect(view).not.toHaveProperty("parameters");
    expect(view.title).toBe("Revenue");
    expect(view.shareMode).toBe("public");
    expect(view.lastRefreshAt).toBe("2026-04-04T01:00:00.000Z");
  });

  it("builds a frozen { label, displayValue } parameter summary (no keys/definitions)", () => {
    const view = projectSharedDashboardView(fullDashboard);
    // The projection ALWAYS emits the summary (optional only for wire fwd-compat).
    expect(view.parameterSummary).toBeDefined();
    const summary = view.parameterSummary ?? [];
    expect(summary).toEqual([
      { label: "Date", displayValue: "2026-06-01" },
      { label: "Region", displayValue: "All" },
      { label: "Top N", displayValue: "10" },
    ]);
    // Each entry carries ONLY label + displayValue — no key/type/default leak.
    for (const item of summary) {
      expect(Object.keys(item).toSorted()).toEqual(["displayValue", "label"]);
    }
  });

  it("resolves a relative-date default to a concrete date in the summary", () => {
    const now = new Date("2026-07-04T12:00:00.000Z");
    const summary = buildSharedParameterSummary(
      [{ key: "since", type: "date", default: "now - 30 days", label: "Since" }],
      now,
    );
    expect(summary).toEqual([{ label: "Since", displayValue: "2026-06-04" }]);
  });

  it("falls back to the raw literal for an unparseable date default (never throws)", () => {
    const summary = buildSharedParameterSummary(
      [{ key: "bad", type: "date", default: "not-a-date", label: "Bad" }],
      new Date("2026-07-04T00:00:00.000Z"),
    );
    expect(summary).toEqual([{ label: "Bad", displayValue: "not-a-date" }]);
  });

  it("renders a numeric 0 and an empty-string default literally (not collapsed to 'All')", () => {
    // Guards against a future `if (!param.default)` regression that would fold a
    // legitimate `0` / "" into the null-means-"All" branch.
    const summary = buildSharedParameterSummary([
      { key: "floor", type: "number", default: 0, label: "Floor" },
      { key: "note", type: "text", default: "", label: "Note" },
    ]);
    expect(summary).toEqual([
      { label: "Floor", displayValue: "0" },
      { label: "Note", displayValue: "" },
    ]);
  });

  it("returns an empty summary when the dashboard declares no parameters", () => {
    expect(buildSharedParameterSummary([])).toEqual([]);
    expect(buildSharedParameterSummary(null)).toEqual([]);
    expect(buildSharedParameterSummary(undefined)).toEqual([]);
  });

  it("round-trips through the strict shared-view Zod schema", () => {
    const view = projectSharedDashboardView(fullDashboard);
    const parsed = sharedDashboardViewSchema.safeParse(view);
    expect(parsed.success).toBe(true);
  });

  it("a projected view carrying a stray internal field fails the strict schema", () => {
    const view = projectSharedDashboardView(fullDashboard);
    // Simulate a regression that re-adds `sql` to a card — `.strict()` must reject.
    const leaky = {
      ...view,
      cards: [{ ...view.cards[0], sql: "SELECT 1" }],
    };
    expect(sharedDashboardViewSchema.safeParse(leaky).success).toBe(false);
  });
});
