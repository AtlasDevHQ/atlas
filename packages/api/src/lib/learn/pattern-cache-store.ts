/**
 * In-memory store for approved learned patterns: a TTL-expiring, LRU-evicting
 * cache keyed by (org, connection group), plus its invalidation (#3721).
 *
 * Split out of pattern-cache.ts so the eviction/TTL policy is isolated from the
 * ranking math (`pattern-ranking.ts`) and the retrieval composition
 * (`pattern-cache.ts`): changing the cache policy touches no ranking code, and
 * the pure ranking helpers don't drag this module's db/logger imports into their
 * tests.
 */

import { getApprovedPatterns, type ApprovedPatternRow } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("pattern-cache-store");

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

interface CacheEntry {
  patterns: ApprovedPatternRow[];
  expiresAt: number;
  lastAccessedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Org segment of a cache key — `"__global__"` for null orgId, prefixed to
 *  avoid collision. */
function orgKeyPart(orgId: string | null): string {
  return orgId === null ? "__global__" : `org:${orgId}`;
}

/** Canonical cache key — scoped by org AND connection group (#3611) so a
 *  `us-prod` agent session never serves a `eu-prod` group's cached patterns.
 *  `"__nogroup__"` represents the default (flat `entities/`) scope. */
function cacheKey(orgId: string | null, connectionGroupId: string | null): string {
  const groupPart = connectionGroupId === null ? "__nogroup__" : `group:${connectionGroupId}`;
  return `${orgKeyPart(orgId)}::${groupPart}`;
}

/** Get approved patterns for an org + connection group, hitting cache first.
 *  DB failures are logged and return [] without being cached. */
export async function getCachedPatterns(
  orgId: string | null,
  connectionGroupId: string | null,
): Promise<ApprovedPatternRow[]> {
  const key = cacheKey(orgId, connectionGroupId);
  const entry = cache.get(key);

  if (entry && Date.now() < entry.expiresAt) {
    entry.lastAccessedAt = Date.now();
    return entry.patterns;
  }

  try {
    const patterns = await getApprovedPatterns(orgId, connectionGroupId);

    // Evict oldest entry if cache is at capacity
    if (cache.size >= MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of cache) {
        if (v.lastAccessedAt < oldestTime) {
          oldestTime = v.lastAccessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) cache.delete(oldestKey);
    }

    const now = Date.now();
    cache.set(key, { patterns, expiresAt: now + DEFAULT_TTL_MS, lastAccessedAt: now });
    return patterns;
  } catch (err) {
    log.warn(
      { orgId, connectionGroupId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load approved patterns (table may not exist yet) — not caching",
    );
    return [];
  }
}

/**
 * Invalidate the pattern cache for a specific org, across ALL of its connection
 * groups. The admin approve/reject path (`admin-learned-patterns.ts`) operates
 * at org granularity and doesn't know which group a reviewed pattern belongs
 * to, so a single call must clear every group-scoped entry for the org (#3611).
 */
export function invalidatePatternCache(orgId: string | null): void {
  const prefix = `${orgKeyPart(orgId)}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Reset entire cache. For testing only. */
export function _resetPatternCache(): void {
  cache.clear();
}
