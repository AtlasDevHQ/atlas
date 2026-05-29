/**
 * Restore-into-scratch-DB verification tests (#2941).
 *
 * Two layers of coverage:
 *
 *  1. **Real-PG regression** (opt-in — skips unless a scratch Postgres URL is
 *     available). This is the test the fuller fix exists for: a dump with a
 *     valid pg_dump header but a TRUNCATED tail PASSED the old header-only
 *     check. Under restore-into-scratch-DB verification it must now FAIL.
 *     The matching valid dump must PASS with a non-zero table count.
 *
 *     Mirrors the skip pattern in `migrate-pg.test.ts` — set either
 *     `ATLAS_BACKUP_VERIFY_SCRATCH_URL` or `TEST_DATABASE_URL` (the latter is
 *     used both as the source DB to dump AND, with a dedicated scratch DB
 *     created per-run, as the restore target). Requires `pg_dump` + `psql` on
 *     PATH. ⚠️ The scratch DB's public schema is WIPED — never point at prod.
 *
 *  2. **Fail-loud** (always runs, mocked): when the scratch URL IS configured
 *     but the restore subprocess can't run (psql missing / connection refused),
 *     verification returns verified:false at the full-restore level — it must
 *     NOT fall through to verified:true.
 *
 * Uses real fs/zlib/child_process (unlike verify.test.ts, which mocks them) so
 * the psql-pipe path is genuinely exercised. Only the DB / enterprise / logger
 * seams are mocked.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { Effect } from "effect";
import { spawnSync } from "child_process";
import { gzipSync } from "zlib";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks — DB / enterprise / logger only; fs/zlib/child_process stay real ──

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

// Engine: only verify.ts's imports (ensureTable + getBackupById) need stubbing.
let mockBackup: Record<string, unknown> | null = null;
mock.module("./engine", () => ({
  ensureTable: () => Effect.void,
  getBackupById: () => Effect.succeed(mockBackup),
  getBackupConfig: () => Effect.succeed({ schedule: "0 3 * * *", retention_days: 30, storage_path: "./backups" }),
  updateBackupConfig: () => Effect.void,
  createBackup: () => Effect.succeed({ id: "b1", storagePath: "/tmp/b1.sql.gz", sizeBytes: 1000, status: "completed" }),
  listBackups: () => Effect.succeed([]),
  purgeExpiredBackups: () => Effect.succeed(0),
  listStorageFiles: () => Effect.succeed([]),
  _resetTableReady: () => {},
}));

const { verifyBackup } = await import("./verify");

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect as Effect.Effect<A, never>);

const baseBackup = (storagePath: string) => ({
  id: "b1",
  created_at: "2026-01-01",
  size_bytes: "1000",
  status: "completed",
  storage_path: storagePath,
  retention_expires_at: "2026-02-01",
  error_message: null,
  verify_level: null,
});

// ── (2) Fail-loud — scratch URL set but psql can't run ───────────────

describe("verifyBackup full-restore — fail loud when restore can't run (#2941)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "atlas-verify-"));

  beforeEach(() => {
    ee.reset();
    // Point at an unreachable scratch DB so psql exits non-zero / errors.
    process.env.ATLAS_BACKUP_VERIFY_SCRATCH_URL =
      "postgresql://nobody:nope@127.0.0.1:1/atlas_scratch_unreachable";
  });

  afterAll(() => {
    delete process.env.ATLAS_BACKUP_VERIFY_SCRATCH_URL;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns verified:false at full-restore level (never falls through to true)", async () => {
    const dumpPath = join(tmp, "valid-header.sql.gz");
    writeFileSync(
      dumpPath,
      gzipSync(Buffer.from("-- PostgreSQL database dump\nCREATE TABLE t (id int);\n")),
    );
    mockBackup = baseBackup(dumpPath);
    // Allow the best-effort failure UPDATE to consume a queued (empty) result.
    ee.queueMockRows([]);

    const result = await run(verifyBackup("b1"));
    expect(result.verified).toBe(false);
    expect(result.level).toBe("full-restore");
  });
});

// ── (1) Real-PG regression — opt-in, skips when no scratch DB available ──

const SCRATCH_URL = process.env.ATLAS_BACKUP_VERIFY_SCRATCH_URL_TEST ?? process.env.TEST_DATABASE_URL;
const hasPsqlTools =
  spawnSync("psql", ["--version"]).status === 0 && spawnSync("pg_dump", ["--version"]).status === 0;

const describeIfPg = SCRATCH_URL && hasPsqlTools ? describe : describe.skip;

describeIfPg("verifyBackup full-restore — real Postgres smoke (#2941)", () => {
  // A self-contained valid plain-format dump: one CREATE TABLE + a couple
  // INSERTs. Restoring this into a fresh public schema yields ≥1 table.
  const VALID_DUMP = [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "SET statement_timeout = 0;",
    "SET client_encoding = 'UTF8';",
    "CREATE TABLE public.widgets (id integer NOT NULL, name text);",
    "INSERT INTO public.widgets (id, name) VALUES (1, 'alpha');",
    "INSERT INTO public.widgets (id, name) VALUES (2, 'beta');",
    "ALTER TABLE ONLY public.widgets ADD CONSTRAINT widgets_pkey PRIMARY KEY (id);",
    "--",
    "-- PostgreSQL database dump complete",
    "--",
    "",
  ].join("\n");

  let tmp: string;

  beforeEach(() => {
    ee.reset();
    tmp = mkdtempSync(join(tmpdir(), "atlas-verify-pg-"));
    // SCRATCH_URL is guaranteed defined inside describeIfPg.
    process.env.ATLAS_BACKUP_VERIFY_SCRATCH_URL = SCRATCH_URL as string;
  });

  afterAll(() => {
    delete process.env.ATLAS_BACKUP_VERIFY_SCRATCH_URL;
  });

  it("verifies a valid dump as restorable with a non-zero table count", async () => {
    const dumpPath = join(tmp, "valid.sql.gz");
    writeFileSync(dumpPath, gzipSync(Buffer.from(VALID_DUMP)));
    mockBackup = baseBackup(dumpPath);
    ee.queueMockRows([]); // status -> verified UPDATE

    const result = await run(verifyBackup("b1"));
    rmSync(tmp, { recursive: true, force: true });

    expect(result.level).toBe("full-restore");
    expect(result.verified).toBe(true);
    // The message reports the restored table count.
    expect(result.message).toMatch(/restored \d+ table/);
  });

  it("REGRESSION: a valid-header-but-truncated dump now FAILS (header-only would have passed)", async () => {
    // Truncate the valid dump mid-statement but KEEP the header. The old
    // header-only check returned verified:true for exactly this shape; the
    // restore smoke makes psql exit non-zero under ON_ERROR_STOP=on.
    const truncatedAt = VALID_DUMP.indexOf("CREATE TABLE public.widgets (id integer NOT NULL");
    const truncated = VALID_DUMP.slice(0, truncatedAt + 40); // cut off mid-CREATE TABLE
    expect(truncated.includes("PostgreSQL database dump")).toBe(true); // header survives

    const dumpPath = join(tmp, "truncated.sql.gz");
    writeFileSync(dumpPath, gzipSync(Buffer.from(truncated)));
    mockBackup = baseBackup(dumpPath);
    ee.queueMockRows([]); // status -> failed UPDATE

    const result = await run(verifyBackup("b1"));
    rmSync(tmp, { recursive: true, force: true });

    expect(result.level).toBe("full-restore");
    expect(result.verified).toBe(false);
  });
});
