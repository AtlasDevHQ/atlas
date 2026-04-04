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

// Mock fs + zlib for readGzipHeader
let mockReadStreamChunks: Buffer[] = [Buffer.from("-- PostgreSQL database dump\n-- Dumped from")];
let mockReadStreamError: Error | null = null;

mock.module("fs", () => ({
  createReadStream: () => ({
    on: mock((event: string, cb: (err: Error) => void) => {
      if (event === "error" && mockReadStreamError) cb(mockReadStreamError);
    }),
    pipe: mock((gunzip: unknown) => gunzip),
    destroy: mock(),
  }),
  createWriteStream: mock(() => ({ on: mock(), write: mock(), end: mock() })),
}));

mock.module("zlib", () => ({
  createGunzip: () => {
    let dataHandler: ((chunk: Buffer) => void) | null = null;
    let endHandler: (() => void) | null = null;
    let errorHandler: ((err: Error) => void) | null = null;
    const gunzip = {
      on: mock((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "data") dataHandler = cb as (chunk: Buffer) => void;
        if (event === "end") endHandler = cb as () => void;
        if (event === "error") errorHandler = cb as (err: Error) => void;
      }),
      destroy: mock(),
    };
    // Simulate data flow on next tick
    setTimeout(() => {
      if (mockReadStreamError && errorHandler) {
        errorHandler(mockReadStreamError);
      } else if (dataHandler) {
        for (const chunk of mockReadStreamChunks) dataHandler(chunk);
        endHandler?.();
      }
    }, 0);
    return gunzip;
  },
  createGzip: mock(() => ({ on: mock(), pipe: mock() })),
}));

// Mock engine exports that verify.ts imports
let mockGetBackupById: (() => unknown) | null = null;
mock.module("./engine", () => ({
  ensureTable: () => Effect.void,
  getBackupById: (_id: string) => {
    if (mockGetBackupById) {
      const result = mockGetBackupById();
      return Effect.succeed(result);
    }
    return Effect.succeed(null);
  },
  _resetTableReady: () => {},
}));

// Import after mocks
const { verifyBackup } = await import("./verify");

// ── Helpers ────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const validBackup = {
  id: "b1",
  created_at: "2026-01-01",
  size_bytes: "1000",
  status: "completed",
  storage_path: "/tmp/b1.sql.gz",
  retention_expires_at: "2026-02-01",
  error_message: null,
};

// ── Tests ──────────────────────────────────────────────────────────

describe("verifyBackup", () => {
  beforeEach(() => {
    ee.reset();
    mockGetBackupById = null;
    mockReadStreamChunks = [Buffer.from("-- PostgreSQL database dump\n-- Dumped from")];
    mockReadStreamError = null;
  });

  it("verifies a valid backup with pg_dump header", async () => {
    mockGetBackupById = () => validBackup;
    // UPDATE to 'verified'
    ee.queueMockRows([]);

    const result = await run(verifyBackup("b1"));
    expect(result.verified).toBe(true);
    expect(result.message).toContain("verified");
  });

  it("returns false for invalid header", async () => {
    mockGetBackupById = () => validBackup;
    mockReadStreamChunks = [Buffer.from("not a pg_dump file\nrandom content")];
    // UPDATE to 'failed'
    ee.queueMockRows([]);

    const result = await run(verifyBackup("b1"));
    expect(result.verified).toBe(false);
    expect(result.message).toContain("pg_dump header not found");
  });

  it("fails when backup not found", async () => {
    mockGetBackupById = () => null;
    await expect(run(verifyBackup("missing"))).rejects.toThrow("Backup not found");
  });

  it("fails when backup has wrong status", async () => {
    mockGetBackupById = () => ({ ...validBackup, status: "in_progress" });
    await expect(run(verifyBackup("b1"))).rejects.toThrow('Cannot verify backup with status "in_progress"');
  });

  it("allows verified status for re-verification", async () => {
    mockGetBackupById = () => ({ ...validBackup, status: "verified" });
    ee.queueMockRows([]);

    const result = await run(verifyBackup("b1"));
    expect(result.verified).toBe(true);
  });

  it("fails when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(verifyBackup("b1"))).rejects.toThrow("Enterprise features");
  });

  it("fails when no internal DB", async () => {
    ee.setHasInternalDB(false);
    await expect(run(verifyBackup("b1"))).rejects.toThrow("Internal database required");
  });

  it("returns verified:false on decompression error (catchAll)", async () => {
    mockGetBackupById = () => validBackup;
    mockReadStreamError = new Error("corrupt gzip data");

    const result = await run(verifyBackup("b1"));
    expect(result.verified).toBe(false);
    expect(result.message).toContain("Verification failed");
  });
});
