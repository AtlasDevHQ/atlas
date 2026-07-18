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

export type { CacheBackend, CacheEntry, CacheScope, CacheStats } from "./types";
export { buildCacheKey } from "./keys";
export { validateCacheBackend, type CacheBackendValidation } from "./validate";

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

/**
 * Replace the cache backend (used by plugins providing Redis, etc). The caller
 * is responsible for validating the backend's shape first (see
 * {@link validateCacheBackend}) — a shape-invalid backend must never reach here.
 */
export async function setCacheBackend(backend: CacheBackend): Promise<void> {
  const old = _backend;
  _backend = backend;
  log.info("Cache backend replaced by plugin");
  if (old) {
    try {
      await old.flush();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to flush old cache backend during replacement");
    }
  }
}

/**
 * Flush the ENTIRE cache — every Workspace's entries in this process. Called on
 * config reload and via the admin API. For a single Workspace's teardown use
 * {@link flushCacheByOrg} so co-tenants keep their warm entries.
 */
export async function flushCache(): Promise<void> {
  if (_backend) {
    await _backend.flush();
    log.info("Cache flushed");
  }
}

/**
 * Purge exactly one Workspace's cached entries (org deletion, residency
 * migration). Returns the number removed (0 when the cache is uninitialized).
 * Unlike {@link flushCache}, a co-tenant's warm entries survive.
 */
export async function flushCacheByOrg(orgId: string): Promise<number> {
  if (!_backend) return 0;
  const removed = await _backend.flushByOrg(orgId);
  log.info({ orgId, removed }, "Cache purged for org");
  return removed;
}

/** Get the default TTL for new cache entries. */
export function getDefaultTtl(): number {
  return getCacheTtl();
}

/** Reset the cache module to its uninitialized state. For test isolation only. */
export function _resetCache(): void {
  _backend = null;
}
