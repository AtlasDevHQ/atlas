/**
 * Backoff math for the `crm_outbox` flusher (#2729).
 *
 * Pure, unit-tested. Both this file and the SQL CASE expression in
 * `outbox.ts` must stay in lockstep — the SQL WHERE clause is what
 * enforces backoff (a sleep would let a long-backoff row block newer
 * pending rows), so a divergence here means rows either retry too
 * eagerly (data loss against the rate limit) or never retry at all.
 *
 * Delay interpretation: `delayUntilNextAttemptMs(attempts)` returns the
 * total time, measured from `created_at`, that must elapse before
 * attempt N+1 is allowed. The flusher's claim WHERE clause is
 * `created_at + delay <= now()`. With the per-tier values below,
 * inter-attempt gaps grow geometrically (30s, ~1m30s, ~6m, ~22m, ~1h30m)
 * even though the base is `created_at` — each tier is large enough that
 * a fast-failing attempt at the previous tier still leaves a real gap
 * before the next try. A row whose attempts dispatch unusually slowly
 * may see attempt N+1 fire immediately after attempt N, which is
 * acceptable: the next attempt's failure pushes the row into the next
 * tier, and the gap grows from there.
 *
 * `nextDelayMs` is an alias retained for the spec wording in #2729.
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
  120_000,      // 2m
  480_000,      // 8m
  1_800_000,    // 30m
  7_200_000,    // 2h
];

/**
 * Delay from `created_at` until the (attempts+1)th dispatch is allowed.
 *
 * Pure function — unit-tested in `__tests__/backoff.test.ts`. Mirrors
 * the SQL CASE in `OUTBOX_CLAIM_SQL`.
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
    WHEN 2 THEN INTERVAL '2 minutes'
    WHEN 3 THEN INTERVAL '8 minutes'
    WHEN 4 THEN INTERVAL '30 minutes'
    WHEN 5 THEN INTERVAL '2 hours'
    ELSE INTERVAL '2 hours'
  END
`;
