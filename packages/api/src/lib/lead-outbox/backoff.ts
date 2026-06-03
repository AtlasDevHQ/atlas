/**
 * Backoff math for the `crm_outbox` flusher (#2729).
 *
 * Pure, unit-tested. The `DELAYS_MS` array and `CLAIM_DELAY_SQL` CASE
 * below must stay in lockstep — the SQL WHERE clause in
 * `outbox.ts:CLAIM_SQL` is what enforces backoff (a sleep would let a
 * long-backoff row block newer pending rows), so a divergence means
 * rows either retry too eagerly (data loss against the rate limit) or
 * never retry at all. `__tests__/backoff.test.ts` pins both sides;
 * `outbox-pg.test.ts` extends the check end-to-end via Postgres.
 *
 * Delay interpretation: `nextDelayMs(attempts)` returns the total
 * time, measured from `created_at`, that must elapse before attempt
 * N+1 is allowed. The flusher's claim WHERE clause is
 * `COALESCE(retry_after, created_at + delay) <= now()` — when the
 * upstream surfaced a `Retry-After` header the absolute `retry_after`
 * wins; otherwise the tier-based delay applies. The per-tier values
 * below grow geometrically (~6× per tier) to a ~12h ceiling
 * (30s → 3m → 20m → 2h → 12h). The extended ceiling (#2874) lets a
 * lead survive a multi-hour upstream outage (e.g. a Twenty maintenance
 * window) within the fixed `DEAD_AFTER_ATTEMPTS` budget instead of
 * dead-lettering at 2h; the low-frequency backstop sweep gates the
 * eventual retry when an in-memory retry timer is lost to a restart.
 * A row whose attempts dispatch unusually slowly may see attempt N+1
 * fire immediately after attempt N, which is acceptable: the next
 * attempt's failure pushes the row into the next tier, and the gap
 * grows from there.
 */

/**
 * Hard dead-letter threshold. After this many failed attempts the
 * flusher flips the row to `status='dead'` and stops retrying.
 */
export const DEAD_AFTER_ATTEMPTS = 6;

/**
 * Per-attempt delays in milliseconds, indexed by `attempts`.
 *
 * - `attempts=0` is the first try and must be immediate (delay 0) so
 *   `enqueue → flushBatch` round-trips in a single tick.
 * - `attempts=1..5` are the post-failure waits.
 * - `attempts>=6` is unreachable in the claim WHERE (filtered by
 *   `attempts < DEAD_AFTER_ATTEMPTS`); the array still terminates
 *   defensively in case a caller asks.
 */
const DELAYS_MS: ReadonlyArray<number> = [
  0,
  30_000,       // 30s
  180_000,      // 3m
  1_200_000,    // 20m
  7_200_000,    // 2h
  43_200_000,   // 12h — long-tail ceiling (#2874)
];

/**
 * Delay from `created_at` until the (attempts+1)th dispatch is allowed.
 *
 * Pure function — unit-tested in `__tests__/backoff.test.ts`. Mirrors
 * `CLAIM_DELAY_SQL` below; both are interpolated into
 * `outbox.ts:CLAIM_SQL`'s WHERE clause.
 */
export function nextDelayMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 0) return 0;
  const floored = Math.floor(attempts);
  if (floored >= DELAYS_MS.length) return DELAYS_MS[DELAYS_MS.length - 1];
  return DELAYS_MS[floored];
}

/**
 * SQL fragment that computes the per-attempt delay interval. Drop into
 * a WHERE clause as `created_at + <FRAGMENT> <= now()`. Kept here so
 * tier changes touch one file. Must match `DELAYS_MS` above.
 */
export const CLAIM_DELAY_SQL = `
  CASE attempts
    WHEN 0 THEN INTERVAL '0'
    WHEN 1 THEN INTERVAL '30 seconds'
    WHEN 2 THEN INTERVAL '3 minutes'
    WHEN 3 THEN INTERVAL '20 minutes'
    WHEN 4 THEN INTERVAL '2 hours'
    WHEN 5 THEN INTERVAL '12 hours'
    ELSE INTERVAL '12 hours'
  END
`;
