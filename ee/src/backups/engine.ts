/**
 * Backup engine — pg_dump-based backup with gzip compression.
 *
 * Creates compressed backups of the internal PostgreSQL database
 * and stores them to a configurable local directory.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 * Enterprise-gated via requireEnterpriseEffect("backups").
 */

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { mkdir, stat, unlink, readdir } from "fs/promises";
import { join, dirname } from "path";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { Effect } from "effect";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
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
           error_message         TEXT
         )`,
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
 * Create a backup of the internal database.
 *
 * Uses pg_dump with plain-text format, then gzip-compresses the output.
 * Records the backup in the internal backups table.
 */
export const createBackup = (): Effect.Effect<
  { id: string; storagePath: string; sizeBytes: number; status: BackupStatus },
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

    // Inner effect uses tryPromise so errors land in the typed channel
    // (Effect.promise treats rejections as defects, which bypass tapError)
    const backupWork = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(storagePath), { recursive: true }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      const { args, password } = parseDatabaseUrl(databaseUrl);

      // Run pg_dump → gzip → file
      const pgDump = spawn("pg_dump", [...args, "--format=plain"], {
        env: { ...process.env, PGPASSWORD: password ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const outStream = createWriteStream(storagePath);
      const gzip = createGzip();

      // Collect stderr for error reporting
      let stderr = "";
      pgDump.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      yield* Effect.tryPromise({
        try: () => pipeline(pgDump.stdout, gzip, outStream),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      const exitCode = yield* Effect.tryPromise({
        try: () => new Promise<number>((resolve) => { pgDump.on("close", resolve); }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (exitCode !== 0) {
        return yield* Effect.fail(new Error(`pg_dump exited with code ${exitCode}: ${stderr.slice(0, 500)}`));
      }

      // Get file size
      const fileStat = yield* Effect.tryPromise({
        try: () => stat(storagePath),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      // Mark as completed
      yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `UPDATE backups SET status = 'completed', size_bytes = $1 WHERE id = $2`,
            [fileStat.size, backupId],
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      log.info({ backupId, storagePath, sizeBytes: fileStat.size }, "Backup completed successfully");
      return { id: backupId, storagePath, sizeBytes: fileStat.size, status: "completed" as const };
    });

    return yield* backupWork.pipe(
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
};

type BackupRowQuery = {
  id: string;
  created_at: string;
  size_bytes: string | null;
  status: string;
  storage_path: string;
  retention_expires_at: string;
  error_message: string | null;
};

export const listBackups = (limit = 50): Effect.Effect<BackupRow[], EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* ensureTable();
    const rows = yield* Effect.promise(() =>
      internalQuery<BackupRowQuery>(
        `SELECT id, created_at::text, size_bytes::text, status, storage_path, retention_expires_at::text, error_message
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
        `SELECT id, created_at::text, size_bytes::text, status, storage_path, retention_expires_at::text, error_message
         FROM backups WHERE id = $1`,
        [id],
      ),
    );
    return (rows[0] as BackupRow | undefined) ?? null;
  });

/**
 * Delete expired backups — removes both the DB record and the file on disk.
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
      const fileDeleted = yield* Effect.tryPromise({
        try: () => unlink(row.storage_path),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => true),
        Effect.catchAll((err) => {
          const code = "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
          if (code === "ENOENT") return Effect.succeed(true); // file already removed
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

    return purged;
  });

/**
 * List files in the backup storage directory for verification purposes.
 */
export const listStorageFiles = (): Effect.Effect<string[], EnterpriseError | Error> =>
  Effect.gen(function* () {
    const config = yield* getBackupConfig();
    return yield* Effect.tryPromise({
      try: () => readdir(config.storage_path),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.map((files) => files.filter((f) => f.endsWith(".sql.gz"))),
      Effect.catchAll((err) => {
        if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return Effect.succeed([] as string[]);
        }
        log.warn(
          { err: err.message, path: config.storage_path },
          "Failed to list backup storage directory",
        );
        return Effect.fail(err);
      }),
    );
  });
