/**
 * Config-resolution seam for the Query Cache singleton (#4545, closes audit
 * M10's zero-coverage finding).
 *
 * Covers the three registry knobs as read by `lib/cache/index.ts`:
 *   - which tier each resolver reads (workspace override honored for the
 *     workspace-scoped enabled/ttl keys; orgId ignored for the
 *     platform-scoped maxSize key)
 *   - default + parse fallbacks (missing / non-numeric / non-positive)
 *   - backend RESIZE: a maxSize/ttl settings change is reconciled onto the
 *     running LRU in place by `getCache()` — hit/miss counters AND existing
 *     entries survive (no fresh cold backend)
 *   - a plugin-provided backend is never reconciled
 *
 * The tier CHAIN itself (workspace > platform > env > default) lives in and is
 * tested by `lib/settings.ts`; here `getSetting`/`getSettingAuto` are mocked
 * so we can drive each resolver's tier-and-fallback behavior deterministically.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { CacheBackend, CacheEntry, CacheScope } from "../types";

// Controllable settings store: `key` for the platform tier, `key::orgId` for
// a workspace override. Mirrors getSetting's precedence (workspace first for
// a workspace-scoped read, then platform).
const settingsStore = new Map<string, string>();
function storeKey(key: string, orgId?: string): string {
  return orgId ? `${key}::${orgId}` : key;
}
function resolveMock(key: string, orgId?: string): string | undefined {
  if (orgId && settingsStore.has(storeKey(key, orgId))) return settingsStore.get(storeKey(key, orgId));
  return settingsStore.get(key);
}

// Intentional partial mock: `lib/cache/index.ts` is the only module in this
// test's isolated-runner graph that imports from `@atlas/api/lib/settings`,
// and it imports ONLY `getSetting` + `getSettingAuto`. Stubbing just those two
// is safe here (nothing else resolves a missing export); if this file ever
// imports a module that reads another settings export, the isolated runner
// fails loudly at import ("Export named X not found"), never silently.
void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string, orgId?: string) => resolveMock(key, orgId),
  getSettingAuto: (key: string, orgId?: string) => resolveMock(key, orgId),
}));

const {
  getCache, cacheEnabled, getDefaultTtl, setCacheBackend, flushCache, _resetCache,
  cacheOrgEntryCount, recordCacheAccess, getOrgCacheStats,
  cacheListByOrg, cacheDeleteEntry,
} = await import("../index");
const { LRUCacheBackend } = await import("../lru");

function makeEntry(overrides?: Partial<CacheEntry>): CacheEntry {
  return { columns: ["id"], rows: [{ id: 1 }], cachedAt: Date.now(), ttl: 300_000, ...overrides };
}

// The #4548 async contract requires a scope on every set(); connectionId is
// always present, orgId optional. These tests exercise the backend lifecycle,
// not scoped invalidation, so a fixed connection scope suffices.
const SCOPE: CacheScope = { connectionId: "conn-1" };

beforeEach(() => {
  settingsStore.clear();
  _resetCache();
});

describe("cacheEnabled — ATLAS_CACHE_ENABLED (workspace-scoped)", () => {
  it("defaults to enabled when nothing is set", () => {
    expect(cacheEnabled()).toBe(true);
    expect(cacheEnabled("org-1")).toBe(true);
  });

  it("only an explicit false/0 disables", () => {
    settingsStore.set("ATLAS_CACHE_ENABLED", "false");
    expect(cacheEnabled()).toBe(false);
    settingsStore.set("ATLAS_CACHE_ENABLED", "0");
    expect(cacheEnabled()).toBe(false);
    settingsStore.set("ATLAS_CACHE_ENABLED", "true");
    expect(cacheEnabled()).toBe(true);
  });

  it("honors a per-workspace override over the platform value", () => {
    settingsStore.set("ATLAS_CACHE_ENABLED", "true"); // platform enabled
    settingsStore.set(storeKey("ATLAS_CACHE_ENABLED", "org-1"), "false"); // workspace disabled
    expect(cacheEnabled("org-1")).toBe(false);
    expect(cacheEnabled("org-2")).toBe(true); // other workspace unaffected
    expect(cacheEnabled()).toBe(true); // platform tier
  });
});

describe("getDefaultTtl — ATLAS_CACHE_TTL (workspace-scoped)", () => {
  it("defaults to 300000ms (5 min) when unset or invalid", () => {
    expect(getDefaultTtl()).toBe(300_000);
    settingsStore.set("ATLAS_CACHE_TTL", "not-a-number");
    expect(getDefaultTtl()).toBe(300_000);
    settingsStore.set("ATLAS_CACHE_TTL", "0");
    expect(getDefaultTtl()).toBe(300_000);
    settingsStore.set("ATLAS_CACHE_TTL", "-5");
    expect(getDefaultTtl()).toBe(300_000);
  });

  it("reads a valid platform value and a workspace override", () => {
    settingsStore.set("ATLAS_CACHE_TTL", "60000");
    expect(getDefaultTtl()).toBe(60_000);
    settingsStore.set(storeKey("ATLAS_CACHE_TTL", "org-1"), "10000");
    expect(getDefaultTtl("org-1")).toBe(10_000);
    expect(getDefaultTtl("org-2")).toBe(60_000);
  });
});

describe("getCache — ATLAS_CACHE_MAX_SIZE (platform-scoped) + backend lifecycle", () => {
  it("builds an LRU sized from the platform maxSize/ttl settings", async () => {
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "42");
    settingsStore.set("ATLAS_CACHE_TTL", "60000");
    const stats = await getCache().stats();
    expect(stats.maxSize).toBe(42);
    expect(stats.ttl).toBe(60_000);
  });

  it("falls back to default maxSize (1000) on missing/invalid values", async () => {
    expect((await getCache().stats()).maxSize).toBe(1000);
    _resetCache();
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "-3");
    expect((await getCache().stats()).maxSize).toBe(1000);
  });

  it("resizes the running backend in place on a maxSize change, carrying counters and entries", async () => {
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "5");
    const backend = getCache();
    // Generate counter activity: 1 miss then a hit.
    expect(await backend.get("k1")).toBeNull(); // miss
    await backend.set("k1", makeEntry(), SCOPE);
    expect(await backend.get("k1")).not.toBeNull(); // hit
    // Fill past the new cap to prove eviction after shrink.
    await backend.set("k2", makeEntry(), SCOPE);
    await backend.set("k3", makeEntry(), SCOPE);
    const before = await backend.stats();
    expect(before.hits).toBe(1);
    expect(before.misses).toBe(1);

    // Shrink maxSize; the SAME backend instance is reconciled in place.
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "2");
    const after = getCache();
    expect(after).toBe(backend); // not a fresh object — resized in place
    const afterStats = await after.stats();
    expect(afterStats.maxSize).toBe(2);
    expect(afterStats.entryCount).toBe(2); // evicted down to the new cap, entries kept
    // Counters carried across the in-place resize.
    expect(afterStats.hits).toBe(1);
    expect(afterStats.misses).toBe(1);
  });

  it("reflects a ttl change on the running backend's reported ttl", async () => {
    settingsStore.set("ATLAS_CACHE_TTL", "60000");
    const backend = getCache();
    expect((await backend.stats()).ttl).toBe(60_000);
    settingsStore.set("ATLAS_CACHE_TTL", "120000");
    expect((await getCache().stats()).ttl).toBe(120_000);
  });

  it("ignores orgId for the platform-scoped maxSize (a workspace override does not apply)", async () => {
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "10");
    settingsStore.set(storeKey("ATLAS_CACHE_MAX_SIZE", "org-1"), "999");
    // getCache() resolves maxSize with no orgId, so the workspace row is inert.
    expect((await getCache().stats()).maxSize).toBe(10);
  });

  it("never reconciles a plugin-provided backend", async () => {
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "5");
    getCache(); // build the built-in LRU first
    let flushed = false;
    const plugin: CacheBackend = {
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      flush: async () => { flushed = true; },
      flushByOrg: async () => 0,
      stats: async () => ({ hits: 7, misses: 3, entryCount: 0, maxSize: 999, ttl: 111 }),
    };
    await setCacheBackend(plugin);
    // Even after a maxSize change, the plugin backend is returned untouched.
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "1");
    const returned = getCache();
    expect(returned).toBe(plugin);
    expect((await returned.stats()).maxSize).toBe(999); // not resized
    // getCache() must not flush a plugin backend during reconcile.
    expect(flushed).toBe(false);
  });
});

describe("setCacheBackend / flushCache", () => {
  it("flushes the old backend when a plugin replaces it", async () => {
    const old = getCache();
    await old.set("k", makeEntry(), SCOPE);
    expect((await old.stats()).entryCount).toBe(1);
    const plugin = new LRUCacheBackend(3, 1000);
    await setCacheBackend(plugin);
    expect((await old.stats()).entryCount).toBe(0); // old flushed
    expect(getCache()).toBe(plugin);
  });

  it("flushCache clears entries but keeps counters", async () => {
    const backend = getCache();
    await backend.get("miss"); // 1 miss
    await backend.set("k", makeEntry(), SCOPE);
    await backend.get("k"); // 1 hit
    expect((await backend.stats()).entryCount).toBe(1);
    await flushCache();
    const s = await backend.stats();
    expect(s.entryCount).toBe(0);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cacheOrgEntryCount + stats-registry independence (#4549)
// ---------------------------------------------------------------------------

describe("cacheOrgEntryCount", () => {
  it("returns 0 before any backend exists", async () => {
    expect(await cacheOrgEntryCount("org-1")).toBe(0);
  });

  it("counts the owned LRU's live entries for the org", async () => {
    const backend = getCache();
    await backend.set("k1", makeEntry(), { orgId: "org-1", connectionId: "conn-1" });
    await backend.set("k2", makeEntry(), { orgId: "org-1", connectionId: "conn-1" });
    await backend.set("k3", makeEntry(), { orgId: "org-2", connectionId: "conn-1" });
    expect(await cacheOrgEntryCount("org-1")).toBe(2);
    expect(await cacheOrgEntryCount("org-2")).toBe(1);
  });

  it("returns null for a plugin backend (count structurally unavailable, not 0)", async () => {
    const plugin: CacheBackend = {
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      flush: async () => {},
      flushByOrg: async () => 0,
      stats: async () => ({ hits: 0, misses: 0, entryCount: 5, maxSize: 10, ttl: 1000 }),
    };
    await setCacheBackend(plugin);
    expect(await cacheOrgEntryCount("org-1")).toBeNull();
  });
});

describe("cacheListByOrg / cacheDeleteEntry (#4550)", () => {
  function pluginBackend(): CacheBackend & { deleteCalls: number } {
    const b = {
      deleteCalls: 0,
      get: async () => null,
      set: async () => {},
      delete: async () => {
        b.deleteCalls++;
        return true;
      },
      flush: async () => {},
      flushByOrg: async () => 0,
      stats: async () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 0, ttl: 0 }),
    };
    return b;
  }

  it("uninitialized cache: lists as empty, deletes as not-found — never unavailable", async () => {
    expect(await cacheListByOrg("org-1")).toEqual([]);
    expect(await cacheDeleteEntry("org-1", "k")).toBe(false);
  });

  it("owned LRU: org-scoped listing, undefined orgId lists everything", async () => {
    const backend = getCache();
    await backend.set("k1", makeEntry({ sqlPreview: "SELECT 1" }), { orgId: "org-1", connectionId: "conn-1" });
    await backend.set("k2", makeEntry(), { orgId: "org-2", connectionId: "conn-1" });
    await backend.set("k3", makeEntry(), { connectionId: "conn-1" }); // no-org entry

    const org1 = await cacheListByOrg("org-1");
    expect(org1!.map((m) => m.key)).toEqual(["k1"]);
    expect(org1![0]!.sqlPreview).toBe("SELECT 1");

    const all = await cacheListByOrg(undefined);
    expect(all!.map((m) => m.key).toSorted()).toEqual(["k1", "k2", "k3"]);
  });

  it("owned LRU: delete is org-authorized; undefined orgId is a plain delete", async () => {
    const backend = getCache();
    await backend.set("k1", makeEntry(), { orgId: "org-1", connectionId: "conn-1" });
    await backend.set("k2", makeEntry(), { orgId: "org-2", connectionId: "conn-1" });

    // Co-tenant key refused, entry survives.
    expect(await cacheDeleteEntry("org-1", "k2")).toBe(false);
    expect(await backend.get("k2")).not.toBeNull();
    // Own key removed.
    expect(await cacheDeleteEntry("org-1", "k1")).toBe(true);
    expect(await backend.get("k1")).toBeNull();
    // Whole-cache-reach delete (single-tenant / platform).
    expect(await cacheDeleteEntry(undefined, "k2")).toBe(true);
  });

  it("plugin backend: both degrade to null and the plugin's delete is NEVER called", async () => {
    const plugin = pluginBackend();
    await setCacheBackend(plugin);
    expect(await cacheListByOrg("org-1")).toBeNull();
    expect(await cacheDeleteEntry("org-1", "k")).toBeNull();
    expect(await cacheDeleteEntry(undefined, "k")).toBeNull();
    // The null degrade is what keeps org authorization trustworthy: an
    // external store's own scoping is never trusted with the delete.
    expect(plugin.deleteCalls).toBe(0);
  });
});

describe("stats registry survives backend recreation", () => {
  it("counters are untouched by resize and plugin swap; only _resetCache clears them", async () => {
    recordCacheAccess("org-1", true);
    recordCacheAccess("org-1", false);
    expect(getOrgCacheStats("org-1").hits).toBe(1);

    // In-place resize (settings change) — registry untouched.
    settingsStore.set("ATLAS_CACHE_MAX_SIZE", "7");
    getCache();
    expect(getOrgCacheStats("org-1").hits).toBe(1);

    // Plugin backend swap (old backend flushed) — registry untouched: it
    // lives ABOVE the cache module's `_state`, which is the whole point.
    await setCacheBackend(new LRUCacheBackend(3, 1000));
    expect(getOrgCacheStats("org-1").hits).toBe(1);
    expect(getOrgCacheStats("org-1").misses).toBe(1);

    // Test isolation is the one reset path.
    _resetCache();
    expect(getOrgCacheStats("org-1").since).toBeNull();
  });
});
