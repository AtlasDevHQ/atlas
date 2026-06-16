/**
 * Cache backend interface and entry types for query result caching.
 */

export interface CacheEntry {
  columns: string[];
  rows: Record<string, unknown>[];
  cachedAt: number;
  ttl: number;
  /**
   * Wall-clock duration (ms) of the ORIGINAL execution that populated this
   * entry. Replayed onto the cache-hit `audit_log` row's `duration_ms` so
   * cache hits carry the query's real cost instead of `0` — otherwise the
   * zero-duration hit rows drag down every hot query's average in
   * `/analytics/slow` (#3616). Optional so external/legacy backends (Redis,
   * pre-#3616 entries) that omit it degrade to `0` rather than crashing.
   */
  executionMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entryCount: number;
  maxSize: number;
  ttl: number;
}

/**
 * Abstract cache backend. The default in-memory LRU implements this.
 * Plugins can provide external backends (Redis, Memcached) via this interface.
 */
export interface CacheBackend {
  get(key: string): CacheEntry | null;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): boolean;
  /** Flush all entries. */
  flush(): void;
  stats(): CacheStats;
}
