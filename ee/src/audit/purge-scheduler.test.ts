import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock control variables
// ---------------------------------------------------------------------------

let mockEnterpriseEnabled = true;
let mockLicenseKey: string | undefined = "test-key";
let mockInternalDB = true;
let purgeCalled = false;
let hardDeleteCalled = false;

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
  purgeExpiredEntries: async () => {
    purgeCalled = true;
    return [];
  },
  hardDeleteExpired: async () => {
    hardDeleteCalled = true;
    return { deletedCount: 0 };
  },
  getRetentionPolicy: async () => null,
  setRetentionPolicy: async () => ({}),
  exportAuditLog: async () => ({ content: "", format: "json", rowCount: 0, totalAvailable: 0, truncated: false }),
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
    await runPurgeCycle();
    expect(purgeCalled).toBe(true);
    expect(hardDeleteCalled).toBe(true);
  });

  it("runPurgeCycle is no-op when enterprise disabled", async () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    await runPurgeCycle();
    expect(purgeCalled).toBe(false);
    expect(hardDeleteCalled).toBe(false);
  });
});
