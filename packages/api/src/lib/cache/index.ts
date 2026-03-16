/**
 * Query result cache singleton.
 *
 * Initializes from config on first access. Default: in-memory LRU.
 * Plugins can replace the backend via setCacheBackend().
 */

import { createLogger } from "@atlas/api/lib/logger";
import { LRUCacheBackend } from "./lru";
import type { CacheBackend, CacheEntry } from "./types";

export type { CacheBackend, CacheEntry, CacheStats } from "./types";
export { buildCacheKey } from "./keys";

const log = createLogger("cache");

/** Default TTL in milliseconds. Configurable via ATLAS_CACHE_TTL. */
function getCacheTtl(): number {
  const raw = parseInt(process.env.ATLAS_CACHE_TTL ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000; // 5 min
}

/** Default max cache entries. Configurable via ATLAS_CACHE_MAX_SIZE. */
function getCacheMaxSize(): number {
  const raw = parseInt(process.env.ATLAS_CACHE_MAX_SIZE ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

/** Whether caching is enabled. Configurable via ATLAS_CACHE_ENABLED. */
function isCacheEnabled(): boolean {
  const raw = process.env.ATLAS_CACHE_ENABLED;
  if (raw === "false" || raw === "0") return false;
  return true; // enabled by default
}

let _backend: CacheBackend | null = null;
let _enabled: boolean | null = null;

/** Get or create the cache backend singleton. */
export function getCache(): CacheBackend {
  if (!_backend) {
    const ttl = getCacheTtl();
    const maxSize = getCacheMaxSize();
    _backend = new LRUCacheBackend(maxSize, ttl);
    log.info({ maxSize, ttl }, "Query cache initialized (in-memory LRU)");
  }
  return _backend;
}

/** Check if caching is enabled. */
export function cacheEnabled(): boolean {
  if (_enabled === null) {
    _enabled = isCacheEnabled();
  }
  return _enabled;
}

/** Replace the cache backend (used by plugins providing Redis, etc). */
export function setCacheBackend(backend: CacheBackend): void {
  const old = _backend;
  _backend = backend;
  log.info("Cache backend replaced by plugin");
  if (old) {
    old.flush();
  }
}

/** Flush the entire cache. Used on semantic layer changes and config reload. */
export function flushCache(prefix?: string): void {
  if (_backend) {
    _backend.flush(prefix);
    log.info({ prefix: prefix ?? "(all)" }, "Cache flushed");
  }
}

/** Get the default TTL for new cache entries. */
export function getDefaultTtl(): number {
  return getCacheTtl();
}

/** Reset the cache singleton. For testing only. */
export function _resetCache(): void {
  _backend = null;
  _enabled = null;
}
