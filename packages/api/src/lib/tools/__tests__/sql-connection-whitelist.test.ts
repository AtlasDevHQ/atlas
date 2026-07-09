/**
 * Tests for per-connection table whitelist enforcement in validateSQL.
 *
 * Separated from sql.test.ts because it needs a different mock for
 * getWhitelistedTables that respects the connectionId parameter.
 */
import { describe, it, expect, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Mock getWhitelistedTables to return different sets per connectionId
void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: (connectionId?: string) => {
    switch (connectionId) {
      case "warehouse":
        return new Set(["events", "analytics.events"]);
      case "nonexistent":
        return new Set(); // empty — unknown connection
      case "scanfail":
        // A REGISTERED connection whose semantic directory scan FAILED, so its
        // whitelist came back empty (fail-closed, #3243). It must reject all
        // queries — never validate against the default group's tables.
        return new Set();
      default:
        return new Set(["orders", "users", "companies"]);
    }
  },
  _resetWhitelists: () => {},
}));

// Mock the DB connection — validateSQL doesn't need it, but the module
// imports it at the top level.
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      getDBType: (id?: string) => {
        if (id === "nonexistent") throw new Error(`Connection "nonexistent" is not registered.`);
        return "postgres" as const;
      },
      list: () => ["default", "warehouse"],
      describe: () => [
        { id: "default", dbType: "postgres" as const },
        { id: "warehouse", dbType: "postgres" as const },
      ],
      _reset: () => {},
    },
  }),
);

const { validateSQL } = await import("../sql");

describe("per-connection whitelist enforcement", () => {
  it("allows table in default connection whitelist", async () => {
    const result = await validateSQL("SELECT * FROM orders");
    expect(result.valid).toBe(true);
  });

  it("allows table in warehouse connection whitelist", async () => {
    const result = await validateSQL("SELECT * FROM events", "warehouse");
    expect(result.valid).toBe(true);
  });

  it("rejects table not in target connection whitelist", async () => {
    const result = await validateSQL("SELECT * FROM orders", "warehouse");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("rejects all tables for unknown connection", async () => {
    // getDBType throws for "nonexistent", so validateSQL returns an error
    const result = await validateSQL("SELECT * FROM orders", "nonexistent");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("default connection cannot access warehouse-only tables", async () => {
    const result = await validateSQL("SELECT * FROM events");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("allows schema-qualified table in warehouse whitelist", async () => {
    const result = await validateSQL("SELECT * FROM analytics.events", "warehouse");
    expect(result.valid).toBe(true);
  });

  it("rejects schema-qualified table not in warehouse whitelist", async () => {
    const result = await validateSQL("SELECT * FROM public.orders", "warehouse");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("fails closed: a registered connection whose scan failed (empty whitelist) rejects queries — not validated against default (#3243)", async () => {
    // `orders` IS in the default whitelist. The "scanfail" connection is
    // registered (getDBType returns postgres, no throw) but its whitelist is
    // empty because its semantic scan failed and fell back closed. The query
    // must be REJECTED — proving it did not silently validate against default.
    const result = await validateSQL("SELECT * FROM orders", "scanfail");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });
});
