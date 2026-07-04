/**
 * Dashboard render resource-discipline tests (#4319).
 *
 * The shared headless Chromium behind dashboard screenshots + PDF/PNG export
 * must:
 *   1. Cap simultaneous renders with a semaphore — excess requests QUEUE and
 *      still complete, rather than each spawning its own browser context.
 *   2. Detect a dead/crashed browser and relaunch it on the next acquire,
 *      instead of serving the cached dead instance forever (every export
 *      failing until an API restart).
 *
 * Both are exercised through injectable seams (`_setRenderFn`,
 * `_setBrowserLauncher`) so the suite never downloads or launches real
 * Chromium — the real Playwright path stays in the opt-in smoke spec.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  screenshotDashboard,
  exportDashboard,
  clampRenderConcurrency,
  _resetScreenshotCache,
  _resetScreenshotBrowserState,
  _setRenderFn,
  _setExportRenderFn,
  _setRenderConcurrency,
  _setBrowserLauncher,
  _acquireScreenshotBrowser,
  _renderInFlight,
  type LaunchedBrowser,
} from "../dashboard-screenshot";

// Stub getDashboard so the snapshot-hash step doesn't touch the internal DB.
// Mock-all-exports: anything the module exports but we don't call is `never`.
mock.module("@atlas/api/lib/dashboards", () => ({
  getDashboard: mock(async () => ({
    ok: true,
    data: {
      id: "dash-1",
      title: "Demo",
      description: null,
      updatedAt: "2026-07-04",
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
  })),
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
  rowToCard: undefined as never,
  loadGroupSnapshot: undefined as never,
  buildSharedParameterSummary: undefined as never,
  projectSharedDashboardView: undefined as never,
  getDashboardsDueForRefresh: undefined as never,
  lockDashboardForRefresh: undefined as never,
  refreshDashboardCards: undefined as never,
  NoGroupMembersError: class {},
}));

const PNG = Buffer.from("FAKE-PNG", "utf8");

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("dashboard render concurrency cap (#4319)", () => {
  beforeEach(() => {
    _resetScreenshotCache();
    _setRenderConcurrency(null);
  });

  afterEach(() => {
    _setRenderFn(null);
    _setRenderConcurrency(null);
    _resetScreenshotCache();
  });

  it("caps simultaneous renders and queues the excess, which still complete", async () => {
    _setRenderConcurrency(2);

    let active = 0;
    let peak = 0;
    let started = 0;
    let completed = 0;
    // One resolver per parked render; resolving it lets that render finish.
    const gates: Array<() => void> = [];

    _setRenderFn(async () => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      completed += 1;
      return PNG;
    });

    // Fire 5 renders at once. Distinct userIds ⇒ 5 distinct cache keys ⇒ all
    // 5 actually render (none served from cache).
    const all = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        screenshotDashboard({ dashboardId: "dash-1", userId: `user-${i}`, orgId: "org-1" }),
      ),
    );

    // Only the cap (2) may be in flight; the other 3 queue.
    await waitFor(() => started === 2);
    // Give any erroneously-admitted 3rd render a chance to show up.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(2);
    expect(_renderInFlight()).toBe(2);
    expect(peak).toBe(2);

    // Drain: release one render at a time; each completion admits exactly one
    // queued render. The cap must never be exceeded during the drain.
    while (completed < 5) {
      await waitFor(() => gates.length > 0);
      const before = completed;
      gates.shift()?.();
      await waitFor(() => completed === before + 1);
      expect(_renderInFlight()).toBeLessThanOrEqual(2);
    }

    const results = await all;
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
    // The queued excess completed without ever breaching the cap.
    expect(peak).toBe(2);
    expect(started).toBe(5);
    expect(_renderInFlight()).toBe(0);
  });

  it("serializes to a single render when the cap is 1", async () => {
    _setRenderConcurrency(1);

    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    _setRenderFn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      return PNG;
    });

    const all = Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        screenshotDashboard({ dashboardId: "dash-1", userId: `solo-${i}`, orgId: "org-1" }),
      ),
    );

    await waitFor(() => gates.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(_renderInFlight()).toBe(1);

    // Release renders until all three complete.
    for (let i = 0; i < 3; i++) {
      await waitFor(() => gates.length > 0);
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 10));
    }

    const results = await all;
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(1);
  });

  it("releases the permit when a render FAILS, so the semaphore never starves", async () => {
    // Regression guard for the exact deadlock class #4319 exists to kill: if
    // `RenderSemaphore.run` ever released only on success, every failed render
    // would leak a permit and — because screenshot/export swallow errors into
    // `{ ok: false }` — silently starve ALL renders until an API restart.
    _setRenderConcurrency(1);

    // First render rejects. screenshotDashboard maps the throw to ok:false.
    _setRenderFn(async () => {
      throw new Error("nav timeout");
    });
    const failed = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-fail",
      orgId: "org-1",
    });
    expect(failed.ok).toBe(false);
    // The permit was returned despite the failure.
    expect(_renderInFlight()).toBe(0);

    // A subsequent render is admitted and completes — no starvation.
    _setRenderFn(async () => PNG);
    const next = await screenshotDashboard({
      dashboardId: "dash-1",
      userId: "user-ok",
      orgId: "org-1",
    });
    expect(next.ok).toBe(true);
    expect(_renderInFlight()).toBe(0);
  });

  it("exports share the same semaphore and acquire the permit BEFORE the render timeout starts", async () => {
    // The export path deliberately wraps `withTimeout(fn(...))` INSIDE
    // `renderSemaphore.run(...)`, so time spent queueing for a permit is not
    // charged against the render budget. Park a screenshot render to hold the
    // sole permit, fire an export behind it with a tiny timeout, and prove the
    // export neither starts nor times out while queued.
    _setRenderConcurrency(1);

    let exportStarted = false;
    const screenshotGate: Array<() => void> = [];
    _setRenderFn(async () => {
      await new Promise<void>((resolve) => screenshotGate.push(resolve));
      return PNG;
    });
    _setExportRenderFn(async () => {
      exportStarted = true;
      return { bytes: PNG, contentType: "image/png", partial: false };
    });

    // Hold the permit with a screenshot render.
    const shot = screenshotDashboard({ dashboardId: "dash-1", userId: "holder", orgId: "org-1" });
    await waitFor(() => screenshotGate.length === 1);
    expect(_renderInFlight()).toBe(1);

    // Fire the export with a 30ms render budget. If the budget were counted
    // during the queue wait, this would time out; instead it must simply wait.
    const exp = exportDashboard({
      dashboardId: "dash-1",
      userId: "exporter",
      orgId: "org-1",
      format: "png",
      timeoutMs: 30,
    });

    // Stay queued well past its own render budget without starting or failing.
    await new Promise((r) => setTimeout(r, 80));
    expect(exportStarted).toBe(false);

    // Release the screenshot → the export is admitted, its clock starts fresh.
    screenshotGate.shift()?.();
    const shotResult = await shot;
    const expResult = await exp;
    expect(shotResult.ok).toBe(true);
    expect(exportStarted).toBe(true);
    expect(expResult.ok).toBe(true); // did not time out — budget started after admission
    expect(_renderInFlight()).toBe(0);

    _setExportRenderFn(null);
  });
});

describe("clampRenderConcurrency boundaries (#4319)", () => {
  it("falls back to the default (3) for unset / empty / non-numeric input", () => {
    expect(clampRenderConcurrency(null)).toBe(3);
    expect(clampRenderConcurrency(undefined)).toBe(3);
    expect(clampRenderConcurrency("")).toBe(3);
    expect(clampRenderConcurrency("abc")).toBe(3);
    expect(clampRenderConcurrency(Number.NaN)).toBe(3);
  });

  it("clamps to the floor of 1 for zero / negative (a 0 cap would deadlock)", () => {
    expect(clampRenderConcurrency("0")).toBe(1);
    expect(clampRenderConcurrency(0)).toBe(1);
    expect(clampRenderConcurrency("-5")).toBe(1);
    expect(clampRenderConcurrency(-5)).toBe(1);
  });

  it("clamps to the ceiling of 16 for oversized input", () => {
    expect(clampRenderConcurrency("17")).toBe(16);
    expect(clampRenderConcurrency(1000)).toBe(16);
  });

  it("truncates fractional values and passes valid ones through", () => {
    expect(clampRenderConcurrency("3.9")).toBe(3);
    expect(clampRenderConcurrency(4.2)).toBe(4);
    expect(clampRenderConcurrency("1")).toBe(1);
    expect(clampRenderConcurrency("16")).toBe(16);
    expect(clampRenderConcurrency(8)).toBe(8);
  });
});

describe("dashboard headless browser liveness + relaunch (#4319)", () => {
  beforeEach(() => {
    _resetScreenshotBrowserState();
  });

  afterEach(() => {
    _setBrowserLauncher(null);
    _resetScreenshotBrowserState();
  });

  const makeFakeBrowser = (isAlive: () => boolean, onClose: (id: number) => void, id: number): LaunchedBrowser => ({
    isConnected: isAlive,
    close: async () => {
      onClose(id);
    },
    // Never reached in the lifecycle tests — they drive getBrowser() directly.
    newContext: async () => {
      throw new Error("fake browser: newContext not used in lifecycle tests");
    },
  });

  it("reuses a live cached browser without relaunching", async () => {
    let launches = 0;
    _setBrowserLauncher(async () => {
      launches += 1;
      return makeFakeBrowser(() => true, () => {}, launches);
    });

    const first = await _acquireScreenshotBrowser();
    const second = await _acquireScreenshotBrowser();
    expect(launches).toBe(1);
    expect(second).toBe(first);
  });

  it("relaunches a dead browser on next acquire instead of serving the cached dead instance", async () => {
    let launches = 0;
    let alive = true;
    const closed: number[] = [];
    _setBrowserLauncher(async () => {
      launches += 1;
      return makeFakeBrowser(() => alive, (id) => closed.push(id), launches);
    });

    const first = await _acquireScreenshotBrowser();
    expect(launches).toBe(1);

    // Simulate a crash: the cached browser reports disconnected.
    alive = false;

    const relaunched = await _acquireScreenshotBrowser();
    expect(launches).toBe(2); // a fresh browser was launched
    expect(relaunched).not.toBe(first); // not the dead cached instance
    expect(closed).toEqual([1]); // the dead handle was closed, not leaked

    // The relaunched instance is live (shared flag restored) and gets reused
    // on subsequent acquires — no second relaunch.
    alive = true;
    const again = await _acquireScreenshotBrowser();
    expect(again).toBe(relaunched);
    expect(launches).toBe(2);
  });

  it("relaunches even when closing the dead handle throws", async () => {
    let launches = 0;
    let alive = true;
    _setBrowserLauncher(async () => {
      launches += 1;
      const thisLaunch = launches;
      return {
        isConnected: () => (thisLaunch === 1 ? alive : true),
        close: async () => {
          if (thisLaunch === 1) throw new Error("close failed on dead handle");
        },
        newContext: async () => {
          throw new Error("unused");
        },
      } satisfies LaunchedBrowser;
    });

    await _acquireScreenshotBrowser();
    expect(launches).toBe(1);

    alive = false; // first browser now dead; its close() will throw
    const relaunched = await _acquireScreenshotBrowser();
    // A throw while closing the dead handle must not block the relaunch.
    expect(launches).toBe(2);
    expect(relaunched).toBeDefined();
  });

  it("treats a browser whose isConnected() THROWS as dead and relaunches", async () => {
    // A crashed browser's transport can make isConnected() throw rather than
    // return false; that must still be read as dead, not propagated.
    let launches = 0;
    let transportGone = false;
    _setBrowserLauncher(async () => {
      launches += 1;
      const thisLaunch = launches;
      return {
        isConnected: () => {
          if (thisLaunch === 1 && transportGone) throw new Error("transport closed");
          return true;
        },
        close: async () => {},
        newContext: async () => {
          throw new Error("unused");
        },
      } satisfies LaunchedBrowser;
    });

    const first = await _acquireScreenshotBrowser();
    expect(launches).toBe(1);

    transportGone = true; // first browser's isConnected() now throws
    const relaunched = await _acquireScreenshotBrowser();
    expect(launches).toBe(2); // a throwing liveness probe forced a relaunch
    expect(relaunched).not.toBe(first);
  });

  it("single-flights concurrent acquires into one launch", async () => {
    let launches = 0;
    _setBrowserLauncher(async () => {
      launches += 1;
      // Defer so both acquires overlap before the first launch resolves.
      await new Promise((r) => setTimeout(r, 15));
      return makeFakeBrowser(() => true, () => {}, launches);
    });

    const [a, b] = await Promise.all([_acquireScreenshotBrowser(), _acquireScreenshotBrowser()]);
    expect(launches).toBe(1); // both shared one launch
    expect(a).toBe(b);
  });
});
