/**
 * Tests for the ConnectionRegistry class and per-connection whitelists.
 *
 * Uses the cache-busting import pattern from connection.test.ts to bypass
 * global mocks registered by other test files. Mocks pg and mysql2/promise
 * so register() can create connections without real databases.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock database drivers before importing connection module
mock.module("pg", () => ({
  Pool: class MockPool {
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
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => ({
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

// Import semantic module with cache-busting too
const semModPath = resolve(__dirname, "../../semantic.ts");
const semMod = await import(`${semModPath}?t=${Date.now()}`);
const getWhitelistedTables = semMod.getWhitelistedTables as typeof import("../../semantic").getWhitelistedTables;
const _resetWhitelists = semMod._resetWhitelists as typeof import("../../semantic")._resetWhitelists;

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
      await connections.registerDirect("bench", mockConn, "postgres");
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

      await connections.registerDirect("bench", firstConn, "postgres");
      await connections.registerDirect("bench", secondConn, "postgres");

      expect(closeCalled).toBe(1);
      expect(connections.get("bench")).toBe(secondConn);
    });

    it("stores optional description in metadata", async () => {
      const mockConn: import("../connection").DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() {},
      };
      await connections.registerDirect("bench", mockConn, "duckdb", "Benchmark DB");

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
      await connections.registerDirect("ch", conn, "clickhouse");
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
      const semOrigModPath = resolve(__dirname, "../../semantic.ts");
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
