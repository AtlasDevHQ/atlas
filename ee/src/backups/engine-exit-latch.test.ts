/**
 * Regression: the scheduled-backup create pipeline must not hang on the
 * pg_dump exit-code wait.
 *
 * The bug (found diagnosing every prod region stuck with zero verified
 * backups): `performBackup` attached its `pgDump.on("close", …)` listener
 * *after* `await Promise.all([put, pipeline])`. But `close` is a one-shot
 * event that fires as soon as the pipeline drains pg_dump's stdout — and the
 * S3 `writer.end()` round-trip delays `Promise.all` ~150ms past that. So the
 * listener attached afterwards always missed the already-fired event and
 * awaited forever; the 2h fiber timeout then interrupted the cycle, stranding
 * the row `in_progress` (no error, no size — interruption skips `tapError`).
 *
 * This test reproduces the exact ordering with REAL streams (not the
 * instant-resolve mocks in engine.test.ts, which re-fire `close` on every
 * listener attach and so can never catch this): a one-shot `EventEmitter`
 * process whose `close` fires right after stdout EOF, and a `storage.put`
 * that resolves *after* that. Against the buggy ordering `createBackup` never
 * settles (the timeout race below fails fast instead of hanging the suite);
 * with the exit latch registered before the pipeline it completes.
 *
 * NB: this file intentionally does NOT mock `zlib` / `stream/promises` — the
 * real gzip + pipeline are what make the `close`-before-`Promise.all`
 * ordering faithful.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Effect } from "effect";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { createEEMock } from "../__mocks__/internal";

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

// Storage driver whose put resolves AFTER the process 'close' fires — the
// real S3 writer.end() round-trip is exactly this "settles slightly later".
const storageMock = {
  kind: "local" as const,
  put: mock(async (_path: string, source: AsyncIterable<Buffer | string>) => {
    let sizeBytes = 0;
    for await (const chunk of source) {
      sizeBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    }
    // Resolve on a later macrotask so the one-shot 'close' (scheduled via
    // setImmediate below) has already fired by the time Promise.all settles.
    await new Promise((r) => setTimeout(r, 20));
    return { sizeBytes };
  }),
  getStream: mock(async () => Readable.from([])),
  list: mock(async () => [] as string[]),
  remove: mock(async () => {}),
};
mock.module("./storage", () => ({
  getBackupStorage: () => storageMock,
  isS3BackupStorageConfigured: () => false,
  createLocalBackupStorage: () => storageMock,
  createS3BackupStorage: () => storageMock,
  _resetBackupStorage: () => {},
}));

// Faithful one-shot process: real stdout Readable, `close` emitted exactly
// once right after stdout EOF (mirrors pg_dump exiting when its stdout is
// drained). A real EventEmitter gives correct one-shot semantics — a late
// listener misses the event, which is the whole point.
function makeProc(): EventEmitter & { stdout: Readable; stderr: Readable } {
  const proc = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
  proc.stdout = Readable.from([Buffer.from("-- pg_dump output\nSELECT 1;\n")]);
  proc.stderr = Readable.from([]);
  proc.stdout.once("end", () => setImmediate(() => proc.emit("close", 0)));
  return proc;
}
mock.module("child_process", () => ({ spawn: () => makeProc() }));

const { createBackup, _resetTableReady } = await import("./engine");

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect as Effect.Effect<A, never>);

const ENSURE_TABLE_QUERIES = 8;
const ensureTableEmpties = (): Record<string, unknown>[][] =>
  Array.from({ length: ENSURE_TABLE_QUERIES }, () => []);
const defaultConfigRow = { schedule: "0 3 * * *", retention_days: 30, storage_path: "./backups" };

describe("createBackup — pg_dump exit-code latch (no hang when close fires before Promise.all)", () => {
  let priorDatabaseUrl: string | undefined;

  beforeEach(() => {
    ee.reset();
    _resetTableReady();
    storageMock.put.mockClear();
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
  });

  afterEach(() => {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  it("completes even though the process 'close' fires before the storage put settles", async () => {
    // Query order: ensureTable (8) + getBackupConfig SELECT (1)
    //   + INSERT ... RETURNING id (1) + countSourceBaseTables (1)
    //   + completed UPDATE (1) = 12.
    ee.queueMockRows(
      ...ensureTableEmpties(),
      [defaultConfigRow],
      [{ id: "b1" }],
      [{ count: "1" }],
      [],
    );

    const result = await Promise.race([
      run(createBackup()),
      new Promise<never>((_, rej) =>
        setTimeout(
          () =>
            rej(
              new Error(
                "createBackup did not settle within 5s — exit-code latch regression: " +
                  "the pg_dump 'close' listener was attached after Promise.all and missed the one-shot event",
              ),
            ),
          5000,
        ),
      ),
    ]);

    expect(result.status).toBe("completed");
    expect(storageMock.put).toHaveBeenCalledTimes(1);
  });
});
