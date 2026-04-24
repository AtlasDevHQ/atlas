/**
 * Audit log purge scheduler — daily interval-based purge of expired audit entries.
 *
 * Runs soft-delete purge and hard-delete cleanup on a configurable interval
 * (default: daily at startup, then every 24 hours).
 *
 * Start via `startAuditPurgeScheduler()` during API startup when
 * enterprise features are enabled.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { isEnterpriseEnabled } from "../index";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";

const log = createLogger("ee:audit-purge");

/** Default purge interval: 24 hours in milliseconds. */
const DEFAULT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Reserved system-actor string for every audit row written by the purge
 * scheduler (cycle rows + any library-layer hard-delete rows triggered from
 * within a cycle). Exported so retention.ts and tests can pin the format
 * rather than duplicate the literal. See F-27.
 */
export const AUDIT_PURGE_SCHEDULER_ACTOR = "system:audit-purge-scheduler" as const;

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

/**
 * Run a single purge cycle: soft-delete expired entries, then hard-delete old ones.
 * Errors are logged but never thrown — the scheduler must not crash.
 */
export const runPurgeCycle = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!isEnterpriseEnabled() || !hasInternalDB()) return;

    yield* Effect.tryPromise({
      try: async () => {
        const { purgeExpiredEntries, hardDeleteExpired } = await import("./retention");

        // Soft-delete expired entries across all orgs
        const softResults = await Effect.runPromise(purgeExpiredEntries());
        const totalSoftDeleted = softResults.reduce((sum: number, r: { softDeletedCount: number }) => sum + r.softDeletedCount, 0);

        if (totalSoftDeleted > 0) {
          log.info({ totalSoftDeleted, orgs: softResults.length }, "Audit purge cycle: soft-delete complete");
        }

        // Hard-delete entries past the delay
        const hardResult = await Effect.runPromise(hardDeleteExpired());
        if (hardResult.deletedCount > 0) {
          log.info({ deletedCount: hardResult.deletedCount }, "Audit purge cycle: hard-delete complete");
        }

        // Self-audit the cycle (F-27). Emitted even at zero rows — the
        // *absence* of a cycle row over a retention window is itself
        // evidence the scheduler stopped, which a compliance reviewer must
        // be able to detect. `logAdminAction` is fire-and-forget and never
        // throws, so an audit miss can't break the cycle loop.
        logAdminAction({
          actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
          targetType: "audit_log",
          targetId: "scheduler",
          scope: "platform",
          systemActor: AUDIT_PURGE_SCHEDULER_ACTOR,
          metadata: {
            softDeleted: totalSoftDeleted,
            hardDeleted: hardResult.deletedCount,
            orgs: softResults.length,
          },
        });
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.catchAll((err) => {
        // Emit a failure cycle row so a compliance reviewer can tell a
        // silent drop-off from a run that started and errored. Zeros for
        // soft/hard/orgs — the point of the row is the failure signal, not
        // the (unknown) partial counts.
        logAdminAction({
          actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
          targetType: "audit_log",
          targetId: "scheduler",
          scope: "platform",
          systemActor: AUDIT_PURGE_SCHEDULER_ACTOR,
          status: "failure",
          metadata: { error: err.message, softDeleted: 0, hardDeleted: 0, orgs: 0 },
        });
        log.error(
          { err: err.message },
          "Audit purge cycle failed — will retry next interval",
        );
        return Effect.void;
      }),
    );
  });

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
  void Effect.runPromise(runPurgeCycle());

  // Schedule recurring purge
  _timer = setInterval(() => {
    void Effect.runPromise(runPurgeCycle());
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
