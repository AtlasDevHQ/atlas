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

// `internalExecute` captured at module scope so tests can assert the
// `INSERT INTO abuse_events (...)` row actually fires from `persistAbuseEvent`
// with the right parameter shape — the F-33 regression floor at the
// lib layer. Without this, the route-level dual-write coverage only
// proves the mocked `reinstateWorkspace` was called, not that the
// abuse_events sink is actually written to.
const mockInternalExecute = mock(() => {});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => _hasInternalDB,
  internalExecute: mockInternalExecute,
  internalQuery: <T>(sql: string, params?: unknown[]) => _internalQueryImpl<T>(sql, params),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// Capture counter increments to verify the abuse Meter wiring without
// standing up an in-memory MeterProvider.
const counterAdds: { value: number; attributes: Record<string, unknown> }[] = [];

mock.module("@atlas/api/lib/metrics", () => ({
  abuseEscalations: {
    add: (value: number, attributes: Record<string, unknown>) => {
      counterAdds.push({ value, attributes });
    },
  },
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
  getAbuseRestoreStatus,
  _resetAbuseState,
} = await import("../abuse");

const { isLoadTestWorkspace } = await import("../../auth/load-test-allowlist");

describe("Abuse Prevention Engine", () => {
  beforeEach(() => {
    _resetAbuseState();
    resetLogCalls();
    setInternalDB(false);
    setInternalQuery(async () => []);
    mockInternalExecute.mockClear();
    counterAdds.length = 0;
    // Every legacy fast-walk test in this file assumes the engine is
    // engaged AND the cooldown gate is open. SaaS mode keeps
    // `recordQueryEvent` from short-circuiting on self-hosted; cooldown=0
    // lets a tight-loop driver walk warning→throttled→suspended without
    // wall-clock waits. Tests that need to exercise the gate override
    // these locally.
    process.env.ATLAS_DEPLOY_MODE = "saas";
    process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "0";
  });


  describe("getAbuseConfig()", () => {
    it("returns default thresholds", () => {
      // The default-thresholds assertion needs `ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS`
      // unset — the global beforeEach pins it to "0" for fast-walk tests, which
      // would mask a missing default. Drop it here, restore in finally.
      const original = process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
      try {
        delete process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
        const config = getAbuseConfig();
        expect(config.queryRateLimit).toBe(200);
        expect(config.queryRateWindowSeconds).toBe(300);
        expect(config.errorRateThreshold).toBe<number>(0.5);
        expect(config.uniqueTablesLimit).toBe(50);
        expect(config.throttleDelayMs).toBe(2000);
        // 60s default — keeps a single failing-SQL burst from walking
        // warning→throttled→suspended in the same second. Pinned here so a
        // future "no one will notice if we drop it to 0" regression trips
        // the suite.
        expect(config.escalationCooldownMs).toBe(60_000);
      } finally {
        if (original === undefined) delete process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
        else process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = original;
      }
    });

    it("envIntAllowZero accepts 0 for cooldown (test/dev opt-out)", () => {
      const original = process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
      try {
        process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "0";
        expect(getAbuseConfig().escalationCooldownMs).toBe(0);
      } finally {
        if (original === undefined) delete process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
        else process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = original;
      }
    });

    it("envIntAllowZero rejects negative cooldown and falls back to default", () => {
      const original = process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
      try {
        process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "-30";
        expect(getAbuseConfig().escalationCooldownMs).toBe(60_000);
      } finally {
        if (original === undefined) delete process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
        else process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = original;
      }
    });

    it("envIntAllowZero rejects fractional / non-integer cooldown values", () => {
      // `parseInt("0.5", 10)` returns `0` and would silently disable the
      // cooldown despite the helper's "only an explicit 0 opts out"
      // contract. The strict `Number.isInteger` parse rejects fractional
      // and unit-suffixed values, falling back to the 60s default.
      const original = process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
      try {
        for (const raw of ["0.5", "0s", "1.5", "30s", "abc", ""]) {
          process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = raw;
          expect(getAbuseConfig().escalationCooldownMs).toBe(60_000);
        }
      } finally {
        if (original === undefined) delete process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS;
        else process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = original;
      }
    });
  });

  describe("escalation cooldown (#2167)", () => {
    // Pre-cooldown: three consecutive over-threshold checks fired in the
    // same millisecond walked `none → warning → throttled → suspended` with
    // no chance for the operator to react or for warn/throttle to take
    // effect. The cooldown gates each ladder rung by a minimum dwell time.

    it("blocks rapid-fire transitions past warning while dwell time is in effect", () => {
      process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "60";
      const config = getAbuseConfig();
      // Drive far past the rate limit in a tight loop — pre-fix this would
      // suspend the workspace; with cooldown it must hold at warning.
      for (let i = 0; i <= config.queryRateLimit + 50; i++) {
        recordQueryEvent("ws-cooldown-hold", { success: true });
      }
      expect(checkAbuseStatus("ws-cooldown-hold").level).toBe("warning");
      // Counter still accumulates so the metrics + admin UI reflect ongoing
      // pressure even when the level isn't advancing.
      const flagged = listFlaggedWorkspaces();
      expect(flagged.find((f) => f.workspaceId === "ws-cooldown-hold")).toBeDefined();
    });

    it("only emits one OTel transition during a held cooldown window", () => {
      process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "60";
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit + 50; i++) {
        recordQueryEvent("ws-cooldown-counter", { success: true });
      }
      // Only the initial `none → warning` transition fires the meter; the
      // suppressed warning→throttled and throttled→suspended bumps must
      // not show up as no-op transitions.
      expect(counterAdds).toEqual([
        { value: 1, attributes: { level: "warning", trigger: "query_rate" } },
      ]);
    });

    it("allows the next rung once dwell time has elapsed", () => {
      // Mock `Date.now` so we can advance virtual time past the cooldown
      // without sleeping. The engine reads `Date.now()` in both
      // `recordQueryEvent` and `escalate` — by mocking the global, we
      // control the entire wall-clock from the test.
      process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "60";
      const origNow = Date.now.bind(Date);
      let virtualNow = origNow();
      const dateNowSpy = mock(() => virtualNow);
      Date.now = dateNowSpy as unknown as typeof Date.now;
      try {
        const config = getAbuseConfig();
        for (let i = 0; i <= config.queryRateLimit; i++) {
          recordQueryEvent("ws-cooldown-advance", { success: true });
        }
        expect(checkAbuseStatus("ws-cooldown-advance").level).toBe("warning");

        // 61s later — past the 60s cooldown.
        virtualNow += 61_000;
        recordQueryEvent("ws-cooldown-advance", { success: true });
        expect(checkAbuseStatus("ws-cooldown-advance").level).toBe("throttled");

        // Still cooldowned again — another rapid call must hold.
        recordQueryEvent("ws-cooldown-advance", { success: true });
        expect(checkAbuseStatus("ws-cooldown-advance").level).toBe("throttled");

        // Advance another cooldown — escalates to suspended.
        virtualNow += 61_000;
        recordQueryEvent("ws-cooldown-advance", { success: true });
        expect(checkAbuseStatus("ws-cooldown-advance").level).toBe("suspended");
      } finally {
        Date.now = origNow as typeof Date.now;
      }
    });

    it("seeds lastLevelChangeAt from the persisted event on rehydrate so the gate carries across restarts", async () => {
      // Without the rehydrate-time seeding, a process restart would reset
      // `lastLevelChangeAt` to undefined and the very next over-threshold
      // check would advance the ladder — collapsing the cooldown across
      // boots. The fix seeds it from `abuse_events.created_at`.
      process.env.ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS = "60";
      setInternalDB(true);
      const justNowIso = new Date().toISOString();
      setInternalQuery(async () => [
        {
          workspace_id: "ws-restart-gate",
          level: "warning",
          trigger_type: "query_rate",
          message: "rehydrated warning",
          created_at: justNowIso,
        },
      ]);
      await restoreAbuseState();
      expect(checkAbuseStatus("ws-restart-gate").level).toBe("warning");

      // Right after restart the cooldown is still active — a single
      // over-threshold check must NOT advance to throttled.
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit + 5; i++) {
        recordQueryEvent("ws-restart-gate", { success: true });
      }
      expect(checkAbuseStatus("ws-restart-gate").level).toBe("warning");
    });
  });

  describe("self-hosted deploy bypass", () => {
    it("recordQueryEvent skips when ATLAS_DEPLOY_MODE !== 'saas'", () => {
      // Drop the env var entirely — self-hosted is the unset default.
      delete process.env.ATLAS_DEPLOY_MODE;
      const config = getAbuseConfig();
      // Same loop that suspends a saas workspace.
      for (let i = 0; i <= config.queryRateLimit + 50; i++) {
        recordQueryEvent("ws-selfhost", { success: true });
      }
      // Engine is fully disengaged — no escalation, no event log, no
      // workspace entry in the in-memory map.
      expect(listFlaggedWorkspaces()).toEqual([]);
      expect(counterAdds).toEqual([]);
    });

    it("checkAbuseStatus reports 'none' when ATLAS_DEPLOY_MODE !== 'saas' even with stale suspended state", () => {
      // Seed state under saas mode so the in-memory map carries a
      // suspended record, then flip to self-hosted. The read-time gate
      // must lift the suspension so the chat gate doesn't keep blocking.
      process.env.ATLAS_DEPLOY_MODE = "saas";
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit + 5; i++) {
        recordQueryEvent("ws-mode-flip", { success: true });
      }
      expect(checkAbuseStatus("ws-mode-flip").level).toBe("suspended");

      delete process.env.ATLAS_DEPLOY_MODE;
      expect(checkAbuseStatus("ws-mode-flip").level).toBe("none");
      expect(checkAbuseStatus("ws-mode-flip").throttleDelayMs).toBeUndefined();
    });

    it("non-'saas' deploy mode values (e.g. 'self-hosted', 'auto') skip the engine", () => {
      // The startup gate only treats 'saas' as the enable signal — any
      // other value (including the canonical 'self-hosted' and the
      // pre-resolution 'auto') must bypass.
      for (const mode of ["self-hosted", "auto", "unknown"]) {
        _resetAbuseState();
        process.env.ATLAS_DEPLOY_MODE = mode;
        const config = getAbuseConfig();
        for (let i = 0; i <= config.queryRateLimit + 5; i++) {
          recordQueryEvent(`ws-${mode}`, { success: true });
        }
        expect(checkAbuseStatus(`ws-${mode}`).level).toBe("none");
      }
    });

    it("admin abuse views are bypassed alongside enforcement on self-hosted", async () => {
      // Seed a suspended workspace under saas mode, then flip to
      // self-hosted. The admin list + detail must collapse to the
      // disengaged shape (empty list / null detail) so an operator can't
      // reinstate a workspace that's already not being blocked.
      process.env.ATLAS_DEPLOY_MODE = "saas";
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit + 5; i++) {
        recordQueryEvent("ws-admin-bypass", { success: true });
      }
      expect(listFlaggedWorkspaces().length).toBeGreaterThan(0);
      expect(await getAbuseDetail("ws-admin-bypass")).not.toBeNull();

      delete process.env.ATLAS_DEPLOY_MODE;
      expect(listFlaggedWorkspaces()).toEqual([]);
      expect(await getAbuseDetail("ws-admin-bypass")).toBeNull();
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

    // #2166 — load-test allowlist. Workspaces in
    // ATLAS_LOADTEST_ALLOWED_ORGS (the same allowlist that gates the
    // self-mint MCP load-test JWT endpoint) skip every counter so they
    // cannot escalate past `none`, regardless of how aggressively they
    // hammer the rate limits.
    it("does not escalate workspaces in ATLAS_LOADTEST_ALLOWED_ORGS", () => {
      const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-loadtest";
      try {
        const config = getAbuseConfig();
        // Same loop that suspends a non-allowlisted org in the prior tests.
        for (let i = 0; i <= config.queryRateLimit + 5; i++) {
          recordQueryEvent("ws-loadtest", { success: true });
        }
        expect(checkAbuseStatus("ws-loadtest").level).toBe("none");
        // First skip emits a single info log; subsequent skips stay quiet.
        const skipLogs = infoCalls.filter((c) =>
          c.msg.includes("ATLAS_LOADTEST_ALLOWED_ORGS"),
        );
        expect(skipLogs.length).toBe(1);
      } finally {
        if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
      }
    });

    // Regression for the platform-admin "looks fine while chat is blocked"
    // bug — a workspace that escalated to suspended *before* it was added
    // to ATLAS_LOADTEST_ALLOWED_ORGS must report `none` once allowlisted,
    // even though the in-memory state still says `suspended`. Without this
    // guard, `recordQueryEvent` would skip new events but the chat path
    // would keep reading the stale `suspended` level forever.
    it("checkAbuseStatus returns 'none' for allowlisted workspaces even with stale suspended state", () => {
      const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      try {
        // Defensive — a prior test that forgot to restore the env could
        // short-circuit the suspension setup below via `recordQueryEvent`'s
        // allowlist guard, masking a regression as "still works."
        delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        // Drive the workspace to suspended *without* the allowlist set.
        const config = getAbuseConfig();
        for (let i = 0; i <= config.queryRateLimit + 5; i++) {
          recordQueryEvent("ws-late-allowlist", { success: true });
        }
        expect(checkAbuseStatus("ws-late-allowlist").level).toBe("suspended");

        // Now add to the allowlist — read-time guard must lift the suspension.
        process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-late-allowlist";
        expect(checkAbuseStatus("ws-late-allowlist").level).toBe("none");
        expect(checkAbuseStatus("ws-late-allowlist").throttleDelayMs).toBeUndefined();
      } finally {
        if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
      }
    });

    // Companion: pins the throttled-branch path that the suspended-seed
    // test above couldn't reach. `checkAbuseStatus`'s throttled arm
    // constructs `throttleDelayMs`; the suspended arm never builds it.
    // A refactor that drops the allowlist guard from the `throttled`
    // arm would leak the delay value here.
    it("checkAbuseStatus returns 'none' (no throttleDelayMs) for an allowlisted-with-throttled workspace", () => {
      const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      try {
        delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        const config = getAbuseConfig();
        // Drive through warning → throttled but stop short of suspended.
        // Each call over the limit bumps escalations; the ladder hits
        // throttled at the second escalation.
        for (let i = 0; i <= config.queryRateLimit + 1; i++) {
          recordQueryEvent("ws-throttle-allowlist", { success: true });
        }
        // Seed state should be throttled, not suspended.
        expect(checkAbuseStatus("ws-throttle-allowlist").level).toBe("throttled");
        expect(checkAbuseStatus("ws-throttle-allowlist").throttleDelayMs).toBe(
          config.throttleDelayMs,
        );

        process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-throttle-allowlist";
        const status = checkAbuseStatus("ws-throttle-allowlist");
        expect(status.level).toBe("none");
        expect(status.throttleDelayMs).toBeUndefined();
      } finally {
        if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
      }
    });

    // Companion to the read-time guard above: a fresh process restarting
    // with persisted `abuse_events` rows for an allowlisted workspace must
    // skip rehydration. Otherwise a later `delete ATLAS_LOADTEST_ALLOWED_ORGS`
    // would snap the workspace back to suspended without any new escalation.
    it("restoreAbuseState skips workspaces in the allowlist", async () => {
      const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      // Two allowlisted IDs so the `allowlistSkippedIds` assertion
      // distinguishes "pinned contents" from "pinned length" — a
      // regression that pushed `row.workspace_id` once per loop
      // iteration or a constant value would pass with a single-row
      // seed.
      process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-rehydrate-skip-a,ws-rehydrate-skip-b";
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          workspace_id: "ws-rehydrate-skip-a",
          level: "suspended",
          trigger_type: "query_rate",
          message: "old suspension a",
          created_at: "2026-04-01T00:00:00Z",
        },
        {
          workspace_id: "ws-rehydrate-skip-b",
          level: "throttled",
          trigger_type: "query_rate",
          message: "old throttle b",
          created_at: "2026-04-01T00:00:00Z",
        },
        {
          workspace_id: "ws-rehydrate-keep",
          level: "suspended",
          trigger_type: "query_rate",
          message: "should still rehydrate",
          created_at: "2026-04-01T00:00:00Z",
        },
      ]);
      try {
        await restoreAbuseState();
        expect(checkAbuseStatus("ws-rehydrate-skip-a").level).toBe("none");
        expect(checkAbuseStatus("ws-rehydrate-skip-b").level).toBe("none");
        expect(checkAbuseStatus("ws-rehydrate-keep").level).toBe("suspended");
        // Restore log includes both counts and the offending IDs so
        // operators can recover from an env-var typo with logs alone
        // (over-skip via a bare count is unrecoverable). Asserting
        // both `restored` and `allowlistSkipped` together catches the
        // symmetric regression: an over-skip would inflate
        // `allowlistSkipped`, an under-skip would inflate `restored`.
        const restoreLog = infoCalls.find((c) =>
          c.msg.includes("Restored abuse state"),
        );
        expect(restoreLog).toBeDefined();
        expect(restoreLog?.ctx.count).toBe(1);
        expect(restoreLog?.ctx.allowlistSkipped).toBe(2);
        // Order follows `internalQuery` row order — the rehydrate
        // loop pushes IDs in iteration order, not lexicographic.
        expect(restoreLog?.ctx.allowlistSkippedIds).toEqual([
          "ws-rehydrate-skip-a",
          "ws-rehydrate-skip-b",
        ]);
      } finally {
        if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
      }
    });

    // Companion to the rehydrate-skip test: the restore status getter
    // surfaces the boot outcome so the platform-admin page can warn
    // when in-memory state is empty because rehydration *failed*, not
    // because the workspace is genuinely clean.
    it("getAbuseRestoreStatus reports the last restoreAbuseState outcome", async () => {
      expect(getAbuseRestoreStatus()).toBe("pending");

      setInternalDB(true);
      setInternalQuery(async () => []);
      await restoreAbuseState();
      expect(getAbuseRestoreStatus()).toBe("ok");

      setInternalQuery(async () => {
        throw new Error("simulated DB outage");
      });
      await restoreAbuseState();
      expect(getAbuseRestoreStatus()).toBe("load_failed");

      setInternalDB(false);
      await restoreAbuseState();
      expect(getAbuseRestoreStatus()).toBe("db_unavailable");
    });

    it("isLoadTestWorkspace reflects env-var changes without restart", () => {
      const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      try {
        delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        expect(isLoadTestWorkspace("ws-x")).toBe(false);
        process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-x, ws-y ,  ";
        // Whitespace + empty entries get trimmed/dropped.
        expect(isLoadTestWorkspace("ws-x")).toBe(true);
        expect(isLoadTestWorkspace("ws-y")).toBe(true);
        expect(isLoadTestWorkspace("ws-z")).toBe(false);
      } finally {
        if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
      }
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

  describe("OTel counter wiring (#1979)", () => {
    it("increments abuseEscalations counter on every level transition", () => {
      const config = getAbuseConfig();
      // Drive through warning → throttled → suspended.
      for (let i = 0; i <= config.queryRateLimit + 5; i++) {
        recordQueryEvent("ws-counter", { success: true });
      }
      // One increment per transition, never one per query.
      expect(counterAdds.length).toBe(3);
      expect(counterAdds[0]).toEqual({
        value: 1,
        attributes: { level: "warning", trigger: "query_rate" },
      });
      expect(counterAdds[1]).toEqual({
        value: 1,
        attributes: { level: "throttled", trigger: "query_rate" },
      });
      expect(counterAdds[2]).toEqual({
        value: 1,
        attributes: { level: "suspended", trigger: "query_rate" },
      });
    });

    it("increments counter on manual reinstate with level=none, trigger=manual", () => {
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-reinstate-counter", { success: true });
      }
      counterAdds.length = 0;
      reinstateWorkspace("ws-reinstate-counter", "admin-1");
      expect(counterAdds).toEqual([
        { value: 1, attributes: { level: "none", trigger: "manual" } },
      ]);
    });

    it("does not increment counter when threshold isn't crossed", () => {
      // Small number of healthy queries — never crosses any threshold.
      for (let i = 0; i < 20; i++) {
        recordQueryEvent("ws-quiet", { success: true });
      }
      expect(counterAdds).toEqual([]);
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

    // Mirrors `checkAbuseStatus`'s read-time allowlist guard — without
    // this filter, the abuse console keeps showing an allowlisted-
    // suspended workspace forever even though every other read path
    // (chat gate, platform-admin abuseLevel, etc.) reports it as none.
    // A reinstate click on such a row would be a no-op.
    it("filters out allowlisted workspaces even when in-memory state is non-none", () => {
      const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      try {
        delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        const config = getAbuseConfig();
        for (let i = 0; i <= config.queryRateLimit; i++) {
          recordQueryEvent("ws-late-allow", { success: true });
        }
        expect(checkAbuseStatus("ws-late-allow").level).toBe("warning");

        process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-late-allow";
        expect(listFlaggedWorkspaces()).toEqual([]);

        // Pin the underlying state is *filtered*, not *deleted* — a
        // future refactor that drops the in-memory entry would also
        // pass the `toEqual([])` check but break the "remove from
        // allowlist → snap back to warning" semantic the rest of the
        // suite relies on. Clearing the env restores the read-time
        // view of the preserved state.
        delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        expect(checkAbuseStatus("ws-late-allow").level).toBe("warning");
        expect(listFlaggedWorkspaces()).toHaveLength(1);
      } finally {
        if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
        else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
      }
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
      const flaggedLevel = checkAbuseStatus("ws-counters").level;
      // TS can't narrow `flaggedLevel` off the `not.toBe("none")` runtime
      // assertion, so the inline guard narrows it to `ReinstatedLevel`
      // before the structural comparison below.
      if (flaggedLevel === "none") {
        throw new Error("expected workspace to be flagged before reinstate");
      }

      const result = reinstateWorkspace("ws-counters", "admin-1");
      // F-33: pins that the returned `previousLevel` matches the actual
      // escalation depth reached — proves a future refactor reading
      // state.level *after* the reset (= "none") trips the suite.
      expect(result).toBe(flaggedLevel);

      // Normal queries after reinstate should not re-trigger
      for (let i = 0; i < 5; i++) {
        recordQueryEvent("ws-counters", { success: true });
      }
      expect(checkAbuseStatus("ws-counters").level).toBe("none");
    });

    it("persists an abuse_events row with previousLevel metadata when DB is available (#1788, F-33)", () => {
      // Route-level tests mock `reinstateWorkspace` wholesale, so without
      // this assertion nothing pins that `persistAbuseEvent` actually
      // fires the `INSERT INTO abuse_events` SQL with the right params.
      // A regression that deletes the `persistAbuseEvent(event)` call in
      // `reinstateWorkspace`, or drops `previousLevel` from the event
      // metadata, would pass the route suite silently.
      setInternalDB(true);
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-persist", { success: true });
      }
      // `recordQueryEvent` escalations emit their own abuse_events rows;
      // clear so the assertion below only sees the reinstate INSERT.
      mockInternalExecute.mockClear();

      const result = reinstateWorkspace("ws-persist", "admin-1");
      expect(result).toBe("warning");

      expect(mockInternalExecute).toHaveBeenCalledTimes(1);
      const call = mockInternalExecute.mock.calls[0] as unknown as [string, unknown[]];
      expect(call[0]).toContain("INSERT INTO abuse_events");
      const params = call[1];
      // Columns: (id, workspace_id, level, trigger_type, message, metadata, actor, created_at)
      expect(params[1]).toBe("ws-persist");
      expect(params[2]).toBe("none");
      expect(params[3]).toBe("manual");
      expect(params[6]).toBe("admin-1");
      const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
      expect(metadata.previousLevel).toBe("warning");
    });

    it("skips the abuse_events INSERT when no internal DB is configured (#1788, F-33)", () => {
      // Symmetric degradation with `logAdminAction` — both DB-backed
      // writes bail when `hasInternalDB()` is false. The route surfaces
      // this to the admin via `auditPersisted: false`.
      setInternalDB(false);
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-no-db", { success: true });
      }
      mockInternalExecute.mockClear();

      const result = reinstateWorkspace("ws-no-db", "admin-1");
      expect(result).toBe("warning");
      expect(mockInternalExecute).not.toHaveBeenCalled();
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

    it("surfaces triggerCounters from the latest escalation event's metadata (#2167)", async () => {
      // Pre-fix, a suspended workspace's live counters showed 0 queries / 0
      // tables / no error rate (the sliding window prunes after 5min while
      // `recordQueryEvent` short-circuits at the suspended level), yet the
      // trigger message + level still showed "Error rate 75% exceeds
      // threshold 50%". The frozen at-trigger snapshot from
      // `abuse_events.metadata` is what makes the admin panel coherent
      // again — pin both the shape and the metadata-passthrough here so a
      // future refactor that drops the metadata read trips the suite.
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-trigger-counters", { success: true });
      }
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "evt-trigger",
          workspace_id: "ws-trigger-counters",
          level: "warning",
          trigger_type: "error_rate",
          message: "Error rate 75% exceeds threshold 50%",
          metadata: JSON.stringify({
            queryCount: 12,
            errorCount: 9,
            uniqueTables: 3,
            escalations: 1,
          }),
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      const detail = await getAbuseDetail("ws-trigger-counters");
      expect(detail).not.toBeNull();
      if (!detail) return;

      expect(detail.triggerCounters).not.toBeNull();
      // queryCount + errorCount come directly from the persisted metadata —
      // they reflect the moment of escalation, not the live (now-pruned)
      // sliding window.
      expect(detail.triggerCounters?.queryCount).toBe(12);
      expect(detail.triggerCounters?.errorCount).toBe(9);
      // errorRatePct is recomputed from queryCount/errorCount via the
      // shared `errorRatePct` helper so it matches the engine's own
      // 2-decimal rounding — NOT scraped from the human-readable message
      // string.
      expect(detail.triggerCounters?.errorRatePct).toBe<number>(75);
      expect(detail.triggerCounters?.uniqueTablesAccessed).toBe(3);
      expect(detail.triggerCounters?.escalations).toBe(1);
    });

    it("returns triggerCounters=null when no events have persisted yet", async () => {
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-no-events", { success: true });
      }
      setInternalDB(true);
      setInternalQuery(async () => []);

      const detail = await getAbuseDetail("ws-no-events");
      expect(detail).not.toBeNull();
      if (!detail) return;
      // No abuse_events row yet → no at-trigger snapshot. UI falls back to
      // the live counters for this case (and renders the original "Current
      // counters" heading).
      expect(detail.triggerCounters).toBeNull();
      // Live counters still populated from in-memory window.
      expect(detail.counters.queryCount).toBe(config.queryRateLimit + 1);
    });

    it("coerces hostile / corrupt metadata to 0 rather than rendering NaN", async () => {
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-corrupt-md", { success: true });
      }
      setInternalDB(true);
      // Metadata fields with non-numeric strings — Number() returns NaN.
      // The Number.isFinite guard inside `triggerCountersFromInstance`
      // must clamp these to 0 so the wire schema (z.number()) doesn't
      // reject the response.
      setInternalQuery(async () => [
        {
          id: "evt-bad-md",
          workspace_id: "ws-corrupt-md",
          level: "warning",
          trigger_type: "query_rate",
          message: "bad metadata",
          metadata: JSON.stringify({
            queryCount: "not a number",
            errorCount: null,
            uniqueTables: undefined,
            escalations: "five",
          }),
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      const detail = await getAbuseDetail("ws-corrupt-md");
      expect(detail).not.toBeNull();
      if (!detail) return;
      expect(detail.triggerCounters).not.toBeNull();
      // All fields land at 0 — no NaN escapes to the wire.
      expect(detail.triggerCounters?.queryCount).toBe(0);
      expect(detail.triggerCounters?.errorCount).toBe(0);
      expect(detail.triggerCounters?.uniqueTablesAccessed).toBe(0);
      expect(detail.triggerCounters?.escalations).toBe(0);
      // queryCount=0 → below the 10-query baseline → errorRatePct null.
      expect(detail.triggerCounters?.errorRatePct).toBeNull();
    });

    it("clamps negative metadata counts so errorRatePct precondition isn't violated", async () => {
      // `errorRatePct` throws on non-finite or negative inputs. Pre-clamp,
      // a corrupt `abuse_events` row with `queryCount >= 10` and
      // `errorCount: -1` (partial-write race) would throw out of
      // `triggerCountersFromInstance` and 500 the entire admin detail
      // page. Sanitize to non-negative floor before the call so the
      // panel renders and operators can still investigate the workspace.
      const config = getAbuseConfig();
      for (let i = 0; i <= config.queryRateLimit; i++) {
        recordQueryEvent("ws-neg-md", { success: true });
      }
      setInternalDB(true);
      setInternalQuery(async () => [
        {
          id: "evt-neg-md",
          workspace_id: "ws-neg-md",
          level: "warning",
          trigger_type: "query_rate",
          message: "negative metadata",
          metadata: JSON.stringify({
            queryCount: 50,
            errorCount: -3, // negative → would have thrown
            uniqueTables: -1,
            escalations: 1,
          }),
          actor: "system",
          created_at: "2026-04-19T10:00:00Z",
        },
      ]);

      const detail = await getAbuseDetail("ws-neg-md");
      expect(detail).not.toBeNull();
      if (!detail) return;
      expect(detail.triggerCounters).not.toBeNull();
      expect(detail.triggerCounters?.queryCount).toBe(50);
      expect(detail.triggerCounters?.errorCount).toBe(0);
      expect(detail.triggerCounters?.uniqueTablesAccessed).toBe(0);
      // 0 / 50 = 0% — clean number, no NaN, no throw.
      expect(detail.triggerCounters?.errorRatePct).toBe<number>(0);
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
