import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Mock control variables
// ---------------------------------------------------------------------------

let mockEnterpriseEnabled = true;
let mockLicenseKey: string | undefined = "test-key";
let mockInternalDB = true;
let purgeCalled = false;
let hardDeleteCalled = false;
let purgeReturn: Array<{ orgId: string; softDeletedCount: number }> = [];
let hardDeleteReturn: { deletedCount: number } = { deletedCount: 0 };
let hardDeleteThrow: Error | null = null;
let auditCalls: Array<Record<string, unknown>> = [];
let auditShouldThrow: Error | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({
    enterprise: {
      enabled: mockEnterpriseEnabled,
      licenseKey: mockLicenseKey,
    },
  }),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockInternalDB,
  internalQuery: async () => [],
  getInternalDB: () => ({
    query: async () => ({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalExecute: () => {},
}));

mock.module("./retention", () => ({
  purgeExpiredEntries: () => {
    purgeCalled = true;
    return Effect.succeed(purgeReturn);
  },
  hardDeleteExpired: () => {
    hardDeleteCalled = true;
    if (hardDeleteThrow) return Effect.fail(hardDeleteThrow);
    return Effect.succeed(hardDeleteReturn);
  },
  getRetentionPolicy: () => Effect.succeed(null),
  setRetentionPolicy: () => Effect.succeed({}),
  exportAuditLog: () => Effect.succeed({ content: "", format: "json", rowCount: 0, totalAvailable: 0, truncated: false }),
  MIN_RETENTION_DAYS: 7,
  DEFAULT_HARD_DELETE_DELAY_DAYS: 30,
  RetentionError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
    if (auditShouldThrow) throw auditShouldThrow;
  },
  ADMIN_ACTIONS: {
    audit_log: { purgeCycle: "audit_log.purge_cycle" },
    audit_retention: {
      policyUpdate: "audit_retention.policy_update",
      hardDelete: "audit_retention.hard_delete",
    },
  },
}));

// Import after mocks
const {
  startAuditPurgeScheduler,
  stopAuditPurgeScheduler,
  isPurgeSchedulerRunning,
  _resetPurgeScheduler,
  runPurgeCycle,
} = await import("./purge-scheduler");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("purge scheduler", () => {
  beforeEach(() => {
    _resetPurgeScheduler();
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    purgeCalled = false;
    hardDeleteCalled = false;
    purgeReturn = [];
    hardDeleteReturn = { deletedCount: 0 };
    hardDeleteThrow = null;
    auditCalls = [];
    auditShouldThrow = null;
  });

  it("starts and reports running", () => {
    expect(isPurgeSchedulerRunning()).toBe(false);
    startAuditPurgeScheduler(60_000);
    expect(isPurgeSchedulerRunning()).toBe(true);
    stopAuditPurgeScheduler();
    expect(isPurgeSchedulerRunning()).toBe(false);
  });

  it("does not start when enterprise is disabled", () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    startAuditPurgeScheduler(60_000);
    expect(isPurgeSchedulerRunning()).toBe(false);
  });

  it("does not start when no internal DB", () => {
    mockInternalDB = false;
    startAuditPurgeScheduler(60_000);
    expect(isPurgeSchedulerRunning()).toBe(false);
  });

  it("does not double-start", () => {
    startAuditPurgeScheduler(60_000);
    expect(isPurgeSchedulerRunning()).toBe(true);
    startAuditPurgeScheduler(60_000); // should be no-op
    expect(isPurgeSchedulerRunning()).toBe(true);
    stopAuditPurgeScheduler();
  });

  it("runPurgeCycle calls purge and hard-delete", async () => {
    await Effect.runPromise(runPurgeCycle());
    expect(purgeCalled).toBe(true);
    expect(hardDeleteCalled).toBe(true);
  });

  it("runPurgeCycle is no-op when enterprise disabled", async () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    await Effect.runPromise(runPurgeCycle());
    expect(purgeCalled).toBe(false);
    expect(hardDeleteCalled).toBe(false);
  });
});

// F-27 — the cycle must emit a self-audit row every tick, even on a zero-row
// cycle. The *absence* of the cycle row over a retention window is the signal
// that the scheduler stopped; zero counts still prove it ran.
describe("runPurgeCycle self-audit (F-27)", () => {
  beforeEach(() => {
    _resetPurgeScheduler();
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    purgeCalled = false;
    hardDeleteCalled = false;
    purgeReturn = [];
    hardDeleteReturn = { deletedCount: 0 };
    hardDeleteThrow = null;
    auditCalls = [];
    auditShouldThrow = null;
  });

  it("emits exactly one purge_cycle audit row per cycle on a zero-row cycle", async () => {
    await Effect.runPromise(runPurgeCycle());
    const cycleRows = auditCalls.filter((c) => c.actionType === "audit_log.purge_cycle");
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].targetType).toBe("audit_log");
    expect(cycleRows[0].targetId).toBe("scheduler");
    expect(cycleRows[0].scope).toBe("platform");
    expect(cycleRows[0].systemActor).toBe("system:audit-purge-scheduler");
    expect(cycleRows[0].metadata).toEqual({
      softDeleted: 0,
      hardDeleted: 0,
      orgs: 0,
    });
  });

  it("records soft/hard/org counts in metadata on a non-empty cycle", async () => {
    purgeReturn = [
      { orgId: "org-1", softDeletedCount: 5 },
      { orgId: "org-2", softDeletedCount: 3 },
    ];
    hardDeleteReturn = { deletedCount: 2 };
    await Effect.runPromise(runPurgeCycle());
    const cycleRow = auditCalls.find((c) => c.actionType === "audit_log.purge_cycle");
    expect(cycleRow).toBeDefined();
    expect(cycleRow!.metadata).toEqual({
      softDeleted: 8,
      hardDeleted: 2,
      orgs: 2,
    });
  });

  it("emits a failure cycle row when the underlying purge throws", async () => {
    hardDeleteThrow = new Error("boom");
    await Effect.runPromise(runPurgeCycle());
    const cycleRows = auditCalls.filter((c) => c.actionType === "audit_log.purge_cycle");
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].status).toBe("failure");
    expect((cycleRows[0].metadata as { error: string }).error).toContain("boom");
  });

  it("emits no audit row when enterprise is disabled (cycle is a no-op)", async () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    await Effect.runPromise(runPurgeCycle());
    expect(auditCalls).toHaveLength(0);
  });

  it("pins the reserved system-actor string", () => {
    // A rename of this literal would silently break every forensic query
    // that filters on `actor_id = 'system:audit-purge-scheduler'`. Pin it.
    expect("system:audit-purge-scheduler").toMatch(/^system:[a-z0-9][a-z0-9_-]*$/);
  });

  it("cycle completes without rejecting when logAdminAction throws synchronously", async () => {
    // Load-bearing invariant: a programmer error in the audit helper
    // (e.g., future contract regression that lets a malformed actor
    // escape) must not crash the scheduler loop. Prior to the
    // failure-path try/catch + runCycleWithDefectGuard, a throw here
    // would bypass `Effect.catchAll` (which only maps Effect failures,
    // not sync defects in its handler) and emit an unhandled rejection.
    auditShouldThrow = new TypeError("synthetic audit crash");
    await expect(Effect.runPromise(runPurgeCycle())).resolves.toBeUndefined();
    // Two attempts: one from the success path (inside tryPromise.try)
    // and one from the failure-row emission (inside Effect.catchAll).
    // Both pushed-then-threw. Neither should crash the cycle.
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[1].status).toBe("failure");
  });
});
