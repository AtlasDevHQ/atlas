/**
 * Shape validation for plugin-provided cache backends.
 *
 * A plugin can replace the in-process LRU with an external backend (Redis,
 * Memcached). Before we swap it in we prove it conforms to the async
 * {@link CacheBackend} contract — required methods present, and `stats()`
 * returns the documented numeric shape. A backend that fails validation must
 * NOT be registered: per "prefer errors over silent fallbacks", the offending
 * plugin fails its init (goes red in plugin health) while the cache degrades to
 * the LRU so queries keep working, rather than silently swallowing a
 * misimplemented backend that would corrupt every hit.
 */

import type { CacheStats } from "./types";

/** The methods a conforming backend must expose. */
const REQUIRED_METHODS = ["get", "set", "delete", "flush", "flushByOrg", "stats"] as const;

/** The numeric fields `stats()` must return. */
const STATS_FIELDS: readonly (keyof CacheStats)[] = ["hits", "misses", "entryCount", "maxSize", "ttl"];

/**
 * How long the `stats()` probe may take before validation gives up. `stats()`
 * is documented on the contract as cheap + side-effect-free, so a probe that
 * doesn't resolve promptly means a misbehaving backend (e.g. a Redis client
 * blocked on a dead connection). Bounding it keeps a hung backend from stalling
 * plugin-registry boot — the whole point of validation is to fail fast and
 * degrade to the LRU so queries keep working.
 */
const STATS_PROBE_TIMEOUT_MS = 2_000;

export type CacheBackendValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate a candidate cache backend against the contract. Probes `stats()`
 * (bounded by `timeoutMs`, default {@link STATS_PROBE_TIMEOUT_MS}) to confirm
 * the stats shape, treating a throw, a non-conforming return, or a hang as a
 * validation failure rather than letting any of them escape registration.
 * `timeoutMs` is injectable so tests can exercise the hang path without waiting
 * the full production bound.
 */
export async function validateCacheBackend(
  candidate: unknown,
  timeoutMs: number = STATS_PROBE_TIMEOUT_MS,
): Promise<CacheBackendValidation> {
  if (candidate === null || typeof candidate !== "object") {
    return { ok: false, reason: `cache backend must be an object, got ${candidate === null ? "null" : typeof candidate}` };
  }

  const obj = candidate as Record<string, unknown>;
  const missing = REQUIRED_METHODS.filter((m) => typeof obj[m] !== "function");
  if (missing.length > 0) {
    return { ok: false, reason: `cache backend missing required method(s): ${missing.join(", ")}` };
  }

  // Probe the stats contract. A conforming backend returns an object with the
  // five numeric fields; anything else (missing field, wrong type, a throw, or
  // a probe that never resolves) is a contract violation.
  const TIMED_OUT = Symbol("stats-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stats: unknown;
  const statsPromise = (obj.stats as () => Promise<unknown>)();
  // If the timeout wins the race, the losing `stats()` promise stays pending;
  // a late rejection on it (the exact dead-connection case this probe guards)
  // must not escape as an unhandledRejection. Swallow it — we've already
  // decided the backend is invalid via the timeout branch below.
  statsPromise.catch(() => {});
  try {
    stats = await Promise.race([
      statsPromise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } catch (err) {
    return { ok: false, reason: `cache backend stats() threw: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (stats === TIMED_OUT) {
    return { ok: false, reason: `cache backend stats() did not resolve within ${timeoutMs}ms` };
  }
  if (stats === null || typeof stats !== "object") {
    return { ok: false, reason: `cache backend stats() must return an object, got ${stats === null ? "null" : typeof stats}` };
  }
  const statsObj = stats as Record<string, unknown>;
  const badFields = STATS_FIELDS.filter((f) => typeof statsObj[f] !== "number");
  if (badFields.length > 0) {
    return { ok: false, reason: `cache backend stats() missing numeric field(s): ${badFields.join(", ")}` };
  }

  return { ok: true };
}
