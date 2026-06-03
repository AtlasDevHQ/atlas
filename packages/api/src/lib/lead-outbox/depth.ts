/**
 * Outbox depth metrics + threshold alerting (#2734, slice 8 of 1.6.0).
 *
 * Two responsibilities:
 *
 *  1. `queryDepthSnapshot` — one round-trip to count `pending` /
 *     `dead` rows and grab the oldest pending row's `created_at`. The
 *     flusher tick calls this BEFORE dispatch so the gauges reflect
 *     pre-tick queue depth (the value an operator sees in the metrics
 *     endpoint between ticks).
 *
 *  2. `OutboxWarnRateLimiter` — once-per-minute gate on the
 *     "pending depth exceeds threshold" `log.warn` so a sustained
 *     backlog doesn't fill the log stream. Stateful by design; one
 *     instance is allocated per scheduler Layer scope and drops when
 *     the scope finalizes.
 *
 * Threshold default is 100; `ATLAS_CRM_OUTBOX_WARN_THRESHOLD` overrides
 * with the same clamp-and-warn discipline as `getBackstopSweepIntervalMs`
 * (`outbox.ts`) — an out-of-range value lands at the boundary rather than
 * silently defaulting, so the operator's intent is preserved.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { OutboxDB } from "./outbox";

const log = createLogger("lead-outbox:depth");

// ─────────────────────────────────────────────────────────────────────
//  Snapshot
// ─────────────────────────────────────────────────────────────────────

export interface OutboxDepthSnapshot {
  readonly pending: number;
  readonly dead: number;
  readonly oldestPendingCreatedAt: Date | null;
}

/**
 * Single aggregate row — keeps the snapshot to one round-trip even
 * under contention. The outer `WHERE status IN ('pending', 'dead')`
 * scopes the scan to the only two statuses we report on, so the
 * snapshot's cost does NOT scale with the unbounded history of
 * `done` rows that accumulate over the lifetime of the table. The
 * `pending` side of the scan hits the
 * `idx_crm_outbox_pending_created` partial index (mig 0102); the
 * `dead` side falls back to a sequential walk of dead rows only —
 * small in practice (a few hundred at most absent a sustained
 * upstream outage).
 */
const SNAPSHOT_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status = 'pending')        AS pending_count,
    COUNT(*) FILTER (WHERE status = 'dead')           AS dead_count,
    MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
  FROM crm_outbox
  WHERE status IN ('pending', 'dead')
`;

interface SnapshotRow extends Record<string, unknown> {
  pending_count: string | number;
  dead_count: string | number;
  oldest_pending_at: Date | string | null;
}

export async function queryDepthSnapshot(db: OutboxDB): Promise<OutboxDepthSnapshot> {
  const rows = await db.query<SnapshotRow>(SNAPSHOT_SQL);
  const row = rows[0];
  if (!row) {
    // PG's contract: `SELECT COUNT(*) FROM x` with no GROUP BY always
    // returns exactly one row. Zero rows here means something below
    // the SQL layer broke — driver/pool short-circuit, adapter
    // regression, or a custom OutboxDB stub violating the contract.
    // Throw so the caller's `Effect.catchAll` emits
    // `lead_outbox.tick_failed` (slice 2) and the OTel gauges retain
    // their last-recorded values rather than being reset to a
    // misleading zero — a sticky pool failure must NOT make the
    // queue look healthy.
    throw new Error(
      "crm_outbox snapshot returned no aggregate row — driver/pool invariant violated",
    );
  }
  return {
    pending: parseCount(row.pending_count),
    dead: parseCount(row.dead_count),
    oldestPendingCreatedAt: parseTimestamp(row.oldest_pending_at),
  };
}

function parseCount(v: string | number): number {
  if (typeof v === "number") {
    if (Number.isFinite(v)) return v;
    log.warn(
      { raw: v, event: "lead_outbox.snapshot_count_unparseable" },
      "crm_outbox aggregate count is NaN/Infinity — clamping to 0; pg type-parser config drifted",
    );
    return 0;
  }
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n)) return n;
  log.warn(
    { raw: v, event: "lead_outbox.snapshot_count_unparseable" },
    "crm_outbox aggregate count is not a valid integer — clamping to 0",
  );
  return 0;
}

function parseTimestamp(v: Date | string | null): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    log.warn(
      { raw: v, event: "lead_outbox.snapshot_timestamp_unparseable" },
      "crm_outbox oldest_pending_at could not be parsed as a Date — dropping; depth_threshold_warn ageMs will be null this tick",
    );
    return null;
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────
//  Threshold + rate-limit
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_WARN_THRESHOLD = 100;
export const WARN_INTERVAL_MS = 60_000;
export const MIN_WARN_THRESHOLD = 1;
export const MAX_WARN_THRESHOLD = 1_000_000;

export function getWarnThreshold(): number {
  const raw = process.env.ATLAS_CRM_OUTBOX_WARN_THRESHOLD;
  if (!raw) return DEFAULT_WARN_THRESHOLD;
  // Reject operator typos like "100abc" — `parseInt` is forgiving and
  // would silently accept `100`, masking a misconfigured env var. The
  // strict integer regex rejects anything that isn't a clean optional
  // sign followed by digits.
  if (!/^-?\d+$/.test(raw)) {
    log.warn(
      { requested: raw, event: "lead_outbox.threshold_unparseable" },
      `ATLAS_CRM_OUTBOX_WARN_THRESHOLD=${raw} is not a valid integer — using default ${DEFAULT_WARN_THRESHOLD}`,
    );
    return DEFAULT_WARN_THRESHOLD;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WARN_THRESHOLD;
  if (parsed < MIN_WARN_THRESHOLD) {
    log.warn(
      { requested: parsed, clamped: MIN_WARN_THRESHOLD, event: "lead_outbox.threshold_clamped" },
      `ATLAS_CRM_OUTBOX_WARN_THRESHOLD=${parsed} below ${MIN_WARN_THRESHOLD} — clamping`,
    );
    return MIN_WARN_THRESHOLD;
  }
  if (parsed > MAX_WARN_THRESHOLD) {
    log.warn(
      { requested: parsed, clamped: MAX_WARN_THRESHOLD, event: "lead_outbox.threshold_clamped" },
      `ATLAS_CRM_OUTBOX_WARN_THRESHOLD=${parsed} exceeds ${MAX_WARN_THRESHOLD} — clamping`,
    );
    return MAX_WARN_THRESHOLD;
  }
  return parsed;
}

export interface WarnDecision {
  readonly depth: number;
  readonly threshold: number;
  readonly oldestPendingCreatedAt: Date | null;
  readonly oldestPendingAgeMs: number | null;
}

/**
 * Stateful gate on the "depth exceeds threshold" warning. Holds the
 * timestamp of the last emitted warn; suppresses subsequent calls
 * within `intervalMs`. One instance per flusher Layer scope.
 *
 * `evaluate(snapshot, now)` returns `null` when the operator should
 * NOT see a warn (depth under threshold OR still inside the rate-limit
 * window) and the fully-shaped payload otherwise. The gate is
 * time-based, not edge-based: a depth that crosses the threshold,
 * drops below, and re-crosses within `intervalMs` is suppressed on
 * the second cross — re-emission happens once the interval elapses,
 * regardless of intervening dips. After the interval, a still-elevated
 * depth (or a fresh re-rise) re-warns.
 */
export class OutboxWarnRateLimiter {
  private lastWarnAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly intervalMs: number = WARN_INTERVAL_MS,
  ) {}

  evaluate(snapshot: OutboxDepthSnapshot, now: number = Date.now()): WarnDecision | null {
    if (snapshot.pending <= this.threshold) return null;
    if (now - this.lastWarnAt < this.intervalMs) return null;
    this.lastWarnAt = now;
    const oldestAgeMs =
      snapshot.oldestPendingCreatedAt == null
        ? null
        : Math.max(0, now - snapshot.oldestPendingCreatedAt.getTime());
    return {
      depth: snapshot.pending,
      threshold: this.threshold,
      oldestPendingCreatedAt: snapshot.oldestPendingCreatedAt,
      oldestPendingAgeMs: oldestAgeMs,
    };
  }
}
