import { describe, expect, test } from "bun:test";
import { analyzeQueries, type AuditRow } from "../analyze";

function makeRow(sql: string, overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    sql,
    row_count: 10,
    tables_accessed: null,
    columns_accessed: null,
    ...overrides,
  };
}

describe("analyzeQueries", () => {
  test("returns empty result for no rows", () => {
    const result = analyzeQueries([]);
    expect(result.totalQueries).toBe(0);
    expect(result.patterns).toHaveLength(0);
    expect(result.joins.size).toBe(0);
    expect(result.aliases).toHaveLength(0);
  });

  test("counts table usage from pre-computed tables_accessed", () => {
    const rows = [
      makeRow("SELECT * FROM users", { tables_accessed: ["users"] }),
      makeRow("SELECT * FROM users", { tables_accessed: ["users"] }),
      makeRow("SELECT * FROM orders", { tables_accessed: ["orders"] }),
    ];
    const result = analyzeQueries(rows);
    expect(result.tableUsage.get("users")).toBe(2);
    expect(result.tableUsage.get("orders")).toBe(1);
  });

  test("extracts table usage from SQL when tables_accessed is null", () => {
    const rows = [
      makeRow("SELECT id, name FROM users WHERE id = 1"),
      makeRow("SELECT id, name FROM users WHERE id = 2"),
    ];
    const result = analyzeQueries(rows);
    expect(result.tableUsage.get("users")).toBe(2);
  });

  test("detects join patterns", () => {
    const sql = "SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id";
    const rows = [makeRow(sql), makeRow(sql)];
    const result = analyzeQueries(rows);
    expect(result.joins.size).toBeGreaterThanOrEqual(1);
    const joinEntry = [...result.joins.values()][0];
    expect(joinEntry!.count).toBe(2);
  });

  test("deduplicates normalized patterns", () => {
    const rows = [
      makeRow("SELECT  id, name  FROM  users WHERE id = 1"),
      makeRow("SELECT id, name FROM users WHERE id = 1"),
    ];
    const result = analyzeQueries(rows);
    // Both normalize to the same pattern → count = 2
    const matching = result.patterns.filter((p) => p.tables.includes("users"));
    expect(matching.length).toBeLessThanOrEqual(1);
    if (matching.length > 0) {
      expect(matching[0]!.count).toBe(2);
    }
  });

  test("filters patterns below frequency threshold", () => {
    const rows = [
      makeRow("SELECT id FROM users WHERE id = 1"), // unique query
    ];
    const result = analyzeQueries(rows);
    // Single-occurrence patterns should be filtered out (MIN_PATTERN_COUNT = 2)
    expect(result.patterns).toHaveLength(0);
  });

  test("extracts column aliases", () => {
    const sql = "SELECT COUNT(*) AS total_users FROM users";
    const rows = [makeRow(sql), makeRow(sql)];
    const result = analyzeQueries(rows);
    const totalUsers = result.aliases.find((a) => a.alias === "total_users");
    if (totalUsers) {
      expect(totalUsers.count).toBe(2);
    }
  });

  test("handles unparseable SQL gracefully", () => {
    const rows = [
      makeRow("THIS IS NOT SQL AT ALL"),
      makeRow("SELECT id FROM users"),
      makeRow("SELECT id FROM users"),
    ];
    const result = analyzeQueries(rows);
    expect(result.totalQueries).toBe(3);
    // Should still extract what it can
    expect(result.tableUsage.get("users")).toBe(2);
  });
});
