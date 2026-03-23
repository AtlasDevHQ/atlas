/**
 * Audit log purge scheduler — daily interval-based purge of expired audit entries.
 *
 * Runs soft-delete purge and hard-delete cleanup on a configurable interval
 * (default: daily at startup, then every 24 hours).
 *
 * Start via `startAuditPurgeScheduler()` during API startup when
 * enterprise features are enabled.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { isEnterpriseEnabled } from "../index";
import { hasInternalDB } from "@atlas/api/lib/db/internal";

const log = createLogger("ee:audit-purge");

/** Default purge interval: 24 hours in milliseconds. */
const DEFAULT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

/**
 * Run a single purge cycle: soft-delete expired entries, then hard-delete old ones.
 * Errors are logged but never thrown — the scheduler must not crash.
 */
export async function runPurgeCycle(): Promise<void> {
  if (!isEnterpriseEnabled() || !hasInternalDB()) return;

  try {
    const { purgeExpiredEntries, hardDeleteExpired } = await import("./retention");

    // Soft-delete expired entries across all orgs
    const softResults = await purgeExpiredEntries();
    const totalSoftDeleted = softResults.reduce((sum, r) => sum + r.softDeletedCount, 0);

    if (totalSoftDeleted > 0) {
      log.info({ totalSoftDeleted, orgs: softResults.length }, "Audit purge cycle: soft-delete complete");
    }

    // Hard-delete entries past the delay
    const hardResult = await hardDeleteExpired();
    if (hardResult.deletedCount > 0) {
      log.info({ deletedCount: hardResult.deletedCount }, "Audit purge cycle: hard-delete complete");
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Audit purge cycle failed — will retry next interval",
    );
  }
}

/**
 * Start the audit purge scheduler.
 *
 * Runs an initial purge cycle immediately, then repeats at the configured interval.
 * No-op if enterprise features are disabled or already running.
 */
export function startAuditPurgeScheduler(intervalMs?: number): void {
  if (_running) {
    log.debug("Audit purge scheduler already running — skipping start");
    return;
  }

  if (!isEnterpriseEnabled()) {
    log.debug("Enterprise features not enabled — audit purge scheduler not started");
    return;
  }

  if (!hasInternalDB()) {
    log.debug("No internal database — audit purge scheduler not started");
    return;
  }

  const interval = intervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
  _running = true;

  log.info({ intervalMs: interval }, "Starting audit purge scheduler");

  // Run initial purge cycle (non-blocking)
  void runPurgeCycle();

  // Schedule recurring purge
  _timer = setInterval(() => {
    void runPurgeCycle();
  }, interval);

  // Don't prevent process exit
  _timer.unref();
}

/**
 * Stop the audit purge scheduler.
 */
export function stopAuditPurgeScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  log.info("Audit purge scheduler stopped");
}

/** Check if the scheduler is running. */
export function isPurgeSchedulerRunning(): boolean {
  return _running;
}

/** Reset scheduler state — for testing only. */
export function _resetPurgeScheduler(): void {
  stopAuditPurgeScheduler();
}
