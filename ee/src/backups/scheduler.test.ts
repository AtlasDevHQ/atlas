import { describe, it, expect, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ──────────────────────────────────────────────────────────

const ee = createEEMock();
mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Mock engine functions. Schedule is "* * * * *" so the tick always
// proceeds past the cron gate when exercised directly.
const mockBackupResult = { id: "b1", storagePath: "/tmp/b1.sql.gz", sizeBytes: 1000, status: "completed" as const };
const mockPurgeCount = 0;
const mockConfig = { schedule: "* * * * *", retention_days: 30, storage_path: "./backups" };

mock.module("./engine", () => ({
  ensureTable: () => Effect.void,
  createBackup: () => Effect.succeed(mockBackupResult),
  purgeExpiredBackups: () => Effect.succeed(mockPurgeCount),
  getBackupConfig: () => Effect.succeed(mockConfig),
  updateBackupConfig: () => Effect.void,
  listBackups: () => Effect.succeed([]),
  getBackupById: () => Effect.succeed(null),
  listStorageFiles: () => Effect.succeed([]),
  _resetTableReady: () => {},
}));

// Verify mock — spy so we can assert the tick verifies each backup (#2941).
let verifyResult: { verified: boolean; message: string } = { verified: true, message: "ok" };
const verifySpy = mock((backupId: string) => Effect.succeed({ ...verifyResult, backupId }));
mock.module("./verify", () => ({ verifyBackup: verifySpy }));

// Import after mocks — exercises the cron helper and the tick.
const { _cronMatchesNow, _tick, stopScheduler } = await import("./scheduler");

// ── Tests ──────────────────────────────────────────────────────────

describe("_cronMatchesNow (cron expression matching)", () => {
  it("matches wildcard (* * * * *) always", () => {
    expect(_cronMatchesNow("* * * * *")).toBe(true);
  });

  it("matches specific minute", () => {
    const now = new Date();
    const minute = now.getUTCMinutes();
    expect(_cronMatchesNow(`${minute} * * * *`)).toBe(true);
    expect(_cronMatchesNow(`${(minute + 1) % 60} * * * *`)).toBe(false);
  });

  it("matches step values (*/5)", () => {
    const now = new Date();
    const minute = now.getUTCMinutes();
    // */1 matches every minute
    expect(_cronMatchesNow("*/1 * * * *")).toBe(true);
    // Check if current minute is divisible by 5
    if (minute % 5 === 0) {
      expect(_cronMatchesNow("*/5 * * * *")).toBe(true);
    } else {
      expect(_cronMatchesNow("*/5 * * * *")).toBe(false);
    }
  });

  it("matches range (10-20)", () => {
    const now = new Date();
    const minute = now.getUTCMinutes();
    if (minute >= 10 && minute <= 20) {
      expect(_cronMatchesNow("10-20 * * * *")).toBe(true);
    } else {
      expect(_cronMatchesNow("10-20 * * * *")).toBe(false);
    }
  });

  it("matches comma-separated values", () => {
    const now = new Date();
    const minute = now.getUTCMinutes();
    expect(_cronMatchesNow(`${minute},${(minute + 30) % 60} * * * *`)).toBe(true);
    expect(_cronMatchesNow(`${(minute + 1) % 60},${(minute + 2) % 60} * * * *`)).toBe(false);
  });

  it("rejects invalid cron (not 5 fields)", () => {
    expect(_cronMatchesNow("* * *")).toBe(false); // only 3 fields
    expect(_cronMatchesNow("")).toBe(false);
  });

  it("matches range with step (1-30/2)", () => {
    const now = new Date();
    const minute = now.getUTCMinutes();
    if (minute >= 1 && minute <= 30 && (minute - 1) % 2 === 0) {
      expect(_cronMatchesNow("1-30/2 * * * *")).toBe(true);
    } else {
      expect(_cronMatchesNow("1-30/2 * * * *")).toBe(false);
    }
  });
});

describe("tick — backup verification (#2941)", () => {
  it("verifies each backup after creating it, and a failed verify does not crash the tick", async () => {
    // A failed verify must be handled (logged) without throwing out of the
    // tick — otherwise one corrupt dump would kill the scheduler fiber.
    verifyResult = { verified: false, message: "truncated dump" };

    await Effect.runPromise(_tick());

    // The created backup's id is passed straight to verifyBackup.
    expect(verifySpy).toHaveBeenCalledWith("b1");
  });
});

describe("stopScheduler", () => {
  it("can be called safely when no scheduler is running", () => {
    expect(() => stopScheduler()).not.toThrow();
  });
});
