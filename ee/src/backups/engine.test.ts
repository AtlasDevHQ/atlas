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

// Mock fs/promises, child_process, stream/promises, zlib
const mockMkdir = mock(() => Promise.resolve(undefined));
const mockStat = mock(() => Promise.resolve({ size: 12345 }));
let mockUnlink = mock(() => Promise.resolve(undefined));
let mockReaddir = mock(() => Promise.resolve(["backup-1.sql.gz", "backup-2.sql.gz", "readme.txt"]));
mock.module("fs/promises", () => ({
  mkdir: () => mockMkdir(),
  stat: () => mockStat(),
  unlink: () => mockUnlink(),
  readdir: () => mockReaddir(),
}));

// Mock spawn to return a controllable child process
function createMockProcess(exitCode = 0) {
  const stdout = { on: mock(), pipe: mock() };
  const stderr = {
    on: mock((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data" && exitCode !== 0) cb(Buffer.from("pg_dump error"));
    }),
  };
  const proc = {
    stdout,
    stderr,
    stdin: { on: mock(), write: mock(), end: mock() },
    on: mock((event: string, cb: (code: number) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), 0);
    }),
  };
  return proc;
}

const mockSpawn = mock(() => createMockProcess(0));
mock.module("child_process", () => ({
  spawn: () => mockSpawn(),
}));

mock.module("stream/promises", () => ({
  pipeline: mock(() => Promise.resolve()),
}));

mock.module("fs", () => ({
  createWriteStream: mock(() => ({ on: mock(), write: mock(), end: mock() })),
  createReadStream: mock(() => ({ on: mock(), pipe: mock(), destroy: mock() })),
}));

mock.module("zlib", () => ({
  createGzip: mock(() => ({ on: mock(), pipe: mock() })),
  createGunzip: mock(() => ({ on: mock(), pipe: mock(), destroy: mock() })),
}));

// Import after mocks
const {
  ensureTable,
  getBackupConfig,
  updateBackupConfig,
  listBackups,
  getBackupById,
  purgeExpiredBackups,
  listStorageFiles,
  _resetTableReady,
} = await import("./engine");

// ── Helpers ────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const defaultConfigRow = { schedule: "0 3 * * *", retention_days: 30, storage_path: "./backups" };

// ── Tests ──────────────────────────────────────────────────────────

describe("ensureTable", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("creates tables and seeds config on first call", async () => {
    // Queue empty results for all CREATE TABLE/INDEX/INSERT queries
    ee.queueMockRows([], [], [], []);
    await run(ensureTable());
    // Should have run: CREATE TABLE backups, CREATE INDEX, CREATE TABLE backup_config, INSERT seed = 4 queries
    expect(ee.capturedQueries.length).toBe(4);
    expect(ee.capturedQueries[0].sql).toContain("CREATE TABLE IF NOT EXISTS backups");
  });

  it("skips creation on second call (idempotent)", async () => {
    ee.queueMockRows([], [], [], []);
    await run(ensureTable());
    const firstCount = ee.capturedQueries.length;
    await run(ensureTable());
    // No additional queries on second call
    expect(ee.capturedQueries.length).toBe(firstCount);
  });

  it("fails when enterprise is disabled", async () => {
    ee.setHasInternalDB(false);
    await expect(run(ensureTable())).rejects.toThrow("Internal database required");
  });
});

describe("getBackupConfig", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("returns config row from DB", async () => {
    // ensureTable (4) + config SELECT (1)
    ee.queueMockRows([], [], [], [], [defaultConfigRow]);
    const config = await run(getBackupConfig());
    expect(config.schedule).toBe("0 3 * * *");
    expect(config.retention_days).toBe(30);
    expect(config.storage_path).toBe("./backups");
  });

  it("returns defaults when config row missing", async () => {
    // ensureTable (4) + empty config SELECT (1)
    ee.queueMockRows([], [], [], [], []);
    const config = await run(getBackupConfig());
    expect(config.schedule).toBe("0 3 * * *");
    expect(config.retention_days).toBe(30);
  });
});

describe("updateBackupConfig", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("upserts partial config", async () => {
    // ensureTable (4) + config SELECT (1) + UPSERT (1)
    ee.queueMockRows([], [], [], [], [defaultConfigRow], []);
    await run(updateBackupConfig({ schedule: "0 1 * * *" }));
    // The last query should be the upsert (not the seed from ensureTable)
    const upsertQuery = ee.capturedQueries[ee.capturedQueries.length - 1];
    expect(upsertQuery.sql).toContain("ON CONFLICT");
    expect(upsertQuery.params[0]).toBe("0 1 * * *"); // new schedule
    expect(upsertQuery.params[1]).toBe(30); // unchanged retention
  });
});

describe("listBackups", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("returns backup rows", async () => {
    const row = { id: "b1", created_at: "2026-01-01", size_bytes: "1000", status: "completed", storage_path: "/tmp/b1.sql.gz", retention_expires_at: "2026-02-01", error_message: null };
    // ensureTable (4) + SELECT (1)
    ee.queueMockRows([], [], [], [], [row]);
    const backups = await run(listBackups());
    expect(backups).toHaveLength(1);
    expect(backups[0].id).toBe("b1");
  });

  it("returns empty array when no backups", async () => {
    ee.queueMockRows([], [], [], [], []);
    const backups = await run(listBackups());
    expect(backups).toHaveLength(0);
  });
});

describe("getBackupById", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("returns backup when found", async () => {
    const row = { id: "b1", created_at: "2026-01-01", size_bytes: "1000", status: "completed", storage_path: "/tmp/b1.sql.gz", retention_expires_at: "2026-02-01", error_message: null };
    // ensureTable (4) + SELECT (1)
    ee.queueMockRows([], [], [], [], [row]);
    const backup = await run(getBackupById("b1"));
    expect(backup).not.toBeNull();
    expect(backup!.id).toBe("b1");
  });

  it("returns null when not found", async () => {
    ee.queueMockRows([], [], [], [], []);
    const backup = await run(getBackupById("nonexistent"));
    expect(backup).toBeNull();
  });
});

describe("purgeExpiredBackups", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("purges expired backups — deletes file and DB record", async () => {
    const expired = [
      { id: "b1", storage_path: "/tmp/b1.sql.gz" },
      { id: "b2", storage_path: "/tmp/b2.sql.gz" },
    ];
    // ensureTable (4) + SELECT expired (1) + DELETE b1 (1) + DELETE b2 (1)
    ee.queueMockRows([], [], [], [], expired, [], []);
    mockUnlink = mock(() => Promise.resolve(undefined));

    const count = await run(purgeExpiredBackups());
    expect(count).toBe(2);
  });

  it("handles ENOENT — file already gone, still deletes DB record", async () => {
    const expired = [{ id: "b1", storage_path: "/tmp/gone.sql.gz" }];
    // ensureTable (4) + SELECT expired (1) + DELETE (1)
    ee.queueMockRows([], [], [], [], expired, []);
    mockUnlink = mock(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const count = await run(purgeExpiredBackups());
    expect(count).toBe(1); // still counted as purged
  });

  it("skips DB deletion when file delete fails with non-ENOENT", async () => {
    const expired = [{ id: "b1", storage_path: "/tmp/locked.sql.gz" }];
    // ensureTable (4) + SELECT expired (1) — no DELETE (file unlink fails)
    ee.queueMockRows([], [], [], [], expired);
    mockUnlink = mock(() => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      return Promise.reject(err);
    });

    const count = await run(purgeExpiredBackups());
    expect(count).toBe(0); // skipped
  });

  it("returns 0 when no expired backups", async () => {
    // ensureTable (4) + SELECT expired returns empty (1)
    ee.queueMockRows([], [], [], [], []);
    const count = await run(purgeExpiredBackups());
    expect(count).toBe(0);
  });
});

describe("listStorageFiles", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("returns only .sql.gz files", async () => {
        // getBackupConfig: ensureTable (4) + SELECT config (1)
    ee.queueMockRows([], [], [], [], [defaultConfigRow]);
    mockReaddir = mock(() => Promise.resolve(["a.sql.gz", "b.sql.gz", "notes.txt"]));

    const files = await run(listStorageFiles());
    expect(files).toEqual(["a.sql.gz", "b.sql.gz"]);
  });

  it("returns empty array when directory does not exist (ENOENT)", async () => {
        // getBackupConfig: ensureTable (4) + SELECT config (1)
    ee.queueMockRows([], [], [], [], [defaultConfigRow]);
    mockReaddir = mock(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const files = await run(listStorageFiles());
    expect(files).toEqual([]);
  });

  it("propagates non-ENOENT errors", async () => {
        // getBackupConfig: ensureTable (4) + SELECT config (1)
    ee.queueMockRows([], [], [], [], [defaultConfigRow]);
    mockReaddir = mock(() => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      return Promise.reject(err);
    });

    await expect(run(listStorageFiles())).rejects.toThrow("EACCES");
  });
});

describe("enterprise gate", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("ensureTable fails when enterprise disabled (via db-guard)", async () => {
    ee.setHasInternalDB(false);
    await expect(run(ensureTable())).rejects.toThrow("Internal database required");
  });
});
