/**
 * Backup verification — restorability checks for backup files.
 *
 * Two verification levels (#2941):
 *
 *  - **full-restore** (preferred): when `ATLAS_BACKUP_VERIFY_SCRATCH_URL` points
 *    at a disposable scratch Postgres, the dump is decompressed and piped into
 *    `psql --single-transaction --set ON_ERROR_STOP=on` against that scratch DB,
 *    then a `count(*)` over `information_schema.tables` proves the restore
 *    produced real objects. "Verified" then means "restorable", not merely "has
 *    a valid header". A dump that is a valid pg_dump header but truncated /
 *    corrupt-tailed makes psql exit non-zero (or yields zero tables) under
 *    ON_ERROR_STOP=on, so verification FAILS — which header-only checking missed.
 *
 *  - **header-only** (degraded fallback): when no scratch URL is configured we
 *    gunzip the first 4096 bytes and check for the pg_dump header string. This
 *    is the legacy behaviour and is strictly weaker — a truncated dump can pass.
 *    We log a loud warning explaining WHY we degraded (never silently skip).
 *
 * ⚠️  The scratch URL MUST point at a genuinely disposable database. Full-restore
 *    verification WIPES the scratch DB's `public` schema (`DROP SCHEMA public
 *    CASCADE; CREATE SCHEMA public;`) before each restore so a plain-format
 *    pg_dump restores without object conflicts. Never point it at a real DB.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 * Enterprise-gated via requireEnterpriseEffect("backups").
 */

import { spawn } from "child_process";
import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Effect } from "effect";
import { requireEnterpriseEffect } from "../index";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { requireInternalDBEffect } from "../lib/db-guard";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { ensureTable, getBackupById } from "./engine";

const log = createLogger("ee:backups-verify");

/** Which depth of verification actually ran for a given backup. */
export type VerifyLevel = "full-restore" | "header-only";

/**
 * Verify a backup file's restorability.
 *
 * 1. Check the DB record exists and is in completed/verified state.
 * 2. If `ATLAS_BACKUP_VERIFY_SCRATCH_URL` is set → restore-into-scratch-DB smoke
 *    (decompress → psql → count tables). "verified" means "restorable".
 * 3. Otherwise → degrade to a header-only check and log a loud warning.
 *
 * Returns `{ verified, message, level }`. `verified:true` on success,
 * `verified:false` on integrity failure (the backup row is stamped `failed`).
 * Fails with Error if the backup is not found, has an invalid status, or the
 * internal DB is not configured.
 */
export const verifyBackup = (
  backupId: string,
): Effect.Effect<{ verified: boolean; message: string; level: VerifyLevel }, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("backups");
    yield* ensureTable();

    yield* requireInternalDBEffect("backup verification");

    const backup = yield* getBackupById(backupId);
    if (!backup) {
      return yield* Effect.fail(new Error("Backup not found"));
    }

    if (backup.status !== "completed" && backup.status !== "verified") {
      return yield* Effect.fail(new Error(`Cannot verify backup with status "${backup.status}"`));
    }

    const scratchUrl = process.env.ATLAS_BACKUP_VERIFY_SCRATCH_URL;

    // Inner effect uses tryPromise so errors land in the typed channel
    const verifyWork = scratchUrl
      ? verifyByRestore(backupId, backup.storage_path, scratchUrl)
      : verifyByHeader(backupId, backup.storage_path);

    return yield* verifyWork.pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), backupId },
            "Backup verification failed",
          );

          // Best-effort status update — fire-and-forget with error handling
          void internalQuery(
            `UPDATE backups SET status = 'failed', error_message = $1 WHERE id = $2`,
            [`Verification failed: ${errorMessage.slice(0, 1000)}`, backupId],
          ).catch((updateErr) => {
            log.warn(
              { err: updateErr instanceof Error ? updateErr.message : String(updateErr), backupId },
              "Failed to update backup status after verification failure",
            );
          });

          // A verify that can't actually verify is a failure, not a pass —
          // when a scratch URL IS configured but the restore path blew up
          // (psql missing, connection refused, …) we report the strongest
          // level so callers don't mistake this for a degraded header check.
          const level: VerifyLevel = scratchUrl ? "full-restore" : "header-only";
          return { verified: false, message: `Verification failed: ${errorMessage}`, level };
        }),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Full-restore verification — restore into a disposable scratch DB and count.
// ---------------------------------------------------------------------------

/**
 * Restore the dump into the scratch DB and assert it produced objects.
 *
 * Resets the scratch DB's public schema, pipes the decompressed dump into
 * `psql --single-transaction --set ON_ERROR_STOP=on`, then counts tables in
 * `information_schema`. A truncated dump exits non-zero under ON_ERROR_STOP or
 * yields zero tables → verification fails.
 */
const verifyByRestore = (
  backupId: string,
  storagePath: string,
  scratchUrl: string,
): Effect.Effect<{ verified: boolean; message: string; level: VerifyLevel }, Error> =>
  Effect.gen(function* () {
    const conn = parsePsqlConn(scratchUrl);

    log.info({ backupId }, "Verifying backup via restore-into-scratch-DB smoke");

    // Step 1: reset the scratch schema so a plain-format dump restores cleanly.
    yield* runPsqlCommand(conn, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

    // Step 2: restore the dump into the scratch DB.
    yield* restoreDumpIntoScratch(conn, storagePath);

    // Step 3: prove the restore produced real objects.
    const tableCount = yield* countScratchTables(conn);

    if (tableCount <= 0) {
      yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `UPDATE backups SET status = 'failed', verify_level = 'full-restore', error_message = 'Verification failed: restore smoke produced zero tables' WHERE id = $1`,
            [backupId],
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      return {
        verified: false,
        message: "Restore smoke produced zero tables in public schema — backup is empty or unrestorable",
        level: "full-restore" as const,
      };
    }

    yield* Effect.tryPromise({
      try: () =>
        internalQuery(
          `UPDATE backups SET status = 'verified', verify_level = 'full-restore', error_message = NULL WHERE id = $1`,
          [backupId],
        ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    log.info({ backupId, tableCount, level: "full-restore" }, "Backup verified via restore-into-scratch-DB smoke");
    return {
      verified: true,
      message: `Backup verified via restore-into-scratch-DB smoke — restored ${tableCount} table(s)`,
      level: "full-restore" as const,
    };
  });

type PsqlConn = { args: string[]; password: string };

/** Parse a Postgres URL into psql connection args (password via PGPASSWORD). */
function parsePsqlConn(url: string): PsqlConn {
  const parsed = new URL(url);
  const args: string[] = [];
  if (parsed.hostname) args.push("-h", parsed.hostname);
  if (parsed.port) args.push("-p", parsed.port);
  if (parsed.username) args.push("-U", parsed.username);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (dbName) args.push("-d", dbName);
  return { args, password: parsed.password ? decodeURIComponent(parsed.password) : "" };
}

/** Run a single SQL command against the scratch DB via `psql -c`. */
const runPsqlCommand = (conn: PsqlConn, sql: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const psql = spawn(
      "psql",
      [...conn.args, "--set", "ON_ERROR_STOP=on", "-c", sql],
      {
        env: { ...process.env, PGPASSWORD: conn.password },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";
    psql.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          psql.on("close", resolve);
          psql.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
        }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`psql command failed (exit ${exitCode}): ${stderr.slice(0, 500)}`));
    }
  });

/**
 * Decompress the dump and pipe it into `psql --single-transaction --set
 * ON_ERROR_STOP=on`. Reuses the psql-pipe pattern from restore.ts:126-167.
 */
const restoreDumpIntoScratch = (conn: PsqlConn, storagePath: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const psql = spawn(
      "psql",
      [...conn.args, "--single-transaction", "--set", "ON_ERROR_STOP=on"],
      {
        env: { ...process.env, PGPASSWORD: conn.password },
        stdio: ["pipe", "ignore", "pipe"],
      },
    );

    let stderr = "";
    psql.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const input = createReadStream(storagePath);
    const gunzip = createGunzip();

    yield* Effect.tryPromise({
      try: () => pipeline(input, gunzip, psql.stdin),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const exitCode = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          psql.on("close", resolve);
          psql.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
        }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`Restore smoke failed — psql exited ${exitCode}: ${stderr.slice(0, 500)}`),
      );
    }
  });

/** Count tables in the scratch DB's public schema after a restore. */
const countScratchTables = (conn: PsqlConn): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const psql = spawn(
      "psql",
      [
        ...conn.args,
        "--set",
        "ON_ERROR_STOP=on",
        "-tA",
        "-c",
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
      ],
      {
        env: { ...process.env, PGPASSWORD: conn.password },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    psql.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    psql.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          psql.on("close", resolve);
          psql.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
        }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`Table count failed (exit ${exitCode}): ${stderr.slice(0, 500)}`));
    }

    const count = parseInt(stdout.trim(), 10);
    if (Number.isNaN(count)) {
      return yield* Effect.fail(new Error(`Could not parse table count from psql output: "${stdout.trim()}"`));
    }
    return count;
  });

// ---------------------------------------------------------------------------
// Header-only verification — degraded fallback when no scratch DB is configured.
// ---------------------------------------------------------------------------

/**
 * Legacy header-only check. Strictly weaker than full-restore — a valid header
 * with a truncated tail passes. Logs a loud warning so operators know why
 * verification degraded and how to upgrade it.
 */
const verifyByHeader = (
  backupId: string,
  storagePath: string,
): Effect.Effect<{ verified: boolean; message: string; level: VerifyLevel }, Error> =>
  Effect.gen(function* () {
    log.warn(
      { backupId },
      "ATLAS_BACKUP_VERIFY_SCRATCH_URL is not set — degrading to header-only backup verification. " +
        "A truncated/corrupt dump with a valid header will PASS. Set ATLAS_BACKUP_VERIFY_SCRATCH_URL " +
        "to a disposable scratch Postgres to enable restore-into-scratch-DB verification.",
    );

    const header = yield* Effect.tryPromise({
      try: () => readGzipHeader(storagePath, 4096),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    // pg_dump plain format starts with "-- PostgreSQL database dump" or similar
    const hasPgDumpHeader = header.includes("PostgreSQL database dump")
      || header.includes("-- Dumped from")
      || header.includes("-- Dumped by");

    if (!hasPgDumpHeader) {
      yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `UPDATE backups SET status = 'failed', verify_level = 'header-only', error_message = 'Verification failed: invalid pg_dump header' WHERE id = $1`,
            [backupId],
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      return {
        verified: false,
        message: "Invalid backup file — pg_dump header not found",
        level: "header-only" as const,
      };
    }

    yield* Effect.tryPromise({
      try: () =>
        internalQuery(
          `UPDATE backups SET status = 'verified', verify_level = 'header-only', error_message = NULL WHERE id = $1`,
          [backupId],
        ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    log.info({ backupId, level: "header-only" }, "Backup verified (header-only — NOT proven restorable)");
    return {
      verified: true,
      message: "Backup verified (header-only — NOT proven restorable; set ATLAS_BACKUP_VERIFY_SCRATCH_URL for full restore smoke)",
      level: "header-only" as const,
    };
  });

/**
 * Read and decompress the first N bytes of a gzip file to inspect the header.
 */
function readGzipHeader(filePath: string, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    const input = createReadStream(filePath);
    const gunzip = createGunzip();

    gunzip.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalLength += chunk.length;
      if (totalLength >= maxBytes) {
        gunzip.destroy();
        input.destroy();
        resolve(Buffer.concat(chunks).toString("utf-8").slice(0, maxBytes));
      }
    });

    gunzip.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8").slice(0, maxBytes));
    });

    gunzip.on("error", (err) => {
      input.destroy();
      reject(new Error(`Failed to decompress backup: ${err.message}`));
    });

    input.on("error", (err) => {
      gunzip.destroy();
      reject(new Error(`Failed to read backup file: ${err.message}`));
    });

    input.pipe(gunzip);
  });
}
