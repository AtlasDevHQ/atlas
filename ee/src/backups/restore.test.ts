import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ──────────────────────────────────────────────────────────

const ee = createEEMock();
mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!(ee.internalDBMock.hasInternalDB as () => boolean)())
      throw factory?.() ?? new Error(`Internal database required for ${label}.`);
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) =>
    (ee.internalDBMock.hasInternalDB as () => boolean)()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`)),
}));
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Mock engine exports
const validBackup = {
  id: "b1",
  created_at: "2026-01-01",
  size_bytes: "1000",
  status: "completed",
  storage_path: "/tmp/b1.sql.gz",
  retention_expires_at: "2026-02-01",
  error_message: null,
};

let mockGetBackupById: (() => unknown) | null = () => validBackup;
let mockCreateBackupResult = { id: "pre-b1", storagePath: "/tmp/pre.sql.gz", sizeBytes: 500, status: "completed" as const };
let mockCreateBackupError: Error | null = null;

mock.module("./engine", () => ({
  ensureTable: () => Effect.void,
  getBackupById: () => {
    const result = mockGetBackupById?.();
    return Effect.succeed(result ?? null);
  },
  createBackup: () => {
    if (mockCreateBackupError) return Effect.fail(mockCreateBackupError);
    return Effect.succeed(mockCreateBackupResult);
  },
  _resetTableReady: () => {},
}));

// Mock child_process, fs, zlib, stream
mock.module("child_process", () => ({
  spawn: mock(() => {
    const proc = {
      stdout: { on: mock(), pipe: mock() },
      stderr: { on: mock() },
      stdin: { on: mock(), write: mock(), end: mock() },
      on: mock((event: string, cb: (code: number) => void) => {
        if (event === "close") setTimeout(() => cb(0), 0);
      }),
    };
    return proc;
  }),
}));

mock.module("stream/promises", () => ({
  pipeline: mock(() => Promise.resolve()),
}));

mock.module("fs", () => ({
  createReadStream: mock(() => ({ on: mock(), pipe: mock(), destroy: mock() })),
  createWriteStream: mock(() => ({ on: mock(), write: mock(), end: mock() })),
}));

mock.module("zlib", () => ({
  createGunzip: mock(() => ({ on: mock(), pipe: mock(), destroy: mock() })),
  createGzip: mock(() => ({ on: mock(), pipe: mock() })),
}));

// Import after mocks
const { requestRestore, executeRestore } = await import("./restore");

// ── Helpers ────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

// ── Tests ──────────────────────────────────────────────────────────

describe("requestRestore", () => {
  beforeEach(() => {
    ee.reset();
    mockGetBackupById = () => validBackup;
  });

  it("generates a confirmation token", async () => {
    const result = await run(requestRestore("b1"));
    expect(result.confirmationToken).toBeDefined();
    expect(result.confirmationToken.length).toBeGreaterThan(0);
    expect(result.message).toContain("confirmation token");
  });

  it("fails when backup not found", async () => {
    mockGetBackupById = () => null;
    await expect(run(requestRestore("missing"))).rejects.toThrow("Backup not found");
  });

  it("fails when backup has wrong status", async () => {
    mockGetBackupById = () => ({ ...validBackup, status: "failed" });
    await expect(run(requestRestore("b1"))).rejects.toThrow("Cannot restore backup with status");
  });

  it("allows verified status", async () => {
    mockGetBackupById = () => ({ ...validBackup, status: "verified" });
    const result = await run(requestRestore("b1"));
    expect(result.confirmationToken).toBeDefined();
  });

  it("fails when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(requestRestore("b1"))).rejects.toThrow("Enterprise features");
  });

  it("fails when no internal DB", async () => {
    ee.setHasInternalDB(false);
    await expect(run(requestRestore("b1"))).rejects.toThrow("Internal database required");
  });
});

describe("executeRestore", () => {
  beforeEach(() => {
    ee.reset();
    mockGetBackupById = () => validBackup;
    mockCreateBackupError = null;
    mockCreateBackupResult = { id: "pre-b1", storagePath: "/tmp/pre.sql.gz", sizeBytes: 500, status: "completed" };
    // Set DATABASE_URL for restore
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
  });

  it("fails with invalid token", async () => {
    await expect(run(executeRestore("bad-token"))).rejects.toThrow("Invalid or expired confirmation token");
  });

  it("fails when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(executeRestore("any-token"))).rejects.toThrow("Enterprise features");
  });

  it("fails when pre-restore backup fails", async () => {
    // First get a valid token
    const { confirmationToken } = await run(requestRestore("b1"));

    mockCreateBackupError = new Error("pg_dump failed");
    await expect(run(executeRestore(confirmationToken))).rejects.toThrow("Pre-restore backup failed");
  });

  it("fails when DATABASE_URL not set", async () => {
    const { confirmationToken } = await run(requestRestore("b1"));
    delete process.env.DATABASE_URL;
    await expect(run(executeRestore(confirmationToken))).rejects.toThrow("DATABASE_URL is not set");
  });
});
