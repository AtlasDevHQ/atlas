/**
 * dashboard-screenshot unit tests (#2367).
 *
 * Exercises the cache + invalidation + render-fn injection seam without
 * touching Playwright. Two layered concerns:
 *
 *   1. Cache: `(dashboardId, userId, snapshotHash)` keys, mutations
 *      invalidate every user's view of that dashboard.
 *   2. Render seam: `_setRenderFn` swaps in a stub renderer; verifies
 *      the default tool-integration path stays fast and deterministic.
 *
 * The Playwright-backed render path is exercised by the smoke spec
 * (`dashboard-screenshot.smoke.test.ts`), gated on
 * `TEST_SCREENSHOT_BROWSER=true`.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  screenshotDashboard,
  invalidateDashboardScreenshot,
  _resetScreenshotCache,
  _screenshotCacheSize,
  _setRenderFn,
} from "../dashboard-screenshot";

// Stub getDashboard so we don't touch the internal DB.
let dashboardResult: { ok: true; data: unknown } | { ok: false; reason: "no_db" | "not_found" | "error" } = {
  ok: true,
  data: {
    id: "dash-1",
    title: "Demo",
    description: null,
    updatedAt: "2026-05-17",
    cards: [
      {
        id: "card-1",
        title: "Signups",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
        layout: null,
        position: 0,
      },
    ],
  },
};

mock.module("@atlas/api/lib/dashboards", () => ({
  getDashboard: mock(async () => dashboardResult),
  // Surface-complete partial mock — anything else we don't use is `never`.
  createDashboard: undefined as never,
  listDashboards: undefined as never,
  updateDashboard: undefined as never,
  deleteDashboard: undefined as never,
  addCard: undefined as never,
  updateCard: undefined as never,
  removeCard: undefined as never,
  refreshCard: undefined as never,
  getCard: undefined as never,
  shareDashboard: undefined as never,
  unshareDashboard: undefined as never,
  getShareStatus: undefined as never,
  getSharedDashboard: undefined as never,
  setRefreshSchedule: undefined as never,
  CardLayoutSchema: { safeParse: () => ({ success: false }) },
  resolveCardConnectionId: undefined as never,
  NoGroupMembersError: class {},
}));

describe("dashboard-screenshot", () => {
  let renderCalls = 0;
  const PNG_FAKE = Buffer.from("FAKE-PNG", "utf8");

  beforeEach(() => {
    renderCalls = 0;
    _resetScreenshotCache();
    _setRenderFn(async () => {
      renderCalls += 1;
      return PNG_FAKE;
    });
    dashboardResult = {
      ok: true,
      data: {
        id: "dash-1",
        title: "Demo",
        description: null,
        updatedAt: "2026-05-17",
        cards: [
          {
            id: "card-1",
            title: "Signups",
            sql: "SELECT 1",
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
            layout: null,
            position: 0,
          },
        ],
      },
    };
  });

  afterEach(() => {
    _setRenderFn(null);
    _resetScreenshotCache();
  });

  it("returns a PNG buffer with cached=false on first render", async () => {
    const result = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.png.toString()).toBe("FAKE-PNG");
    expect(result.cached).toBe(false);
    expect(renderCalls).toBe(1);
  });

  it("returns cached PNG on second call with same inputs (no re-render)", async () => {
    await screenshotDashboard({ dashboardId: "dash-1", userId: "user-1", orgId: "org-1" });
    const second = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok");
    expect(second.cached).toBe(true);
    expect(renderCalls).toBe(1);
  });

  it("keys cache by userId — user A's PNG does not leak to user B", async () => {
    await screenshotDashboard({ dashboardId: "dash-1", userId: "user-a", orgId: "org-1" });
    expect(renderCalls).toBe(1);
    expect(_screenshotCacheSize()).toBe(1);

    const userB = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-b",
      orgId: "org-1",
    });
    expect(userB.ok).toBe(true);
    if (!userB.ok) throw new Error("expected ok");
    expect(userB.cached).toBe(false);
    expect(renderCalls).toBe(2);
    expect(_screenshotCacheSize()).toBe(2);
  });

  it("invalidateDashboardScreenshot drops every cached entry for a dashboard", async () => {
    await screenshotDashboard({ dashboardId: "dash-1", userId: "user-a", orgId: "org-1" });
    await screenshotDashboard({ dashboardId: "dash-1", userId: "user-b", orgId: "org-1" });
    expect(_screenshotCacheSize()).toBe(2);

    invalidateDashboardScreenshot("dash-1");
    expect(_screenshotCacheSize()).toBe(0);

    // Next call re-renders.
    const next = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-a",
      orgId: "org-1",
    });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("expected ok");
    expect(next.cached).toBe(false);
  });

  it("invalidates implicitly when the snapshot hash changes (e.g. card SQL edit)", async () => {
    await screenshotDashboard({ dashboardId: "dash-1", userId: "user-1", orgId: "org-1" });
    expect(renderCalls).toBe(1);

    // Simulate a card-SQL change without explicit invalidation.
    dashboardResult = {
      ok: true,
      data: {
        id: "dash-1",
        title: "Demo",
        description: null,
        updatedAt: "2026-05-17T12:00:00Z",
        cards: [
          {
            id: "card-1",
            title: "Signups",
            sql: "SELECT 2", // changed
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
            layout: null,
            position: 0,
          },
        ],
      },
    };

    const result = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.cached).toBe(false);
    expect(renderCalls).toBe(2);
  });

  it("returns dashboard_not_found when getDashboard fails with not_found", async () => {
    dashboardResult = { ok: false, reason: "not_found" };
    const result = await screenshotDashboard({
      dashboardId: "missing",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("dashboard_not_found");
  });

  it("returns no_db when the internal database is unavailable", async () => {
    dashboardResult = { ok: false, reason: "no_db" };
    const result = await screenshotDashboard({
      dashboardId: "any",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("no_db");
  });

  it("returns render_failed when the render fn throws unexpectedly", async () => {
    _setRenderFn(async () => {
      throw new Error("nav timeout");
    });
    const result = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("render_failed");
  });

  it("returns browser_unavailable when Playwright is not installed", async () => {
    _setRenderFn(async () => {
      throw new Error("playwright_not_installed");
    });
    const result = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("browser_unavailable");
  });
});
