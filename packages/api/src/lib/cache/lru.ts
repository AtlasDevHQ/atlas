/**
 * In-memory LRU cache backend with TTL eviction.
 *
 * Uses a Map for O(1) get/set (Map preserves insertion order)
 * with TTL-based expiry on read and max-size eviction on write.
 *
 * Scope side index: alongside the entry Map, an `orgId → keys` index (with a
 * `key → scope` reverse map) lets {@link LRUCacheBackend.flushByOrg} purge
 * exactly one Workspace's entries in O(entries-for-that-org) rather than
 * scanning the whole cache. Per-entry removal paths — set-overwrite, delete,
 * capacity eviction, TTL expiry on read — all route through a single
 * `unindex()` seam so an entry can never linger in the side index after it
 * leaves the entry Map (a leak that would make `flushByOrg` return stale counts
 * and hold key references forever). The two bulk paths clear the index maps
 * directly: `flush()` empties them wholesale, and `flushByOrg()` deletes an
 * org's key set in one pass.
 */

import type { CacheBackend, CacheEntry, CacheScope, CacheStats } from "./types";

export class LRUCacheBackend implements CacheBackend {
  private cache = new Map<string, CacheEntry>();
  /** Reverse lookup: key → its scope tags. One entry per cached key. */
  private keyScope = new Map<string, CacheScope>();
  /** Forward index: orgId → set of keys owned by that org. */
  private orgKeys = new Map<string, Set<string>>();
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

  /**
   * Record a key's scope in the side index. Called from `set()` only. Every
   * key gets a `keyScope` record (so its connectionId is retained); only keys
   * carrying an `orgId` join the `orgKeys` forward index.
   */
  private index(key: string, scope: CacheScope): void {
    this.keyScope.set(key, scope);
    if (scope.orgId === undefined) return;
    let keys = this.orgKeys.get(scope.orgId);
    if (!keys) {
      keys = new Set<string>();
      this.orgKeys.set(scope.orgId, keys);
    }
    keys.add(key);
  }

  /**
   * Remove a key from the side index. Idempotent — safe to call for a key that
   * was never indexed. The single seam every entry-removal path routes through
   * (set-overwrite, delete, eviction, TTL expiry) so the index can't drift.
   */
  private unindex(key: string): void {
    const scope = this.keyScope.get(key);
    if (scope === undefined) return;
    this.keyScope.delete(key);
    if (scope.orgId === undefined) return;
    const keys = this.orgKeys.get(scope.orgId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) this.orgKeys.delete(scope.orgId);
    }
  }

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // TTL check — an expired entry leaves the Map AND the side index.
    if (Date.now() - entry.cachedAt > entry.ttl) {
      this.cache.delete(key);
      this.unindex(key);
      this.misses++;
      return null;
    }

    // Move to end (most recently used) by re-inserting. This re-orders the
    // entry Map only; the key's scope is unchanged, so the side index is left
    // as-is (no unindex/index churn on a plain read).
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry;
  }

  async set(key: string, entry: CacheEntry, scope: CacheScope): Promise<void> {
    // Delete first to update insertion order; clear any stale scope for this
    // key (an overwrite may carry different tags than the prior write).
    this.cache.delete(key);
    this.unindex(key);

    // Evict oldest entries if at capacity — each eviction unindexes too.
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.unindex(oldest);
      } else {
        break;
      }
    }

    this.cache.set(key, entry);
    this.index(key, scope);
  }

  async delete(key: string): Promise<boolean> {
    this.unindex(key);
    return this.cache.delete(key);
  }

  async flush(): Promise<void> {
    this.cache.clear();
    this.keyScope.clear();
    this.orgKeys.clear();
  }

  async flushByOrg(orgId: string): Promise<number> {
    const keys = this.orgKeys.get(orgId);
    if (!keys) return 0;
    let removed = 0;
    // Iterate a snapshot and inline the per-key `keyScope` cleanup rather than
    // calling `unindex(key)` — `unindex` would `delete` from `orgKeys.get(orgId)`,
    // the very set we're iterating. The `[...keys]` copy plus a single trailing
    // `orgKeys.delete(orgId)` drops the whole set at once, so the live set is
    // never mutated mid-iteration.
    for (const key of [...keys]) {
      if (this.cache.delete(key)) removed++;
      this.keyScope.delete(key);
    }
    this.orgKeys.delete(orgId);
    return removed;
  }

  async stats(): Promise<CacheStats> {
    return {
      hits: this.hits,
      misses: this.misses,
      entryCount: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.defaultTtl,
    };
  }
}
