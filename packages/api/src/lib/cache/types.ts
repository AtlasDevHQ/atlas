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
  /**
   * First {@link SQL_PREVIEW_MAX_CHARS} chars of the post-`beforeQuery` SQL
   * that built this entry's key, stamped at write time for the admin
   * entry-inspection table (#4550). A capped preview by design — never
   * full-SQL retention beyond what the entry already holds. Optional so
   * legacy/plugin-written entries degrade to "no preview" rather than
   * crashing.
   */
  sqlPreview?: string;
}

/** Cap for {@link CacheEntry.sqlPreview} — the single statement of "~200 chars". */
export const SQL_PREVIEW_MAX_CHARS = 200;

/**
 * Row-shaped metadata for one live cache entry, served to the admin
 * entry-inspection table (#4550). Metadata ONLY — the rows blob never
 * leaves the backend over this surface.
 *
 * Deliberately NOT part of the `CacheBackend` contract: the listing/delete
 * primitives (`listByOrg`/`listAll`/`deleteForOrg`) are LRU-concrete,
 * reached via the cache module's `owned` state variant — the org side index
 * is what makes a TRUSTWORTHY org-scoped listing possible, so a plugin
 * backend degrades to "unavailable" instead of the contract growing a
 * method every external backend would have to implement (and existing ones
 * would fail validation on). Mirrors #4549's `entryCountByOrg` decision.
 */
export interface CacheEntryMeta {
  /** The full cache key (needed by the per-entry delete action). */
  key: string;
  /** Capped SQL preview stamped at write time; absent on legacy entries. */
  sqlPreview?: string;
  /** The Datasource connection the entry's rows came from. */
  connectionId: string;
  /** Number of cached rows. */
  rowCount: number;
  /** Age of the entry (ms since it was written). */
  ageMs: number;
  /** The entry's TTL (ms). */
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
 * Scope tags carried on every `set()`. They let the cache purge exactly the
 * entries a governance event affects, instead of nuking the whole region's
 * cache (a workspace deletion or region migration must not evict a co-tenant's
 * warm entries).
 *
 * - `orgId` — the owning Workspace. Drives {@link CacheBackend.flushByOrg}. May
 *   be `undefined` in auth mode "none" (no tenant), in which case the entry is
 *   simply not reachable by `flushByOrg` — there is no org to target.
 * - `connectionId` — the Datasource connection the entry's rows came from.
 *   Always present. Retained on the tag so a future per-connection invalidation
 *   can filter an org's entries by connection, and so external backends (Redis,
 *   Memcached) can tag entries by connection. No in-process reader filters by it
 *   yet — the LRU indexes by `orgId` only.
 */
export interface CacheScope {
  orgId?: string;
  connectionId: string;
}

/**
 * Abstract cache backend. The default in-memory LRU implements this.
 * Plugins can provide external backends (Redis, Memcached) via this interface.
 *
 * Every method is `Promise`-returning so an out-of-process backend (Redis,
 * Memcached) is actually implementable against this contract. The in-process
 * LRU satisfies it trivially (its bodies are synchronous, wrapped in `async`).
 * Awaiting at the call sites is what kills the phantom-hit failure mode — a raw
 * Promise is truthy, so a sync-shaped `get()` returning an unawaited Promise
 * would read as a cache HIT for every query and serve `undefined` rows.
 */
export interface CacheBackend {
  get(key: string): Promise<CacheEntry | null>;
  /** Store an entry under `key`, tagged with `scope` for scoped invalidation. */
  set(key: string, entry: CacheEntry, scope: CacheScope): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Flush all entries (fleet-wide — every Workspace's entries in this process). */
  flush(): Promise<void>;
  /**
   * Purge exactly the entries owned by `orgId`. Returns the number removed.
   * Used by org deletion + residency migration so one Workspace's teardown
   * never evicts another's warm entries.
   */
  flushByOrg(orgId: string): Promise<number>;
  /**
   * Return live counters. Must be cheap + idempotent: it is invoked on
   * every admin stats poll and — for a plugin-supplied backend — as the
   * shape probe during registration validation. It MAY lazily drop
   * already-expired entries (the LRU does, so `entryCount` never counts
   * corpses; pruning during the validation probe is harmless — it only
   * removes entries that are already dead) but must have no other side
   * effect.
   */
  stats(): Promise<CacheStats>;
}
