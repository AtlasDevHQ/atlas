/**
 * Backup restore — psql-based restore with safety checks.
 *
 * Before restoring, creates a pre-restore backup so the operation
 * is reversible. Requires a confirmation token to proceed.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 * Enterprise-gated via requireEnterpriseEffect("backups").
 */

import { spawn } from "child_process";
import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Effect } from "effect";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import { createLogger } from "@atlas/api/lib/logger";
import { createBackup, getBackupById, ensureTable } from "./engine";

const log = createLogger("ee:backups-restore");

// In-memory token store — short-lived confirmation tokens.
// Token is generated when a restore is requested, and must be
// echoed back to confirm. This prevents accidental restores.
const pendingRestores = new Map<string, { backupId: string; expiresAt: number }>();

/**
 * Generate a confirmation token for a restore operation.
 * The token must be passed back to `executeRestore()` within 5 minutes.
 */
export const requestRestore = (backupId: string): Effect.Effect<
  { confirmationToken: string; message: string },
  EnterpriseError | Error
> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("backups");
    yield* ensureTable();

    yield* requireInternalDBEffect("backup restoration");

    const backup = yield* getBackupById(backupId);
    if (!backup) {
      return yield* Effect.fail(new Error("Backup not found"));
    }

    if (backup.status !== "completed" && backup.status !== "verified") {
      return yield* Effect.fail(new Error(`Cannot restore backup with status "${backup.status}" — only completed or verified backups can be restored`));
    }

    const token = crypto.randomUUID();
    pendingRestores.set(token, { backupId, expiresAt: Date.now() + 5 * 60 * 1000 });

    // Cleanup expired tokens
    for (const [key, value] of pendingRestores) {
      if (value.expiresAt < Date.now()) pendingRestores.delete(key);
    }

    return {
      confirmationToken: token,
      message: `Restore requested for backup ${backupId}. Pass the confirmation token to confirm. Token expires in 5 minutes. A pre-restore backup will be created automatically.`,
    };
  });

/**
 * Execute the restore operation after confirmation.
 *
 * Steps:
 * 1. Validate the confirmation token
 * 2. Create a pre-restore backup (safety net)
 * 3. Decompress and pipe into psql
 */
export const executeRestore = (
  confirmationToken: string,
): Effect.Effect<
  { restored: boolean; preRestoreBackupId: string; message: string },
  EnterpriseError | Error
> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("backups");

    const pending = pendingRestores.get(confirmationToken);
    if (!pending) {
      return yield* Effect.fail(new Error("Invalid or expired confirmation token"));
    }

    if (pending.expiresAt < Date.now()) {
      pendingRestores.delete(confirmationToken);
      return yield* Effect.fail(new Error("Confirmation token has expired — request a new one"));
    }

    pendingRestores.delete(confirmationToken);
    const { backupId } = pending;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return yield* Effect.fail(new Error("DATABASE_URL is not set — cannot restore backup"));
    }

    const backup = yield* getBackupById(backupId);
    if (!backup) {
      return yield* Effect.fail(new Error("Backup not found — it may have been purged"));
    }

    log.warn({ backupId }, "Starting database restore — creating pre-restore backup first");

    // Step 1: Create pre-restore safety backup
    const preRestore = yield* createBackup().pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), backupId },
            "Failed to create pre-restore backup — aborting restore",
          );
          return yield* Effect.fail(
            new Error(`Pre-restore backup failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }),
      ),
    );
    const preRestoreBackupId = preRestore.id;
    log.info({ preRestoreBackupId }, "Pre-restore backup created");

    // Step 2: Restore from backup — uses tryPromise so errors are in the typed channel
    const restoreWork = Effect.gen(function* () {
      const parsed = new URL(databaseUrl);
      const psqlArgs: string[] = [];

      if (parsed.hostname) psqlArgs.push("-h", parsed.hostname);
      if (parsed.port) psqlArgs.push("-p", parsed.port);
      if (parsed.username) psqlArgs.push("-U", parsed.username);
      const dbName = parsed.pathname.replace(/^\//, "");
      if (dbName) psqlArgs.push("-d", dbName);

      // Add flags: single transaction and stop on error
      psqlArgs.push("--single-transaction", "--set", "ON_ERROR_STOP=on");

      const password = parsed.password ? decodeURIComponent(parsed.password) : "";

      const psql = spawn("psql", psqlArgs, {
        env: { ...process.env, PGPASSWORD: password },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      psql.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const input = createReadStream(backup.storage_path);
      const gunzip = createGunzip();

      yield* Effect.tryPromise({
        try: () => pipeline(input, gunzip, psql.stdin),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      const exitCode = yield* Effect.tryPromise({
        try: () => new Promise<number>((resolve) => { psql.on("close", resolve); }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (exitCode !== 0) {
        return yield* Effect.fail(new Error(`psql exited with code ${exitCode}: ${stderr.slice(0, 500)}`));
      }

      log.info({ backupId, preRestoreBackupId }, "Database restore completed successfully");
      return {
        restored: true,
        preRestoreBackupId,
        message: `Database restored from backup ${backupId}. Pre-restore backup saved as ${preRestoreBackupId}.`,
      };
    });

    return yield* restoreWork.pipe(
      Effect.mapError((err) => {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)), backupId, preRestoreBackupId },
          "Database restore failed — pre-restore backup is available for recovery",
        );
        return new Error(
          `Restore failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Pre-restore backup ${preRestoreBackupId} is available for recovery.`,
          { cause: err },
        );
      }),
    );
  });
