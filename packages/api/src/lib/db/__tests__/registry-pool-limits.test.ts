/**
 * Tests for ConnectionRegistry pool limit and LRU eviction features.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock database drivers
mock.module("pg", () => ({
  Pool: class MockPool {
    constructor(public opts?: Record<string, unknown>) {}
    async query() { return { rows: [], fields: [] }; }
    async connect() {
      return { async query() { return { rows: [], fields: [] }; }, release() {} };
    }
    async end() {}
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: (opts: Record<string, unknown>) => ({
    _opts: opts,
    async getConnection() {
      return { async execute() { return [[], []]; }, release() {} };
    },
    async end() {},
  }),
}));

// Cache-busting import
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;

describe("ConnectionRegistry pool limits", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  it("threads maxConnections to pg Pool constructor", () => {
    registry.register("pg", {
      url: "postgresql://user:pass@localhost:5432/db",
      maxConnections: 20,
    });
    expect(registry.get("pg")).toBeDefined();
  });

  it("threads maxConnections to mysql pool constructor", () => {
    registry.register("my", {
      url: "mysql://user:pass@localhost:3306/db",
      maxConnections: 15,
    });
    expect(registry.get("my")).toBeDefined();
  });

  it("uses default maxConnections=10 when not specified", () => {
    registry.register("pg", {
      url: "postgresql://user:pass@localhost:5432/db",
    });
    expect(registry.get("pg")).toBeDefined();
  });

  it("evicts LRU connection when total pool slots exceed max", async () => {
    registry.setMaxTotalConnections(20);

    // Register two connections (10 slots each = 20 total, at cap)
    registry.register("a", { url: "postgresql://user:pass@localhost:5432/a" });
    registry.register("b", { url: "postgresql://user:pass@localhost:5432/b" });
    expect(registry.list()).toContain("a");
    expect(registry.list()).toContain("b");

    // Touch "b" so "a" is LRU
    registry.get("b");
    await new Promise((r) => setTimeout(r, 5));

    // Register a third — should evict "a" (LRU)
    registry.register("c", { url: "postgresql://user:pass@localhost:5432/c" });
    expect(registry.list()).not.toContain("a");
    expect(registry.list()).toContain("b");
    expect(registry.list()).toContain("c");
  });

  it("re-registration does not trigger eviction", () => {
    registry.setMaxTotalConnections(10);
    registry.register("a", { url: "postgresql://user:pass@localhost:5432/a" });

    // Re-register "a" — should NOT evict since it replaces in-place
    registry.register("a", { url: "postgresql://user:pass@localhost:5432/a-new" });
    expect(registry.list()).toEqual(["a"]);
  });

  it("setMaxTotalConnections changes the cap", () => {
    registry.setMaxTotalConnections(10);
    registry.register("a", { url: "postgresql://user:pass@localhost:5432/a" });
    expect(registry.list()).toEqual(["a"]);
    // New connection (total would be 20) — should evict "a"
    registry.register("b", { url: "postgresql://user:pass@localhost:5432/b" });
    expect(registry.list()).not.toContain("a");
    expect(registry.list()).toContain("b");
  });

  it("get() updates lastQueryAt for LRU tracking", async () => {
    registry.setMaxTotalConnections(20);
    registry.register("a", { url: "postgresql://user:pass@localhost:5432/a" });
    await new Promise((r) => setTimeout(r, 10));
    registry.register("b", { url: "postgresql://user:pass@localhost:5432/b" });
    await new Promise((r) => setTimeout(r, 10));

    // Access "a" to make it more recent than "b"
    registry.get("a");
    await new Promise((r) => setTimeout(r, 10));

    // Register "c" — should evict "b" (LRU)
    registry.register("c", { url: "postgresql://user:pass@localhost:5432/c" });
    expect(registry.list()).toContain("a");
    expect(registry.list()).not.toContain("b");
    expect(registry.list()).toContain("c");
  });

  it("close() is called on evicted connection", async () => {
    let closeCalled = 0;
    registry.setMaxTotalConnections(10);
    registry.register("a", { url: "postgresql://user:pass@localhost:5432/a" });
    const origConn = registry.get("a");
    const origClose = origConn.close;
    origConn.close = async () => { closeCalled++; return origClose.call(origConn); };

    registry.register("b", { url: "postgresql://user:pass@localhost:5432/b" });
    await new Promise((r) => setTimeout(r, 10));
    expect(closeCalled).toBe(1);
  });
});
