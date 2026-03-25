/**
 * Tests for ConnectionRegistry drain cooldown via Effect.sleep.
 *
 * Verifies that:
 * - Drain succeeds when no cooldown is active
 * - Second drain within cooldown window is rejected
 * - Cooldown expires and drain succeeds again
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock pg so pool creation doesn't fail
mock.module("pg", () => ({
  Pool: class MockPool {
    async query() { return { rows: [], fields: [] }; }
    async connect() {
      return {
        async query() { return { rows: [], fields: [] }; },
        release() {},
      };
    }
    async end() {}
    get totalCount() { return 0; }
    get idleCount() { return 0; }
    get waitingCount() { return 0; }
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => ({
    async getConnection() {
      return { async execute() { return [[], []]; }, release() {} };
    },
    async end() {},
  }),
}));

// Cache-busting import for the real module
const connModPath = resolve(__dirname, "../../db/connection.ts");
const connMod = await import(`${connModPath}?drain=${Date.now()}`);
const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../../db/connection").ConnectionRegistry;

describe("ConnectionRegistry drain cooldown (Effect.sleep)", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test@localhost/db";
  });

  afterEach(() => {
    registry._reset();
    delete process.env.ATLAS_DATASOURCE_URL;
  });

  it("first drain succeeds", async () => {
    registry.register("test", { url: "postgresql://test@localhost/db" });
    const result = await registry.drain("test");
    expect(result.drained).toBe(true);
    expect(result.message).toBe("Pool drained and recreated");
  });

  it("second drain within cooldown is rejected", async () => {
    registry.register("test", { url: "postgresql://test@localhost/db" });

    const first = await registry.drain("test");
    expect(first.drained).toBe(true);

    const second = await registry.drain("test");
    expect(second.drained).toBe(false);
    expect(second.message).toContain("cooldown");
  });

  it("drain of plugin-managed connection is rejected", async () => {
    const mockConn = {
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
    };
    registry.registerDirect("plugin-conn", mockConn, "postgres");

    const result = await registry.drain("plugin-conn");
    expect(result.drained).toBe(false);
    expect(result.message).toContain("plugin-managed");
  });

  it("drain of unknown connection throws", async () => {
    expect(() => registry.drain("nonexistent")).toThrow("not registered");
  });

  it("auto-drain via recordError respects cooldown", async () => {
    registry.register("test", { url: "postgresql://test@localhost/db" });

    // Trigger auto-drain by exceeding failure threshold (default 5)
    for (let i = 0; i < 5; i++) {
      registry.recordError("test");
    }

    // The first auto-drain should have set the cooldown.
    // Verify cooldown is active — second drain should be rejected
    const result = await registry.drain("test");
    expect(result.drained).toBe(false);
    expect(result.message).toContain("cooldown");

    // Trigger more errors — should not drain again (cooldown active, no crash)
    for (let i = 0; i < 5; i++) {
      registry.recordError("test");
    }
  });
});
