/**
 * Query result cache singleton.
 *
 * Reads settings from resolved config (atlas.config.ts) with env var
 * fallbacks. Default: in-memory LRU.
 * Plugins can replace the backend via setCacheBackend().
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";
import { LRUCacheBackend } from "./lru";
import type { CacheBackend } from "./types";

export type { CacheBackend, CacheEntry, CacheStats } from "./types";
export { buildCacheKey } from "./keys";

const log = createLogger("cache");

/** Resolve cache TTL from config file, then env var, then default (5 min). */
function getCacheTtl(): number {
  const config = getConfig();
  if (config?.cache?.ttl) return config.cache.ttl;
  const raw = parseInt(process.env.ATLAS_CACHE_TTL ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/** Resolve cache max size from config file, then env var, then default (1000). */
function getCacheMaxSize(): number {
  const config = getConfig();
  if (config?.cache?.maxSize) return config.cache.maxSize;
  const raw = parseInt(process.env.ATLAS_CACHE_MAX_SIZE ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

/** Check if caching is enabled via config file, then env var. Enabled by default. */
function isCacheEnabled(): boolean {
  const config = getConfig();
  if (config?.cache) return config.cache.enabled;
  const raw = process.env.ATLAS_CACHE_ENABLED;
  if (raw === "false" || raw === "0") return false;
  return true;
}

let _backend: CacheBackend | null = null;

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

/** Check if caching is enabled. Re-reads config on each call for dynamic toggling. */
export function cacheEnabled(): boolean {
  return isCacheEnabled();
}

/** Replace the cache backend (used by plugins providing Redis, etc). */
export function setCacheBackend(backend: CacheBackend): void {
  const old = _backend;
  _backend = backend;
  log.info("Cache backend replaced by plugin");
  if (old) {
    try {
      old.flush();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to flush old cache backend during replacement");
    }
  }
}

/** Flush the entire cache. Called on config reload and available via admin API. */
export function flushCache(): void {
  if (_backend) {
    _backend.flush();
    log.info("Cache flushed");
  }
}

/** Get the default TTL for new cache entries. */
export function getDefaultTtl(): number {
  return getCacheTtl();
}

/** Reset the cache module to its uninitialized state. For test isolation only. */
export function _resetCache(): void {
  _backend = null;
}
