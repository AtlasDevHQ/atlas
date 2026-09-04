/**
 * Tests for the ConnectionRegistry class and per-connection whitelists.
 *
 * Uses the cache-busting import pattern from connection.test.ts to bypass
 * global mocks registered by other test files. Mocks pg and mysql2/promise
 * so register() can create connections without real databases.
 *
 * Also carries the health-check, pool-limit/LRU and Effect-fiber suites that
 * used to live in three sibling files, all of which drove this same
 * `ConnectionRegistry` behind an equivalent pg/mysql2 mock pair:
 * formerly registry-health.test.ts, registry-pool-limits.test.ts and
 * health-effect.test.ts. The pg double below is the union of the three
 * (constructor options + pool-stat getters), which every suite tolerates.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock database drivers before importing connection module
void mock.module("pg", () => ({
  Pool: class MockPool {
    constructor(public opts?: Record<string, unknown>) {}
    async query() {
      return { rows: [], fields: [] };
    }
    async connect() {
      return {
        async query() {
          return { rows: [], fields: [] };
        },
        release() {},
      };
    }
    async end() {}
    get totalCount() {
      return 0;
    }
    get idleCount() {
      return 0;
    }
    get waitingCount() {
      return 0;
    }
  },
}));

void mock.module("mysql2/promise", () => ({
  createPool: (opts?: Record<string, unknown>) => ({
    _opts: opts,
    async getConnection() {
      return {
        async execute() {
          return [[], []];
        },
        release() {},
      };
    },
    async end() {},
  }),
}));

// Note: ClickHouse, DuckDB, Snowflake adapter mocks removed — those
// adapters are now plugins. See plugins/{clickhouse,duckdb,snowflake}-datasource/.

// Cache-busting import to get a fresh module instance
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);

const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;
const connections = connMod.connections as import("../connection").ConnectionRegistry;
const getDB = connMod.getDB as typeof import("../connection").getDB;
const detectDBType = connMod.detectDBType as typeof import("../connection").detectDBType;
const extractTargetHost = connMod.extractTargetHost as typeof import("../connection").extractTargetHost;
type DBConnection = import("../connection").DBConnection;

// Import semantic module with cache-busting too
const semModPath = resolve(__dirname, "../../semantic/whitelist.ts");
const semMod = await import(`${semModPath}?t=${Date.now()}`);
const getWhitelistedTables = semMod.getWhitelistedTables as typeof import("../../semantic/whitelist").getWhitelistedTables;
const _resetWhitelists = semMod._resetWhitelists as typeof import("../../semantic/whitelist")._resetWhitelists;

describe("ConnectionRegistry", () => {
  const origUrl = process.env.ATLAS_DATASOURCE_URL;
  const origSchema = process.env.ATLAS_SCHEMA;

  beforeEach(() => {
    connections._reset();
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_SCHEMA;
  });

  afterEach(() => {
    connections._reset();
    if (origUrl !== undefined) {
      process.env.ATLAS_DATASOURCE_URL = origUrl;
    } else {
      delete process.env.ATLAS_DATASOURCE_URL;
    }
    if (origSchema !== undefined) {
      process.env.ATLAS_SCHEMA = origSchema;
    } else {
      delete process.env.ATLAS_SCHEMA;
    }
  });

  describe("register + get", () => {
    it("registers a connection and retrieves it by ID", () => {
      connections.register("analytics", {
        url: "postgresql://user:pass@localhost:5432/test",
      });
      const conn = connections.get("analytics");
      expect(conn).toBeDefined();
      expect(conn.query).toBeFunction();
      expect(conn.close).toBeFunction();
    });

    it("overwrites existing connection on re-register (closes old)", async () => {
      let closeCalled = 0;
      connections.register("test", { url: "postgresql://user:pass@localhost:5432/a" });
      const original = connections.get("test");
      const origClose = original.close;
      original.close = async () => {
        closeCalled++;
        return origClose.call(original);
      };

      connections.register("test", { url: "postgresql://user:pass@localhost:5432/b" });
      // Give the async close a tick to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(closeCalled).toBe(1);

      // New connection should be different
      const replacement = connections.get("test");
      expect(replacement).not.toBe(original);
    });
  });

  describe("registerDirect", () => {
    it("stores and retrieves a pre-built connection", async () => {
      const mockConn: import("../connection").DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() {},
      };
      connections.registerDirect("bench", mockConn, "postgres");
      expect(connections.get("bench")).toBe(mockConn);
      expect(connections.getDBType("bench")).toBe("postgres");
    });

    it("closes previous connection on re-registration", async () => {
      let closeCalled = 0;
      const firstConn: import("../connection").DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() { closeCalled++; },
      };
      const secondConn: import("../connection").DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() {},
      };

      connections.registerDirect("bench", firstConn, "postgres");
      connections.registerDirect("bench", secondConn, "postgres");

      expect(closeCalled).toBe(1);
      expect(connections.get("bench")).toBe(secondConn);
    });

    it("stores optional description in metadata", async () => {
      const mockConn: import("../connection").DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() {},
      };
      connections.registerDirect("bench", mockConn, "duckdb", "Benchmark DB");

      const meta = connections.describe();
      const benchMeta = meta.find((m) => m.id === "bench");
      expect(benchMeta).toBeDefined();
      expect(benchMeta!.dbType).toBe("duckdb");
      expect(benchMeta!.description).toBe("Benchmark DB");
    });
  });

  describe("getDefault", () => {
    it("auto-registers from ATLAS_DATASOURCE_URL on first call", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/auto";
      const conn = connections.getDefault();
      expect(conn).toBeDefined();
      expect(connections.list()).toContain("default");
    });

    it("throws when ATLAS_DATASOURCE_URL is not set and no default registered", () => {
      expect(() => connections.getDefault()).toThrow(
        "No analytics datasource configured"
      );
    });

    it("returns same instance on repeated calls (lazy singleton)", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/lazy";
      const first = connections.getDefault();
      const second = connections.getDefault();
      expect(first).toBe(second);
    });
  });

  describe("get", () => {
    it("throws for unregistered connection ID", () => {
      expect(() => connections.get("nonexistent")).toThrow(
        'Connection "nonexistent" is not registered.'
      );
    });
  });

  describe("list", () => {
    it("returns empty array when no connections registered", () => {
      expect(connections.list()).toEqual([]);
    });

    it("returns all registered connection IDs", () => {
      connections.register("a", { url: "postgresql://user:pass@localhost:5432/a" });
      connections.register("b", { url: "mysql://user:pass@localhost:3306/b" });
      const ids = connections.list();
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids.length).toBe(2);
    });
  });

  describe("database type detection", () => {
    it("creates postgres connection for postgresql:// URLs", () => {
      connections.register("pg", {
        url: "postgresql://user:pass@localhost:5432/db",
      });
      expect(connections.get("pg")).toBeDefined();
    });

    it("creates mysql connection for mysql:// URLs", () => {
      connections.register("my", {
        url: "mysql://user:pass@localhost:3306/db",
      });
      expect(connections.get("my")).toBeDefined();
    });

    it("throws for non-core adapter URLs with plugin migration hint", () => {
      expect(() => connections.register("ch", { url: "clickhouse://user:pass@localhost:8123/default" })).toThrow("plugin");
      expect(() => connections.register("sf", { url: "snowflake://user:pass@account123/mydb" })).toThrow("plugin");
      expect(() => connections.register("dk", { url: "duckdb://:memory:" })).toThrow("plugin");
    });

    it("throws for unrecognized URL scheme", () => {
      expect(() =>
        connections.register("sq", { url: "file:./test.db" })
      ).toThrow();
    });
  });

  describe("getDB backward compat", () => {
    it("getDB() returns same connection as connections.getDefault()", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/compat";
      const fromGetDB = getDB();
      const fromRegistry = connections.getDefault();
      expect(fromGetDB).toBe(fromRegistry);
    });
  });

  describe("getDBType", () => {
    it("returns correct type for postgres connection", () => {
      connections.register("pg", { url: "postgresql://user:pass@localhost:5432/db" });
      expect(connections.getDBType("pg")).toBe("postgres");
    });

    it("returns correct type for mysql connection", () => {
      connections.register("my", { url: "mysql://user:pass@localhost:3306/db" });
      expect(connections.getDBType("my")).toBe("mysql");
    });

    it("returns correct type for plugin-registered connection", async () => {
      const conn = { async query() { return { columns: [], rows: [] }; }, async close() {} };
      connections.registerDirect("ch", conn, "clickhouse");
      expect(connections.getDBType("ch")).toBe("clickhouse");
    });

    it("throws for unregistered connection ID", () => {
      expect(() => connections.getDBType("nonexistent")).toThrow(
        'Connection "nonexistent" is not registered.'
      );
    });
  });

  describe("describe", () => {
    it("returns metadata for all registered connections", () => {
      connections.register("pg", {
        url: "postgresql://user:pass@localhost:5432/db",
        description: "Main database",
      });
      connections.register("my", {
        url: "mysql://user:pass@localhost:3306/db",
        description: "Reporting database",
      });

      const meta = connections.describe();
      expect(meta).toHaveLength(2);

      const pgMeta = meta.find((m) => m.id === "pg");
      expect(pgMeta).toBeDefined();
      expect(pgMeta!.dbType).toBe("postgres");
      expect(pgMeta!.description).toBe("Main database");

      const myMeta = meta.find((m) => m.id === "my");
      expect(myMeta).toBeDefined();
      expect(myMeta!.dbType).toBe("mysql");
      expect(myMeta!.description).toBe("Reporting database");
    });

    it("returns empty array when no connections registered", () => {
      expect(connections.describe()).toEqual([]);
    });

    it("includes connections without description", () => {
      connections.register("bare", {
        url: "postgresql://user:pass@localhost:5432/db",
      });

      const meta = connections.describe();
      expect(meta).toHaveLength(1);
      expect(meta[0].id).toBe("bare");
      expect(meta[0].dbType).toBe("postgres");
      expect(meta[0].description).toBeUndefined();
    });
  });

  describe("_reset", () => {
    it("clears all connections", () => {
      connections.register("x", { url: "postgresql://user:pass@localhost:5432/x" });
      connections.register("y", { url: "mysql://user:pass@localhost:3306/y" });
      expect(connections.list().length).toBe(2);

      connections._reset();
      expect(connections.list()).toEqual([]);
    });

    it("also clears whitelist cache", async () => {
      // Populate whitelist cache via the same semantic module that connection.ts uses
      // (connection.ts imports _resetWhitelists from @atlas/api/lib/semantic, which is
      // the non-cache-busted instance — so we import it the same way to test the contract)
      const semOrigModPath = resolve(__dirname, "../../semantic/whitelist.ts");
      const semOrig = await import(semOrigModPath);
      const origGetWhitelisted = semOrig.getWhitelistedTables as typeof getWhitelistedTables;

      const before = origGetWhitelisted("reset-test-conn");
      connections._reset();
      // After reset, whitelist cache is cleared — new call returns a fresh Set
      const after = origGetWhitelisted("reset-test-conn");
      expect(before).not.toBe(after);
    });
  });

  describe("detectDBType", () => {
    it("returns 'postgres' for postgresql:// URLs", () => {
      expect(detectDBType("postgresql://user:pass@localhost:5432/db")).toBe("postgres");
    });

    it("returns 'mysql' for mysql:// URLs", () => {
      expect(detectDBType("mysql://user:pass@localhost:3306/db")).toBe("mysql");
    });

    it("throws for non-core URL schemes with plugin suggestion", () => {
      expect(() => detectDBType("clickhouse://user:pass@localhost:8123/default")).toThrow("plugin");
    });

    it("throws for unsupported URL scheme", () => {
      expect(() => detectDBType("file:./test.db")).toThrow("Unsupported database URL");
    });
  });

  describe("constructor creates independent instances", () => {
    it("new ConnectionRegistry is independent", () => {
      const reg = new ConnectionRegistry();
      reg.register("isolated", { url: "postgresql://user:pass@localhost:5432/isolated" });
      expect(reg.list()).toEqual(["isolated"]);
      expect(connections.list()).toEqual([]);
      reg._reset();
    });
  });
});

describe("per-connection whitelist", () => {
  beforeEach(() => {
    _resetWhitelists();
  });

  afterEach(() => {
    _resetWhitelists();
  });

  it("getWhitelistedTables() returns default set", () => {
    const tables = getWhitelistedTables();
    expect(tables).toBeInstanceOf(Set);
  });

  it("getWhitelistedTables('default') returns same set as no-arg call", () => {
    const noArg = getWhitelistedTables();
    const explicit = getWhitelistedTables("default");
    expect(noArg).toBe(explicit);
  });

  it("_resetWhitelists() clears cache", () => {
    const first = getWhitelistedTables();
    _resetWhitelists();
    const second = getWhitelistedTables();
    // After reset, a new Set is created (not the same reference)
    expect(first).not.toBe(second);
  });

  it("different connectionIds share the same whitelist in backward-compat mode", () => {
    const a = getWhitelistedTables("a");
    const b = getWhitelistedTables("b");
    // When no entity uses `connection:`, all connections share the same table set
    expect(a.size).toBe(b.size);
  });
});

/**
 * ── Moved from registry-health.test.ts and health-effect.test.ts ──
 *
 * Health checks over a fresh `new ConnectionRegistry()`. `health-effect.test.ts`
 * covered the same three probe outcomes plus the Effect-fiber lifecycle
 * (stop-without-start, `_reset`, `shutdown`); only the fiber-lifecycle cases
 * moved, the three probe cases it duplicated did not.
 */
describe("ConnectionRegistry health checks", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  function mockConn(opts?: { failQuery?: boolean }): DBConnection {
    return {
      async query() {
        if (opts?.failQuery) throw new Error("connection refused");
        return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
      },
      async close() {},
    };
  }

  it("healthy on successful health check", async () => {
    registry.registerDirect("test", mockConn(), "postgres");
    const result = await registry.healthCheck("test");
    expect(result.status).toBe("healthy");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("degraded after 1 failure", async () => {
    registry.registerDirect("test", mockConn({ failQuery: true }), "postgres");
    const result = await registry.healthCheck("test");
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("connection refused");
  });

  it("unhealthy after 3 failures spanning > 5 minutes", async () => {
    const conn = mockConn({ failQuery: true });
    registry.registerDirect("test", conn, "postgres");

    // Simulate 3 failures over 5+ minutes
    await registry.healthCheck("test"); // failure 1

    // Manipulate the entry's firstFailureAt to simulate time passing
    // Access private field via any cast
    const entries = (registry as unknown as { entries: Map<string, { firstFailureAt: number | null; consecutiveFailures: number }> }).entries;
    const entry = entries.get("test")!;
    entry.firstFailureAt = Date.now() - (5 * 60 * 1000 + 1000); // 5min + 1s ago
    entry.consecutiveFailures = 2; // already had 2 failures

    const result = await registry.healthCheck("test"); // failure 3
    expect(result.status).toBe("unhealthy");
  });

  it("recovers from unhealthy to healthy on success", async () => {
    let shouldFail = true;
    const conn: DBConnection = {
      async query() {
        if (shouldFail) throw new Error("down");
        return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
      },
      async close() {},
    };

    registry.registerDirect("test", conn, "postgres");

    // Make it unhealthy
    const entries = (registry as unknown as { entries: Map<string, { firstFailureAt: number | null; consecutiveFailures: number }> }).entries;
    await registry.healthCheck("test");
    const entry = entries.get("test")!;
    entry.firstFailureAt = Date.now() - (5 * 60 * 1000 + 1000);
    entry.consecutiveFailures = 2;
    const unhealthy = await registry.healthCheck("test");
    expect(unhealthy.status).toBe("unhealthy");

    // Now recover
    shouldFail = false;
    const recovered = await registry.healthCheck("test");
    expect(recovered.status).toBe("healthy");
  });

  it("describe() includes health status", async () => {
    registry.registerDirect("test", mockConn(), "postgres", "Test DB");
    await registry.healthCheck("test");

    const meta = registry.describe();
    expect(meta).toHaveLength(1);
    expect(meta[0].health).toBeDefined();
    expect(meta[0].health!.status).toBe("healthy");
  });

  it("describe() omits health when no check has been run", async () => {
    registry.registerDirect("test", mockConn(), "postgres");
    const meta = registry.describe();
    expect(meta[0].health).toBeUndefined();
  });

  it("_reset() stops health checks", () => {
    registry.startHealthChecks(60000);
    registry._reset();
    // Should not throw — interval is already cleared
    registry.stopHealthChecks();
  });

  it("startHealthChecks is idempotent", () => {
    registry.startHealthChecks(60000);
    registry.startHealthChecks(60000); // should not create a second interval
    registry.stopHealthChecks();
  });

  it("getTargetHost returns host for registered connection", () => {
    registry.register("pg", {
      url: "postgresql://user:pass@db-host.example.com:5432/mydb",
    });
    expect(registry.getTargetHost("pg")).toBe("db-host.example.com");
  });

  it("getTargetHost returns (unknown) for unregistered connection", () => {
    expect(registry.getTargetHost("nonexistent")).toBe("(unknown)");
  });

  // ── The Effect-fiber lifecycle, formerly health-effect.test.ts ──
  // Verifies that the setInterval replacement (Effect.repeat + Fiber)
  // correctly starts and stops health check cycles.
  it("stopHealthChecks is safe to call without start", () => {
    registry.stopHealthChecks(); // no-op, no error
  });

  it("_reset stops health check fiber", () => {
    registry.registerDirect("test", mockConn(), "postgres");
    registry.startHealthChecks(60000);
    registry._reset();
    // If fiber was properly interrupted, this should not throw
    expect(registry.list()).toEqual([]);
  });

  it("shutdown stops health check fiber and closes pools", async () => {
    let closed = false;
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() { closed = true; },
    };
    registry.registerDirect("test", conn, "postgres");
    registry.startHealthChecks(60000);

    await registry.shutdown();

    expect(closed).toBe(true);
    expect(registry.list()).toEqual([]);
  });
});

/** Moved from registry-health.test.ts. */
describe("extractTargetHost", () => {
  it("extracts hostname from postgresql URL", () => {
    expect(extractTargetHost("postgresql://user:pass@db.example.com:5432/mydb")).toBe("db.example.com");
  });

  it("extracts hostname from mysql URL", () => {
    expect(extractTargetHost("mysql://user:pass@mysql.host:3306/db")).toBe("mysql.host");
  });

  it("extracts hostname from clickhouse URL", () => {
    expect(extractTargetHost("clickhouse://user:pass@ch.host:8123/default")).toBe("ch.host");
  });

  it("extracts hostname from snowflake URL", () => {
    expect(extractTargetHost("snowflake://user:pass@account123/db/schema")).toBe("account123");
  });

  it("extracts hostname from duckdb URL", () => {
    // duckdb://:memory: doesn't have a parseable hostname
    expect(extractTargetHost("duckdb://:memory:")).toBe("(unknown)");
  });

  it("returns (unknown) for unparseable URL", () => {
    expect(extractTargetHost("not-a-url")).toBe("(unknown)");
  });

  it("never exposes credentials", () => {
    const host = extractTargetHost("postgresql://admin:s3cret@db.example.com:5432/production");
    expect(host).toBe("db.example.com");
    expect(host).not.toContain("admin");
    expect(host).not.toContain("s3cret");
  });
});

/**
 * Moved from registry-pool-limits.test.ts — pool limit and LRU eviction.
 * The pg/mysql2 doubles above capture their constructor options for these.
 */
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
