/**
 * Backup verification — integrity checks for backup files.
 *
 * Decompresses the gzip archive and validates the pg_dump header.
 *
 * Enterprise-gated via requireEnterprise("backups").
 */

import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { requireEnterprise } from "../index";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { ensureTable, getBackupById } from "./engine";

const log = createLogger("ee:backups-verify");

/**
 * Verify a backup file's integrity:
 * 1. Check the DB record exists and is in completed/verified state
 * 2. Decompress the gzip file
 * 3. Validate the pg_dump SQL header is present
 *
 * Returns { verified: true } on success, { verified: false } on integrity failure.
 * Throws if the backup is not found, has an invalid status, or the DB is not configured.
 */
export async function verifyBackup(backupId: string): Promise<{ verified: boolean; message: string }> {
  requireEnterprise("backups");
  await ensureTable();

  if (!hasInternalDB()) {
    throw new Error("Internal database not configured — cannot verify backup");
  }

  const backup = await getBackupById(backupId);
  if (!backup) {
    throw new Error("Backup not found");
  }

  if (backup.status !== "completed" && backup.status !== "verified") {
    throw new Error(`Cannot verify backup with status "${backup.status}"`);
  }

  try {
    // Read and decompress the first chunk to validate the header
    const header = await readGzipHeader(backup.storage_path, 4096);

    // pg_dump plain format starts with "-- PostgreSQL database dump" or similar
    const hasPgDumpHeader = header.includes("PostgreSQL database dump")
      || header.includes("-- Dumped from")
      || header.includes("-- Dumped by");

    if (!hasPgDumpHeader) {
      await internalQuery(
        `UPDATE backups SET status = 'failed', error_message = 'Verification failed: invalid pg_dump header' WHERE id = $1`,
        [backupId],
      );
      return { verified: false, message: "Invalid backup file — pg_dump header not found" };
    }

    // Mark as verified
    await internalQuery(
      `UPDATE backups SET status = 'verified' WHERE id = $1`,
      [backupId],
    );

    log.info({ backupId }, "Backup verified successfully");
    return { verified: true, message: "Backup verified — valid pg_dump archive" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), backupId }, "Backup verification failed");

    await internalQuery(
      `UPDATE backups SET status = 'failed', error_message = $1 WHERE id = $2`,
      [`Verification failed: ${errorMessage.slice(0, 1000)}`, backupId],
    ).catch((updateErr) => {
      log.warn(
        { err: updateErr instanceof Error ? updateErr.message : String(updateErr), backupId },
        "Failed to update backup status after verification failure",
      );
    });

    return { verified: false, message: `Verification failed: ${errorMessage}` };
  }
}

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
