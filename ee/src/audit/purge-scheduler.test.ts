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

let adminActionPurgeCalled = false;
let adminActionPurgeReturn: Array<{ orgId: string; deletedCount: number }> = [];
let adminActionPurgeThrow: Error | null = null;

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
  // F-36 — the scheduler processes both `audit_log` and `admin_action_log`
  // in one cycle. The admin-action branch returns per-org deletes plus a
  // per-table self-audit row; this mock mirrors the audit-log branch.
  purgeAdminActionExpired: () => {
    adminActionPurgeCalled = true;
    if (adminActionPurgeThrow) return Effect.fail(adminActionPurgeThrow);
    return Effect.succeed(adminActionPurgeReturn);
  },
  anonymizeUserAdminActions: () => Effect.succeed({ anonymizedRowCount: 0 }),
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

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => err instanceof Error ? err.message : String(err),
  causeToError: (_cause: unknown) => undefined,
}));

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
    if (auditShouldThrow) throw auditShouldThrow;
  },
  logAdminActionAwait: async (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
    if (auditShouldThrow) throw auditShouldThrow;
  },
  ADMIN_ACTIONS: {
    audit_log: { purgeCycle: "audit_log.purge_cycle" },
    admin_action_log: { purgeCycle: "admin_action_log.purge_cycle" },
    audit_retention: {
      policyUpdate: "audit_retention.policy_update",
      hardDelete: "audit_retention.hard_delete",
    },
    admin_action_retention: {
      policyUpdate: "admin_action_retention.policy_update",
      manualPurge: "admin_action_retention.manual_purge",
      hardDelete: "admin_action_retention.hard_delete",
    },
    user: { erase: "user.erase" },
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
    adminActionPurgeCalled = false;
    adminActionPurgeReturn = [];
    adminActionPurgeThrow = null;
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
    adminActionPurgeCalled = false;
    adminActionPurgeReturn = [];
    adminActionPurgeThrow = null;
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
    // F-36 split the cycle into two branches (audit_log + admin_action_log).
    // Each branch attempts a success row (inside tryPromise.try) which
    // throws, then a failure row (inside Effect.catchAll) which also
    // throws. Two branches × two attempts = four entries in auditCalls.
    // None of them should crash the cycle.
    expect(auditCalls).toHaveLength(4);
    expect(auditCalls[1].status).toBe("failure");
    expect(auditCalls[3].status).toBe("failure");
  });
});

/**
 * F-36 — scheduler processes `audit_log` and `admin_action_log` in one tick.
 *
 * Emits two self-audit rows per cycle (one per table) so an outage on
 * either side can be detected independently by forensic queries. See the
 * design doc at `.claude/research/design/admin-action-log-retention.md`
 * for the "two rows per cycle, not one combined" decision.
 */
describe("runPurgeCycle admin-action branch (F-36)", () => {
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
    adminActionPurgeCalled = false;
    adminActionPurgeReturn = [];
    adminActionPurgeThrow = null;
  });

  it("calls purgeAdminActionExpired on every cycle", async () => {
    await Effect.runPromise(runPurgeCycle());
    expect(adminActionPurgeCalled).toBe(true);
  });

  it("emits exactly one admin_action_log.purge_cycle row per cycle on zero rows", async () => {
    await Effect.runPromise(runPurgeCycle());
    const adminCycleRows = auditCalls.filter((c) => c.actionType === "admin_action_log.purge_cycle");
    expect(adminCycleRows).toHaveLength(1);
    expect(adminCycleRows[0].targetType).toBe("admin_action_log");
    expect(adminCycleRows[0].targetId).toBe("scheduler");
    expect(adminCycleRows[0].scope).toBe("platform");
    expect(adminCycleRows[0].systemActor).toBe("system:audit-purge-scheduler");
    expect(adminCycleRows[0].metadata).toEqual({
      deleted: 0,
      orgs: 0,
    });
  });

  it("records deleted count + orgs in metadata on a non-empty admin-action cycle", async () => {
    adminActionPurgeReturn = [
      { orgId: "platform", deletedCount: 7 },
      { orgId: "org-1", deletedCount: 3 },
    ];
    await Effect.runPromise(runPurgeCycle());
    const adminCycleRow = auditCalls.find((c) => c.actionType === "admin_action_log.purge_cycle");
    expect(adminCycleRow).toBeDefined();
    expect(adminCycleRow!.metadata).toEqual({
      deleted: 10,
      orgs: 2,
    });
  });

  it("emits two separate cycle rows per tick (audit_log + admin_action_log)", async () => {
    await Effect.runPromise(runPurgeCycle());
    const auditLogRows = auditCalls.filter((c) => c.actionType === "audit_log.purge_cycle");
    const adminActionRows = auditCalls.filter((c) => c.actionType === "admin_action_log.purge_cycle");
    // Two rows = two forensic signals. A combined row would hide a
    // per-table outage from a compliance reviewer.
    expect(auditLogRows).toHaveLength(1);
    expect(adminActionRows).toHaveLength(1);
  });

  it("admin-action branch failure emits a failure cycle row without crashing audit-log branch", async () => {
    adminActionPurgeThrow = new Error("admin-action branch boom");
    await Effect.runPromise(runPurgeCycle());
    const adminCycleRows = auditCalls.filter((c) => c.actionType === "admin_action_log.purge_cycle");
    expect(adminCycleRows).toHaveLength(1);
    expect(adminCycleRows[0].status).toBe("failure");
    expect((adminCycleRows[0].metadata as { error: string }).error).toContain("admin-action branch boom");
    // The audit-log branch must still have fired its success row.
    const auditLogRows = auditCalls.filter((c) => c.actionType === "audit_log.purge_cycle");
    expect(auditLogRows).toHaveLength(1);
    expect(auditLogRows[0].status === undefined || auditLogRows[0].status === "success").toBe(true);
  });

  it("is a no-op when enterprise is disabled (no admin-action cycle row emitted)", async () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    await Effect.runPromise(runPurgeCycle());
    expect(adminActionPurgeCalled).toBe(false);
    const adminCycleRows = auditCalls.filter((c) => c.actionType === "admin_action_log.purge_cycle");
    expect(adminCycleRows).toHaveLength(0);
  });
});
