/**
 * Tests for query result caching: LRU backend, cache keys, and integration.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { LRUCacheBackend } from "../lru";
import { buildCacheKey } from "../keys";
import type { CacheEntry } from "../types";

function makeEntry(overrides?: Partial<CacheEntry>): CacheEntry {
  return {
    columns: ["id", "name"],
    rows: [{ id: 1, name: "test" }],
    cachedAt: Date.now(),
    ttl: 300_000,
    ...overrides,
  };
}

describe("LRUCacheBackend", () => {
  let cache: LRUCacheBackend;

  beforeEach(() => {
    cache = new LRUCacheBackend(5, 300_000);
  });

  it("returns null on cache miss", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("stores and retrieves an entry", () => {
    const entry = makeEntry();
    cache.set("key1", entry);
    const result = cache.get("key1");
    expect(result).not.toBeNull();
    expect(result!.columns).toEqual(["id", "name"]);
    expect(result!.rows).toEqual([{ id: 1, name: "test" }]);
  });

  it("evicts expired entries on read", () => {
    const entry = makeEntry({ cachedAt: Date.now() - 400_000, ttl: 300_000 });
    cache.set("expired", entry);
    expect(cache.get("expired")).toBeNull();
  });

  it("evicts oldest entry when at max size", () => {
    for (let i = 0; i < 5; i++) {
      cache.set(`key${i}`, makeEntry());
    }
    expect(cache.stats().entryCount).toBe(5);

    // Adding a 6th should evict the oldest (key0)
    cache.set("key5", makeEntry());
    expect(cache.stats().entryCount).toBe(5);
    expect(cache.get("key0")).toBeNull(); // evicted
    expect(cache.get("key5")).not.toBeNull(); // present
  });

  it("LRU ordering: accessed items are not evicted", () => {
    for (let i = 0; i < 5; i++) {
      cache.set(`key${i}`, makeEntry());
    }
    // Access key0 to move it to end
    cache.get("key0");

    // Insert key5 — should evict key1 (oldest unused), not key0
    cache.set("key5", makeEntry());
    expect(cache.get("key0")).not.toBeNull();
    expect(cache.get("key1")).toBeNull(); // evicted
  });

  it("delete removes an entry", () => {
    cache.set("key1", makeEntry());
    expect(cache.delete("key1")).toBe(true);
    expect(cache.get("key1")).toBeNull();
    expect(cache.delete("key1")).toBe(false); // already gone
  });

  it("flush clears all entries", () => {
    cache.set("a", makeEntry());
    cache.set("b", makeEntry());
    cache.flush();
    expect(cache.stats().entryCount).toBe(0);
    expect(cache.get("a")).toBeNull();
  });

  it("stats tracks hits and misses", () => {
    cache.set("key1", makeEntry());
    cache.get("key1"); // hit
    cache.get("key1"); // hit
    cache.get("miss"); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.entryCount).toBe(1);
    expect(stats.maxSize).toBe(5);
    expect(stats.ttl).toBe(300_000);
  });

  it("overwriting a key updates the entry", () => {
    cache.set("key1", makeEntry({ rows: [{ id: 1 }] }));
    cache.set("key1", makeEntry({ rows: [{ id: 2 }] }));
    const result = cache.get("key1");
    expect(result!.rows).toEqual([{ id: 2 }]);
    expect(cache.stats().entryCount).toBe(1); // not duplicated
  });
});

// ---------------------------------------------------------------------------
// TTL edge cases
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — TTL edge cases", () => {
  it("entry with TTL of 1ms expires almost immediately", async () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const entry = makeEntry({ cachedAt: Date.now(), ttl: 1 });
    cache.set("fast-expire", entry);

    // Wait just enough for the 1ms TTL to elapse
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.get("fast-expire")).toBeNull();
  });

  it("entry with very large TTL persists", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const entry = makeEntry({ cachedAt: Date.now(), ttl: 999_999_999 });
    cache.set("long-lived", entry);
    expect(cache.get("long-lived")).not.toBeNull();
  });

  it("entry at exact TTL boundary is NOT expired (> check, not >=)", () => {
    const now = 1_000_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const cache = new LRUCacheBackend(5, 300_000);
      // cachedAt is exactly ttl ms in the past — Date.now() - cachedAt === ttl
      // The implementation uses `>` so at exact boundary the entry is still valid
      const entry = makeEntry({ cachedAt: now - 300_000, ttl: 300_000 });
      cache.set("boundary", entry);
      expect(cache.get("boundary")).not.toBeNull();
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
  it("consecutive set() for the same key — last write wins", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const entry1 = makeEntry({ rows: [{ id: 1, name: "first" }] });
    const entry2 = makeEntry({ rows: [{ id: 2, name: "second" }] });

    cache.set("race", entry1);
    cache.set("race", entry2);

    const result = cache.get("race");
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([{ id: 2, name: "second" }]);
    expect(cache.stats().entryCount).toBe(1);
  });

  it("get() during rapid set() calls returns consistent state", () => {
    const cache = new LRUCacheBackend(100, 300_000);
    // Interleave reads and writes
    for (let i = 0; i < 50; i++) {
      cache.set(`key${i}`, makeEntry({ rows: [{ id: i }] }));
      if (i > 0) {
        const prev = cache.get(`key${i - 1}`);
        expect(prev).not.toBeNull();
        expect(prev!.rows).toEqual([{ id: i - 1 }]);
      }
    }
    expect(cache.stats().entryCount).toBe(50);
  });

  it("flush() during reads clears everything", () => {
    const cache = new LRUCacheBackend(10, 300_000);
    for (let i = 0; i < 10; i++) {
      cache.set(`key${i}`, makeEntry());
    }

    // Read some, then flush, then verify all gone
    cache.get("key0");
    cache.get("key5");
    cache.flush();

    for (let i = 0; i < 10; i++) {
      expect(cache.get(`key${i}`)).toBeNull();
    }
    expect(cache.stats().entryCount).toBe(0);
  });

  it("delete() then set() on same key works correctly", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    cache.set("key", makeEntry({ rows: [{ id: 1 }] }));
    cache.delete("key");
    cache.set("key", makeEntry({ rows: [{ id: 2 }] }));

    const result = cache.get("key");
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([{ id: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Large entries
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — large entries", () => {
  it("stores and retrieves a 10K-row result with integrity", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const largeRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 10_000; i++) {
      largeRows.push({ id: i, name: `row-${i}`, value: Math.random() });
    }
    const columns = ["id", "name", "value"];
    const entry = makeEntry({ columns, rows: largeRows });

    cache.set("big", entry);
    const result = cache.get("big");

    expect(result).not.toBeNull();
    expect(result!.rows.length).toBe(10_000);
    expect(result!.columns).toEqual(columns);
    // Verify first and last rows
    expect(result!.rows[0]).toEqual(largeRows[0]);
    expect(result!.rows[9999]).toEqual(largeRows[9999]);
  });

  it("large entry still subject to LRU eviction", () => {
    const cache = new LRUCacheBackend(2, 300_000);
    const bigEntry = makeEntry({
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: i })),
    });

    cache.set("big1", bigEntry);
    cache.set("big2", bigEntry);
    // At capacity — next insert evicts big1
    cache.set("big3", bigEntry);

    expect(cache.get("big1")).toBeNull();
    expect(cache.get("big2")).not.toBeNull();
    expect(cache.get("big3")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LRU eviction ordering
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — LRU eviction ordering", () => {
  it("evicts entries in insertion order when none are accessed", () => {
    const cache = new LRUCacheBackend(3, 300_000);
    cache.set("a", makeEntry());
    cache.set("b", makeEntry());
    cache.set("c", makeEntry());

    // d evicts a, e evicts b
    cache.set("d", makeEntry());
    cache.set("e", makeEntry());

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).not.toBeNull();
    expect(cache.get("d")).not.toBeNull();
    expect(cache.get("e")).not.toBeNull();
  });

  it("set() on existing key refreshes its position", () => {
    const cache = new LRUCacheBackend(3, 300_000);
    cache.set("a", makeEntry());
    cache.set("b", makeEntry());
    cache.set("c", makeEntry());

    // Re-set "a" — moves it to end
    cache.set("a", makeEntry({ rows: [{ id: 999 }] }));

    // Insert "d" — should evict "b" (oldest), not "a"
    cache.set("d", makeEntry());
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("a")!.rows).toEqual([{ id: 999 }]);
    expect(cache.get("b")).toBeNull();
  });

  it("multiple evictions in sequence follow LRU order", () => {
    const cache = new LRUCacheBackend(3, 300_000);
    cache.set("a", makeEntry());
    cache.set("b", makeEntry());
    cache.set("c", makeEntry());

    // Access "a" and "b", making "c" the least recently used
    cache.get("a");
    cache.get("b");

    // Insert "d" — evicts "c"
    cache.set("d", makeEntry());
    expect(cache.get("c")).toBeNull();

    // Insert "e" — evicts "a" (oldest of a, b, d)
    cache.set("e", makeEntry());
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("d")).not.toBeNull();
    expect(cache.get("e")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stats accuracy
// ---------------------------------------------------------------------------

describe("LRUCacheBackend — stats accuracy", () => {
  it("hit/miss/entry counts are accurate after mixed operations", () => {
    const cache = new LRUCacheBackend(3, 300_000);

    // 3 sets
    cache.set("a", makeEntry());
    cache.set("b", makeEntry());
    cache.set("c", makeEntry());

    // 3 hits
    cache.get("a");
    cache.get("b");
    cache.get("c");

    // 2 misses
    cache.get("x");
    cache.get("y");

    // Eviction: "a" becomes LRU after the gets above, but we accessed all three.
    // Insert "d" — evicts "a" (first inserted after all were accessed,
    // but get() re-inserts in order a, b, c — so a is oldest)
    cache.set("d", makeEntry());

    // 1 more miss (evicted "a")
    cache.get("a");

    const stats = cache.stats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(3); // x, y, evicted-a
    expect(stats.entryCount).toBe(3); // b, c, d
    expect(stats.maxSize).toBe(3);
  });

  it("stats reset with new cache instance", () => {
    const cache1 = new LRUCacheBackend(5, 300_000);
    cache1.set("a", makeEntry());
    cache1.get("a");
    cache1.get("miss");

    const cache2 = new LRUCacheBackend(5, 300_000);
    const stats = cache2.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.entryCount).toBe(0);
  });

  it("expired entry read counts as a miss, not a hit", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    const expired = makeEntry({ cachedAt: Date.now() - 500_000, ttl: 300_000 });
    cache.set("old", expired);

    cache.get("old"); // Should be a miss (expired)

    const stats = cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(1);
    expect(stats.entryCount).toBe(0);
  });

  it("flush() clears entries but preserves hit/miss stats", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    cache.set("a", makeEntry());
    cache.get("a"); // hit
    cache.get("miss"); // miss
    cache.flush();

    const stats = cache.stats();
    expect(stats.entryCount).toBe(0);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("overwriting a key does not inflate entry count", () => {
    const cache = new LRUCacheBackend(5, 300_000);
    for (let i = 0; i < 20; i++) {
      cache.set("same-key", makeEntry({ rows: [{ id: i }] }));
    }
    expect(cache.stats().entryCount).toBe(1);
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

  it("no orgId produces different key than with orgId", () => {
    const a = buildCacheKey("SELECT 1", "default");
    const b = buildCacheKey("SELECT 1", "default", "org1");
    expect(a).not.toBe(b);
  });
});
