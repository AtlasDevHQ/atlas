/**
 * In-memory LRU cache backend with TTL eviction.
 *
 * Uses a Map for O(1) get/set (Map preserves insertion order)
 * with TTL-based expiry on read and max-size eviction on write.
 */

import type { CacheBackend, CacheEntry, CacheStats } from "./types";

export class LRUCacheBackend implements CacheBackend {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private defaultTtl: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number, defaultTtl: number) {
    if (maxSize < 1) throw new Error(`Cache maxSize must be >= 1, got ${maxSize}`);
    if (defaultTtl < 1) throw new Error(`Cache defaultTtl must be >= 1ms, got ${defaultTtl}`);
    this.maxSize = maxSize;
    this.defaultTtl = defaultTtl;
  }

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // TTL check
    if (Date.now() - entry.cachedAt > entry.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    // Delete first to update insertion order
    this.cache.delete(key);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      } else {
        break;
      }
    }

    this.cache.set(key, entry);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  flush(): void {
    this.cache.clear();
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entryCount: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.defaultTtl,
    };
  }
}
