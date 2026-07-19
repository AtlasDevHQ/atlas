/**
 * Backup cadence — turns the persisted `backup_config.schedule` cron string
 * into a fixed cadence window the scheduled-backup fiber and the /health
 * tripwire share (#4457).
 *
 * This is deliberately NOT a cron tick-matcher. The retired
 * `ee/src/backups/scheduler.ts` `startScheduler` evaluated "does the cron
 * match the current minute" on a 60s `setInterval` — which silently skips a
 * window whenever the process happens to be down (or deploying) at the
 * matching minute, and double-fires across replicas. Instead the schedule is
 * interpreted as a **cadence** (window length + anchor offset): every window
 * gets at most one backup attempt — exactly one across replicas whenever any
 * replica is up during the window — claimed atomically in the DB when a
 * fiber first ticks inside the window. Restart-safe catch-up semantics.
 *
 * Recognized schedule shapes (everything the docs/config surface has ever
 * suggested):
 *
 *   "M H * * *"    — daily at H:M UTC   → 24h cadence anchored at H:M
 *   "M *\/N * * *"  — every N hours      → N·1h cadence anchored at :M
 *   "M * * * *"    — hourly at :M       → 1h cadence anchored at :M
 *   "*\/N * * * *"  — every N minutes    → N·1m cadence (min 10m)
 *
 * Anything else falls back to the daily 03:00 UTC default with a warning —
 * the fiber still runs (a mistyped schedule must not silently disable
 * backups), and `recognized: false` lets callers surface the fallback.
 *
 * Lives in core (not `/ee`) because the /health tripwire — core code — needs
 * the same cadence to decide "is the last verified backup older than the
 * cadence window". Core-side placement keeps `check-ee-imports.sh` happy;
 * `/ee` imports from core freely.
 */

export const DEFAULT_BACKUP_SCHEDULE = "0 3 * * *";

/** Fiber check interval — how often the claim attempt runs, not the backup cadence. */
export const SCHEDULED_BACKUP_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Boot-consumed kill switch for the scheduled-backup path only (manual admin
 * backups are unaffected). The ONE definition shared by the fiber gate
 * (`layers.ts:makeSchedulerLive`) and the /health tripwire's expectation
 * mirror (`lib/backups/health.ts`) — those two are required to agree (the
 * tripwire's premise is "expected mirrors the gate"), so the accepted value
 * set must never be duplicated.
 */
export function isScheduledBackupEnvDisabled(): boolean {
  return (
    process.env.ATLAS_BACKUP_SCHEDULED_ENABLED === "false" ||
    process.env.ATLAS_BACKUP_SCHEDULED_ENABLED === "0"
  );
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Floor for minute-step schedules so a typo can't turn backups into a load storm. */
const MIN_CADENCE_MS = 10 * MINUTE_MS;

export interface BackupCadence {
  /** Window length in milliseconds. */
  readonly cadenceMs: number;
  /** Offset of the window boundary from the epoch-aligned grid (e.g. 03:00 for the daily default). */
  readonly anchorMs: number;
  /** False when the schedule didn't match a recognized shape and the daily default applied. */
  readonly recognized: boolean;
}

export function resolveBackupCadence(schedule: string | undefined | null): BackupCadence {
  const raw = (schedule ?? DEFAULT_BACKUP_SCHEDULE).trim();

  let m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(raw);
  if (m) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    if (minute <= 59 && hour <= 23) {
      return { cadenceMs: DAY_MS, anchorMs: hour * HOUR_MS + minute * MINUTE_MS, recognized: true };
    }
  }

  m = /^(\d{1,2})\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/.exec(raw);
  if (m) {
    const minute = Number(m[1]);
    const hours = Number(m[2]);
    if (minute <= 59 && hours >= 1 && hours <= 24) {
      return { cadenceMs: hours * HOUR_MS, anchorMs: minute * MINUTE_MS, recognized: true };
    }
  }

  m = /^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/.exec(raw);
  if (m) {
    const minute = Number(m[1]);
    if (minute <= 59) {
      return { cadenceMs: HOUR_MS, anchorMs: minute * MINUTE_MS, recognized: true };
    }
  }

  m = /^\*\/(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/.exec(raw);
  if (m) {
    const minutes = Number(m[1]);
    if (minutes >= 1 && minutes <= 59) {
      return { cadenceMs: Math.max(minutes * MINUTE_MS, MIN_CADENCE_MS), anchorMs: 0, recognized: true };
    }
  }

  // Unrecognized — daily 03:00 UTC default. `recognized: false` so the
  // caller logs the fallback loudly (never here: this is a pure function
  // called from both the fiber and the cached health probe).
  return { cadenceMs: DAY_MS, anchorMs: 3 * HOUR_MS, recognized: false };
}

/**
 * Deterministic key for the cadence window containing `nowMs`. Identical
 * across replicas (pure arithmetic over the epoch grid), so a UNIQUE index
 * on the key is the cross-replica concurrency claim: whichever replica's
 * INSERT lands first owns the window's backup.
 *
 * The cadence and anchor participate in the key, so changing the schedule
 * starts a fresh key space (worst case: one extra backup at the transition,
 * never a skipped window).
 */
export function backupWindowKey(nowMs: number, cadence: BackupCadence): string {
  // Every resolveBackupCadence result satisfies this, but the interface is
  // open — a fabricated cadence with cadenceMs 0/NaN would yield an
  // Infinity/NaN window index, i.e. ONE eternal window whose first claim
  // silently satisfies every future tick. Fail loud instead.
  if (!Number.isFinite(cadence.cadenceMs) || cadence.cadenceMs <= 0) {
    throw new Error(`Invalid backup cadence: cadenceMs must be a positive finite number (got ${cadence.cadenceMs})`);
  }
  const windowIndex = Math.floor((nowMs - cadence.anchorMs) / cadence.cadenceMs);
  return `w${cadence.cadenceMs}a${cadence.anchorMs}-${windowIndex}`;
}
