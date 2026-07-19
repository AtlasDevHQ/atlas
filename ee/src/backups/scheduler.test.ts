/**
 * Scheduled-backup cycle tests (#4457).
 *
 * The cycle replaced the dead `startScheduler` cron loop: each tick reaps
 * stale claims, atomically claims the current cadence window (via
 * `createScheduledBackup`), and on a won claim runs create→verify→purge.
 * These tests exercise the tick body with the engine/verify seams mocked;
 * the claim's index-backed atomicity is proven against real Postgres in
 * `packages/api/src/lib/db/__tests__/migrate-pg.test.ts` (0177).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ──────────────────────────────────────────────────────────

const ee = createEEMock();
mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

const mockBackupResult = {
  id: "b1",
  storagePath: "./backups/b1.sql.gz",
  sizeBytes: 1000,
  status: "completed" as const,
};

let mockConfig = { schedule: "0 3 * * *", retention_days: 30, storage_path: "./backups" };
let scheduledBackupResult: typeof mockBackupResult | null = mockBackupResult;
let scheduledBackupError: Error | null = null;
const createScheduledBackupSpy = mock((windowKey: string) => {
  void windowKey;
  if (scheduledBackupError) return Effect.fail(scheduledBackupError);
  return Effect.succeed(scheduledBackupResult);
});
const purgeSpy = mock(() => Effect.succeed(2));

mock.module("./engine", () => ({
  ensureTable: () => Effect.void,
  createBackup: () => Effect.succeed(mockBackupResult),
  createScheduledBackup: createScheduledBackupSpy,
  purgeExpiredBackups: purgeSpy,
  getBackupConfig: () => Effect.succeed(mockConfig),
  updateBackupConfig: () => Effect.void,
  listBackups: () => Effect.succeed([]),
  getBackupById: () => Effect.succeed(null),
  listStorageFiles: () => Effect.succeed([]),
  _resetTableReady: () => {},
}));

// Verify mock — spy so we can assert the cycle verifies each backup (#2941).
let verifyResult: { verified: boolean; message: string; level: "full-restore" | "header-only" } = {
  verified: true,
  message: "ok",
  level: "full-restore",
};
const verifySpy = mock((backupId: string) => {
  void backupId;
  return Effect.succeed(verifyResult);
});
mock.module("./verify", () => ({ verifyBackup: verifySpy }));

// Import after mocks
const { runScheduledBackupCycle } = await import("./scheduler");

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

function resetAll() {
  ee.reset();
  createScheduledBackupSpy.mockClear();
  purgeSpy.mockClear();
  verifySpy.mockClear();
  mockConfig = { schedule: "0 3 * * *", retention_days: 30, storage_path: "./backups" };
  scheduledBackupResult = mockBackupResult;
  scheduledBackupError = null;
  verifyResult = { verified: true, message: "ok", level: "full-restore" };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("runScheduledBackupCycle — won claim", () => {
  beforeEach(resetAll);

  it("claims the current window, verifies the backup, and purges", async () => {
    // First internalQuery call = the stale-claim reap UPDATE (empty result).
    ee.queueMockRows([]);

    const result = await run(runScheduledBackupCycle());
    expect(result.status).toBe("ran");
    if (result.status === "ran") {
      expect(result.backupId).toBe("b1");
      expect(result.verified).toBe(true);
      expect(result.verifyLevel).toBe("full-restore");
      expect(result.purged).toBe(2);
    }

    // The window key is deterministic and derived from the daily 03:00
    // cadence (w<cadenceMs>a<anchorMs>-<index>).
    expect(createScheduledBackupSpy).toHaveBeenCalledTimes(1);
    const windowKey = createScheduledBackupSpy.mock.calls[0][0];
    expect(windowKey).toMatch(/^w86400000a10800000-\d+$/);

    expect(verifySpy).toHaveBeenCalledWith("b1");
    expect(purgeSpy).toHaveBeenCalledTimes(1);
  });

  it("a failed verify does not fail the cycle — the result carries verified:false", async () => {
    ee.queueMockRows([]);
    verifyResult = { verified: false, message: "truncated dump", level: "full-restore" };

    const result = await run(runScheduledBackupCycle());
    expect(result.status).toBe("ran");
    if (result.status === "ran") expect(result.verified).toBe(false);
    // Purge still runs — retention enforcement is independent of verify.
    expect(purgeSpy).toHaveBeenCalledTimes(1);
  });

  it("header-only verification still completes the cycle (degraded, logged loudly)", async () => {
    ee.queueMockRows([]);
    verifyResult = { verified: true, message: "header ok", level: "header-only" };

    const result = await run(runScheduledBackupCycle());
    expect(result.status).toBe("ran");
    if (result.status === "ran") expect(result.verifyLevel).toBe("header-only");
  });

  it("issues the stale-claim reap before claiming", async () => {
    ee.queueMockRows([]);
    await run(runScheduledBackupCycle());

    const reap = ee.capturedQueries.find((q) => q.sql.includes("Scheduled backup never completed"));
    expect(reap).toBeDefined();
    expect(reap!.sql).toContain("status = 'in_progress'");
    expect(reap!.sql).toContain("scheduled_window IS NOT NULL");
  });
});

describe("runScheduledBackupCycle — lost claim", () => {
  beforeEach(resetAll);

  it("returns window-already-claimed and skips verify + purge", async () => {
    ee.queueMockRows([]);
    scheduledBackupResult = null;

    const result = await run(runScheduledBackupCycle());
    expect(result.status).toBe("window-already-claimed");
    expect(verifySpy).not.toHaveBeenCalled();
    expect(purgeSpy).not.toHaveBeenCalled();
  });
});

describe("runScheduledBackupCycle — failures stay typed", () => {
  beforeEach(resetAll);

  it("a failed backup propagates in the error channel (fiber-level recovery logs it)", async () => {
    ee.queueMockRows([]);
    scheduledBackupError = new Error("pg_dump exited with code 1");

    await expect(run(runScheduledBackupCycle())).rejects.toThrow("pg_dump exited with code 1");
  });
});

describe("runScheduledBackupCycle — cadence interpretation", () => {
  beforeEach(resetAll);

  it("an unrecognized schedule falls back to the daily 03:00 cadence (fiber keeps running)", async () => {
    ee.queueMockRows([]);
    mockConfig = { ...mockConfig, schedule: "not a cron at all" };

    const result = await run(runScheduledBackupCycle());
    expect(result.status).toBe("ran");
    const windowKey = createScheduledBackupSpy.mock.calls[0][0];
    // Daily default: 24h cadence anchored at 03:00 UTC.
    expect(windowKey).toMatch(/^w86400000a10800000-\d+$/);
  });

  it("an every-6-hours schedule produces a 6h-cadence window key", async () => {
    ee.queueMockRows([]);
    mockConfig = { ...mockConfig, schedule: "0 */6 * * *" };

    const result = await run(runScheduledBackupCycle());
    expect(result.status).toBe("ran");
    const windowKey = createScheduledBackupSpy.mock.calls[0][0];
    expect(windowKey).toMatch(/^w21600000a0-\d+$/);
  });
});
