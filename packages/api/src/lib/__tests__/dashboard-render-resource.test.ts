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
  _resetScreenshotCache,
  _resetScreenshotBrowserState,
  _setRenderFn,
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
