/**
 * Cache backend interface and entry types for query result caching.
 */

export interface CacheEntry {
  columns: string[];
  rows: Record<string, unknown>[];
  cachedAt: number;
  ttl: number;
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
