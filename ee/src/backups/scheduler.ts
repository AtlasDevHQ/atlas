/**
 * Scheduled-backup cycle (#4457) — the per-tick body behind the
 * `scheduled_backup` periodic fiber registered in
 * `packages/api/src/lib/effect/layers.ts:makeSchedulerLive` (reached
 * through the `BackupsManager` Tag, never by a direct core→ee import).
 *
 * This replaces the dead `startScheduler` cron loop: that hand-rolled
 * `setInterval` + minute-matcher had zero production callers, skipped any
 * window the process was down for, and had only per-process-memory
 * double-fire protection. The cycle model instead:
 *
 *   1. Interprets the configured schedule as a **cadence window**
 *      (`resolveBackupCadence` — core, shared with the /health tripwire).
 *   2. Reaps stale `in_progress` scheduled rows (a crash mid-backup must
 *      not read as a healthy claim forever).
 *   3. Atomically **claims** the current window via
 *      `createScheduledBackup` — an `INSERT … ON CONFLICT DO NOTHING`
 *      against the partial UNIQUE index on `backups.scheduled_window`, so
 *      exactly one backup runs per region per window no matter how many
 *      replicas tick (the #4650 re-storm class).
 *   4. On a won claim: create → verify → purge. Verification depth follows
 *      `ATLAS_BACKUP_VERIFY_SCRATCH_URL` (#2941); header-only mode is
 *      treated as DEGRADED and logged at error level so on-call sees it.
 *
 * Enterprise-gated via requireEnterpriseEffect("backups") inside
 * `createScheduledBackup`. The per-tenant Business-plan entitlement
 * (`feature: "backups"`) is tracked as structurally inapplicable to this
 * platform-scoped surface in `lib/billing/enforcement-parity.ts` (#3984) —
 * the enterprise-license Tag is the gate.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { ScheduledBackupCycleResultShape } from "@atlas/api/lib/effect/services";
import {
  backupWindowKey,
  resolveBackupCadence,
} from "@atlas/api/lib/backups/cadence";
import { createScheduledBackup, getBackupConfig, purgeExpiredBackups } from "./engine";
import { verifyBackup } from "./verify";

const log = createLogger("ee:backups-scheduler");

/**
 * A scheduled `in_progress` row older than this is a crash carcass: mark it
 * failed (keeping its window claim — a window is attempted at most once).
 */
const STALE_CLAIM_AFTER_MS = 6 * 60 * 60 * 1000;

// The single definition lives on the Tag boundary (core services.ts) and is
// aliased here — a type-only import, so no runtime coupling. This makes
// ee↔core drift structurally impossible instead of one-way-checked.
export type ScheduledBackupCycleResult = ScheduledBackupCycleResultShape;

/**
 * One tick of the scheduled-backup fiber. Errors stay in the typed channel;
 * the fiber's `onTickFailure` recovery logs them and keeps the loop alive.
 */
export const runScheduledBackupCycle = (): Effect.Effect<ScheduledBackupCycleResult, Error> =>
  Effect.gen(function* () {
    const config = yield* getBackupConfig();
    const cadence = resolveBackupCadence(config.schedule);
    if (!cadence.recognized) {
      log.warn(
        { schedule: config.schedule },
        "Backup schedule not recognized — falling back to the daily 03:00 UTC cadence. " +
          "Supported shapes: 'M H * * *', 'M */N * * *', 'M * * * *', '*/N * * * *'.",
      );
    }

    // Reap crash carcasses so a dead in_progress row is visible as failed.
    yield* Effect.tryPromise({
      try: () =>
        internalQuery<{ id: string }>(
          `UPDATE backups
             SET status = 'failed',
                 error_message = 'Scheduled backup never completed — process likely crashed or was redeployed mid-backup'
           WHERE status = 'in_progress'
             AND scheduled_window IS NOT NULL
             AND created_at < now() - ($1 || ' milliseconds')::interval
           RETURNING id`,
          [String(STALE_CLAIM_AFTER_MS)],
        ),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tap((reaped) =>
        Effect.sync(() => {
          if (reaped.length > 0) {
            log.error(
              { backupIds: reaped.map((r) => r.id), staleAfterMs: STALE_CLAIM_AFTER_MS },
              "Marked stale scheduled backup(s) as failed — their windows produced no artifact",
            );
          }
        }),
      ),
    );

    const windowKey = backupWindowKey(Date.now(), cadence);
    const backup = yield* createScheduledBackup(windowKey);
    if (backup === null) {
      // Another replica owns this window, or its backup already ran (or
      // already failed — at most one attempt per window; the /health
      // tripwire flags a window that produced no verified artifact).
      return { status: "window-already-claimed" as const };
    }

    log.info(
      { backupId: backup.id, windowKey, cadenceMs: cadence.cadenceMs },
      "Scheduled backup created — verifying",
    );

    // Verify every automated backup — without this the success signal is
    // just "pg_dump exited 0 + non-empty artifact". Depth is governed by
    // ATLAS_BACKUP_VERIFY_SCRATCH_URL (#2941): full restore-into-scratch
    // when set, degraded header-only otherwise.
    const verification = yield* verifyBackup(backup.id);
    if (!verification.verified) {
      log.error(
        { backupId: backup.id, reason: verification.message, level: verification.level },
        "Scheduled backup failed verification — artifact may not be restorable",
      );
    } else if (verification.level === "header-only") {
      // Loud, error-level: a green scheduled backup that was never proven
      // restorable is exactly the boot-green-but-broken state #4457 exists
      // to prevent. Set ATLAS_BACKUP_VERIFY_SCRATCH_URL in production.
      log.error(
        { backupId: backup.id },
        "Scheduled backup verified HEADER-ONLY (degraded) — a truncated dump would pass. " +
          "Set ATLAS_BACKUP_VERIFY_SCRATCH_URL to a disposable scratch Postgres for full-restore verification.",
      );
    }

    // Purge expired backups after the scheduled backup completes.
    const purged = yield* purgeExpiredBackups();

    return {
      status: "ran" as const,
      backupId: backup.id,
      verified: verification.verified,
      verifyLevel: verification.level,
      purged,
    };
  });
