/**
 * Unit tests for abuse prevention engine.
 *
 * Tests anomaly detection, graduated escalation, reinstatement, and config.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
} from "bun:test";

// --- Mocks ---

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  internalExecute: mock(() => {}),
  internalQuery: mock(async () => []),
}));

// --- Import after mocks ---

const {
  recordQueryEvent,
  checkAbuseStatus,
  listFlaggedWorkspaces,
  reinstateWorkspace,
  getAbuseConfig,
  _resetAbuseState,
  _stopCleanup,
} = await import("../abuse");

// Stop cleanup timer to prevent test hangs
_stopCleanup();

describe("Abuse Prevention Engine", () => {
  beforeEach(() => {
    _resetAbuseState();
  });

  describe("getAbuseConfig()", () => {
    it("returns default thresholds", () => {
      const config = getAbuseConfig();
      expect(config.queryRateLimit).toBe(200);
      expect(config.queryRateWindowSeconds).toBe(300);
      expect(config.errorRateThreshold).toBe(0.5);
      expect(config.uniqueTablesLimit).toBe(50);
      expect(config.throttleDelayMs).toBe(2000);
    });
  });

  describe("checkAbuseStatus()", () => {
    it("returns 'none' for unknown workspaces", () => {
      const status = checkAbuseStatus("unknown-ws");
      expect(status.level).toBe("none");
    });

    it("returns 'none' for workspaces with normal activity", () => {
      // Record a few queries — well below threshold
      for (let i = 0; i < 5; i++) {
        recordQueryEvent("ws-normal", { success: true });
      }
      const status = checkAbuseStatus("ws-normal");
      expect(status.level).toBe("none");
    });
  });

  describe("graduated escalation", () => {
    it("escalates to warning on first threshold breach", () => {
      const config = getAbuseConfig();
      // Exceed query rate limit
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-warn", { success: true });
      }
      const status = checkAbuseStatus("ws-warn");
      expect(status.level).toBe("warning");
    });

    it("escalates through warning to throttled with continued abuse", () => {
      const config = getAbuseConfig();
      // Push exactly to the limit + 1 to trigger first warning
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-throttle", { success: true });
      }
      // The escalation count increments on each call over the limit.
      // After exactly limit+1 calls, we should be at least at warning.
      const level = checkAbuseStatus("ws-throttle").level;
      expect(level).not.toBe("none");

      // Adding more queries escalates further. Check throttle delay works for throttled level.
      // Push to throttled by adding a couple more
      for (let i = 0; i < 5; i++) {
        recordQueryEvent("ws-throttle", { success: true });
      }
      const status = checkAbuseStatus("ws-throttle");
      // Should be either throttled or suspended at this point
      expect(["throttled", "suspended"]).toContain(status.level);
      if (status.level === "throttled") {
        expect(status.throttleDelayMs).toBe(config.throttleDelayMs);
      }
    });

    it("escalates to suspended after sustained abuse", () => {
      const config = getAbuseConfig();
      // Exceed rate limit — each subsequent call while over threshold escalates
      // warning (1st breach) → throttled (2nd) → suspended (3rd)
      for (let i = 0; i <= config.queryRateLimit + 5; i++) {
        recordQueryEvent("ws-suspend", { success: true });
      }
      const status = checkAbuseStatus("ws-suspend");
      expect(status.level).toBe("suspended");
    });

    it("stops recording events for suspended workspaces", () => {
      const config = getAbuseConfig();
      // Get to suspended
      for (let i = 0; i <= config.queryRateLimit + 5; i++) {
        recordQueryEvent("ws-stopped", { success: true });
      }
      expect(checkAbuseStatus("ws-stopped").level).toBe("suspended");
      // More events don't change anything (no crash, stays suspended)
      recordQueryEvent("ws-stopped", { success: true });
      expect(checkAbuseStatus("ws-stopped").level).toBe("suspended");
    });

    it("triggers on high error rate", () => {
      // First 5 are success, next 5 are errors — 50% when checked at query 10
      for (let i = 0; i < 5; i++) {
        recordQueryEvent("ws-errors", { success: true });
      }
      // Now push errors to trigger error rate threshold
      for (let i = 0; i < 6; i++) {
        recordQueryEvent("ws-errors", { success: false });
      }
      const status = checkAbuseStatus("ws-errors");
      // Should have been flagged (at least warning level)
      expect(status.level).not.toBe("none");
    });

    it("triggers on unique tables limit", () => {
      const config = getAbuseConfig();
      const tables: string[] = [];
      for (let i = 0; i <= config.uniqueTablesLimit; i++) {
        tables.push(`table_${i}`);
      }
      recordQueryEvent("ws-tables", { success: true, tablesAccessed: tables });
      const status = checkAbuseStatus("ws-tables");
      expect(status.level).toBe("warning");
    });
  });

  describe("listFlaggedWorkspaces()", () => {
    it("returns empty when no workspaces are flagged", () => {
      expect(listFlaggedWorkspaces()).toEqual([]);
    });

    it("returns flagged workspaces sorted by updatedAt desc", () => {
      const config = getAbuseConfig();
      // Flag two workspaces
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-a", { success: true });
      }
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-b", { success: true });
      }
      const flagged = listFlaggedWorkspaces();
      expect(flagged.length).toBe(2);
      expect(flagged[0].level).toBe("warning");
    });

    it("excludes workspaces with level none", () => {
      recordQueryEvent("ws-ok", { success: true });
      expect(listFlaggedWorkspaces()).toEqual([]);
    });
  });

  describe("reinstateWorkspace()", () => {
    it("reinstates a flagged workspace", () => {
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-reinstate", { success: true });
      }
      expect(checkAbuseStatus("ws-reinstate").level).toBe("warning");

      const result = reinstateWorkspace("ws-reinstate", "admin-1");
      expect(result).toBe(true);
      expect(checkAbuseStatus("ws-reinstate").level).toBe("none");
    });

    it("returns false for non-flagged workspaces", () => {
      const result = reinstateWorkspace("ws-nonexistent", "admin-1");
      expect(result).toBe(false);
    });

    it("resets abuse counters on reinstate", () => {
      const config = getAbuseConfig();
      // Get to throttled
      for (let i = 0; i <= config.queryRateLimit + 10; i++) {
        recordQueryEvent("ws-counters", { success: true });
      }
      expect(checkAbuseStatus("ws-counters").level).not.toBe("none");

      reinstateWorkspace("ws-counters", "admin-1");

      // Normal queries after reinstate should not re-trigger
      for (let i = 0; i < 5; i++) {
        recordQueryEvent("ws-counters", { success: true });
      }
      expect(checkAbuseStatus("ws-counters").level).toBe("none");
    });
  });

  describe("normal patterns do not trigger", () => {
    it("does not flag low query rate", () => {
      for (let i = 0; i < 10; i++) {
        recordQueryEvent("ws-normal-rate", { success: true });
      }
      expect(checkAbuseStatus("ws-normal-rate").level).toBe("none");
    });

    it("does not flag low error rate", () => {
      // 10 queries with 2 errors = 20% (below 50%)
      for (let i = 0; i < 10; i++) {
        recordQueryEvent("ws-normal-errors", { success: i < 8 });
      }
      expect(checkAbuseStatus("ws-normal-errors").level).toBe("none");
    });

    it("does not flag small table set", () => {
      recordQueryEvent("ws-normal-tables", {
        success: true,
        tablesAccessed: ["orders", "users", "products"],
      });
      expect(checkAbuseStatus("ws-normal-tables").level).toBe("none");
    });
  });
});
