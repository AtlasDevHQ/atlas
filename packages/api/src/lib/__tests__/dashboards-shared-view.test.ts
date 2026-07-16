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
  resolveSharedSnapshotInstant,
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

  it("freezes relative-date summaries against the snapshot's refresh instant, not request time (#4538)", () => {
    // The card's cachedRows are frozen at lastRefreshAt; the parameter summary
    // that labels them must resolve its relative-date defaults against the SAME
    // frozen instant — never a fresh `new Date()` per view request (which would
    // drift the chip ahead of the data window as the share link ages).
    const dashboard: DashboardWithCards = {
      ...fullDashboard,
      lastRefreshAt: "2026-04-04T01:00:00.000Z",
      parameters: [{ key: "since", type: "date", default: "now - 30 days", label: "Since" }],
    };
    const view = projectSharedDashboardView(dashboard);
    // 2026-04-04 − 30 days = 2026-03-05 — the frozen window, independent of today.
    expect(view.parameterSummary).toEqual([{ label: "Since", displayValue: "2026-03-05" }]);
  });

  it("keeps the relative-date summary stable across repeated view requests (#4538)", () => {
    const dashboard: DashboardWithCards = {
      ...fullDashboard,
      lastRefreshAt: "2026-04-04T01:00:00.000Z",
      parameters: [{ key: "since", type: "date", default: "now - 7 days", label: "Since" }],
    };
    const first = projectSharedDashboardView(dashboard);
    const second = projectSharedDashboardView(dashboard);
    expect(first.parameterSummary).toEqual(second.parameterSummary);
    // 2026-04-04 − 7 days = 2026-03-28.
    expect(first.parameterSummary).toEqual([{ label: "Since", displayValue: "2026-03-28" }]);
  });

  it("falls back to updatedAt for the frozen instant when never refreshed (#4538)", () => {
    const dashboard: DashboardWithCards = {
      ...fullDashboard,
      lastRefreshAt: null,
      // Never refreshed: no card has cached data either.
      cards: [{ ...fullCard, cachedAt: null }],
      parameters: [{ key: "since", type: "date", default: "now - 30 days", label: "Since" }],
    };
    const view = projectSharedDashboardView(dashboard);
    // updatedAt 2026-04-03 − 30 days = 2026-03-04.
    expect(view.parameterSummary).toEqual([{ label: "Since", displayValue: "2026-03-04" }]);
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

  // #4538 — the frozen-instant resolver itself. The projection-level tests
  // above prove the summary uses it; these pin the instant-selection order:
  // newest of (lastRefreshAt, every card's cachedAt), else updatedAt.
  describe("resolveSharedSnapshotInstant (#4538)", () => {
    it("uses the newest card cachedAt when it is newer than lastRefreshAt", () => {
      const instant = resolveSharedSnapshotInstant({
        ...fullDashboard,
        lastRefreshAt: "2026-04-04T01:00:00.000Z",
        cards: [
          fullCard,
          { ...fullCard, id: "card-2", cachedAt: "2026-05-10T12:00:00.000Z" },
        ],
      });
      expect(instant.toISOString()).toBe("2026-05-10T12:00:00.000Z");
    });

    it("uses card cachedAt when lastRefreshAt is null", () => {
      const instant = resolveSharedSnapshotInstant({
        ...fullDashboard,
        lastRefreshAt: null,
      });
      expect(instant.toISOString()).toBe("2026-04-04T00:00:00.000Z");
    });

    it("falls back to updatedAt for a never-refreshed dashboard with no cached cards", () => {
      const instant = resolveSharedSnapshotInstant({
        ...fullDashboard,
        lastRefreshAt: null,
        cards: [{ ...fullCard, cachedAt: null }],
      });
      expect(instant.toISOString()).toBe("2026-04-03T00:00:00.000Z");
    });
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
