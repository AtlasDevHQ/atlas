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
