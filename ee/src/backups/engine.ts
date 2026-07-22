/**
 * Backup engine — pg_dump-based backup with gzip compression.
 *
 * Creates compressed backups of the internal PostgreSQL database and
 * streams them to the configured storage driver (`./storage.ts`) — local
 * directory by default, S3-compatible object storage (Railway buckets)
 * when `ATLAS_BACKUP_S3_BUCKET` is set (#4457).
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 * Enterprise-gated via requireEnterpriseEffect("backups").
 */

import { spawn } from "child_process";
import { join } from "path";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { PassThrough } from "stream";
import { Effect } from "effect";
import { requireEnterpriseEffect } from "../index";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { requireInternalDBEffect } from "../lib/db-guard";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getBackupStorage } from "./storage";
import type { BackupStatus } from "@useatlas/types";

const log = createLogger("ee:backups-engine");

// ---------------------------------------------------------------------------
// Table bootstrap — idempotent, runs on first use
// ---------------------------------------------------------------------------

let _tableReady = false;

export const ensureTable = (): Effect.Effect<void, EnterpriseError | Error> =>
  Effect.gen(function* () {
    if (_tableReady) return;
    yield* requireInternalDBEffect("backup operations");

    yield* Effect.promise(() =>
      internalQuery(
        `CREATE TABLE IF NOT EXISTS backups (
           id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
           created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
           size_bytes            BIGINT,
           status                TEXT NOT NULL DEFAULT 'in_progress',
           storage_path          TEXT NOT NULL,
           retention_expires_at  TIMESTAMPTZ NOT NULL,
           error_message         TEXT,
           verify_level          TEXT
         )`,
      ),
    );
    // verify_level records which depth of verification last ran for a backup —
    // 'full-restore' (restored into a scratch DB and counted) vs 'header-only'
    // (degraded fallback). The `backups` table IS mirrored in
    // `packages/api/src/lib/db/schema.ts` (and migrations/0000_baseline.sql), so
    // this column MUST also be mirrored there (`verifyLevel: text("verify_level")`)
    // — otherwise the next `drizzle-kit generate` emits a DROP COLUMN and wipes
    // it on deploy (#2941). This idempotent ALTER adds the column at runtime for
    // existing deployments whose `backups` table predates #2941.
    yield* Effect.promise(() =>
      internalQuery(
        `ALTER TABLE backups ADD COLUMN IF NOT EXISTS verify_level TEXT`,
      ),
    );
    // expected_table_count records the source DB's public BASE TABLE count
    // at backup time. verifyByRestore asserts restored >= expected to catch
    // a dump truncated on a CLEAN statement boundary — psql exits 0 but the
    // restore is incomplete, which the bare "> 0 base tables" check misses
    // (#2989, follow-up to #2941). Mirrored in
    // `packages/api/src/lib/db/schema.ts` (`expectedTableCount`) so the next
    // `drizzle-kit generate` doesn't emit a DROP COLUMN. Idempotent ALTER
    // adds it at runtime for deployments whose `backups` table predates this.
    yield* Effect.promise(() =>
      internalQuery(
        `ALTER TABLE backups ADD COLUMN IF NOT EXISTS expected_table_count INTEGER`,
      ),
    );
    // scheduled_window (#4457) — the cross-replica concurrency claim for the
    // scheduled-backup fiber. NULL for manual backups; for scheduled ones it
    // holds the deterministic cadence-window key (`backupWindowKey`), and the
    // partial UNIQUE index makes the claim atomic: whichever replica's
    // INSERT lands first owns the window's backup, everyone else's
    // `ON CONFLICT DO NOTHING` insert returns no row. Mirrored in
    // `packages/api/src/lib/db/schema.ts` + migration 0177 (same discipline
    // as verify_level / expected_table_count above); this idempotent ALTER
    // covers deployments whose `backups` table predates the migration.
    yield* Effect.promise(() =>
      internalQuery(
        `ALTER TABLE backups ADD COLUMN IF NOT EXISTS scheduled_window TEXT`,
      ),
    );
    yield* Effect.promise(() =>
      internalQuery(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_scheduled_window
           ON backups (scheduled_window) WHERE scheduled_window IS NOT NULL`,
      ),
    );
    yield* Effect.promise(() =>
      internalQuery(
        `CREATE INDEX IF NOT EXISTS idx_backups_status ON backups (status, created_at DESC)`,
      ),
    );

    // Backup config table — single row keyed by '_default'
    yield* Effect.promise(() =>
      internalQuery(
        `CREATE TABLE IF NOT EXISTS backup_config (
           id              TEXT PRIMARY KEY DEFAULT '_default',
           schedule        TEXT NOT NULL DEFAULT '0 3 * * *',
           retention_days  INT NOT NULL DEFAULT 30,
           storage_path    TEXT NOT NULL DEFAULT './backups',
           updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      ),
    );

    // Seed default config
    const envSchedule = process.env.ATLAS_BACKUP_SCHEDULE ?? "0 3 * * *";
    const envRetention = parseInt(process.env.ATLAS_BACKUP_RETENTION_DAYS ?? "30", 10) || 30;
    const envStorage = process.env.ATLAS_BACKUP_STORAGE_PATH ?? "./backups";
    yield* Effect.promise(() =>
      internalQuery(
        `INSERT INTO backup_config (id, schedule, retention_days, storage_path)
         VALUES ('_default', $1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [envSchedule, envRetention, envStorage],
      ),
    );

    _tableReady = true;
  });

/** @internal Reset table-ready flag — for testing only. */
export function _resetTableReady(): void {
  _tableReady = false;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type BackupConfigRow = {
  schedule: string;
  retention_days: number;
  storage_path: string;
};

export const getBackupConfig = (): Effect.Effect<BackupConfigRow, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* ensureTable();
    const rows = yield* Effect.promise(() =>
      internalQuery<{
        schedule: string;
        retention_days: number;
        storage_path: string;
      }>(
        `SELECT schedule, retention_days, storage_path FROM backup_config WHERE id = '_default'`,
      ),
    );
    if (!rows[0]) {
      log.warn("Backup config row missing from database — using defaults");
      return { schedule: "0 3 * * *", retention_days: 30, storage_path: "./backups" };
    }
    return rows[0];
  });

export const updateBackupConfig = (
  config: { schedule?: string; retentionDays?: number; storagePath?: string },
): Effect.Effect<void, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* ensureTable();
    const current = yield* getBackupConfig();
    const schedule = config.schedule ?? current.schedule;
    const retentionDays = config.retentionDays ?? current.retention_days;
    const storagePath = config.storagePath ?? current.storage_path;

    yield* Effect.promise(() =>
      internalQuery(
        `INSERT INTO backup_config (id, schedule, retention_days, storage_path, updated_at)
         VALUES ('_default', $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET
           schedule = $1,
           retention_days = $2,
           storage_path = $3,
           updated_at = now()`,
        [schedule, retentionDays, storagePath],
      ),
    );
  });

// ---------------------------------------------------------------------------
// Backup creation
// ---------------------------------------------------------------------------

/**
 * Parse DATABASE_URL into pg_dump connection arguments.
 * Extracts host, port, user, dbname from the URL. Password is passed
 * via PGPASSWORD env var to avoid shell exposure.
 */
function parseDatabaseUrl(url: string): { args: string[]; password: string | undefined } {
  const parsed = new URL(url);
  const args: string[] = [];

  if (parsed.hostname) args.push("-h", parsed.hostname);
  if (parsed.port) args.push("-p", parsed.port);
  if (parsed.username) args.push("-U", parsed.username);

  // Database name is the path without leading slash
  const dbName = parsed.pathname.replace(/^\//, "");
  if (dbName) args.push("-d", dbName);

  return { args, password: parsed.password ? decodeURIComponent(parsed.password) : undefined };
}

/**
 * Count the source DB's public BASE TABLE count — the verification baseline
 * persisted on each backup (#2989). Queried via `internalQuery` (the same
 * internal Postgres pg_dump dumps), filtered to `BASE TABLE` in the `public`
 * schema so it lines up with what `verifyByRestore` counts after restoring.
 *
 * Best-effort: returns `null` (not a failure) when the count can't be read,
 * so a transient query error never aborts an otherwise-good backup — verify
 * simply skips the `restored >= expected` assertion for that backup.
 */
const countSourceBaseTables = (): Effect.Effect<number | null, never> =>
  Effect.tryPromise({
    try: () =>
      internalQuery<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      ),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((rows) => {
      const n = rows[0] ? parseInt(rows[0].count, 10) : Number.NaN;
      return Number.isNaN(n) ? null : n;
    }),
    Effect.catchAll((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Could not count source base tables for the backup verification baseline — verify will skip the count assertion",
      );
      return Effect.succeed(null);
    }),
  );

export type CreateBackupResult = {
  id: string;
  storagePath: string;
  sizeBytes: number;
  status: BackupStatus;
};

/** Shared pre-insert plumbing for both the manual and scheduled create paths. */
const prepareBackupTarget = (): Effect.Effect<
  { databaseUrl: string; storagePath: string; retentionExpiresAt: string },
  EnterpriseError | Error
> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("backups");
    yield* ensureTable();

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return yield* Effect.fail(new Error("DATABASE_URL is not set — cannot create backup"));
    }

    const config = yield* getBackupConfig();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `atlas-backup-${timestamp}.sql.gz`;
    const storagePath = join(config.storage_path, filename);
    const retentionExpiresAt = new Date(Date.now() + config.retention_days * 24 * 60 * 60 * 1000).toISOString();
    return { databaseUrl, storagePath, retentionExpiresAt };
  });

/**
 * The dump→compress→store pipeline for an already-inserted `in_progress`
 * row. pg_dump streams through gzip into the storage driver (local fs or
 * S3 — see ./storage.ts), so nothing is buffered in memory and the write
 * target survives redeploys when the S3 driver is configured (#4457).
 */
const performBackup = (
  backupId: string,
  storagePath: string,
  databaseUrl: string,
): Effect.Effect<CreateBackupResult, Error> => {
  // Inner effect uses tryPromise so errors land in the typed channel
  // (Effect.promise treats rejections as defects, which bypass tapError)
  const backupWork = Effect.gen(function* () {
    const { args, password } = parseDatabaseUrl(databaseUrl);

    // Run pg_dump → gzip → storage driver
    const pgDump = spawn("pg_dump", [...args, "--format=plain"], {
      env: { ...process.env, PGPASSWORD: password ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture spawn-level failures (ENOENT when pg_dump isn't on PATH,
    // EACCES, …). Without a listener the 'error' event is an uncaught
    // exception with zero backup context, 'close' never fires, and the
    // pipeline surfaces a misleading "Premature close" — the operator
    // would chase the wrong cause. The capture is preferred over the
    // derived stream error wherever a failure is reported below.
    let spawnError: Error | null = null;
    pgDump.on("error", (err) => {
      spawnError = err instanceof Error ? err : new Error(String(err));
    });

    // Latch the exit code NOW, while pg_dump is still running — never after
    // the pipeline await below. `close` is a one-shot event that fires as
    // soon as the pipeline drains pg_dump's stdout (observed ~150ms before
    // `Promise.all` settles, because the S3 `writer.end()` round-trip runs
    // after stdout EOF). A `close` listener attached *after* that await
    // always misses the already-fired event and waits forever — the 2h fiber
    // timeout then interrupts the cycle, stranding the row `in_progress` with
    // no error and no size (every scheduled backup in prod hung this way).
    // Resolve-only on BOTH events: `error` (ENOENT/EACCES) is already
    // captured in `spawnError` above and may fire without a following
    // `close`, so it must also settle this latch or the await re-hangs.
    let exitCode: number | null = null;
    const exitClosed = new Promise<void>((resolve) => {
      pgDump.on("close", (code) => {
        exitCode = code;
        resolve();
      });
      pgDump.on("error", () => resolve());
    });

    const gzip = createGzip();
    const gzipped = new PassThrough();

    // Collect stderr for error reporting
    let stderr = "";
    pgDump.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // The pipeline promise and the storage write settle together: pipeline
    // propagates pg_dump/gzip stream errors, put propagates storage errors,
    // and a rejected put destroys the PassThrough so the pipeline can't
    // hang on backpressure.
    const sizeBytes = yield* Effect.tryPromise({
      try: async () => {
        const storage = getBackupStorage();
        const pipelineDone = pipeline(pgDump.stdout, gzip, gzipped);
        const putDone = storage.put(storagePath, gzipped).catch((err: unknown) => {
          // Destroy WITHOUT an error argument: the put rejection already
          // carries the failure (and rejects the Promise.all below), and
          // destroy(err) would emit 'error' on a stream that may have no
          // listener yet. A bare destroy unblocks the pipeline instead.
          gzipped.destroy();
          throw err instanceof Error ? err : new Error(String(err));
        });
        const [{ sizeBytes: written }] = await Promise.all([putDone, pipelineDone]);
        return written;
      },
      // A spawn failure manifests here as a derived stream error — report
      // the root cause instead.
      catch: (err) => spawnError ?? (err instanceof Error ? err : new Error(String(err))),
    });

    // Awaits the pre-registered latch — already settled by now (pg_dump
    // exited during the pipeline above), so this is an immediate read, not a
    // fresh listen that could miss the event.
    yield* Effect.tryPromise({
      try: () => exitClosed,
      catch: (err) => spawnError ?? (err instanceof Error ? err : new Error(String(err))),
    });

    // A spawn failure (or an `error`-without-`close`) leaves `exitCode` null:
    // surface the captured spawn error rather than a misleading exit code.
    if (spawnError) {
      return yield* Effect.fail(spawnError);
    }

    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`pg_dump exited with code ${exitCode}: ${stderr.slice(0, 500)}`));
    }

    // Capture the source DB's public BASE TABLE count as the verification
    // baseline (#2989). Best-effort — null when unreadable.
    const expectedTableCount = yield* countSourceBaseTables();

    // Mark as completed
    yield* Effect.tryPromise({
      try: () =>
        internalQuery(
          `UPDATE backups SET status = 'completed', size_bytes = $1, expected_table_count = $2 WHERE id = $3`,
          [sizeBytes, expectedTableCount, backupId],
        ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    log.info({ backupId, storagePath, sizeBytes, expectedTableCount }, "Backup completed successfully");
    return { id: backupId, storagePath, sizeBytes, status: "completed" as const };
  });

  return backupWork.pipe(
    Effect.tapError((err) =>
      Effect.sync(() => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Best-effort status update — fire-and-forget with error handling
        void internalQuery(
          `UPDATE backups SET status = 'failed', error_message = $1 WHERE id = $2`,
          [errorMessage.slice(0, 2000), backupId],
        ).catch((updateErr) => {
          log.warn(
            { err: updateErr instanceof Error ? updateErr.message : String(updateErr), backupId },
            "Failed to update backup status to failed",
          );
        });
        log.error({ err: err instanceof Error ? err : new Error(String(err)), backupId }, "Backup failed");
      }),
    ),
  );
};

/**
 * Create a backup of the internal database (manual/admin path — unchanged
 * contract).
 *
 * Uses pg_dump with plain-text format, then gzip-compresses the output.
 * Records the backup in the internal backups table.
 */
export const createBackup = (): Effect.Effect<
  CreateBackupResult,
  EnterpriseError | Error
> =>
  Effect.gen(function* () {
    const { databaseUrl, storagePath, retentionExpiresAt } = yield* prepareBackupTarget();

    // Insert in-progress record
    const rows = yield* Effect.promise(() =>
      internalQuery<{ id: string }>(
        `INSERT INTO backups (status, storage_path, retention_expires_at)
         VALUES ('in_progress', $1, $2)
         RETURNING id`,
        [storagePath, retentionExpiresAt],
      ),
    );
    const backupId = rows[0].id;

    return yield* performBackup(backupId, storagePath, databaseUrl);
  });

/**
 * Scheduled-path variant (#4457): atomically claim the cadence window and
 * create its backup. The claim IS the `in_progress` insert — the partial
 * UNIQUE index on `scheduled_window` guarantees at most one row per window
 * across every replica, so N concurrent fibers can never fan out N pg_dumps
 * (the #4650 re-storm class). Returns `null` when the window is already
 * claimed (another replica won, or this window's backup already ran /
 * already failed — a failed attempt keeps its claim, so a window is
 * attempted at most once; the /health tripwire surfaces a missed window).
 */
export const createScheduledBackup = (
  windowKey: string,
): Effect.Effect<CreateBackupResult | null, EnterpriseError | Error> =>
  Effect.gen(function* () {
    const { databaseUrl, storagePath, retentionExpiresAt } = yield* prepareBackupTarget();

    // tryPromise, not Effect.promise: a rejection here (transient DB blip,
    // pool exhaustion) must stay a TYPED failure so the scheduled fiber's
    // onTickFailure recovery logs it and the repeat loop survives — a
    // defect would escape catchAll and kill the fiber for the process
    // lifetime (the layers.ts registration also demotes residual defects).
    const rows = yield* Effect.tryPromise({
      try: () =>
        internalQuery<{ id: string }>(
          `INSERT INTO backups (status, storage_path, retention_expires_at, scheduled_window)
           VALUES ('in_progress', $1, $2, $3)
           ON CONFLICT (scheduled_window) WHERE scheduled_window IS NOT NULL DO NOTHING
           RETURNING id`,
          [storagePath, retentionExpiresAt, windowKey],
        ),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
    if (!rows[0]) return null; // window already claimed

    return yield* performBackup(rows[0].id, storagePath, databaseUrl);
  });

// ---------------------------------------------------------------------------
// List / purge
// ---------------------------------------------------------------------------

export type BackupRow = {
  id: string;
  created_at: string;
  size_bytes: string | null;
  status: BackupStatus;
  storage_path: string;
  retention_expires_at: string;
  error_message: string | null;
  /** Depth of the last verification — 'full-restore' | 'header-only' | null (never verified). */
  verify_level: string | null;
  /**
   * Source DB's public BASE TABLE count captured at backup time (#2989).
   * `verifyByRestore` asserts the restored count is >= this. Null for
   * backups created before this column existed, or when the count couldn't
   * be read — verify then skips the assertion.
   */
  expected_table_count: number | null;
};

type BackupRowQuery = {
  id: string;
  created_at: string;
  size_bytes: string | null;
  status: string;
  storage_path: string;
  retention_expires_at: string;
  error_message: string | null;
  verify_level: string | null;
  expected_table_count: number | null;
};

export const listBackups = (limit = 50): Effect.Effect<BackupRow[], EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* ensureTable();
    const rows = yield* Effect.promise(() =>
      internalQuery<BackupRowQuery>(
        `SELECT id, created_at::text, size_bytes::text, status, storage_path, retention_expires_at::text, error_message, verify_level, expected_table_count
         FROM backups
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      ),
    );
    return rows as BackupRow[];
  });

export const getBackupById = (id: string): Effect.Effect<BackupRow | null, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* ensureTable();
    const rows = yield* Effect.promise(() =>
      internalQuery<BackupRowQuery>(
        `SELECT id, created_at::text, size_bytes::text, status, storage_path, retention_expires_at::text, error_message, verify_level, expected_table_count
         FROM backups WHERE id = $1`,
        [id],
      ),
    );
    return (rows[0] as BackupRow | undefined) ?? null;
  });

/**
 * An incomplete multipart upload older than this is abandoned — no backup
 * takes a week to upload. Aborted during the retention purge (#4727) because
 * Railway buckets support no lifecycle configuration, so the "expire
 * incomplete multipart uploads" rule the platform would normally own has to
 * be enforced by Atlas itself.
 */
const STALE_MULTIPART_UPLOAD_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Abort incomplete multipart uploads under the backup prefix that are older
 * than {@link STALE_MULTIPART_UPLOAD_AFTER_MS}. Never fails the cycle: a
 * driver without a multipart concept (local), an endpoint that doesn't
 * implement the API, and a transport failure all resolve to a logged 0.
 */
const abortStaleMultipartUploads = (): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const config = yield* getBackupConfig();
    return yield* Effect.tryPromise({
      try: () => getBackupStorage().abortStaleUploads(config.storage_path, STALE_MULTIPART_UPLOAD_AFTER_MS),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
  }).pipe(
    Effect.catchAll((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Could not abort stale incomplete multipart uploads — retrying next purge cycle",
      );
      return Effect.succeed(0);
    }),
  );

/**
 * Delete expired backups — removes both the DB record and the file on disk,
 * then sweeps abandoned incomplete multipart uploads under the backup prefix.
 */
export const purgeExpiredBackups = (): Effect.Effect<number, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* ensureTable();

    const expired = yield* Effect.promise(() =>
      internalQuery<{ id: string; storage_path: string }>(
        `SELECT id, storage_path FROM backups WHERE retention_expires_at < now()`,
      ),
    );

    let purged = 0;
    for (const row of expired) {
      // storage.remove is already-gone-tolerant (local ENOENT and the S3
      // missing-key delete both resolve), so a rejection here is a real
      // storage failure — keep the DB record so the artifact isn't orphaned.
      const fileDeleted = yield* Effect.tryPromise({
        try: () => getBackupStorage().remove(row.storage_path),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => true),
        Effect.catchAll((err) => {
          log.warn(
            { err: err.message, backupId: row.id, path: row.storage_path },
            "Could not delete backup file — skipping DB record deletion to avoid orphan",
          );
          return Effect.succeed(false);
        }),
      );

      if (!fileDeleted) continue;

      const dbDeleted = yield* Effect.tryPromise({
        try: () => internalQuery(`DELETE FROM backups WHERE id = $1`, [row.id]),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => true),
        Effect.catchAll((err) => {
          log.warn(
            { err: err.message, backupId: row.id },
            "Failed to delete backup DB record — will retry on next purge cycle",
          );
          return Effect.succeed(false);
        }),
      );

      if (dbDeleted) purged++;
    }

    if (purged > 0) {
      log.info({ count: purged }, "Purged expired backups");
    }

    // Storage-side housekeeping: parts left behind by failed uploads are
    // invisible to `list`, so nothing else in the system would ever reclaim
    // them. Deliberately after the row purge and failure-isolated — the
    // purge count is the caller's contract and must not depend on it.
    yield* abortStaleMultipartUploads();

    return purged;
  });

/**
 * List artifacts in the backup storage location for verification purposes.
 * The driver already filters to `.sql.gz` basenames and treats a missing
 * location (local ENOENT / empty S3 prefix) as an empty list.
 */
export const listStorageFiles = (): Effect.Effect<string[], EnterpriseError | Error> =>
  Effect.gen(function* () {
    const config = yield* getBackupConfig();
    return yield* Effect.tryPromise({
      try: () => getBackupStorage().list(config.storage_path),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.catchAll((err) => {
        log.warn(
          { err: err.message, path: config.storage_path },
          "Failed to list backup storage",
        );
        return Effect.fail(err);
      }),
    );
  });
