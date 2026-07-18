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
 * capacity eviction, TTL expiry on read and on the lazy-pruning list/count
 * paths — all route through a single
 * `unindex()` seam so an entry can never linger in the side index after it
 * leaves the entry Map (a leak that would make `flushByOrg` return stale counts
 * and hold key references forever). The two bulk paths clear the index maps
 * directly: `flush()` empties them wholesale, and `flushByOrg()` deletes an
 * org's key set in one pass.
 */

import type { CacheBackend, CacheEntry, CacheEntryMeta, CacheScope, CacheStats } from "./types";

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

  /**
   * Reconcile the backend to a new resolved max size / default TTL at runtime.
   * Called from `getCache()` when the platform `ATLAS_CACHE_MAX_SIZE` / TTL
   * settings change, so a settings edit takes effect on the running backend
   * with no redeploy.
   *
   * Mutating in place (rather than constructing a fresh `LRUCacheBackend`)
   * preserves BOTH the hit/miss counters and the existing cache entries — a
   * fresh backend would start cold and reset the counters. A max-size
   * decrease evicts the oldest entries down to the new cap (same LRU order as
   * `set()`, and — like every removal path — routing each eviction through
   * `unindex()` so the scope side index can't drift); `defaultTtl` only
   * affects `stats()` reporting since per-entry TTL is stamped at write time.
   *
   * Stays synchronous (not part of the async `CacheBackend` contract): a pure
   * in-memory mutation with no I/O, called from the synchronous `getCache()`.
   */
  resize(maxSize: number, defaultTtl: number): void {
    if (maxSize < 1) throw new Error(`Cache maxSize must be >= 1, got ${maxSize}`);
    if (defaultTtl < 1) throw new Error(`Cache defaultTtl must be >= 1ms, got ${defaultTtl}`);
    this.maxSize = maxSize;
    this.defaultTtl = defaultTtl;
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.unindex(oldest);
    }
  }

  async flush(): Promise<void> {
    this.cache.clear();
    this.keyScope.clear();
    this.orgKeys.clear();
  }

  /**
   * Count one org's LIVE entries, lazily dropping any that have expired so
   * the count (and the flush dialog built on it) never includes corpses.
   * Iterates a snapshot of the org's key set — expiry routes through
   * `unindex()`, which mutates the live set (#4548's `flushByOrg` gotcha).
   *
   * Concrete on the LRU (not part of the `CacheBackend` contract): the cache
   * module's `owned` state variant is typed as `LRUCacheBackend`, so
   * `cacheOrgEntryCount` in `index.ts` reaches it without a contract change;
   * an external plugin backend degrades to "count unavailable" there.
   */
  entryCountByOrg(orgId: string, now: number = Date.now()): number {
    const keys = this.orgKeys.get(orgId);
    if (!keys) return 0;
    let live = 0;
    for (const key of [...keys]) {
      const entry = this.cache.get(key);
      if (!entry) {
        // Index drift shouldn't happen (every removal path unindexes), but
        // self-heal rather than overcount if it ever does — with a debug
        // breadcrumb so a recurring drift bug is detectable, not invisible.
        console.debug(`LRUCacheBackend: healed org-index drift for key ${key.slice(0, 12)}…`);
        this.unindex(key);
        continue;
      }
      if (now - entry.cachedAt > entry.ttl) {
        this.cache.delete(key);
        this.unindex(key);
        continue;
      }
      live++;
    }
    return live;
  }

  /** Map one live entry to its metadata row. Never includes the rows blob. */
  private toMeta(key: string, entry: CacheEntry, now: number): CacheEntryMeta {
    const scope = this.keyScope.get(key);
    if (!scope) {
      // Same invariant violation as the org-index drift heals below — every
      // live key should have a keyScope record. Degrade to "unknown" on the
      // wire, but leave a breadcrumb so recurring drift is detectable.
      console.debug(`LRUCacheBackend: keyScope missing for live key ${key.slice(0, 12)}…`);
    }
    return {
      key,
      // Spread-with-conditional keeps the property ABSENT on the in-memory
      // object for legacy entries (an own `undefined` prop would serialize
      // identically, but `"sqlPreview" in meta` checks — and the wire-shape
      // test pinning them — would see a different shape).
      ...(entry.sqlPreview !== undefined ? { sqlPreview: entry.sqlPreview } : {}),
      connectionId: scope?.connectionId ?? "unknown",
      rowCount: entry.rows.length,
      ageMs: Math.max(0, now - entry.cachedAt),
      ttl: entry.ttl,
    };
  }

  async listByOrg(orgId: string, now: number = Date.now()): Promise<CacheEntryMeta[]> {
    const keys = this.orgKeys.get(orgId);
    if (!keys) return [];
    const out: CacheEntryMeta[] = [];
    // Snapshot-iterate: expiry routes through `unindex`, which mutates the
    // live set (same gotcha as `flushByOrg`/`entryCountByOrg`).
    for (const key of [...keys]) {
      const entry = this.cache.get(key);
      if (!entry) {
        console.debug(`LRUCacheBackend: healed org-index drift for key ${key.slice(0, 12)}…`);
        this.unindex(key);
        continue;
      }
      if (now - entry.cachedAt > entry.ttl) {
        this.cache.delete(key);
        this.unindex(key);
        continue;
      }
      out.push(this.toMeta(key, entry, now));
    }
    return out;
  }

  /**
   * List EVERY live entry — the single-tenant (no-org) admin view, where the
   * whole cache belongs to the one tenant. Concrete on the LRU (not part of
   * the `CacheBackend` contract): a multi-tenant caller must always go
   * through `listByOrg`.
   */
  listAll(now: number = Date.now()): CacheEntryMeta[] {
    this.pruneExpired(now);
    return [...this.cache].map(([key, entry]) => this.toMeta(key, entry, now));
  }

  /**
   * Delete `key` ONLY if it belongs to `orgId` (#4550) — the org-scoped
   * authorization for per-entry delete. A workspace admin deleting by raw
   * key must never reach a co-tenant's entry, so membership is checked
   * against the org index before the delete. Returns whether an entry was
   * removed (an already-expired but unpruned entry still counts as
   * removed). Concrete on the LRU (reached via the `owned` state variant).
   */
  async deleteForOrg(orgId: string, key: string): Promise<boolean> {
    const keys = this.orgKeys.get(orgId);
    if (!keys?.has(key)) return false;
    return this.delete(key);
  }

  /**
   * Drop every already-expired entry. Called at the top of `stats()` so the
   * fill gauge counts live entries only — without it, a burst of short-TTL
   * writes reads as a full cache until each corpse is individually touched.
   */
  pruneExpired(now: number = Date.now()): void {
    for (const [key, entry] of [...this.cache]) {
      if (now - entry.cachedAt > entry.ttl) {
        this.cache.delete(key);
        this.unindex(key);
      }
    }
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
    this.pruneExpired();
    return {
      hits: this.hits,
      misses: this.misses,
      entryCount: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.defaultTtl,
    };
  }
}
