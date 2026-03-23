/**
 * Tests for the PostgreSQL state adapter.
 *
 * Uses a mock PluginDB to verify SQL generation and adapter behavior
 * without requiring a live database.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { PgStateAdapter } from "./pg-adapter";
import type { PluginDB } from "./types";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockDB(options?: {
  queryResults?: Record<string, unknown>[][];
}) {
  const calls: QueryCall[] = [];
  let callIndex = 0;
  const results = options?.queryResults ?? [];

  const db: PluginDB = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      const rows = results[callIndex] ?? [];
      callIndex++;
      return { rows };
    },
    async execute(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      callIndex++;
    },
  };

  return { db, calls, resetIndex: () => { callIndex = 0; } };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("PgStateAdapter lifecycle", () => {
  it("creates tables on connect", async () => {
    const { db, calls } = createMockDB();
    const adapter = new PgStateAdapter(db);

    await adapter.connect();

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS chat_subscriptions"))).toBe(true);
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS chat_locks"))).toBe(true);
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS chat_cache"))).toBe(true);
  });

  it("respects custom table prefix", async () => {
    const { db, calls } = createMockDB();
    const adapter = new PgStateAdapter(db, { tablePrefix: "myapp_" });

    await adapter.connect();

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("myapp_subscriptions"))).toBe(true);
    expect(sqls.some((s) => s.includes("myapp_locks"))).toBe(true);
    expect(sqls.some((s) => s.includes("myapp_cache"))).toBe(true);
  });

  it("skips table creation on second connect", async () => {
    const { db, calls } = createMockDB();
    const adapter = new PgStateAdapter(db);

    await adapter.connect();
    const firstCallCount = calls.length;

    await adapter.connect();
    expect(calls.length).toBe(firstCallCount); // No new calls
  });

  it("throws when calling methods before connect", async () => {
    const { db } = createMockDB();
    const adapter = new PgStateAdapter(db);

    expect(adapter.subscribe("t1")).rejects.toThrow(/not connected/);
  });

  it("rejects invalid tablePrefix with SQL metacharacters", () => {
    const { db } = createMockDB();

    expect(() => new PgStateAdapter(db, { tablePrefix: "; DROP TABLE" })).toThrow(/Invalid tablePrefix/);
    expect(() => new PgStateAdapter(db, { tablePrefix: "has spaces" })).toThrow(/Invalid tablePrefix/);
    expect(() => new PgStateAdapter(db, { tablePrefix: "semi;colon" })).toThrow(/Invalid tablePrefix/);
    expect(() => new PgStateAdapter(db, { tablePrefix: "quote'" })).toThrow(/Invalid tablePrefix/);
    expect(() => new PgStateAdapter(db, { tablePrefix: "1starts_with_number" })).toThrow(/Invalid tablePrefix/);
  });

  it("accepts valid tablePrefix values", () => {
    const { db } = createMockDB();

    expect(() => new PgStateAdapter(db, { tablePrefix: "chat_" })).not.toThrow();
    expect(() => new PgStateAdapter(db, { tablePrefix: "MyApp_" })).not.toThrow();
    expect(() => new PgStateAdapter(db, { tablePrefix: "_private" })).not.toThrow();
    expect(() => new PgStateAdapter(db, { tablePrefix: "a1b2c3" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe("PgStateAdapter subscriptions", () => {
  let adapter: PgStateAdapter;
  let calls: QueryCall[];

  beforeEach(async () => {
    const mock = createMockDB();
    adapter = new PgStateAdapter(mock.db);
    calls = mock.calls;
    await adapter.connect();
    calls.length = 0; // Clear setup calls
  });

  it("subscribe inserts with ON CONFLICT DO NOTHING", async () => {
    await adapter.subscribe("slack:C123:ts456");

    const subCall = calls.find((c) => c.sql.includes("INSERT INTO chat_subscriptions"));
    expect(subCall).toBeDefined();
    expect(subCall!.params).toEqual(["slack:C123:ts456"]);
    expect(subCall!.sql).toContain("ON CONFLICT");
  });

  it("unsubscribe deletes by thread_id", async () => {
    await adapter.unsubscribe("slack:C123:ts456");

    const delCall = calls.find((c) => c.sql.includes("DELETE FROM chat_subscriptions"));
    expect(delCall).toBeDefined();
    expect(delCall!.params).toEqual(["slack:C123:ts456"]);
  });

  it("isSubscribed returns true when row exists", async () => {
    const mock = createMockDB({
      queryResults: [
        // connect() calls return empty, then isSubscribed returns a row
        [], [], [], [], [],
        [{ "1": 1 }],
      ],
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();

    const result = await ad.isSubscribed("slack:C123:ts456");
    expect(result).toBe(true);
  });

  it("isSubscribed returns false when no row", async () => {
    await adapter.connect();
    const result = await adapter.isSubscribed("nonexistent");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

describe("PgStateAdapter locks", () => {
  let adapter: PgStateAdapter;
  let calls: QueryCall[];

  beforeEach(async () => {
    const mock = createMockDB({
      queryResults: [
        // connect() table creation (5 execute calls)
        [], [], [], [], [],
        // acquireLock returns a row
        [{ thread_id: "t1", token: "tok-1", expires_at: new Date(Date.now() + 30000).toISOString() }],
      ],
    });
    adapter = new PgStateAdapter(mock.db);
    calls = mock.calls;
    await adapter.connect();
    calls.length = 0;
  });

  it("acquireLock returns Lock when acquired", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [{ thread_id: "t1", token: "tok-1", expires_at: new Date(Date.now() + 30000).toISOString() }],
      ],
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();

    const lock = await ad.acquireLock("t1", 30000);
    expect(lock).not.toBeNull();
    expect(lock!.threadId).toBe("t1");
    expect(typeof lock!.token).toBe("string");
    expect(lock!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("acquireLock returns null when already locked", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [], // empty result = lock not acquired
      ],
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();

    const lock = await ad.acquireLock("t1", 30000);
    expect(lock).toBeNull();
  });

  it("releaseLock deletes by thread_id + token", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();
    mock.calls.length = 0;

    await ad.releaseLock({ threadId: "t1", token: "tok-1", expiresAt: Date.now() + 30000 });

    const delCall = mock.calls.find((c) => c.sql.includes("DELETE FROM chat_locks"));
    expect(delCall).toBeDefined();
    expect(delCall!.params).toEqual(["t1", "tok-1"]);
  });

  it("extendLock returns true when extended", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [{ thread_id: "t1" }], // extendLock returns row
      ],
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();

    const lock = { threadId: "t1", token: "tok-1", expiresAt: Date.now() + 5000 };
    const result = await ad.extendLock(lock, 60000);
    expect(result).toBe(true);
    expect(lock.expiresAt).toBeGreaterThan(Date.now() + 50000);
  });

  it("extendLock returns false when lock expired or wrong token", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []], // empty result
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();

    const lock = { threadId: "t1", token: "wrong", expiresAt: Date.now() - 1000 };
    const result = await ad.extendLock(lock, 60000);
    expect(result).toBe(false);
  });

  it("forceReleaseLock deletes by thread_id only", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const ad = new PgStateAdapter(mock.db);
    await ad.connect();
    mock.calls.length = 0;

    await ad.forceReleaseLock("t1");

    const delCall = mock.calls.find((c) => c.sql.includes("DELETE FROM chat_locks"));
    expect(delCall).toBeDefined();
    expect(delCall!.params).toEqual(["t1"]);
    expect(delCall!.sql).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// Cache (get/set/delete/setIfNotExists)
// ---------------------------------------------------------------------------

describe("PgStateAdapter cache", () => {
  it("get returns parsed value", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [{ value: { hello: "world" } }],
      ],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.get<{ hello: string }>("mykey");
    expect(result).toEqual({ hello: "world" });
  });

  it("get returns null for missing key", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.get("missing");
    expect(result).toBeNull();
  });

  it("set upserts with TTL", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.set("key1", { data: 42 }, 60000);

    const setCall = mock.calls.find((c) => c.sql.includes("INSERT INTO chat_cache"));
    expect(setCall).toBeDefined();
    expect(setCall!.params![0]).toBe("key1");
    expect(setCall!.sql).toContain("ON CONFLICT (key) DO UPDATE");
    expect(setCall!.sql).toContain("make_interval");
  });

  it("set upserts without TTL", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.set("key1", "value");

    const setCall = mock.calls.find((c) => c.sql.includes("INSERT INTO chat_cache"));
    expect(setCall).toBeDefined();
    expect(setCall!.params!.length).toBe(2); // No TTL param
    expect(setCall!.sql).toContain("NULL");
  });

  it("delete removes by key", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.delete("key1");

    const delCall = mock.calls.find((c) => c.sql.includes("DELETE FROM chat_cache"));
    expect(delCall).toBeDefined();
    expect(delCall!.params).toEqual(["key1"]);
  });

  it("setIfNotExists returns true when key is new", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [{ key: "newkey" }], // CTE INSERT returned a row
      ],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.setIfNotExists("newkey", "val", 5000);
    expect(result).toBe(true);
  });

  it("setIfNotExists uses atomic CTE (single query)", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], [{ key: "k" }]],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.setIfNotExists("k", "v");

    // Should be a single query (CTE), not two separate queries
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].sql).toContain("WITH cleanup AS");
    expect(mock.calls[0].sql).toContain("DELETE FROM");
    expect(mock.calls[0].sql).toContain("INSERT INTO");
  });

  it("setIfNotExists returns false when key exists", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [], // CTE INSERT returned nothing (conflict)
      ],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.setIfNotExists("existing", "val");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

describe("PgStateAdapter lists", () => {
  it("appendToList inserts new array for new key", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.appendToList("list1", { msg: "hello" });

    const insertCall = mock.calls.find((c) => c.sql.includes("INSERT INTO chat_cache"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain("jsonb_build_array");
    expect(insertCall!.params![0]).toBe("list1");
  });

  it("appendToList with maxLength triggers trim query", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.appendToList("list1", { msg: "hello" }, { maxLength: 100 });

    // Should have 2 calls: insert + trim
    expect(mock.calls.length).toBe(2);
    const trimCall = mock.calls[1];
    expect(trimCall.sql).toContain("UPDATE");
    expect(trimCall.sql).toContain("jsonb_array_length");
  });

  it("getList returns parsed array", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [{ value: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }],
      ],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.getList<{ role: string; content: string }>("conv:thread1");
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].content).toBe("hello");
  });

  it("getList returns empty array for missing key", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.getList("missing");
    expect(result).toEqual([]);
  });

  it("appendToList with both maxLength and ttlMs uses $4 for trim", async () => {
    const mock = createMockDB({
      queryResults: [[], [], [], [], [], [], []],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();
    mock.calls.length = 0;

    await adapter.appendToList("list1", { msg: "hi" }, { maxLength: 200, ttlMs: 604800000 });

    // Insert uses $3 for TTL
    expect(mock.calls[0].params).toEqual(["list1", '{"msg":"hi"}', 604800000]);
    expect(mock.calls[0].sql).toContain("make_interval");

    // Trim uses $4 for maxLength
    expect(mock.calls[1].sql).toContain("$4::int");
    expect(mock.calls[1].params).toEqual(["list1", '{"msg":"hi"}', 604800000, 200]);
  });

  it("getList returns empty array for non-array value", async () => {
    const mock = createMockDB({
      queryResults: [
        [], [], [], [], [],
        [{ value: "not-an-array" }],
      ],
    });
    const adapter = new PgStateAdapter(mock.db);
    await adapter.connect();

    const result = await adapter.getList("key-with-scalar");
    expect(result).toEqual([]);
  });
});
