/**
 * Region migration executor.
 *
 * Orchestrates the lifecycle of a workspace region migration:
 * pending → in_progress → completed/failed.
 *
 * The migration runs in 4 phases:
 * 1. **Export** — extract workspace data from the source region's internal DB
 * 2. **Transfer** — send the export bundle to the target region's API
 * 3. **Cutover** — update the organization's region, flush caches, invalidate pools
 * 4. **Cleanup** — schedule source data removal after a 7-day grace period
 *
 * During migration, the workspace is read-only — write operations are rejected
 * by the migration write-lock middleware (see readonly.ts).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { exportWorkspaceBundle } from "./export";
import type { MigrationStatus, MigrationPhase, ExportBundle } from "@useatlas/types";
import { CLEANUP_GRACE_PERIOD_DAYS } from "@useatlas/types";

const log = createLogger("region-migration");

/** Stale migration threshold: 5 minutes. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Migration steps (for logging)
// ---------------------------------------------------------------------------

const MIGRATION_STEPS: Record<MigrationPhase, string> = {
  validating: "Validating migration request",
  exporting: "Exporting workspace data",
  transferring: "Transferring data to target region",
  cutting_over: "Updating region assignment and flushing caches",
  scheduling_cleanup: "Scheduling source data cleanup",
  completed: "Migration completed",
  failed: "Migration failed",
};

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
// Transfer helper — POST bundle to target region
// ---------------------------------------------------------------------------

/**
 * Send an export bundle to the target region's internal import endpoint.
 *
 * Uses ATLAS_INTERNAL_SECRET for service-to-service auth. The target endpoint
 * is derived from the region's apiUrl in the residency config.
 */
async function transferBundleToTarget(
  bundle: ExportBundle,
  targetApiUrl: string,
  orgId: string,
  migrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = process.env.ATLAS_INTERNAL_SECRET;
  if (!secret) {
    return { ok: false, error: "ATLAS_INTERNAL_SECRET is not configured — cannot authenticate cross-region transfer" };
  }

  const url = `${targetApiUrl.replace(/\/+$/, "")}/api/v1/internal/migrate/import`;

  log.info({ migrationId, targetApiUrl: url, orgId }, "Transferring bundle to target region");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-Internal-Token": secret,
      },
      body: JSON.stringify({ ...bundle, orgId }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error connecting to target region: ${msg}` };
  }

  if (!response.ok) {
    let detail: string;
    try {
      const body = await response.json() as { message?: string; error?: string };
      detail = body.message ?? body.error ?? `HTTP ${response.status}`;
    } catch {
      // intentionally ignored: response body may not be JSON (e.g. reverse proxy HTML error)
      detail = `HTTP ${response.status} ${response.statusText}`;
    }
    return { ok: false, error: `Target region import failed: ${detail}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute a region migration by ID.
 *
 * Transitions: pending → in_progress → completed/failed.
 *
 * Phase 1 (Export): Builds an ExportBundle from the source region's internal DB.
 * Phase 2 (Transfer): POSTs the bundle to the target region's import endpoint.
 * Phase 3 (Cutover): Updates organization.region, flushes caches.
 * Phase 4 (Cleanup): Schedules source data cleanup after the grace period.
 *
 * On failure at any phase, records the error and leaves the region unchanged.
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

  // Mark as in_progress — workspace is now read-only
  log.info({ migrationId, workspaceId, sourceRegion, targetRegion, step: MIGRATION_STEPS.validating }, "Migration starting");
  await updateMigrationStatus(migrationId, "in_progress");

  logMigrationEvent("region_migration_started", migrationId, {
    workspaceId,
    sourceRegion,
    targetRegion,
  });

  // Track whether region was updated — declared outside try so the catch block can access it
  let regionUpdated = false;

  try {
    // ── Phase 1: Export ──────────────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.exporting }, "Phase 1: Exporting workspace data");

    const bundle = await exportWorkspaceBundle(workspaceId, `region-migration:${sourceRegion}`);

    log.info(
      { migrationId, counts: bundle.manifest.counts },
      "Phase 1 complete: workspace data exported",
    );

    // ── Phase 2: Transfer ────────────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.transferring }, "Phase 2: Transferring to target region");

    const config = getConfig();
    const targetRegionConfig = config?.residency?.regions[targetRegion];
    const targetApiUrl = targetRegionConfig?.apiUrl;

    if (!targetApiUrl) {
      throw new Error(
        `Target region "${targetRegion}" has no apiUrl configured — ` +
        `cannot transfer data. Add apiUrl to the region config in atlas.config.ts.`,
      );
    }

    const transferResult = await transferBundleToTarget(bundle, targetApiUrl, workspaceId, migrationId);
    if (!transferResult.ok) {
      throw new Error(transferResult.error);
    }

    log.info({ migrationId }, "Phase 2 complete: data transferred to target region");

    // ── Phase 3: Cutover ─────────────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.cutting_over }, "Phase 3: Updating region assignment");

    const pool = getInternalDB();
    const updateResult = await pool.query(
      `UPDATE organization SET region = $1, region_assigned_at = now()
       WHERE id = $2 RETURNING id`,
      [targetRegion, workspaceId],
    );

    if (updateResult.rows.length === 0) {
      throw new Error(`Workspace "${workspaceId}" not found in organization table`);
    }
    regionUpdated = true;

    // Flush cached data
    try {
      const { flushCache } = await import("@atlas/api/lib/cache/index");
      flushCache();
    } catch (cacheErr) {
      log.warn(
        { err: cacheErr instanceof Error ? cacheErr.message : String(cacheErr), migrationId },
        "Cache flush failed during migration (non-fatal)",
      );
    }

    log.info({ migrationId }, "Phase 3 complete: region updated and caches flushed");

    // ── Phase 4: Schedule cleanup ────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.scheduling_cleanup }, "Phase 4: Scheduling source data cleanup");

    const cleanupAfter = new Date();
    cleanupAfter.setDate(cleanupAfter.getDate() + CLEANUP_GRACE_PERIOD_DAYS);

    logMigrationEvent("region_migration_cleanup_scheduled", migrationId, {
      workspaceId,
      sourceRegion,
      cleanupAfter: cleanupAfter.toISOString(),
      gracePeriodDays: CLEANUP_GRACE_PERIOD_DAYS,
    });

    log.info(
      { migrationId, cleanupAfter: cleanupAfter.toISOString(), gracePeriodDays: CLEANUP_GRACE_PERIOD_DAYS },
      "Phase 4 complete: cleanup scheduled",
    );

    // ── Finalize ─────────────────────────────────────────────────────
    const completedAt = new Date().toISOString();
    await updateMigrationStatus(migrationId, "completed", { completedAt });

    logMigrationEvent("region_migration_completed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
    });

    log.info({ migrationId, workspaceId, sourceRegion, targetRegion, completedAt }, "Migration completed successfully");

    return { success: true, migrationId };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);

    // If the region was already updated, retry is dangerous — data exists in both regions
    const errorMessage = regionUpdated
      ? `${rawMessage} (WARNING: region was already updated to "${targetRegion}" — do NOT retry without investigation)`
      : rawMessage;

    log.error({ err: rawMessage, migrationId, workspaceId, regionUpdated }, "Migration failed");

    logMigrationEvent("region_migration_failed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
      error: errorMessage,
      regionUpdated,
    });

    // Mark as failed — the region update may have already happened.
    // The error message includes a warning if retry would be unsafe.
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
// Cleanup detection
// ---------------------------------------------------------------------------

/**
 * Find completed migrations where the source data grace period has elapsed.
 * Returns migrations eligible for source data cleanup.
 */
export async function getCleanupDueMigrations(): Promise<
  Array<{ id: string; workspaceId: string; sourceRegion: string; completedAt: string }>
> {
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<{
    id: string;
    workspace_id: string;
    source_region: string;
    completed_at: string;
  }>(
    `SELECT id, workspace_id, source_region, completed_at
     FROM region_migrations
     WHERE status = 'completed'
       AND completed_at < NOW() - make_interval(days => $1)
     ORDER BY completed_at ASC`,
    [CLEANUP_GRACE_PERIOD_DAYS],
  );

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    sourceRegion: r.source_region,
    completedAt: r.completed_at,
  }));
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
