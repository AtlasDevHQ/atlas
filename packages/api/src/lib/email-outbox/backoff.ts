/**
 * Backoff math for the `email_outbox` flusher (#2942).
 *
 * Pure, unit-tested. The `DELAYS_MS` array and `CLAIM_DELAY_SQL` CASE
 * below must stay in lockstep — the SQL WHERE clause in
 * `outbox.ts:CLAIM_SQL` is what enforces backoff (a sleep would let a
 * long-backoff row block newer pending rows), so a divergence means
 * rows either retry too eagerly (hammer a down provider) or never retry
 * at all. `__tests__/backoff.test.ts` pins both sides.
 *
 * Tier schedule is intentionally identical to lead-outbox: an
 * email_outbox row only exists because the in-process `fetchWithRetry`
 * window (PR #2949) was already exhausted, so the next attempts are
 * spaced to ride out a SUSTAINED outage (30s → 2m → 8m → 30m → 2h)
 * rather than re-hammer a provider that's still down.
 */

/**
 * Hard dead-letter threshold. After this many failed attempts the
 * flusher flips the row to `status='dead'` and stops retrying.
 */
export const DEAD_AFTER_ATTEMPTS = 6;

/**
 * Per-attempt delays in milliseconds, indexed by `attempts`.
 *
 * - `attempts=0` is the first flush after enqueue and must be immediate
 *   (delay 0) so `enqueue → flushBatch` round-trips in a single tick.
 * - `attempts=1..5` are the post-failure waits.
 * - `attempts>=6` is unreachable in the claim WHERE (filtered by
 *   `attempts < DEAD_AFTER_ATTEMPTS`); the array still terminates
 *   defensively in case a caller asks.
 */
const DELAYS_MS: ReadonlyArray<number> = [
  0,
  30_000, // 30s
  120_000, // 2m
  480_000, // 8m
  1_800_000, // 30m
  7_200_000, // 2h
];

/**
 * Per-attempt backoff interval (ms) before the (attempts+1)th dispatch.
 * Added to `now()` at the failure moment by `MARK_TRANSIENT_FAIL_SQL`
 * (`retry_after = now() + tier`), and to `created_at` only for the
 * never-failed (attempts=0) first-claim gate.
 *
 * Pure function — unit-tested in `__tests__/backoff.test.ts`. Mirrors
 * `CLAIM_DELAY_SQL` below; both are interpolated into `outbox.ts`'s
 * CLAIM and MARK_TRANSIENT statements.
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
