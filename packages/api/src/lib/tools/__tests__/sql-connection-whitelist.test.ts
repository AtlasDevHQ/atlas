/**
 * Tests for per-connection table whitelist enforcement in validateSQL.
 *
 * Separated from sql.test.ts because it needs a different mock for
 * getWhitelistedTables that respects the connectionId parameter.
 */
import { describe, it, expect, mock } from "bun:test";

// Mock getWhitelistedTables to return different sets per connectionId
mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: (connectionId?: string) => {
    switch (connectionId) {
      case "warehouse":
        return new Set(["events", "analytics.events"]);
      case "nonexistent":
        return new Set(); // empty — unknown connection
      default:
        return new Set(["orders", "users", "companies"]);
    }
  },
  _resetWhitelists: () => {},
}));

// Mock the DB connection — validateSQL doesn't need it, but the module
// imports it at the top level.
mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({
    query: async () => ({ columns: [], rows: [] }),
    close: async () => {},
  }),
  connections: {
    get: () => ({
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
    }),
    getDefault: () => ({
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
    }),
    getDBType: (id?: string) => {
      if (id === "nonexistent") throw new Error(`Connection "nonexistent" is not registered.`);
      return "postgres" as const;
    },
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default", "warehouse"],
    describe: () => [
      { id: "default", dbType: "postgres" as const },
      { id: "warehouse", dbType: "postgres" as const },
    ],
    _reset: () => {},
  },
  detectDBType: () => "postgres" as const,
  ConnectionRegistry: class {},
}));

const { validateSQL } = await import("../sql");

describe("per-connection whitelist enforcement", () => {
  it("allows table in default connection whitelist", () => {
    const result = validateSQL("SELECT * FROM orders");
    expect(result.valid).toBe(true);
  });

  it("allows table in warehouse connection whitelist", () => {
    const result = validateSQL("SELECT * FROM events", "warehouse");
    expect(result.valid).toBe(true);
  });

  it("rejects table not in target connection whitelist", () => {
    const result = validateSQL("SELECT * FROM orders", "warehouse");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("rejects all tables for unknown connection", () => {
    // getDBType throws for "nonexistent", so validateSQL returns an error
    const result = validateSQL("SELECT * FROM orders", "nonexistent");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("default connection cannot access warehouse-only tables", () => {
    const result = validateSQL("SELECT * FROM events");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("allows schema-qualified table in warehouse whitelist", () => {
    const result = validateSQL("SELECT * FROM analytics.events", "warehouse");
    expect(result.valid).toBe(true);
  });

  it("rejects schema-qualified table not in warehouse whitelist", () => {
    const result = validateSQL("SELECT * FROM public.orders", "warehouse");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });
});
