import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
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

// ── Storage driver mock (#4457) — the engine's artifact seam ───────
let storagePutError: Error | null = null;
let storagePutSize = 12345;
let storageListResult: string[] = [];
let storageListError: Error | null = null;
let storageRemoveError: Error | null = null;
const storageCalls: { op: string; path: string }[] = [];

const storageMock = {
  kind: "local" as const,
  put: mock(async (path: string) => {
    storageCalls.push({ op: "put", path });
    if (storagePutError) throw storagePutError;
    return { sizeBytes: storagePutSize };
  }),
  getStream: mock(async (path: string) => {
    storageCalls.push({ op: "getStream", path });
    return { on: mock(), pipe: mock(), destroy: mock() };
  }),
  list: mock(async (prefix: string) => {
    storageCalls.push({ op: "list", path: prefix });
    if (storageListError) throw storageListError;
    return storageListResult;
  }),
  remove: mock(async (path: string) => {
    storageCalls.push({ op: "remove", path });
    if (storageRemoveError) throw storageRemoveError;
  }),
};

mock.module("./storage", () => ({
  getBackupStorage: () => storageMock,
  isS3BackupStorageConfigured: () => false,
  createLocalBackupStorage: () => storageMock,
  createS3BackupStorage: () => storageMock,
  _resetBackupStorage: () => {},
}));

// Mock spawn to return a controllable child process. When `spawnEmitError`
// is set, the process emits 'error' and NEVER emits 'close' — the real
// missing-binary (ENOENT) shape.
let spawnEmitError: Error | null = null;
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
    on: mock((event: string, cb: (codeOrErr: number | Error) => void) => {
      if (event === "error" && spawnEmitError) cb(spawnEmitError);
      if (event === "close" && !spawnEmitError) setTimeout(() => cb(exitCode), 0);
    }),
  };
  return proc;
}

let spawnExitCode = 0;
const mockSpawn = mock(() => createMockProcess(spawnExitCode));
mock.module("child_process", () => ({
  spawn: () => mockSpawn(),
}));

mock.module("stream/promises", () => ({
  pipeline: mock(() => Promise.resolve()),
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
  createBackup,
  createScheduledBackup,
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

// ensureTable now issues 8 queries: CREATE TABLE backups, ALTER verify_level,
// ALTER expected_table_count, ALTER scheduled_window (#4457), CREATE UNIQUE
// INDEX scheduled_window, CREATE INDEX status, CREATE TABLE backup_config,
// INSERT seed.
const ENSURE_TABLE_QUERIES = 8;
const ensureTableEmpties = (): Record<string, unknown>[][] =>
  Array.from({ length: ENSURE_TABLE_QUERIES }, () => []);

function resetAll() {
  ee.reset();
  _resetTableReady();
  mockSpawn.mockClear();
  spawnExitCode = 0;
  spawnEmitError = null;
  storagePutError = null;
  storagePutSize = 12345;
  storageListResult = [];
  storageListError = null;
  storageRemoveError = null;
  storageCalls.length = 0;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ensureTable", () => {
  beforeEach(resetAll);

  it("creates tables (including the scheduled_window claim column + index) and seeds config on first call", async () => {
    ee.queueMockRows(...ensureTableEmpties());
    await run(ensureTable());
    expect(ee.capturedQueries.length).toBe(ENSURE_TABLE_QUERIES);
    expect(ee.capturedQueries[0].sql).toContain("CREATE TABLE IF NOT EXISTS backups");
    expect(ee.capturedQueries[1].sql).toContain("ADD COLUMN IF NOT EXISTS verify_level");
    expect(ee.capturedQueries[2].sql).toContain("ADD COLUMN IF NOT EXISTS expected_table_count");
    expect(ee.capturedQueries[3].sql).toContain("ADD COLUMN IF NOT EXISTS scheduled_window");
    expect(ee.capturedQueries[4].sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_scheduled_window");
    expect(ee.capturedQueries[4].sql).toContain("WHERE scheduled_window IS NOT NULL");
  });

  it("skips creation on second call (idempotent)", async () => {
    ee.queueMockRows(...ensureTableEmpties());
    await run(ensureTable());
    const firstCount = ee.capturedQueries.length;
    await run(ensureTable());
    // No additional queries on second call
    expect(ee.capturedQueries.length).toBe(firstCount);
  });

  it("fails when internal DB is unavailable", async () => {
    ee.setHasInternalDB(false);
    await expect(run(ensureTable())).rejects.toThrow("Internal database required");
  });
});

describe("getBackupConfig", () => {
  beforeEach(resetAll);

  it("returns config row from DB", async () => {
    ee.queueMockRows(...ensureTableEmpties(), [defaultConfigRow]);
    const config = await run(getBackupConfig());
    expect(config.schedule).toBe("0 3 * * *");
    expect(config.retention_days).toBe(30);
    expect(config.storage_path).toBe("./backups");
  });

  it("returns defaults when config row missing", async () => {
    ee.queueMockRows(...ensureTableEmpties());
    const config = await run(getBackupConfig());
    expect(config.schedule).toBe("0 3 * * *");
    expect(config.retention_days).toBe(30);
  });
});

describe("updateBackupConfig", () => {
  beforeEach(resetAll);

  it("upserts partial config", async () => {
    ee.queueMockRows(...ensureTableEmpties(), [defaultConfigRow], []);
    await run(updateBackupConfig({ schedule: "0 1 * * *" }));
    // The last query should be the upsert (not the seed from ensureTable)
    const upsertQuery = ee.capturedQueries[ee.capturedQueries.length - 1];
    expect(upsertQuery.sql).toContain("ON CONFLICT");
    expect(upsertQuery.params[0]).toBe("0 1 * * *"); // new schedule
    expect(upsertQuery.params[1]).toBe(30); // unchanged retention
  });
});

describe("createBackup — expected_table_count baseline (#2989)", () => {
  let priorDatabaseUrl: string | undefined;

  beforeEach(() => {
    resetAll();
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
  });

  afterEach(() => {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  // Query order for createBackup:
  //   ensureTable (8) + getBackupConfig SELECT (1) + INSERT in-progress (1)
  //   + countSourceBaseTables SELECT (1) + completed UPDATE (1) = 12 queries.
  const completedUpdate = () =>
    ee.capturedQueries.find((q) => q.sql.includes("status = 'completed'"));

  it("persists the source's public BASE TABLE count into the completed UPDATE", async () => {
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],                 // getBackupConfig SELECT
      [{ id: "b1" }],                     // INSERT ... RETURNING id
      [{ count: "5" }],                   // countSourceBaseTables
      [],                                 // completed UPDATE
    );

    const result = await run(createBackup());
    expect(result.status).toBe("completed");

    const update = completedUpdate();
    expect(update).toBeDefined();
    expect(update!.sql).toContain("expected_table_count = $2");
    // params = [size_bytes, expected_table_count, id]
    expect(update!.params[1]).toBe(5);
    expect(update!.params[2]).toBe("b1");
  });

  it("falls back to null (best-effort) when the table count is unreadable — backup still completes", async () => {
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],                 // getBackupConfig SELECT
      [{ id: "b1" }],                     // INSERT ... RETURNING id
      [],                                 // countSourceBaseTables → no row → NaN → null
      [],                                 // completed UPDATE
    );

    const result = await run(createBackup());
    // A missing count must NOT abort an otherwise-good backup.
    expect(result.status).toBe("completed");

    const update = completedUpdate();
    expect(update).toBeDefined();
    expect(update!.params[1]).toBeNull();
  });

  it("streams the artifact through the storage driver and records its byte count", async () => {
    storagePutSize = 9876;
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],
      [{ id: "b1" }],
      [{ count: "3" }],
      [],
    );

    const result = await run(createBackup());
    expect(result.sizeBytes).toBe(9876);
    expect(storageCalls.some((c) => c.op === "put" && c.path.endsWith(".sql.gz"))).toBe(true);
  });

  it("stamps the row failed when the storage write fails", async () => {
    storagePutError = new Error("bucket unavailable");
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],
      [{ id: "b1" }],
    );

    await expect(run(createBackup())).rejects.toThrow("bucket unavailable");

    // The tapError stamp is fire-and-forget — flush microtasks, then assert
    // the failed UPDATE actually landed (deleting the tapError block must
    // not leave this suite green).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failedUpdate = ee.capturedQueries.find((q) => q.sql.includes("status = 'failed'"));
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.params[0]).toContain("bucket unavailable");
    expect(failedUpdate!.params[1]).toBe("b1");
  });

  it("attributes a spawn failure to the real cause (pg_dump missing), not a derived stream error", async () => {
    // The real ENOENT shape: 'error' fires, 'close' never does. The failure
    // must carry the spawn error — not "Premature close" — so the operator
    // sees the actual cause in the row and the logs.
    spawnEmitError = new Error('Executable not found in $PATH: "pg_dump"');
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],
      [{ id: "b1" }],
    );

    await expect(run(createBackup())).rejects.toThrow("Executable not found");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const failedUpdate = ee.capturedQueries.find((q) => q.sql.includes("status = 'failed'"));
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.params[0]).toContain("Executable not found");
  });

  it("fails (and stamps the row failed) when pg_dump exits non-zero, including the stderr excerpt", async () => {
    spawnExitCode = 1;
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],
      [{ id: "b1" }],
    );

    await expect(run(createBackup())).rejects.toThrow(/pg_dump exited with code 1.*pg_dump error/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const failedUpdate = ee.capturedQueries.find((q) => q.sql.includes("status = 'failed'"));
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.params[1]).toBe("b1");
  });
});

describe("createScheduledBackup — cadence-window claim (#4457)", () => {
  let priorDatabaseUrl: string | undefined;

  beforeEach(() => {
    resetAll();
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
  });

  afterEach(() => {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  it("claims the window with INSERT … ON CONFLICT DO NOTHING and runs the backup on a won claim", async () => {
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],                 // getBackupConfig SELECT
      [{ id: "b-sched" }],                // claim INSERT ... RETURNING id (won)
      [{ count: "4" }],                   // countSourceBaseTables
      [],                                 // completed UPDATE
    );

    const result = await run(createScheduledBackup("w86400000a10800000-123"));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("b-sched");
    expect(result!.status).toBe("completed");

    const claim = ee.capturedQueries.find((q) => q.sql.includes("ON CONFLICT (scheduled_window)"));
    expect(claim).toBeDefined();
    expect(claim!.sql).toContain("WHERE scheduled_window IS NOT NULL DO NOTHING");
    expect(claim!.params[2]).toBe("w86400000a10800000-123");
  });

  it("returns null (and never spawns pg_dump) when the window is already claimed", async () => {
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],                 // getBackupConfig SELECT
      [],                                 // claim INSERT → no row (lost)
    );

    const result = await run(createScheduledBackup("w86400000a10800000-123"));
    expect(result).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(storageCalls.filter((c) => c.op === "put")).toHaveLength(0);
  });
});

describe("listBackups", () => {
  beforeEach(resetAll);

  it("returns backup rows", async () => {
    const row = { id: "b1", created_at: "2026-01-01", size_bytes: "1000", status: "completed", storage_path: "/tmp/b1.sql.gz", retention_expires_at: "2026-02-01", error_message: null };
    ee.queueMockRows(...ensureTableEmpties(), [row]);
    const backups = await run(listBackups());
    expect(backups).toHaveLength(1);
    expect(backups[0].id).toBe("b1");
  });

  it("returns empty array when no backups", async () => {
    ee.queueMockRows(...ensureTableEmpties());
    const backups = await run(listBackups());
    expect(backups).toHaveLength(0);
  });
});

describe("getBackupById", () => {
  beforeEach(resetAll);

  it("returns backup when found", async () => {
    const row = { id: "b1", created_at: "2026-01-01", size_bytes: "1000", status: "completed", storage_path: "/tmp/b1.sql.gz", retention_expires_at: "2026-02-01", error_message: null };
    ee.queueMockRows(...ensureTableEmpties(), [row]);
    const backup = await run(getBackupById("b1"));
    expect(backup).not.toBeNull();
    expect(backup!.id).toBe("b1");
  });

  it("returns null when not found", async () => {
    ee.queueMockRows(...ensureTableEmpties());
    const backup = await run(getBackupById("nonexistent"));
    expect(backup).toBeNull();
  });
});

describe("purgeExpiredBackups", () => {
  beforeEach(resetAll);

  it("purges expired backups — deletes artifact via the storage driver and the DB record", async () => {
    const expired = [
      { id: "b1", storage_path: "/tmp/b1.sql.gz" },
      { id: "b2", storage_path: "/tmp/b2.sql.gz" },
    ];
    // ensureTable (8) + SELECT expired (1) + DELETE b1 (1) + DELETE b2 (1)
    ee.queueMockRows(...ensureTableEmpties(), expired, [], []);

    const count = await run(purgeExpiredBackups());
    expect(count).toBe(2);
    expect(storageCalls.filter((c) => c.op === "remove")).toHaveLength(2);
  });

  it("skips DB deletion when the storage delete fails (already-gone is handled inside the driver)", async () => {
    const expired = [{ id: "b1", storage_path: "/tmp/locked.sql.gz" }];
    // ensureTable (8) + SELECT expired (1) — no DELETE (storage remove fails)
    ee.queueMockRows(...ensureTableEmpties(), expired);
    storageRemoveError = new Error("EACCES");

    const count = await run(purgeExpiredBackups());
    expect(count).toBe(0); // skipped
  });

  it("returns 0 when no expired backups", async () => {
    ee.queueMockRows(...ensureTableEmpties());
    const count = await run(purgeExpiredBackups());
    expect(count).toBe(0);
  });
});

describe("listStorageFiles", () => {
  beforeEach(resetAll);

  it("returns the driver's artifact list", async () => {
    ee.queueMockRows(...ensureTableEmpties(), [defaultConfigRow]);
    storageListResult = ["a.sql.gz", "b.sql.gz"];

    const files = await run(listStorageFiles());
    expect(files).toEqual(["a.sql.gz", "b.sql.gz"]);
    expect(storageCalls.some((c) => c.op === "list" && c.path === "./backups")).toBe(true);
  });

  it("propagates driver errors", async () => {
    ee.queueMockRows(...ensureTableEmpties(), [defaultConfigRow]);
    storageListError = new Error("EACCES");

    await expect(run(listStorageFiles())).rejects.toThrow("EACCES");
  });
});

describe("enterprise gate", () => {
  beforeEach(resetAll);

  it("ensureTable fails when internal DB unavailable (via db-guard)", async () => {
    ee.setHasInternalDB(false);
    await expect(run(ensureTable())).rejects.toThrow("Internal database required");
  });
});
