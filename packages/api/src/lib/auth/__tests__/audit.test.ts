import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import type { AtlasUser } from "../types";
import { logQueryAudit } from "../audit";

/**
 * Audit tests use _resetPool() to inject a mock pg.Pool into the real
 * internal.ts module. This avoids mock.module which is unreliable in
 * bun's full test suite (module caching across files).
 */

// Capture pool.query calls for assertion
let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    return { rows: [] };
  },
  end: async () => {},
  on: () => {},
};

describe("logQueryAudit()", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryThrow = null;
  });

  afterEach(() => {
    // Restore original state
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool(null);
  });

  /** Enable the internal DB path by setting env var + injecting mock pool */
  function enableInternalDB() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
  }

  it("inserts into audit_log with correct params when internal DB is available", () => {
    enableInternalDB();
    const user: AtlasUser = { id: "u1", label: "test@example.com", mode: "managed" };

    withRequestContext({ requestId: "req-1", user }, () => {
      logQueryAudit({
        sql: "SELECT 1",
        durationMs: 42,
        rowCount: 1,
        success: true,
      });
    });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].sql).toContain("INSERT INTO audit_log");
    expect(queryCalls[0].params).toEqual([
      "u1",
      "test@example.com",
      "managed",
      "SELECT 1",
      42,
      1,
      true,
      null,
      null, // source_id
      null, // source_type
      null, // target_host
    ]);
  });

  it("includes source fields in audit insert when provided", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: 1,
      success: true,
      sourceId: "warehouse",
      sourceType: "postgres",
      targetHost: "db.example.com",
    });

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0].params!;
    expect(params[8]).toBe("warehouse");   // source_id
    expect(params[9]).toBe("postgres");    // source_type
    expect(params[10]).toBe("db.example.com"); // target_host
  });

  it("does not insert when internal DB is not available", () => {
    delete process.env.DATABASE_URL;
    _resetPool(null);

    expect(() =>
      logQueryAudit({
        sql: "SELECT 1",
        durationMs: 10,
        rowCount: 1,
        success: true,
      }),
    ).not.toThrow();

    expect(queryCalls).toHaveLength(0);
  });

  it("does not throw when DB insert fails", () => {
    enableInternalDB();
    queryThrow = new Error("connection lost");

    expect(() =>
      logQueryAudit({
        sql: "SELECT 1",
        durationMs: 5,
        rowCount: null,
        success: false,
        error: "timeout",
      }),
    ).not.toThrow();
  });

  it("preserves full SQL for DB insert when under 2000 chars", () => {
    enableInternalDB();
    const longSql = "SELECT " + "x".repeat(600); // 607 chars

    logQueryAudit({ sql: longSql, durationMs: 10, rowCount: 5, success: true });

    expect(queryCalls[0].params![3]).toBe(longSql);
  });

  it("truncates SQL to 2000 chars for DB when over limit", () => {
    enableInternalDB();
    const longSql = "SELECT " + "x".repeat(2500); // 2507 chars

    logQueryAudit({ sql: longSql, durationMs: 10, rowCount: 5, success: true });

    expect((queryCalls[0].params![3] as string).length).toBe(2000);
  });

  it("scrubs errors containing 'password' in DB insert", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "password authentication failed for user 'atlas'",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs errors containing 'secret' in DB insert", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "missing secret key",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs errors containing 'credential' in DB insert", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "invalid credential provided",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs errors containing 'connection_string' or 'connectionstring'", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "invalid connection_string format",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "bad connectionstring provided",
    });

    expect(queryCalls[1].params![7]).toBe("[scrubbed]");
  });

  it("scrubs case-insensitively (uppercase sensitive keywords)", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "AUTHENTICATION PASSWORD FAILED",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs MySQL 'Access denied for user' errors", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "Access denied for user 'root'@'localhost' (using password: YES)",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs MySQL ER_ACCESS_DENIED_ERROR", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "ER_ACCESS_DENIED_ERROR: Access denied",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs MySQL PROTOCOL_CONNECTION_LOST", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "PROTOCOL_CONNECTION_LOST: server closed the connection unexpectedly",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs ClickHouse UNKNOWN_USER error", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "UNKNOWN_USER: no user with such name: analyst",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs ClickHouse WRONG_PASSWORD error", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "WRONG_PASSWORD: password is incorrect for user default",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs ClickHouse IP_ADDRESS_NOT_ALLOWED error", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "IP_ADDRESS_NOT_ALLOWED: 10.0.0.5 is not allowed to connect",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("scrubs ClickHouse ALL_CONNECTION_TRIES_FAILED error", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "ALL_CONNECTION_TRIES_FAILED: could not connect to clickhouse-server:9000",
    });

    expect(queryCalls[0].params![7]).toBe("[scrubbed]");
  });

  it("does not scrub non-sensitive errors", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "column bad_col does not exist",
    });

    expect(queryCalls[0].params![7]).toBe("column bad_col does not exist");
  });

  it("pulls user identity from request context", () => {
    enableInternalDB();
    const user: AtlasUser = { id: "user-abc", label: "admin@co.com", mode: "simple-key" };

    withRequestContext({ requestId: "req-42", user }, () => {
      logQueryAudit({ sql: "SELECT 1", durationMs: 5, rowCount: 1, success: true });
    });

    expect(queryCalls[0].params![0]).toBe("user-abc");
    expect(queryCalls[0].params![1]).toBe("admin@co.com");
    expect(queryCalls[0].params![2]).toBe("simple-key");
  });

  it("uses auth_mode 'none' when no request context exists", () => {
    enableInternalDB();

    logQueryAudit({ sql: "SELECT 1", durationMs: 5, rowCount: 1, success: true });

    expect(queryCalls[0].params![0]).toBeNull(); // user_id
    expect(queryCalls[0].params![1]).toBeNull(); // user_label
    expect(queryCalls[0].params![2]).toBe("none"); // auth_mode
  });

  it("records success=false and error for failed queries", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT bad_col FROM t",
      durationMs: 3,
      rowCount: null,
      success: false,
      error: "column bad_col does not exist",
    });

    expect(queryCalls[0].params![5]).toBeNull(); // row_count
    expect(queryCalls[0].params![6]).toBe(false); // success
    expect(queryCalls[0].params![7]).toBe("column bad_col does not exist");
  });

  it("records null error for successful queries", () => {
    enableInternalDB();

    logQueryAudit({ sql: "SELECT 1", durationMs: 5, rowCount: 10, success: true });

    expect(queryCalls[0].params![5]).toBe(10); // row_count
    expect(queryCalls[0].params![6]).toBe(true); // success
    expect(queryCalls[0].params![7]).toBeNull(); // error
  });

  it("treats empty string error as no error (null in DB)", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: "",
    });

    expect(queryCalls[0].params![7]).toBeNull();
  });

  it("treats explicit undefined error as null in DB", () => {
    enableInternalDB();

    logQueryAudit({
      sql: "SELECT 1",
      durationMs: 10,
      rowCount: null,
      success: false,
      error: undefined,
    });

    expect(queryCalls[0].params![7]).toBeNull();
  });
});
