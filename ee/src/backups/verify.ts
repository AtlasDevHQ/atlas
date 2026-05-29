/**
 * Backup verification — restorability checks for backup files.
 *
 * Two verification levels (#2941):
 *
 *  - **full-restore** (preferred): when `ATLAS_BACKUP_VERIFY_SCRATCH_URL` points
 *    at a disposable scratch Postgres, the dump is decompressed and piped into
 *    `psql --single-transaction --set ON_ERROR_STOP=on` against that scratch DB,
 *    then a `count(*)` over base tables in `information_schema.tables` proves the
 *    restore produced real tables. "Verified" then means "restorable", not merely
 *    "has a valid header". A dump that is a valid pg_dump header but truncated /
 *    corrupt-tailed makes psql exit non-zero (or yields zero base tables) under
 *    ON_ERROR_STOP=on, so verification FAILS — which header-only checking missed.
 *    NOTE: this is a *structural* smoke (base tables exist after restore), not a
 *    row-level completeness proof — a dump truncated on a clean statement
 *    boundary after some tables already restored can still pass. See #2941.
 *
 *  - **header-only** (degraded fallback): when no scratch URL is configured we
 *    gunzip the first 4096 bytes and check for the pg_dump header string. This
 *    is the legacy behaviour and is strictly weaker — a truncated dump can pass.
 *    We log a loud warning explaining WHY we degraded (never silently skip).
 *
 * ⚠️  The scratch URL MUST point at a genuinely disposable database. Full-restore
 *    verification WIPES the scratch DB's `public` schema (`DROP SCHEMA IF EXISTS
 *    public CASCADE; CREATE SCHEMA public;`) before each restore so a plain-format
 *    pg_dump restores without object conflicts. Never point it at a real DB. As a
 *    safety net we refuse to run (verified:false, NO wipe) if the scratch URL
 *    resolves to the same {host, port, database} as DATABASE_URL — so a copy-paste
 *    env mistake can't turn nightly verification into a nightly prod wipe.
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

    // A verify that can't actually verify is a failure, not a pass — when a
    // scratch URL IS configured but the restore path blew up (psql missing,
    // connection refused, …) we report the strongest level so callers don't
    // mistake this for a degraded header check.
    const level: VerifyLevel = scratchUrl ? "full-restore" : "header-only";

    // Inner effect uses tryPromise so errors land in the typed channel
    const verifyWork = scratchUrl
      ? verifyByRestore(backupId, backup.storage_path, scratchUrl)
      : verifyByHeader(backupId, backup.storage_path);

    return yield* verifyWork.pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          // Full error (which may include psql stderr with scratch host/port/db)
          // stays server-side only.
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), backupId, level },
            "Backup verification failed",
          );

          // Generic, actionable message — never leak connection details or raw
          // psql/pg_dump stderr onto the wire or into the persisted column
          // (CLAUDE.md: no secrets / stack traces in responses).
          const safeMessage =
            level === "full-restore"
              ? "Verification failed — could not restore the backup into the scratch DB. See server logs."
              : "Verification failed — could not read or decompress the backup file. See server logs.";

          // Best-effort status update — fire-and-forget with error handling.
          void internalQuery(
            `UPDATE backups SET status = 'failed', verify_level = $1, error_message = $2 WHERE id = $3`,
            [level, safeMessage, backupId],
          ).catch((updateErr) => {
            log.warn(
              { err: updateErr instanceof Error ? updateErr.message : String(updateErr), backupId },
              "Failed to update backup status after verification failure",
            );
          });

          return { verified: false, message: safeMessage, level };
        }),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Full-restore verification — restore into a disposable scratch DB and count.
// ---------------------------------------------------------------------------

/**
 * Restore the dump into the scratch DB and assert it produced base tables.
 *
 * Resets the scratch DB's public schema, pipes the decompressed dump into
 * `psql --single-transaction --set ON_ERROR_STOP=on`, then counts BASE TABLES in
 * `information_schema`. A truncated dump exits non-zero under ON_ERROR_STOP or
 * yields zero base tables → verification fails.
 *
 * This is a *structural* smoke (base tables exist after restore), not a
 * row-level completeness proof. A dump truncated on a clean statement boundary
 * after some tables already restored can still pass — recording the source DB's
 * expected base-table count at backup time and asserting `restored >= expected`
 * is a tracked follow-up to #2941.
 */
const verifyByRestore = (
  backupId: string,
  storagePath: string,
  scratchUrl: string,
): Effect.Effect<{ verified: boolean; message: string; level: VerifyLevel }, Error> =>
  Effect.gen(function* () {
    // Safety net: refuse to wipe the scratch DB if it resolves to the same
    // target as DATABASE_URL — a single env copy-paste error would otherwise
    // turn nightly verification into a nightly prod wipe (and then "pass").
    if (scratchTargetsSameAsPrimary(scratchUrl, process.env.DATABASE_URL)) {
      const message =
        "Refusing to verify: ATLAS_BACKUP_VERIFY_SCRATCH_URL resolves to the same database as DATABASE_URL. " +
        "Point it at a DISPOSABLE scratch Postgres — verification WIPES the scratch DB's public schema.";
      log.error({ backupId }, message);
      yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `UPDATE backups SET status = 'failed', verify_level = 'full-restore', error_message = $1 WHERE id = $2`,
            [
              "Verification skipped — scratch DB equals DATABASE_URL (would wipe the primary DB). See server logs.",
              backupId,
            ],
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      return { verified: false, message, level: "full-restore" as const };
    }

    const conn = parsePsqlConn(scratchUrl);

    log.info({ backupId }, "Verifying backup via restore-into-scratch-DB smoke");

    // Step 1: reset the scratch schema so a plain-format dump restores cleanly.
    yield* runPsqlCommand(conn, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

    // Step 2: restore the dump into the scratch DB.
    yield* restoreDumpIntoScratch(conn, storagePath);

    // Step 3: prove the restore produced real base tables.
    const tableCount = yield* countScratchTables(conn);

    if (tableCount <= 0) {
      yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `UPDATE backups SET status = 'failed', verify_level = 'full-restore', error_message = 'Verification failed: restore smoke produced zero base tables' WHERE id = $1`,
            [backupId],
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      return {
        verified: false,
        message: "Restore smoke produced zero base tables in public schema — backup is empty or unrestorable",
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
      message: `Backup verified — structural smoke: ${tableCount} base table(s) restored into the scratch DB (not a row-level completeness proof)`,
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

/**
 * True when `scratchUrl` resolves to the same Postgres target as `primaryUrl`
 * (DATABASE_URL): same hostname, port, and database name. Credentials and query
 * params (sslmode etc.) are intentionally ignored so a creds-only difference
 * doesn't defeat the guard. Exported for unit testing.
 *
 * Conservative: if `primaryUrl` is unset or either URL fails to parse, returns
 * false (we don't block verification on a parse failure — the worst case is the
 * existing destructive behaviour, which the operator already opted into by
 * setting a scratch URL). The host/port/db match is the load-bearing check.
 */
export function scratchTargetsSameAsPrimary(
  scratchUrl: string,
  primaryUrl: string | undefined,
): boolean {
  if (!primaryUrl) return false;
  let scratch: URL;
  let primary: URL;
  try {
    scratch = new URL(scratchUrl);
    primary = new URL(primaryUrl);
  } catch {
    // intentionally ignored: an unparseable URL can't be proven equal; the
    // downstream psql call will surface a connection error instead.
    return false;
  }
  const norm = (u: URL) => ({
    host: u.hostname.toLowerCase(),
    // Default Postgres port is 5432 when the URL omits it.
    port: u.port || "5432",
    db: u.pathname.replace(/^\//, ""),
  });
  const a = norm(scratch);
  const b = norm(primary);
  return a.host === b.host && a.port === b.port && a.db === b.db;
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
      // Raw stderr (scratch host/port/db) stays in the server log; the thrown
      // message is generic so the outer catch can't leak it onto the wire.
      log.error({ exitCode, stderr: stderr.slice(0, 1000) }, "psql scratch-reset command failed");
      return yield* Effect.fail(new Error(`Scratch DB reset failed (psql exit ${exitCode})`));
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
      // Raw stderr stays server-side; the outer catch surfaces a generic message.
      log.error({ exitCode, stderr: stderr.slice(0, 1000) }, "psql restore smoke failed");
      return yield* Effect.fail(new Error(`Restore smoke failed (psql exit ${exitCode})`));
    }
  });

/**
 * Count BASE TABLES in the scratch DB's public schema after a restore.
 *
 * Filtering on `table_type = 'BASE TABLE'` excludes views — a dump whose
 * CREATE TABLEs were truncated but that still created a view would otherwise
 * pass a bare `count(*)`.
 */
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
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
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
      log.error({ exitCode, stderr: stderr.slice(0, 1000) }, "psql base-table count failed");
      return yield* Effect.fail(new Error(`Base table count failed (psql exit ${exitCode})`));
    }

    const count = parseInt(stdout.trim(), 10);
    if (Number.isNaN(count)) {
      log.error({ stdout: stdout.slice(0, 200) }, "Could not parse base table count from psql output");
      return yield* Effect.fail(new Error("Could not parse base table count from psql output"));
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
