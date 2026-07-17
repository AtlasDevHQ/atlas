/**
 * Bounded, config-driven connection-acquire timeout shared by every long-lived
 * database pool: pg pools set it as `connectionTimeoutMillis`, mysql2 pools as
 * `connectTimeout`.
 *
 * Without it, `pg` defaults to `0` — *no* timeout — so a saturated pool queues
 * `pool.connect()` indefinitely and an unreachable-but-routable database stalls
 * every request for the OS TCP keepalive window instead of failing fast. The
 * statement timeout only starts *after* a client is acquired, so it can't help
 * a request that never gets one. (#4463)
 *
 * Read from the `ATLAS_CONNECT_TIMEOUT` env var (milliseconds) at pool
 * construction — env, not the settings registry, because the value is consumed
 * exactly once when the pool is built (a pre-pool boot input, like
 * `ATLAS_POOL_WARMUP`), never re-read per query, so a hot-reloadable setting
 * would never take effect on an already-constructed pool.
 *
 * The result is clamped to `[MIN, MAX]` so a stray `0` (or negative / NaN)
 * can never re-introduce the infinite-hang behaviour, and an absurdly large
 * value can't defeat the fail-fast guarantee.
 */

/** Default acquire timeout when `ATLAS_CONNECT_TIMEOUT` is unset. */
export const CONNECT_TIMEOUT_DEFAULT_MS = 10_000;
/** Floor: guarantees a strictly-positive timeout so pg never falls back to 0 (no timeout). */
export const CONNECT_TIMEOUT_MIN_MS = 1_000;
/** Ceiling: bounds worst-case fail-fast latency regardless of a misconfigured value. */
export const CONNECT_TIMEOUT_MAX_MS = 60_000;

/**
 * Resolve the bounded pool acquire/connect timeout in milliseconds.
 *
 * Applied as `connectionTimeoutMillis` on every pg pool (analytics + internal)
 * and `connectTimeout` on every mysql2 pool.
 */
export function getConnectTimeoutMs(): number {
  const raw = Number(process.env.ATLAS_CONNECT_TIMEOUT);
  const value = Number.isFinite(raw) && raw > 0 ? raw : CONNECT_TIMEOUT_DEFAULT_MS;
  return Math.min(CONNECT_TIMEOUT_MAX_MS, Math.max(CONNECT_TIMEOUT_MIN_MS, Math.floor(value)));
}
