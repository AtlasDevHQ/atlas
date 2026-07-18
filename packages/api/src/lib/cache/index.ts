/**
 * Query result cache singleton.
 *
 * All three knobs live in the settings registry (`lib/settings.ts`), so an
 * operator or workspace admin tunes them at runtime with no redeploy:
 *   - ATLAS_CACHE_ENABLED (workspace-scoped): workspace > platform > env > default
 *   - ATLAS_CACHE_TTL     (workspace-scoped): workspace > platform > env > default
 *   - ATLAS_CACHE_MAX_SIZE (platform-scoped): platform > env > default
 *
 * A `maxSize`/`ttl` change is reconciled onto the running backend by
 * `getCache()` (via `LRUCacheBackend.resize`) with hit/miss counters carried
 * across — nothing is frozen at construction. Default backend: in-memory LRU.
 * Plugins can replace the backend via `setCacheBackend()`; a plugin backend
 * manages its own sizing and is never reconciled.
 *
 * The config-file `cache:` block is gone (#4551 phase 2 — a leftover block
 * fails config validation in `lib/config.ts`) — knobs come from the
 * registry only.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSetting, getSettingAuto } from "@atlas/api/lib/settings";
import { LRUCacheBackend } from "./lru";
import type { CacheBackend, CacheEntryMeta } from "./types";

export type { CacheBackend, CacheEntry, CacheEntryMeta, CacheScope, CacheStats } from "./types";
export { buildCacheKey } from "./keys";
export { validateCacheBackend, type CacheBackendValidation } from "./validate";
export {
  recordCacheAccess,
  getOrgCacheStats,
  getFleetCacheStats,
  resetCacheStatsRegistry,
  type OrgCacheStats,
} from "./stats-registry";

import { resetCacheStatsRegistry } from "./stats-registry";

const log = createLogger("cache");

const DEFAULT_TTL_MS = 300_000; // 5 minutes
const DEFAULT_MAX_SIZE = 1000;

/**
 * Parse a positive-integer setting, warning ONCE per distinct bad value when
 * a value is present but invalid (mirrors `getRowLimit`/`getQueryTimeout` in
 * `tools/sql.ts`). A present-but-invalid value must not silently fall back to
 * the default with no signal — that is the "my admin write did nothing and I
 * can't tell why" trap. An unset value falls back silently (the expected
 * default path). The throttle map keys on the setting name so a spammy hot
 * path doesn't log every request.
 */
const _lastWarnedBadValue = new Map<string, string>();
function parsePositiveIntSetting(key: string, raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(n) && n > 0) return n;
  const present = raw !== undefined && raw.trim() !== "";
  if (present && _lastWarnedBadValue.get(key) !== raw) {
    _lastWarnedBadValue.set(key, raw);
    log.warn({ key, value: raw }, `Invalid ${key} value; using default ${fallback}`);
  }
  return fallback;
}

/**
 * Resolve cache TTL (ms) for a workspace from the settings registry
 * (workspace override > platform override > env > default). Resolved per
 * call — not frozen — so admin overrides take effect without a restart, and
 * `orgId` threads the workspace tier.
 */
function getCacheTtl(orgId?: string): number {
  return parsePositiveIntSetting("ATLAS_CACHE_TTL", getSetting("ATLAS_CACHE_TTL", orgId), DEFAULT_TTL_MS);
}

/**
 * Resolve the platform-scoped max entry count from the settings registry
 * (platform override > env > default). Reads via `getSettingAuto` — the
 * hot-path marker entry point — since a maxSize change drives a process-wide
 * backend reconcile. Note `getSettingAuto` currently delegates to `getSetting`
 * (same in-process cache); the freshness comes from that cache being warmed by
 * writes + demand-driven live reads, not from a stronger read guarantee here.
 */
function getCacheMaxSize(): number {
  return parsePositiveIntSetting("ATLAS_CACHE_MAX_SIZE", getSettingAuto("ATLAS_CACHE_MAX_SIZE"), DEFAULT_MAX_SIZE);
}

/**
 * Check if caching is enabled for a workspace (workspace > platform > env >
 * default). Enabled by default; only an explicit `false`/`0` disables.
 */
function isCacheEnabled(orgId?: string): boolean {
  const raw = getSetting("ATLAS_CACHE_ENABLED", orgId);
  return raw !== "false" && raw !== "0";
}

/**
 * Cache backend state as a discriminated union so illegal states are
 * unrepresentable and `getCache()` needs no runtime `instanceof`:
 *   - `unset`  — nothing constructed yet.
 *   - `owned`  — the built-in LRU we constructed; carries the `maxSize`/`ttl`
 *     it is configured with so `getCache()` can decide whether to reconcile
 *     WITHOUT calling a backend method (keeps `getCache()` synchronous even if
 *     a future plugin backend's methods are async). Only this variant is
 *     resizable — the size/ttl mirror can't go stale because it lives on it.
 *   - `plugin` — a plugin-provided backend that manages its own sizing and is
 *     never reconciled.
 */
type CacheState =
  | { kind: "unset" }
  | { kind: "owned"; backend: LRUCacheBackend; maxSize: number; ttl: number }
  | { kind: "plugin"; backend: CacheBackend };

let _state: CacheState = { kind: "unset" };

/**
 * Get the cache backend singleton, reconciling the built-in LRU to the
 * current resolved platform max size / TTL so a settings change takes effect
 * on the running backend. Hit/miss counters (and existing entries) survive
 * the in-place resize.
 */
export function getCache(): CacheBackend {
  const maxSize = getCacheMaxSize();
  // Platform-tier TTL (no orgId) drives the backend's reported default;
  // per-entry TTL is stamped at write time from the writer's workspace tier.
  const ttl = getCacheTtl();
  if (_state.kind === "unset") {
    const backend = new LRUCacheBackend(maxSize, ttl);
    _state = { kind: "owned", backend, maxSize, ttl };
    log.info({ maxSize, ttl }, "Query cache initialized (in-memory LRU)");
    return backend;
  }
  if (_state.kind === "owned" && (maxSize !== _state.maxSize || ttl !== _state.ttl)) {
    _state.backend.resize(maxSize, ttl);
    _state = { kind: "owned", backend: _state.backend, maxSize, ttl };
    log.info({ maxSize, ttl }, "Query cache backend resized to new settings (counters carried)");
  }
  return _state.backend;
}

/**
 * Check if caching is enabled. Re-reads settings on each call so a toggle
 * takes effect at runtime; pass `orgId` to honor a per-workspace override.
 */
export function cacheEnabled(orgId?: string): boolean {
  return isCacheEnabled(orgId);
}

/**
 * Replace the cache backend (used by plugins providing Redis, etc). The caller
 * is responsible for validating the backend's shape first (see
 * {@link validateCacheBackend}) — a shape-invalid backend must never reach here.
 */
export async function setCacheBackend(backend: CacheBackend): Promise<void> {
  const old = _state.kind === "unset" ? null : _state.backend;
  _state = { kind: "plugin", backend };
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
  if (_state.kind !== "unset") {
    await _state.backend.flush();
    log.info("Cache flushed");
  }
}

/**
 * Purge exactly one Workspace's cached entries (org deletion, residency
 * migration). Returns the number removed (0 when the cache is uninitialized).
 * Unlike {@link flushCache}, a co-tenant's warm entries survive.
 */
export async function flushCacheByOrg(orgId: string): Promise<number> {
  if (_state.kind === "unset") return 0;
  const removed = await _state.backend.flushByOrg(orgId);
  log.info({ orgId, removed }, "Cache purged for org");
  return removed;
}

/**
 * Get the default TTL (ms) for new cache entries. Pass `orgId` so a
 * per-workspace TTL override is stamped onto entries that workspace writes.
 */
export function getDefaultTtl(orgId?: string): number {
  return getCacheTtl(orgId);
}

/**
 * Count one Workspace's LIVE cached entries (expired entries are lazily
 * dropped, never counted). Returns `null` when the count is structurally
 * unavailable — a plugin backend manages its own store and the `CacheBackend`
 * contract has no per-org count — so callers can distinguish "0 entries"
 * from "can't know" instead of rendering a confident zero.
 */
export async function cacheOrgEntryCount(orgId: string): Promise<number | null> {
  if (_state.kind === "unset") return 0;
  if (_state.kind === "plugin") return null;
  return _state.backend.entryCountByOrg(orgId);
}

/**
 * List one Workspace's LIVE cached entries as metadata rows (#4550), or every
 * live entry when `orgId` is undefined — the same undefined-org ⇒
 * whole-cache-reach dispatch as the #4549 flush route; CALLERS are
 * responsible for only passing `undefined` for a principal with legitimate
 * whole-cache reach (single-tenant deployment or platform admin — the route
 * fails a managed org-less session closed before reaching here). Returns
 * `null` when the listing is structurally unavailable: the LRU's org index
 * is what makes a TRUSTWORTHY org-scoped listing possible, so a plugin
 * backend degrades to "unavailable" rather than trusting an external
 * store's scoping. An uninitialized cache lists as empty, not unavailable.
 */
export async function cacheListByOrg(orgId: string | undefined): Promise<CacheEntryMeta[] | null> {
  if (_state.kind === "unset") return [];
  if (_state.kind === "plugin") return null;
  return orgId !== undefined ? _state.backend.listByOrg(orgId) : _state.backend.listAll();
}

/**
 * Delete one cached entry, authorized org-scoped (#4550): with an `orgId`,
 * the delete lands only when the key belongs to that org (a workspace admin
 * deleting by raw key can never reach a co-tenant's entry); with no org it
 * is a plain delete — same caller contract as {@link cacheListByOrg}: pass
 * `undefined` only for a principal with whole-cache reach. Returns whether
 * an entry was removed; `null` when structurally unavailable (plugin
 * backend — no trustworthy org index to authorize against). An
 * uninitialized cache deletes as not-found (`false`), not as unavailable.
 */
export async function cacheDeleteEntry(orgId: string | undefined, key: string): Promise<boolean | null> {
  if (_state.kind === "unset") return false;
  if (_state.kind === "plugin") return null;
  const removed = orgId !== undefined
    ? await _state.backend.deleteForOrg(orgId, key)
    : await _state.backend.delete(key);
  if (removed) log.info({ orgId, key: key.slice(0, 12) }, "Cache entry deleted");
  return removed;
}

/** Reset the cache module to its uninitialized state. For test isolation only. */
export function _resetCache(): void {
  _state = { kind: "unset" };
  _lastWarnedBadValue.clear();
  resetCacheStatsRegistry();
}
