/**
 * Region migration executor.
 *
 * Orchestrates the lifecycle of a workspace region migration:
 * pending → in_progress → completed/failed.
 *
 * In the current implementation, "region migration" is a metadata update —
 * the data stays in the same database. True cross-region data movement
 * (separate DB instances per region) is infrastructure work beyond this scope.
 *
 * The migration:
 * - Updates the workspace_regions assignment in the organization table
 * - Flushes region-cached data (query cache)
 * - Records lifecycle events via structured pino logs
 * - Detects and fails stale in_progress migrations (stuck > 5 min)
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import type { MigrationStatus } from "@useatlas/types";

const log = createLogger("region-migration");

/** Stale migration threshold: 5 minutes. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Migration steps
// ---------------------------------------------------------------------------

const MIGRATION_STEPS = [
  "Validating migration request",
  "Updating region assignment",
  "Flushing cached data",
  "Recording audit trail",
  "Finalizing migration",
] as const;

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/** Log a structured migration lifecycle event via pino. */
function logMigrationEvent(
  event: string,
  migrationId: string,
  details: Record<string, unknown>,
): void {
  log.info({ event, migrationId, ...details }, `Migration audit: ${event}`);
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

async function updateMigrationStatus(
  migrationId: string,
  status: MigrationStatus,
  extra?: { errorMessage?: string; completedAt?: string },
): Promise<void> {
  const sets = [`status = $1`];
  const params: unknown[] = [status];
  let idx = 2;

  if (extra?.completedAt) {
    sets.push(`completed_at = $${idx}`);
    params.push(extra.completedAt);
    idx++;
  }
  if (extra?.errorMessage !== undefined) {
    sets.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }

  params.push(migrationId);
  await internalQuery(
    `UPDATE region_migrations SET ${sets.join(", ")} WHERE id = $${idx}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Discriminated result from migration execution. */
export type MigrationResult =
  | { readonly success: true; readonly migrationId: string }
  | { readonly success: false; readonly migrationId: string; readonly error: string };

/** Failure reason codes for structured HTTP status mapping. */
export type MigrationFailureReason = "not_found" | "invalid_status" | "db_error" | "no_db";

/** Discriminated result from retry/cancel operations. */
export type OperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MigrationFailureReason; readonly error: string };

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute a region migration by ID.
 *
 * Transitions: pending → in_progress → completed/failed.
 * On success, updates the workspace's region assignment and flushes caches.
 * On failure, records the error and leaves the region unchanged.
 */
export async function executeRegionMigration(
  migrationId: string,
): Promise<MigrationResult> {
  if (!hasInternalDB()) {
    log.warn({ migrationId }, "Migration skipped — internal database not available");
    return { success: false, migrationId, error: "Internal database not available" };
  }

  // Load migration record
  const rows = await internalQuery<{
    id: string;
    workspace_id: string;
    source_region: string;
    target_region: string;
    status: string;
  }>(
    `SELECT id, workspace_id, source_region, target_region, status
     FROM region_migrations WHERE id = $1`,
    [migrationId],
  );

  const migration = rows[0];
  if (!migration) {
    log.warn({ migrationId }, "Migration skipped — record not found");
    return { success: false, migrationId, error: "Migration not found" };
  }

  if (migration.status !== "pending") {
    log.warn({ migrationId, status: migration.status }, "Migration skipped — not in pending status");
    return {
      success: false,
      migrationId,
      error: `Migration is "${migration.status}", expected "pending"`,
    };
  }

  const { workspace_id: workspaceId, source_region: sourceRegion, target_region: targetRegion } = migration;

  // Step 1: Mark as in_progress
  log.info({ migrationId, workspaceId, sourceRegion, targetRegion, step: MIGRATION_STEPS[0] }, "Migration starting");
  await updateMigrationStatus(migrationId, "in_progress");

  logMigrationEvent("region_migration_started", migrationId, {
    workspaceId,
    sourceRegion,
    targetRegion,
  });

  try {
    // Step 2: Update the workspace's region assignment (force-update, bypassing immutability)
    log.info({ migrationId, step: MIGRATION_STEPS[1] }, "Updating region assignment");
    const pool = getInternalDB();
    const updateResult = await pool.query(
      `UPDATE organization SET region = $1, region_assigned_at = now()
       WHERE id = $2 RETURNING id`,
      [targetRegion, workspaceId],
    );

    if (updateResult.rows.length === 0) {
      throw new Error(`Workspace "${workspaceId}" not found in organization table`);
    }

    // Step 3: Flush cached data
    log.info({ migrationId, step: MIGRATION_STEPS[2] }, "Flushing cached data");
    try {
      const { flushCache } = await import("@atlas/api/lib/cache/index");
      flushCache();
    } catch (cacheErr) {
      // Cache flush is best-effort — log but don't fail the migration
      log.warn(
        { err: cacheErr instanceof Error ? cacheErr.message : String(cacheErr), migrationId },
        "Cache flush failed during migration (non-fatal)",
      );
    }

    // Step 4: Audit trail
    log.info({ migrationId, step: MIGRATION_STEPS[3] }, "Recording audit trail");
    logMigrationEvent("region_migration_completed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
    });

    // Step 5: Mark completed
    const completedAt = new Date().toISOString();
    log.info({ migrationId, step: MIGRATION_STEPS[4] }, "Finalizing migration");
    await updateMigrationStatus(migrationId, "completed", { completedAt });

    log.info({ migrationId, workspaceId, sourceRegion, targetRegion, completedAt }, "Migration completed successfully");

    return { success: true, migrationId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err: errorMessage, migrationId, workspaceId }, "Migration failed");

    logMigrationEvent("region_migration_failed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
      error: errorMessage,
    });

    // Mark as failed — leave region unchanged (the update may have already happened,
    // but the migration record shows "failed" so admins can investigate)
    try {
      await updateMigrationStatus(migrationId, "failed", {
        errorMessage,
        completedAt: new Date().toISOString(),
      });
    } catch (updateErr) {
      log.error(
        { err: updateErr instanceof Error ? updateErr.message : String(updateErr), migrationId },
        "Failed to update migration status to 'failed'",
      );
    }

    return { success: false, migrationId, error: errorMessage };
  }
}

// ---------------------------------------------------------------------------
// Background processing
// ---------------------------------------------------------------------------

/**
 * Trigger migration execution asynchronously.
 * Returns immediately — the migration runs in the background.
 */
export function triggerMigrationExecution(migrationId: string): void {
  setTimeout(() => {
    executeRegionMigration(migrationId)
      .then((result) => {
        if (!result.success) {
          log.error(
            { migrationId, error: result.error },
            "Background migration execution failed",
          );
        }
      })
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), migrationId },
          "Unhandled error in background migration execution",
        );
      });
  }, 0);
}

// ---------------------------------------------------------------------------
// Stale migration detection
// ---------------------------------------------------------------------------

/**
 * Find and fail migrations stuck in "in_progress" for longer than the threshold.
 * Returns the number of migrations marked as failed.
 */
export async function failStaleMigrations(): Promise<number> {
  if (!hasInternalDB()) return 0;

  const staleThresholdSec = STALE_THRESHOLD_MS / 1000;
  const staleRows = await internalQuery<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM region_migrations
     WHERE status = 'in_progress'
       AND requested_at < NOW() - make_interval(secs => $1)`,
    [staleThresholdSec],
  );

  let failedCount = 0;
  for (const row of staleRows) {
    try {
      await updateMigrationStatus(row.id, "failed", {
        errorMessage: "Migration timed out — stuck in progress for over 5 minutes",
        completedAt: new Date().toISOString(),
      });
      logMigrationEvent("region_migration_failed", row.id, {
        workspaceId: row.workspace_id,
        reason: "stale_timeout",
      });
      failedCount++;
      log.warn({ migrationId: row.id, workspaceId: row.workspace_id }, "Stale migration marked as failed");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), migrationId: row.id },
        "Failed to mark stale migration as failed",
      );
    }
  }

  return failedCount;
}

// ---------------------------------------------------------------------------
// Retry support
// ---------------------------------------------------------------------------

/**
 * Reset a failed migration to "pending" so it can be re-executed.
 * Only works for migrations in "failed" status.
 *
 * @param workspaceId - The org ID that owns this migration (for authorization).
 */
export async function resetMigrationForRetry(
  migrationId: string,
  workspaceId: string,
): Promise<OperationResult> {
  if (!hasInternalDB()) {
    return { ok: false, reason: "no_db", error: "Internal database not available" };
  }

  try {
    const rows = await internalQuery<{ id: string; status: string; workspace_id: string }>(
      `SELECT id, status, workspace_id FROM region_migrations WHERE id = $1`,
      [migrationId],
    );

    if (rows.length === 0) {
      return { ok: false, reason: "not_found", error: "Migration not found" };
    }

    if (rows[0].workspace_id !== workspaceId) {
      return { ok: false, reason: "not_found", error: "Migration not found" };
    }

    if (rows[0].status !== "failed") {
      return { ok: false, reason: "invalid_status", error: `Cannot retry migration in "${rows[0].status}" status` };
    }

    await internalQuery(
      `UPDATE region_migrations SET status = 'pending', error_message = NULL, completed_at = NULL
       WHERE id = $1`,
      [migrationId],
    );

    log.info({ migrationId }, "Migration reset for retry");
    return { ok: true };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), migrationId }, "Failed to reset migration for retry");
    return { ok: false, reason: "db_error", error: "Database error while resetting migration" };
  }
}

// ---------------------------------------------------------------------------
// Cancel support
// ---------------------------------------------------------------------------

/**
 * Cancel a pending migration. Only works for migrations in "pending" status.
 * In-progress migrations cannot be cancelled.
 *
 * @param workspaceId - The org ID that owns this migration (for authorization).
 */
export async function cancelMigration(
  migrationId: string,
  workspaceId: string,
): Promise<OperationResult> {
  if (!hasInternalDB()) {
    return { ok: false, reason: "no_db", error: "Internal database not available" };
  }

  try {
    const rows = await internalQuery<{ id: string; status: string; workspace_id: string }>(
      `SELECT id, status, workspace_id FROM region_migrations WHERE id = $1`,
      [migrationId],
    );

    if (rows.length === 0) {
      return { ok: false, reason: "not_found", error: "Migration not found" };
    }

    if (rows[0].workspace_id !== workspaceId) {
      return { ok: false, reason: "not_found", error: "Migration not found" };
    }

    if (rows[0].status !== "pending") {
      return { ok: false, reason: "invalid_status", error: `Cannot cancel migration in "${rows[0].status}" status` };
    }

    await internalQuery(
      `UPDATE region_migrations SET status = 'cancelled', error_message = 'Cancelled by admin', completed_at = $1
       WHERE id = $2`,
      [new Date().toISOString(), migrationId],
    );

    logMigrationEvent("region_migration_cancelled", migrationId, { workspaceId });
    log.info({ migrationId }, "Migration cancelled");
    return { ok: true };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), migrationId }, "Failed to cancel migration");
    return { ok: false, reason: "db_error", error: "Database error while cancelling migration" };
  }
}
