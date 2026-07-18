/**
 * Tests for query result caching: LRU backend, cache keys, scope side index,
 * and backend shape validation.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { LRUCacheBackend } from "../lru";
import { buildCacheKey } from "../keys";
import { validateCacheBackend } from "../validate";
import type { CacheEntry, CacheScope } from "../types";

function makeEntry(overrides?: Partial<CacheEntry>): CacheEntry {
  return {
    columns: ["id", "name"],
    rows: [{ id: 1, name: "test" }],
    cachedAt: Date.now(),
    ttl: 300_000,
    ...overrides,
  };
}

/** Default scope for tests that don't care about org tagging. */
const SCOPE: CacheScope = { connectionId: "default" };
/** Build a scope with a specific org (and optional connection). */
function scope(orgId?: string, connectionId = "default"): CacheScope {
  return { orgId, connectionId };
}

describe("LRUCacheBackend", () => {
  let cache: LRUCacheBackend;

  beforeEach(() => {
    cache = new LRUCacheBackend(5, 300_000);
  });

  it("returns null on cache miss", async () => {
    expect(await cache.get("nonexistent")).toBeNull();
  });

  it("stores and retrieves an entry", async () => {
    const entry = makeEntry();
    await cache.set("key1", entry, SCOPE);
    const result = await cache.get("key1");
    expect(result).not.toBeNull();
    expect(result!.columns).toEqual(["id", "name"]);
    expect(result!.rows).toEqual([{ id: 1, name: "test" }]);
  });

  it("evicts expired entries on read", async () => {
    const entry = makeEntry({ cachedAt: Date.now() - 400_000, ttl: 300_000 });
    await cache.set("expired", entry, SCOPE);
    expect(await cache.get("expired")).toBeNull();
  });

  it("evicts oldest entry when at max size", async () => {
    for (let i = 0; i < 5; i++) {
      await cache.set(`key${i}`, makeEntry(), SCOPE);
    }
    expect((await cache.stats()).entryCount).toBe(5);

    // Adding a 6th should evict the oldest (key0)
    await cache.set("key5", makeEntry(), SCOPE);
    expect((await cache.stats()).entryCount).toBe(5);
    expect(await cache.get("key0")).toBeNull(); // evicted
    expect(await cache.get("key5")).not.toBeNull(); // present
  });

  it("LRU ordering: accessed items are not evicted", async () => {
    for (let i = 0; i < 5; i++) {
      await cache.set(`key${i}`, makeEntry(), SCOPE);
    }
    // Access key0 to move it to end
    await cache.get("key0");

    // Insert key5 — should evict key1 (oldest unused), not key0
    await cache.set("key5", makeEntry(), SCOPE);
    expect(await cache.get("key0")).not.toBeNull();
    expect(await cache.get("key1")).toBeNull(); // evicted
  });

  it("delete removes an entry", async () => {
    await cache.set("key1", makeEntry(), SCOPE);
    expect(await cache.delete("key1")).toBe(true);
    expect(await cache.get("key1")).toBeNull();
    expect(await cache.delete("key1")).toBe(false); // already gone
  });

  it("flush clears all entries", async () => {
    await cache.set("a", makeEntry(), SCOPE);
    await cache.set("b", makeEntry(), SCOPE);
    await cache.flush();
    expect((await cache.stats()).entryCount).toBe(0);
    expect(await cache.get("a")).toBeNull();
  });

  it("stats tracks hits and misses", async () => {
    await cache.set("key1", makeEntry(), SCOPE);
    await cache.get("key1"); // hit
    await cache.get("key1"); // hit
    await cache.get("miss"); // miss

    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.entryCount).toBe(1);
    expect(stats.maxSize).toBe(5);
    expect(stats.ttl).toBe(300_000);
  });

  it("overwriting a key updates the entry", async () => {
    await cache.set("key1", makeEntry({ rows: [{ id: 1 }] }), SCOPE);
    await cache.set("key1", makeEntry({ rows: [{ id: 2 }] }), SCOPE);
    const result = await cache.get("key1");
    expect(result!.rows).toEqual([{ id: 2 }]);
    expect((await cache.stats()).entryCount).toBe(1); // not duplicated
  });
});

// ---------------------------------------------------------------------------
// TTL edge cases
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — TTL edge cases", () => {
  it("entry with TTL of 1ms expires almost immediately", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const entry = makeEntry({ cachedAt: Date.now(), ttl: 1 });
    await cache.set("fast-expire", entry, SCOPE);

    // Wait just enough for the 1ms TTL to elapse
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get("fast-expire")).toBeNull();
  });

  it("entry with very large TTL persists", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const entry = makeEntry({ cachedAt: Date.now(), ttl: 999_999_999 });
    await cache.set("long-lived", entry, SCOPE);
    expect(await cache.get("long-lived")).not.toBeNull();
  });

  it("entry at exact TTL boundary is NOT expired (> check, not >=)", async () => {
    const now = 1_000_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const cache = new LRUCacheBackend(5, 300_000);
      // cachedAt is exactly ttl ms in the past — Date.now() - cachedAt === ttl
      // The implementation uses `>` so at exact boundary the entry is still valid
      const entry = makeEntry({ cachedAt: now - 300_000, ttl: 300_000 });
      await cache.set("boundary", entry, SCOPE);
      expect(await cache.get("boundary")).not.toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  it("constructor rejects maxSize < 1", () => {
    expect(() => new LRUCacheBackend(0, 300_000)).toThrow("Cache maxSize must be >= 1, got 0");
  });

  it("constructor rejects defaultTtl < 1", () => {
    expect(() => new LRUCacheBackend(5, 0)).toThrow("Cache defaultTtl must be >= 1ms, got 0");
  });
});

// ---------------------------------------------------------------------------
// Interleaved operations
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — interleaved operations", () => {
  it("consecutive set() for the same key — last write wins", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const entry1 = makeEntry({ rows: [{ id: 1, name: "first" }] });
    const entry2 = makeEntry({ rows: [{ id: 2, name: "second" }] });

    await cache.set("race", entry1, SCOPE);
    await cache.set("race", entry2, SCOPE);

    const result = await cache.get("race");
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([{ id: 2, name: "second" }]);
    expect((await cache.stats()).entryCount).toBe(1);
  });

  it("get() during rapid set() calls returns consistent state", async () => {
    const cache = new LRUCacheBackend(100, 300_000);
    // Interleave reads and writes
    for (let i = 0; i < 50; i++) {
      await cache.set(`key${i}`, makeEntry({ rows: [{ id: i }] }), SCOPE);
      if (i > 0) {
        const prev = await cache.get(`key${i - 1}`);
        expect(prev).not.toBeNull();
        expect(prev!.rows).toEqual([{ id: i - 1 }]);
      }
    }
    expect((await cache.stats()).entryCount).toBe(50);
  });

  it("flush() during reads clears everything", async () => {
    const cache = new LRUCacheBackend(10, 300_000);
    for (let i = 0; i < 10; i++) {
      await cache.set(`key${i}`, makeEntry(), SCOPE);
    }

    // Read some, then flush, then verify all gone
    await cache.get("key0");
    await cache.get("key5");
    await cache.flush();

    for (let i = 0; i < 10; i++) {
      expect(await cache.get(`key${i}`)).toBeNull();
    }
    expect((await cache.stats()).entryCount).toBe(0);
  });

  it("delete() then set() on same key works correctly", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    await cache.set("key", makeEntry({ rows: [{ id: 1 }] }), SCOPE);
    await cache.delete("key");
    await cache.set("key", makeEntry({ rows: [{ id: 2 }] }), SCOPE);

    const result = await cache.get("key");
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([{ id: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Large entries
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — large entries", () => {
  it("stores and retrieves a 10K-row result with integrity", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const largeRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 10_000; i++) {
      largeRows.push({ id: i, name: `row-${i}`, value: Math.random() });
    }
    const columns = ["id", "name", "value"];
    const entry = makeEntry({ columns, rows: largeRows });

    await cache.set("big", entry, SCOPE);
    const result = await cache.get("big");

    expect(result).not.toBeNull();
    expect(result!.rows.length).toBe(10_000);
    expect(result!.columns).toEqual(columns);
    // Verify first and last rows
    expect(result!.rows[0]).toEqual(largeRows[0]);
    expect(result!.rows[9999]).toEqual(largeRows[9999]);
  });

  it("large entry still subject to LRU eviction", async () => {
    const cache = new LRUCacheBackend(2, 300_000);
    const bigEntry = makeEntry({
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: i })),
    });

    await cache.set("big1", bigEntry, SCOPE);
    await cache.set("big2", bigEntry, SCOPE);
    // At capacity — next insert evicts big1
    await cache.set("big3", bigEntry, SCOPE);

    expect(await cache.get("big1")).toBeNull();
    expect(await cache.get("big2")).not.toBeNull();
    expect(await cache.get("big3")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LRU eviction ordering
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — LRU eviction ordering", () => {
  it("evicts entries in insertion order when none are accessed", async () => {
    const cache = new LRUCacheBackend(3, 300_000);
    await cache.set("a", makeEntry(), SCOPE);
    await cache.set("b", makeEntry(), SCOPE);
    await cache.set("c", makeEntry(), SCOPE);

    // d evicts a, e evicts b
    await cache.set("d", makeEntry(), SCOPE);
    await cache.set("e", makeEntry(), SCOPE);

    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).not.toBeNull();
    expect(await cache.get("d")).not.toBeNull();
    expect(await cache.get("e")).not.toBeNull();
  });

  it("set() on existing key refreshes its position", async () => {
    const cache = new LRUCacheBackend(3, 300_000);
    await cache.set("a", makeEntry(), SCOPE);
    await cache.set("b", makeEntry(), SCOPE);
    await cache.set("c", makeEntry(), SCOPE);

    // Re-set "a" — moves it to end
    await cache.set("a", makeEntry({ rows: [{ id: 999 }] }), SCOPE);

    // Insert "d" — should evict "b" (oldest), not "a"
    await cache.set("d", makeEntry(), SCOPE);
    expect(await cache.get("a")).not.toBeNull();
    expect((await cache.get("a"))!.rows).toEqual([{ id: 999 }]);
    expect(await cache.get("b")).toBeNull();
  });

  it("multiple evictions in sequence follow LRU order", async () => {
    const cache = new LRUCacheBackend(3, 300_000);
    await cache.set("a", makeEntry(), SCOPE);
    await cache.set("b", makeEntry(), SCOPE);
    await cache.set("c", makeEntry(), SCOPE);

    // Access "a" and "b", making "c" the least recently used
    await cache.get("a");
    await cache.get("b");

    // Insert "d" — evicts "c"
    await cache.set("d", makeEntry(), SCOPE);
    expect(await cache.get("c")).toBeNull();

    // Insert "e" — evicts "a" (oldest of a, b, d)
    await cache.set("e", makeEntry(), SCOPE);
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).not.toBeNull();
    expect(await cache.get("d")).not.toBeNull();
    expect(await cache.get("e")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stats accuracy
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — stats accuracy", () => {
  it("hit/miss/entry counts are accurate after mixed operations", async () => {
    const cache = new LRUCacheBackend(3, 300_000);

    // 3 sets
    await cache.set("a", makeEntry(), SCOPE);
    await cache.set("b", makeEntry(), SCOPE);
    await cache.set("c", makeEntry(), SCOPE);

    // 3 hits
    await cache.get("a");
    await cache.get("b");
    await cache.get("c");

    // 2 misses
    await cache.get("x");
    await cache.get("y");

    // Eviction: "a" becomes LRU after the gets above, but we accessed all three.
    // Insert "d" — evicts "a" (first inserted after all were accessed,
    // but get() re-inserts in order a, b, c — so a is oldest)
    await cache.set("d", makeEntry(), SCOPE);

    // 1 more miss (evicted "a")
    await cache.get("a");

    const stats = await cache.stats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(3); // x, y, evicted-a
    expect(stats.entryCount).toBe(3); // b, c, d
    expect(stats.maxSize).toBe(3);
  });

  it("stats reset with new cache instance", async () => {
    const cache1 = new LRUCacheBackend(5, 300_000);
    await cache1.set("a", makeEntry(), SCOPE);
    await cache1.get("a");
    await cache1.get("miss");

    const cache2 = new LRUCacheBackend(5, 300_000);
    const stats = await cache2.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.entryCount).toBe(0);
  });

  it("expired entry read counts as a miss, not a hit", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const expired = makeEntry({ cachedAt: Date.now() - 500_000, ttl: 300_000 });
    await cache.set("old", expired, SCOPE);

    await cache.get("old"); // Should be a miss (expired)

    const stats = await cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(1);
    expect(stats.entryCount).toBe(0);
  });

  it("flush() clears entries but preserves hit/miss stats", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    await cache.set("a", makeEntry(), SCOPE);
    await cache.get("a"); // hit
    await cache.get("miss"); // miss
    await cache.flush();

    const stats = await cache.stats();
    expect(stats.entryCount).toBe(0);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("overwriting a key does not inflate entry count", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    for (let i = 0; i < 20; i++) {
      await cache.set("same-key", makeEntry({ rows: [{ id: i }] }), SCOPE);
    }
    expect((await cache.stats()).entryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scope side index + flushByOrg
// ---------------------------------------------------------------------------

/**
 * Reads the private scope side index via a cast so a test can assert it stays
 * consistent with the entry Map across every mutation path. The index is an
 * internal invariant (no public getter), so this is the only way to pin it.
 */
function indexState(cache: LRUCacheBackend): {
  keyScopeSize: number;
  orgKeys: Map<string, Set<string>>;
} {
  const internal = cache as unknown as {
    keyScope: Map<string, unknown>;
    orgKeys: Map<string, Set<string>>;
  };
  return { keyScopeSize: internal.keyScope.size, orgKeys: internal.orgKeys };
}

describe("LRUCacheBackend — scope side index + flushByOrg", () => {
  it("flushByOrg removes exactly that org's entries and leaves others", async () => {
    const cache = new LRUCacheBackend(10, 300_000);
    await cache.set("a1", makeEntry(), scope("org-a"));
    await cache.set("a2", makeEntry(), scope("org-a"));
    await cache.set("b1", makeEntry(), scope("org-b"));

    const removed = await cache.flushByOrg("org-a");

    expect(removed).toBe(2);
    expect(await cache.get("a1")).toBeNull();
    expect(await cache.get("a2")).toBeNull();
    expect(await cache.get("b1")).not.toBeNull();
    expect((await cache.stats()).entryCount).toBe(1);
  });

  it("flushByOrg leaves the side index consistent (no keyScope leak, org pruned)", async () => {
    // Pins the reverse `keyScope` map after a purge — `flushByOrg` hand-rolls
    // its cleanup rather than routing through `unindex()`, so a dropped
    // `keyScope.delete` would leak entries forever without this assertion.
    const cache = new LRUCacheBackend(10, 300_000);
    await cache.set("a1", makeEntry(), scope("org-a"));
    await cache.set("a2", makeEntry(), scope("org-a"));
    await cache.set("b1", makeEntry(), scope("org-b"));

    await cache.flushByOrg("org-a");

    const idx = indexState(cache);
    expect(idx.orgKeys.has("org-a")).toBe(false); // purged org pruned
    expect(idx.orgKeys.get("org-b")).toEqual(new Set(["b1"])); // survivor intact
    // keyScope never outlives the entry Map.
    expect(idx.keyScopeSize).toBe((await cache.stats()).entryCount);
  });

  it("flushByOrg on an unknown org removes nothing and returns 0", async () => {
    const cache = new LRUCacheBackend(10, 300_000);
    await cache.set("a1", makeEntry(), scope("org-a"));
    expect(await cache.flushByOrg("org-missing")).toBe(0);
    expect(await cache.get("a1")).not.toBeNull();
  });

  it("per-connection invalidation falls out by filtering an org's entries", async () => {
    // Two connections under the same org. flushByOrg clears both; the retained
    // connectionId scope is what would let a caller narrow to one connection.
    const cache = new LRUCacheBackend(10, 300_000);
    await cache.set("c1", makeEntry(), scope("org-a", "conn-1"));
    await cache.set("c2", makeEntry(), scope("org-a", "conn-2"));
    await cache.set("c3", makeEntry(), scope("org-b", "conn-1"));

    const { orgKeys } = indexState(cache);
    expect(orgKeys.get("org-a")).toEqual(new Set(["c1", "c2"]));
    expect(orgKeys.get("org-b")).toEqual(new Set(["c3"]));

    expect(await cache.flushByOrg("org-a")).toBe(2);
    expect(await cache.get("c3")).not.toBeNull();
  });

  it("index stays consistent across set/overwrite/delete/evict/expiry/flush", async () => {
    const cache = new LRUCacheBackend(3, 300_000);

    // set for two orgs
    await cache.set("k1", makeEntry(), scope("org-a"));
    await cache.set("k2", makeEntry(), scope("org-b"));
    let idx = indexState(cache);
    expect(idx.keyScopeSize).toBe(2);
    expect(idx.orgKeys.get("org-a")).toEqual(new Set(["k1"]));

    // overwrite k1 under a DIFFERENT org — must move it, not duplicate it
    await cache.set("k1", makeEntry(), scope("org-c"));
    idx = indexState(cache);
    expect(idx.keyScopeSize).toBe(2);
    expect(idx.orgKeys.has("org-a")).toBe(false); // org-a set emptied + pruned
    expect(idx.orgKeys.get("org-c")).toEqual(new Set(["k1"]));

    // delete k2 — its org entry is pruned
    await cache.delete("k2");
    idx = indexState(cache);
    expect(idx.keyScopeSize).toBe(1);
    expect(idx.orgKeys.has("org-b")).toBe(false);

    // capacity eviction: fill past maxSize=3 so the oldest is evicted + unindexed
    await cache.set("k3", makeEntry(), scope("org-d"));
    await cache.set("k4", makeEntry(), scope("org-e"));
    await cache.set("k5", makeEntry(), scope("org-f")); // evicts oldest (k1)
    idx = indexState(cache);
    expect(await cache.get("k1")).toBeNull();
    expect(idx.orgKeys.has("org-c")).toBe(false); // k1's org pruned on eviction
    // keyScope never exceeds the live entry count
    expect(idx.keyScopeSize).toBe((await cache.stats()).entryCount);

    // TTL expiry on read unindexes
    await cache.set("expiring", makeEntry({ cachedAt: Date.now() - 400_000, ttl: 300_000 }), scope("org-g"));
    expect(await cache.get("expiring")).toBeNull();
    idx = indexState(cache);
    expect(idx.orgKeys.has("org-g")).toBe(false);
    expect(idx.keyScopeSize).toBe((await cache.stats()).entryCount);

    // flush clears both maps entirely
    await cache.flush();
    idx = indexState(cache);
    expect(idx.keyScopeSize).toBe(0);
    expect(idx.orgKeys.size).toBe(0);
  });

  it("entries without an orgId are not reachable by flushByOrg but still cached", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    await cache.set("no-org", makeEntry(), { connectionId: "default" });
    const idx = indexState(cache);
    expect(idx.keyScopeSize).toBe(1); // scope retained (connectionId)
    expect(idx.orgKeys.size).toBe(0); // but not org-indexed
    expect(await cache.get("no-org")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backend shape validation
// ---------------------------------------------------------------------------

describe("validateCacheBackend", () => {
  const conforming = () => ({
    get: async () => null,
    set: async () => {},
    delete: async () => false,
    flush: async () => {},
    flushByOrg: async () => 0,
    stats: async () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 0, ttl: 0 }),
  });

  it("accepts a conforming async backend", async () => {
    expect(await validateCacheBackend(conforming())).toEqual({ ok: true });
  });

  it("accepts the in-process LRU", async () => {
    expect(await validateCacheBackend(new LRUCacheBackend(5, 300_000))).toEqual({ ok: true });
  });

  it("rejects a non-object", async () => {
    const r = await validateCacheBackend(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("must be an object");
  });

  it("rejects a backend missing required methods", async () => {
    const bad = conforming() as Record<string, unknown>;
    delete bad.flushByOrg;
    delete bad.stats;
    const r = await validateCacheBackend(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("flushByOrg");
      expect(r.reason).toContain("stats");
    }
  });

  it("rejects a backend whose stats() omits numeric fields", async () => {
    const bad = { ...conforming(), stats: async () => ({ hits: 0, misses: 0, size: 0 }) };
    const r = await validateCacheBackend(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("entryCount");
  });

  it("rejects a backend whose stats() throws", async () => {
    const bad = {
      ...conforming(),
      stats: async () => {
        throw new Error("boom");
      },
    };
    const r = await validateCacheBackend(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("boom");
  });

  it("rejects a backend whose stats() never resolves (hang → timeout)", async () => {
    // The boot-safety path: a backend whose stats() hangs (e.g. a Redis client
    // blocked on a dead connection) must fail validation via the timeout rather
    // than stalling plugin-registry boot. A tiny injected timeout keeps the
    // test fast; a late rejection on the abandoned promise must not surface as
    // an unhandledRejection (a failing test run would flag it).
    const bad = { ...conforming(), stats: () => new Promise(() => {}) };
    const r = await validateCacheBackend(bad, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("did not resolve within");
  });

  it("swallows a late rejection from an abandoned stats() probe (no unhandledRejection)", async () => {
    // stats() rejects AFTER the timeout has already won the race. The reject
    // must be swallowed, not escape. We give the reject time to fire and assert
    // the validation result is still the timeout failure.
    const bad = {
      ...conforming(),
      stats: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late-boom")), 20)),
    };
    const r = await validateCacheBackend(bad, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("did not resolve within");
    // Let the late rejection fire; if it were unhandled the runner would flag it.
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

describe("buildCacheKey", () => {
  it("produces a hex hash string", () => {
    const key = buildCacheKey("SELECT 1", "default");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same SQL + same params = same key", () => {
    const a = buildCacheKey("SELECT 1", "default", "org1");
    const b = buildCacheKey("SELECT 1", "default", "org1");
    expect(a).toBe(b);
  });

  it("same SQL + different orgId = different key", () => {
    const a = buildCacheKey("SELECT 1", "default", "org1");
    const b = buildCacheKey("SELECT 1", "default", "org2");
    expect(a).not.toBe(b);
  });

  it("same SQL + different connectionId = different key", () => {
    const a = buildCacheKey("SELECT 1", "default", "org1");
    const b = buildCacheKey("SELECT 1", "warehouse", "org1");
    expect(a).not.toBe(b);
  });

  it("same SQL + different claims = different key", () => {
    const a = buildCacheKey("SELECT 1", "default", "org1", { role: "admin" });
    const b = buildCacheKey("SELECT 1", "default", "org1", { role: "member" });
    expect(a).not.toBe(b);
  });

  it("claims key order does not affect hash", () => {
    const a = buildCacheKey("SELECT 1", "default", "org1", { a: 1, b: 2 });
    const b = buildCacheKey("SELECT 1", "default", "org1", { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("claims differing only at a nested path = different key", () => {
    // Regression for #4532: a JSON.stringify replacer array applied the
    // top-level key whitelist at every depth, so nested claim objects
    // serialized to `{}` and the discriminating value was erased. Two users
    // whose RLS tenant lives at a nested claim path then collided on one key.
    const a = buildCacheKey("SELECT 1", "default", "org1", {
      app_metadata: { org_id: "org-42" },
    });
    const b = buildCacheKey("SELECT 1", "default", "org1", {
      app_metadata: { org_id: "org-99" },
    });
    expect(a).not.toBe(b);
  });

  it("nested claim key order does not affect hash", () => {
    const a = buildCacheKey("SELECT 1", "default", "org1", {
      app_metadata: { tenant: "acme", region: "us" },
    });
    const b = buildCacheKey("SELECT 1", "default", "org1", {
      app_metadata: { region: "us", tenant: "acme" },
    });
    expect(a).toBe(b);
  });

  it("no orgId produces different key than with orgId", () => {
    const a = buildCacheKey("SELECT 1", "default");
    const b = buildCacheKey("SELECT 1", "default", "org1");
    expect(a).not.toBe(b);
  });
});
