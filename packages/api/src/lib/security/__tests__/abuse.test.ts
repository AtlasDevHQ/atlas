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
  getAbuseDetail,
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
      expect(config.errorRateThreshold).toBe<number>(0.5);
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
      // F-33: returns the previous level so the route can audit the delta
      // without a second getter call. Here the workspace was warning-level
      // so we get "warning" back (not a boolean).
      expect(result).toBe("warning");
      expect(checkAbuseStatus("ws-reinstate").level).toBe("none");
    });

    it("returns null for non-flagged workspaces", () => {
      const result = reinstateWorkspace("ws-nonexistent", "admin-1");
      expect(result).toBeNull();
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

      const { events, status } = await getAbuseEvents("ws-drift", 10);

      expect(status).toBe("ok");
      expect(events.length).toBe(1);
      expect(events[0]!.level).toBe("none");
      expect(events[0]!.trigger).toBe("query_rate");

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

      const { events, status } = await getAbuseEvents("ws-drift", 10);

      expect(status).toBe("ok");
      expect(events.length).toBe(1);
      expect(events[0]!.level).toBe("warning");
      expect(events[0]!.trigger).toBe("manual");

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

      const { events } = await getAbuseEvents("ws-drift", 10);

      expect(events[0]!.level).toBe("none");
      expect(events[0]!.trigger).toBe("manual");

      const drifts = warnCalls.filter((c) =>
        c.msg.includes("abuse event with drifted enum"),
      );
      expect(drifts.length).toBe(1);
      expect(drifts[0]!.ctx.rowId).toBe("both-bad-1");
      expect(drifts[0]!.ctx.rawLevel).toBe("Mystery");
      expect(drifts[0]!.ctx.rawTrigger).toBe("bogus");
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

      const { events } = await getAbuseEvents("ws-drift", 10);

      expect(events[0]!.level).toBe("none");
      expect(events[0]!.trigger).toBe("manual");
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

      const { events } = await getAbuseEvents("ws-clean", 10);

      expect(events[0]!.level).toBe("throttled");
      expect(events[0]!.trigger).toBe("error_rate");
      expect(
        warnCalls.find((c) => c.msg.includes("abuse event with drifted enum")),
      ).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // getAbuseEvents() poisoned-metadata row isolation (#1683)
  //
  // A single corrupt `abuse_events.metadata` value (truncated JSON, old
  // schema) used to throw inside the row-map and get caught by the outer
  // try/catch — wiping every valid row in the response as if the DB itself
  // had failed. Per-row isolation narrows the blast radius: the bad row is
  // coerced to an empty metadata object with a warn, the rest pass through.
  // ---------------------------------------------------------------------

  describe("getAbuseEvents() poisoned metadata", () => {
    it("returns valid rows and skips the poisoned one", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "clean-a",
          workspace_id: "ws-mixed",
          level: "warning",
          trigger_type: "query_rate",
          message: "ok",
          metadata: '{"queryCount": 10}',
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
        {
          id: "poisoned-1",
          workspace_id: "ws-mixed",
          level: "warning",
          trigger_type: "query_rate",
          message: "bad metadata",
          metadata: '{"unterminated',
          actor: "system",
          created_at: "2026-04-19T10:05:00Z",
        },
        {
          id: "clean-b",
          workspace_id: "ws-mixed",
          level: "throttled",
          trigger_type: "query_rate",
          message: "ok",
          metadata: '{"queryCount": 250}',
          actor: "system",
          created_at: "2026-04-19T10:10:00Z",
        },
      ]);

      const { events, status } = await getAbuseEvents("ws-mixed", 50);

      // All three rows survive — the poisoned one just gets an empty
      // metadata. Status stays "ok" because the query succeeded.
      expect(status).toBe("ok");
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.id)).toEqual([
        "clean-a",
        "poisoned-1",
        "clean-b",
      ]);
      expect(events[0]!.metadata).toEqual({ queryCount: 10 });
      expect(events[1]!.metadata).toEqual({});
      expect(events[2]!.metadata).toEqual({ queryCount: 250 });

      // One warn emitted, naming the bad row so the operator can chase it.
      const corrupt = warnCalls.filter((c) =>
        c.msg.includes("corrupt abuse_events.metadata"),
      );
      expect(corrupt).toHaveLength(1);
      expect(corrupt[0]!.ctx.rowId).toBe("poisoned-1");
    });

    it("does not log a corrupt warn for rows whose metadata parses cleanly", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "clean-1",
          workspace_id: "ws-clean",
          level: "warning",
          trigger_type: "query_rate",
          message: "ok",
          metadata: '{"queryCount": 5}',
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      await getAbuseEvents("ws-clean", 10);

      expect(
        warnCalls.find((c) => c.msg.includes("corrupt abuse_events.metadata")),
      ).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // getAbuseEvents() diagnostic channel (#1682)
  //
  // Before the channel, a DB outage silently degraded events to [] — the
  // detail panel then looked "this workspace has never been flagged" during
  // a transient DB outage. These tests pin the three-state status so a
  // future edit cannot collapse the states and bring the false-empty-
  // history regression back.
  // ---------------------------------------------------------------------

  describe("getAbuseEvents() diagnostic status", () => {
    it("returns status 'db_unavailable' when internal DB is not configured", async () => {
      setInternalDB(false); // self-hosted without DATABASE_URL
      let queryInvoked = false;
      setInternalQuery(async () => {
        queryInvoked = true;
        return [];
      });

      const result = await getAbuseEvents("ws-any", 10);
      expect(result.events).toEqual([]);
      expect(result.status).toBe("db_unavailable");
      expect(queryInvoked).toBe(false); // Short-circuits.
    });

    it("returns status 'load_failed' and warns when the DB query throws", async () => {
      setInternalDB(true);
      setInternalQuery(async () => {
        throw new Error("simulated DB outage");
      });

      const { events, status } = await getAbuseEvents("ws-outage", 10);
      expect(events).toEqual([]);
      expect(status).toBe("load_failed");

      // Loud by design — a silent [] used to be the bug.
      expect(
        warnCalls.find((c) => c.msg.includes("Failed to load abuse events")),
      ).toBeDefined();
    });

    it("returns status 'ok' with a populated payload on a healthy read", async () => {
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "evt-ok",
          workspace_id: "ws-ok",
          level: "warning",
          trigger_type: "query_rate",
          message: "fine",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      const { events, status } = await getAbuseEvents("ws-ok", 10);
      expect(status).toBe("ok");
      expect(events).toHaveLength(1);
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

  // ---------------------------------------------------------------------
  // getAbuseDetail() — integration test against real in-memory state (#1639)
  //
  // Exercises the full read path: the sliding-window counters that
  // `recordQueryEvent` populates in-memory, the fixture rows served back by
  // the mocked `internalQuery`, and the `splitIntoInstances` grouping that
  // runs over them. The function is covered elsewhere only via the route
  // layer's mocks — these tests pin the data-layer behaviour itself.
  // ---------------------------------------------------------------------

  describe("getAbuseDetail() integration", () => {
    it("returns null for unknown / non-flagged workspaces (route decides 404)", async () => {
      // Sanity: no state → null short-circuits before any query runs.
      setInternalDB(true);
      let queryInvoked = false;
      setInternalQuery(async () => {
        queryInvoked = true;
        return [];
      });
      const detail = await getAbuseDetail("ws-unknown");
      expect(detail).toBeNull();
      expect(queryInvoked).toBe(false);
    });

    it("returns null after reinstate (level=none) without querying the DB", async () => {
      // Flag, then reinstate — state exists but level is "none".
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-cleared", { success: true });
      }
      expect(checkAbuseStatus("ws-cleared").level).toBe("warning");
      reinstateWorkspace("ws-cleared", "admin-1");

      setInternalDB(true);
      let queryInvoked = false;
      setInternalQuery(async () => {
        queryInvoked = true;
        return [];
      });
      const detail = await getAbuseDetail("ws-cleared");
      expect(detail).toBeNull();
      // level=none short-circuits before getAbuseEvents runs.
      expect(queryInvoked).toBe(false);
    });

    it("returns full counters + thresholds + open current instance for a flagged workspace", async () => {
      // Trip the query-rate limit to get to "warning" with real counters.
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-detail", {
          success: true,
          tablesAccessed: [`t-${i % 5}`],
        });
      }
      expect(checkAbuseStatus("ws-detail").level).toBe("warning");

      // DB has the single escalation event that `escalate()` would have
      // persisted — we stub it here since `persistAbuseEvent` is mocked.
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "evt-1",
          workspace_id: "ws-detail",
          level: "warning",
          trigger_type: "query_rate",
          message: "query rate exceeded",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      const detail = await getAbuseDetail("ws-detail");
      expect(detail).not.toBeNull();
      if (!detail) return;

      expect(detail.workspaceId).toBe("ws-detail");
      expect(detail.level).toBe("warning");
      expect(detail.workspaceName).toBeNull(); // resolved by the route, not the lib

      // Counters mirror the real in-memory window — 201 queries, 0 errors, 5 tables.
      expect(detail.counters.queryCount).toBe(config.queryRateLimit + 1);
      expect(detail.counters.errorCount).toBe(0);
      expect(detail.counters.errorRatePct).toBe<number>(0); // baseline met, all succeeded (branded Percentage, #1685)
      expect(detail.counters.uniqueTablesAccessed).toBe(5);
      // escalate() bumps `escalations` on every call while over threshold —
      // first breach transitions to warning, subsequent bumps keep going.
      // Pin the exact value so a future regression in the escalation
      // counter is caught, not just "> 0".
      expect(detail.counters.escalations).toBe(1);

      expect(detail.thresholds).toEqual(config);

      // Open current instance (no reinstatement yet), prior history empty.
      expect(detail.currentInstance.endedAt).toBeNull();
      expect(detail.currentInstance.peakLevel).toBe("warning");
      expect(detail.currentInstance.events).toHaveLength(1);
      expect(detail.priorInstances).toEqual([]);
    });

    it("returns null errorRatePct while under the 10-query baseline", async () => {
      // Directly hydrate state so we can control the exact counter values
      // without racing the escalation ladder. `restoreAbuseState` sets level
      // from the most recent event per workspace, landing us at "warning"
      // with a fresh empty window.
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          workspace_id: "ws-baseline",
          level: "warning",
          trigger_type: "manual",
          message: "seeded",
          created_at: "2026-04-19T09:00:00Z",
        },
      ]);
      await restoreAbuseState();

      // Now swap the internalQuery impl so getAbuseEvents returns the same
      // seed row as an AbuseEvent-shaped row.
      setInternalQuery(async () => [
        {
          id: "evt-seed",
          workspace_id: "ws-baseline",
          level: "warning",
          trigger_type: "manual",
          message: "seeded",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T09:00:00Z",
        },
      ]);
      // Add a handful of successful queries (< 10) so queryCount > 0 but
      // below the baseline.
      for (let i = 0; i < 5; i++) {
        recordQueryEvent("ws-baseline", { success: true });
      }

      const detail = await getAbuseDetail("ws-baseline");
      expect(detail).not.toBeNull();
      if (!detail) return;

      expect(detail.counters.queryCount).toBe(5);
      // Below the 10-query baseline, errorRatePct is null — not 0 — so the
      // UI can distinguish "no data" from "all successful".
      expect(detail.counters.errorRatePct).toBeNull();
    });

    it("preserves prior history on a re-flagged workspace (reinstated-on-evidence)", async () => {
      // In-memory state: re-flagged via recordQueryEvent so level != "none".
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-rehist", { success: true });
      }
      expect(checkAbuseStatus("ws-rehist").level).not.toBe("none");

      // DB rows: [old escalation] → [manual reinstate] → [new escalation],
      // returned newest-first as `getAbuseEvents` would.
      setInternalDB(true);
      setInternalQuery(async () => [
        // Newest: re-flagged after reinstatement
        {
          id: "evt-new",
          workspace_id: "ws-rehist",
          level: "warning",
          trigger_type: "query_rate",
          message: "re-flagged",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T12:00:00Z",
        },
        // Prior boundary: manual reinstatement
        {
          id: "evt-reinstate",
          workspace_id: "ws-rehist",
          level: "none",
          trigger_type: "manual",
          message: "reinstated",
          metadata: "{}",
          actor: "admin-1",
          created_at: "2026-04-19T11:00:00Z",
        },
        // Oldest: prior escalation (peak of the closed instance)
        {
          id: "evt-old",
          workspace_id: "ws-rehist",
          level: "throttled",
          trigger_type: "query_rate",
          message: "old escalation",
          metadata: "{}",
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      const detail = await getAbuseDetail("ws-rehist", 5, 50);
      expect(detail).not.toBeNull();
      if (!detail) return;

      // Current instance: only the newest (post-reinstate) escalation.
      expect(detail.currentInstance.events).toHaveLength(1);
      expect(detail.currentInstance.events[0]!.id).toBe("evt-new");
      expect(detail.currentInstance.endedAt).toBeNull();
      expect(detail.currentInstance.peakLevel).toBe("warning");

      // Prior: the closed instance, bookended by the reinstatement event.
      expect(detail.priorInstances).toHaveLength(1);
      const prior = detail.priorInstances[0]!;
      expect(prior.peakLevel).toBe("throttled");
      expect(prior.endedAt).toBe("2026-04-19T11:00:00Z");
      expect(prior.events.map((e) => e.id)).toEqual([
        "evt-old",
        "evt-reinstate",
      ]);
    });

    it("surfaces eventsStatus='load_failed' on DB failure so the UI can warn (#1682)", async () => {
      // Previously this test pinned a silent `events: []` fallback that
      // was indistinguishable from "never flagged" in the UI. The
      // diagnostic channel lets the admin detail panel render a
      // destructive banner instead of false-empty history, so the
      // invariant to pin is now the status tag.
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-dbfail", { success: true });
      }

      setInternalDB(true);
      setInternalQuery(async () => {
        throw new Error("simulated DB outage");
      });

      const detail = await getAbuseDetail("ws-dbfail");
      expect(detail).not.toBeNull();
      if (!detail) return;

      // The admin panel stays useful: in-memory counters render even when
      // the audit trail is momentarily unreachable.
      expect(detail.counters.queryCount).toBe(config.queryRateLimit + 1);
      // But the events payload is explicitly tagged as degraded — the UI
      // treats this differently from an empty history.
      expect(detail.eventsStatus).toBe("load_failed");
      expect(detail.currentInstance.events).toEqual([]);
      expect(detail.priorInstances).toEqual([]);

      // Loud log line corroborates the status so ops can correlate.
      expect(
        warnCalls.find((c) =>
          c.msg.includes("Failed to load abuse events"),
        ),
      ).toBeDefined();
    });

    it("tags eventsStatus='ok' on a successful read (pins the happy-path signal)", async () => {
      // Same workspace-flagged setup as the load_failed test, but the DB
      // returns clean. The status must NOT collapse to the degraded value
      // when there simply are no events yet.
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-clean", { success: true });
      }

      setInternalDB(true);
      setInternalQuery(async () => []);

      const detail = await getAbuseDetail("ws-clean");
      expect(detail).not.toBeNull();
      if (!detail) return;

      expect(detail.eventsStatus).toBe("ok");
      // Empty history on status=ok is the benign "really never flagged" case.
      expect(detail.currentInstance.events).toEqual([]);
      expect(detail.priorInstances).toEqual([]);
    });

    it("tags eventsStatus='db_unavailable' on a self-hosted deploy without DATABASE_URL", async () => {
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-selfhost", { success: true });
      }

      // hasInternalDB() false — the common no-DATABASE_URL case. The
      // status tells the UI this is expected, not a DB outage.
      setInternalDB(false);

      const detail = await getAbuseDetail("ws-selfhost");
      expect(detail).not.toBeNull();
      if (!detail) return;

      expect(detail.eventsStatus).toBe("db_unavailable");
      expect(detail.currentInstance.events).toEqual([]);
      expect(detail.priorInstances).toEqual([]);
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
