/**
 * Backup scheduler — cron-based automated backups.
 *
 * Evaluates a cron expression to determine when the next backup
 * should run. The scheduler is designed to be called periodically
 * (e.g., every minute via setInterval) and will trigger a backup
 * when the cron expression matches the current time.
 *
 * Enterprise-gated via requireEnterpriseEffect("backups").
 */

import { Effect } from "effect";
import { requireEnterprise } from "../index";
import { createLogger } from "@atlas/api/lib/logger";
import { createBackup, getBackupConfig, purgeExpiredBackups, ensureTable } from "./engine";

const log = createLogger("ee:backups-scheduler");

let _schedulerInterval: ReturnType<typeof setInterval> | null = null;
let _lastRunMinute = -1;

/**
 * Parse a cron expression and check if it matches the current time.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 */
function cronMatchesNow(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    log.warn({ expression }, "Invalid cron expression — expected 5 fields. Scheduled backups will not run.");
    return false;
  }

  const now = new Date();
  const fields = [
    now.getUTCMinutes(),  // 0-59
    now.getUTCHours(),    // 0-23
    now.getUTCDate(),     // 1-31
    now.getUTCMonth() + 1, // 1-12
    now.getUTCDay(),      // 0-6 (Sun=0)
  ];

  return parts.every((part, i) => fieldMatches(part, fields[i]));
}

function fieldMatches(pattern: string, value: number): boolean {
  if (pattern === "*") return true;

  // Handle step values: */N or N-M/S
  if (pattern.includes("/")) {
    const [range, stepStr] = pattern.split("/");
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;
    if (range === "*") return value % step === 0;
    // Range with step: e.g. 1-30/2
    const [startStr, endStr] = range.split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : start;
    if (isNaN(start) || isNaN(end)) return false;
    return value >= start && value <= end && (value - start) % step === 0;
  }

  // Handle comma-separated values: 1,5,10
  if (pattern.includes(",")) {
    return pattern.split(",").some((p) => fieldMatches(p.trim(), value));
  }

  // Handle ranges: N-M
  if (pattern.includes("-")) {
    const [startStr, endStr] = pattern.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end)) return false;
    return value >= start && value <= end;
  }

  // Single value
  return parseInt(pattern, 10) === value;
}

/**
 * Check if a backup should run now and execute it.
 * Called once per minute by the scheduler interval.
 */
const tick = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = new Date();
    const currentMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

    // Prevent double-execution in the same minute
    if (currentMinute === _lastRunMinute) return;

    const config = yield* getBackupConfig();

    if (!cronMatchesNow(config.schedule)) return;

    _lastRunMinute = currentMinute;
    log.info({ schedule: config.schedule }, "Scheduled backup triggered");

    yield* createBackup();

    // Purge expired backups after successful backup
    yield* purgeExpiredBackups();
  }).pipe(
    Effect.catchAll((err) => {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Scheduled backup failed",
      );
      return Effect.void;
    }),
  );

/**
 * Start the backup scheduler. Runs a check every 60 seconds.
 * Idempotent — calling multiple times is safe.
 */
export const startScheduler = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => requireEnterprise("backups"),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    yield* ensureTable();

    if (_schedulerInterval) return;

    const config = yield* getBackupConfig();
    log.info({ schedule: config.schedule, retentionDays: config.retention_days }, "Backup scheduler started");

    // Check immediately, then every 60 seconds
    void Effect.runPromise(tick());

    _schedulerInterval = setInterval(() => {
      void Effect.runPromise(tick());
    }, 60_000);
  });

/**
 * Stop the backup scheduler.
 */
export function stopScheduler(): void {
  if (_schedulerInterval) {
    clearInterval(_schedulerInterval);
    _schedulerInterval = null;
    log.info("Backup scheduler stopped");
  }
}

/** @internal — for testing */
export { cronMatchesNow as _cronMatchesNow };
