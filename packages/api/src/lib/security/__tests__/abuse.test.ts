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

type LogCall = { msg: string; ctx: Record<string, unknown> };
const warnCalls: LogCall[] = [];
const infoCalls: LogCall[] = [];

function resetLogCalls(): void {
  warnCalls.length = 0;
  infoCalls.length = 0;
}

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: (ctx: Record<string, unknown>, msg: string) => {
      infoCalls.push({ msg, ctx: ctx ?? {} });
    },
    warn: (ctx: Record<string, unknown>, msg: string) => {
      warnCalls.push({ msg, ctx: ctx ?? {} });
    },
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// Reconfigurable internal-DB mock so drift-coercion tests can swap in
// hydration rows without tearing down the whole mock.module registration.
let _hasInternalDB = false;
let _internalQueryImpl: <T>(sql: string, params?: unknown[]) => Promise<T[]> =
  async () => [];

function setInternalDB(enabled: boolean): void {
  _hasInternalDB = enabled;
}
function setInternalQuery<T>(impl: (sql: string, params?: unknown[]) => Promise<T[]>): void {
  _internalQueryImpl = impl as typeof _internalQueryImpl;
}

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => _hasInternalDB,
  internalExecute: mock(() => {}),
  internalQuery: <T>(sql: string, params?: unknown[]) => _internalQueryImpl<T>(sql, params),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// --- Import after mocks ---

const {
  recordQueryEvent,
  checkAbuseStatus,
  listFlaggedWorkspaces,
  reinstateWorkspace,
  getAbuseConfig,
  getAbuseEvents,
  restoreAbuseState,
  _resetAbuseState,
} = await import("../abuse");

describe("Abuse Prevention Engine", () => {
  beforeEach(() => {
    _resetAbuseState();
    resetLogCalls();
    setInternalDB(false);
    setInternalQuery(async () => []);
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

  describe("getAbuseEvents() hydration enum drift", () => {
    it("coerces an unknown level to 'none' and emits a drift warning", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "drift-level-1",
          workspace_id: "ws-drift",
          level: "mystery-level", // not in ABUSE_LEVELS
          trigger_type: "query_rate",
          message: "bad row",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      const events = await getAbuseEvents("ws-drift", 10);

      expect(events.length).toBe(1);
      expect(events[0].level).toBe("none");
      expect(events[0].trigger).toBe("query_rate");

      const drift = warnCalls.find((c) =>
        c.msg.includes("abuse event with drifted enum"),
      );
      expect(drift).toBeDefined();
      expect(drift?.ctx.rowId).toBe("drift-level-1");
      expect(drift?.ctx.rawLevel).toBe("mystery-level");
    });

    it("coerces an unknown trigger_type to 'manual' and emits a drift warning", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "drift-trigger-1",
          workspace_id: "ws-drift",
          level: "warning",
          trigger_type: "bogus_trigger", // not in ABUSE_TRIGGERS
          message: "bad row",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      const events = await getAbuseEvents("ws-drift", 10);

      expect(events.length).toBe(1);
      expect(events[0].level).toBe("warning");
      expect(events[0].trigger).toBe("manual");

      const drift = warnCalls.find((c) =>
        c.msg.includes("abuse event with drifted enum"),
      );
      expect(drift).toBeDefined();
      expect(drift?.ctx.rowId).toBe("drift-trigger-1");
      expect(drift?.ctx.rawTrigger).toBe("bogus_trigger");
    });

    it("emits a single drift warning per row when both enums are bad", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "both-bad-1",
          workspace_id: "ws-drift",
          level: "Mystery",
          trigger_type: "bogus",
          message: "bad row",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      const events = await getAbuseEvents("ws-drift", 10);

      expect(events[0].level).toBe("none");
      expect(events[0].trigger).toBe("manual");

      const drifts = warnCalls.filter((c) =>
        c.msg.includes("abuse event with drifted enum"),
      );
      expect(drifts.length).toBe(1);
      expect(drifts[0].ctx.rowId).toBe("both-bad-1");
      expect(drifts[0].ctx.rawLevel).toBe("Mystery");
      expect(drifts[0].ctx.rawTrigger).toBe("bogus");
    });

    it("coerces null / non-string enum values without throwing", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "non-string-1",
          workspace_id: "ws-drift",
          level: null as unknown as string,
          trigger_type: 42 as unknown as string,
          message: "bad row",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      const events = await getAbuseEvents("ws-drift", 10);

      expect(events[0].level).toBe("none");
      expect(events[0].trigger).toBe("manual");
      expect(
        warnCalls.find((c) => c.msg.includes("abuse event with drifted enum")),
      ).toBeDefined();
    });

    it("does not warn for rows whose enums are already valid", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "clean-1",
          workspace_id: "ws-clean",
          level: "throttled",
          trigger_type: "error_rate",
          message: "fine",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      const events = await getAbuseEvents("ws-clean", 10);

      expect(events[0].level).toBe("throttled");
      expect(events[0].trigger).toBe("error_rate");
      expect(
        warnCalls.find((c) => c.msg.includes("abuse event with drifted enum")),
      ).toBeUndefined();
    });
  });

  describe("restoreAbuseState() fail-safe drift handling", () => {
    it("restores clean rows and skips drifted rows without leaking their level", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          workspace_id: "ws-clean",
          level: "throttled",
          trigger_type: "query_rate",
          message: "clean workspace",
          created_at: "2026-04-19T00:00:00Z",
        },
        {
          // Drifted level — legacy "Suspended" casing that is NOT in the tuple.
          // coerceAbuseEnums will collapse to "none"; restoreAbuseState must
          // count this as a drift-skip rather than silently treating as reinstated.
          workspace_id: "ws-drifted",
          level: "Suspended",
          trigger_type: "manual",
          message: "drifted workspace",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      await restoreAbuseState();

      const flagged = listFlaggedWorkspaces();
      const workspaceIds = flagged.map((f) => f.workspaceId);
      expect(workspaceIds).toContain("ws-clean");
      expect(workspaceIds).not.toContain("ws-drifted");

      // Drift warn fired for the bad row
      expect(
        warnCalls.find(
          (c) =>
            c.msg.includes("abuse event with drifted enum") &&
            c.ctx.rawLevel === "Suspended",
        ),
      ).toBeDefined();

      // Summary log surfaces the drift count — not hidden behind "restored N"
      const summary = infoCalls.find((c) =>
        c.msg.includes("Restored abuse state"),
      );
      expect(summary).toBeDefined();
      expect(summary?.ctx.count).toBe(1);
      expect(summary?.ctx.driftSkipped).toBe(1);
    });

    it("skips a genuinely reinstated 'none' row without counting it as drift", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          workspace_id: "ws-reinstated",
          level: "none",
          trigger_type: "manual",
          message: "reinstated",
          created_at: "2026-04-19T00:00:00Z",
        },
      ]);

      await restoreAbuseState();

      expect(listFlaggedWorkspaces()).toEqual([]);
      // Genuine "none" must NOT trigger a drift warn
      expect(
        warnCalls.find((c) => c.msg.includes("abuse event with drifted enum")),
      ).toBeUndefined();
      // And should not show up in the summary as a drift-skip
      const summary = infoCalls.find((c) =>
        c.msg.includes("Restored abuse state"),
      );
      expect(summary).toBeUndefined();
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
