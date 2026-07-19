/**
 * Scheduled-backup health tripwire (#4457) — surfaces "boot-green-but-broken"
 * backup automation on /health.
 *
 * The scheduled-backup fiber can be silently absent for many reasons (EE
 * layer failed to load, gate misconfigured, pg_dump missing, scratch DB
 * broken) while the process boots green. This probe answers one question
 * from the DB, independently of the fiber: **is the newest verified backup
 * older than the cadence window?** If yes — or if none exists at all — the
 * /health `backups` component reports `degraded` (never `down`: backups
 * must not 503 the region or pull it from the LB).
 *
 * Lives in core (not /ee): it only reads the `backups` / `backup_config`
 * tables, which are core-schema (`db/schema.ts`), and /health is core code
 * that must not import `@atlas/ee` (`check-ee-imports.sh`). Whether
 * scheduled backups are *expected* mirrors the fiber's gate:
 * enterprise-enabled (core mirror) + internal DB + not env-disabled.
 *
 * Cached ~60s — /health is public and polled; the two cheap reads (config +
 * newest-verified) happen at most once per minute, not per probe.
 */

import { isEnterpriseEnabled } from "@atlas/api/lib/effect/enterprise-config";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import {
  DEFAULT_BACKUP_SCHEDULE,
  isScheduledBackupEnvDisabled,
  resolveBackupCadence,
} from "./cadence";

const log = createLogger("backups-health");

export type ScheduledBackupHealth =
  | { readonly expected: false }
  | {
      readonly expected: true;
      /** ISO timestamp of the newest `verified` backup, or null if none exists. */
      readonly lastVerifiedAt: string | null;
      /** Cadence window length derived from the configured schedule. */
      readonly cadenceMs: number;
      /** True when the newest verified backup is older than the overdue threshold (or none exists). */
      readonly overdue: boolean;
      /** Human-readable reason when overdue. */
      readonly message?: string;
    };

const CACHE_TTL_MS = 60_000;

/** Grace beyond the cadence before the tripwire fires — absorbs backup + verify runtime and deploy jitter. */
const OVERDUE_GRACE_FACTOR = 1.25;

let _cache: { at: number; value: ScheduledBackupHealth } | null = null;

/** @internal Reset the probe cache — for testing only. */
export function _resetScheduledBackupHealthCache(): void {
  _cache = null;
}

function scheduledBackupsExpected(): boolean {
  // Same predicate the fiber gate uses (shared from cadence.ts) — the
  // tripwire's premise is "expected mirrors the gate".
  if (isScheduledBackupEnvDisabled()) return false;
  return isEnterpriseEnabled() && hasInternalDB();
}

/**
 * Probe the scheduled-backup state for /health. Never throws — a probe
 * failure reports overdue (fail loud, not fail silent: a broken probe on a
 * deployment that expects backups is itself a finding), except when the
 * `backups` table simply doesn't exist yet, which reads as "none yet".
 */
export async function getScheduledBackupHealth(): Promise<ScheduledBackupHealth> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.value;

  const value = await probe(now);
  _cache = { at: now, value };
  return value;
}

async function probe(now: number): Promise<ScheduledBackupHealth> {
  if (!scheduledBackupsExpected()) return { expected: false };

  let schedule = process.env.ATLAS_BACKUP_SCHEDULE ?? DEFAULT_BACKUP_SCHEDULE;
  let lastVerifiedAt: string | null = null;
  try {
    const [configRows, lastRows] = await Promise.all([
      internalQuery<{ schedule: string }>(
        `SELECT schedule FROM backup_config WHERE id = '_default'`,
      ),
      internalQuery<{ last: string | null }>(
        `SELECT max(created_at)::text AS last FROM backups WHERE status = 'verified'`,
      ),
    ]);
    if (configRows[0]?.schedule) schedule = configRows[0].schedule;
    lastVerifiedAt = lastRows[0]?.last ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Narrow match: only the two backup tables missing reads as "first boot
    // before ensureTable / migration 0177". A broad /does not exist/ would
    // also swallow `database/role/column … does not exist` — real
    // misconfiguration that must reach the operator with its own message.
    if (/relation "(backups|backup_config)" does not exist/i.test(message)) {
      // intentionally ignored: first boot before the baseline migration /
      // the engine's ensureTable() has created backups/backup_config —
      // equivalent to "no verified backup yet"; logged at debug for trace.
      log.debug({ err: message }, "Backup tables not created yet — treating as no verified backup");
      lastVerifiedAt = null;
    } else {
      log.warn({ err: message }, "Scheduled-backup health probe query failed — reporting overdue");
      return {
        expected: true,
        lastVerifiedAt: null,
        cadenceMs: resolveBackupCadence(schedule).cadenceMs,
        overdue: true,
        message: "Backup health probe failed — see server logs",
      };
    }
  }

  const cadence = resolveBackupCadence(schedule);
  const thresholdMs = cadence.cadenceMs * OVERDUE_GRACE_FACTOR;

  if (lastVerifiedAt === null) {
    return {
      expected: true,
      lastVerifiedAt: null,
      cadenceMs: cadence.cadenceMs,
      overdue: true,
      message: "No verified backup recorded — the scheduled-backup fiber may not be running or verification is failing",
    };
  }

  const ageMs = now - new Date(lastVerifiedAt).getTime();
  const overdue = !Number.isFinite(ageMs) || ageMs > thresholdMs;
  return {
    expected: true,
    lastVerifiedAt,
    cadenceMs: cadence.cadenceMs,
    overdue,
    ...(overdue && {
      message: Number.isFinite(ageMs)
        ? `Last verified backup is ${Math.round(ageMs / 3_600_000)}h old — older than the configured cadence window`
        : "Last verified backup timestamp is unparseable — treating as overdue",
    }),
  };
}
