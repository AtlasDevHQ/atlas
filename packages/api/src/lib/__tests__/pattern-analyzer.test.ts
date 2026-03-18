/**
 * Unit tests for pattern-analyzer.ts — SQL normalization, fingerprinting,
 * and structural pattern extraction.
 *
 * normalizeSQL, fingerprintSQL, and extractPatternInfo are pure (no I/O).
 * loadYamlQueryPatterns reads the filesystem but is tested against a known fixture directory.
 */
import { describe, test, expect } from "bun:test";
import {
  normalizeSQL,
  fingerprintSQL,
  extractPatternInfo,
  loadYamlQueryPatterns,
} from "@atlas/api/lib/learn/pattern-analyzer";
import * as path from "path";

// ── normalizeSQL ───────────────────────────────────────────────────

describe("normalizeSQL", () => {
  test("collapses whitespace and lowercases", () => {
    expect(normalizeSQL("SELECT  *  \n FROM  users")).toBe(
      "select * from users",
    );
  });

  test("strips line comments", () => {
    expect(normalizeSQL("SELECT * FROM users -- get all users")).toBe(
      "select * from users",
    );
  });

  test("strips block comments", () => {
    expect(normalizeSQL("SELECT /* columns */ * FROM users")).toBe(
      "select * from users",
    );
  });

  test("normalizes string literals", () => {
    expect(normalizeSQL("SELECT * FROM users WHERE name = 'John'")).toBe(
      "select * from users where name = '?'",
    );
  });

  test("normalizes escaped string literals", () => {
    expect(normalizeSQL("SELECT * FROM users WHERE name = 'O''Brien'")).toBe(
      "select * from users where name = '?'",
    );
  });

  test("normalizes numeric literals", () => {
    expect(normalizeSQL("SELECT * FROM users WHERE age > 30")).toBe(
      "select * from users where age > ?",
    );
  });

  test("normalizes decimal literals", () => {
    // 19.99 → ? (the \d+(?:\.\d+)? regex matches the full decimal)
    expect(normalizeSQL("SELECT * FROM products WHERE price > 19.99")).toBe(
      "select * from products where price > ?",
    );
  });

  test("removes LIMIT clause", () => {
    expect(normalizeSQL("SELECT * FROM users LIMIT 100")).toBe(
      "select * from users",
    );
  });

  test("removes OFFSET clause", () => {
    expect(normalizeSQL("SELECT * FROM users LIMIT 100 OFFSET 50")).toBe(
      "select * from users",
    );
  });

  test("produces same result for queries differing only in literals", () => {
    const a = normalizeSQL(
      "SELECT * FROM users WHERE name = 'Alice' LIMIT 10",
    );
    const b = normalizeSQL("SELECT * FROM users WHERE name = 'Bob' LIMIT 20");
    expect(a).toBe(b);
  });

  test("produces different results for structurally different queries", () => {
    const a = normalizeSQL("SELECT * FROM users WHERE name = 'Alice'");
    const b = normalizeSQL("SELECT * FROM orders WHERE status = 'active'");
    expect(a).not.toBe(b);
  });

  test("handles empty input", () => {
    expect(normalizeSQL("")).toBe("");
    expect(normalizeSQL("   ")).toBe("");
  });
});

// ── fingerprintSQL ─────────────────────────────────────────────────

describe("fingerprintSQL", () => {
  test("returns a 16-char hex string", () => {
    const fp = fingerprintSQL("select * from users");
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  test("same input produces same fingerprint", () => {
    expect(fingerprintSQL("select * from users")).toBe(
      fingerprintSQL("select * from users"),
    );
  });

  test("different input produces different fingerprint", () => {
    expect(fingerprintSQL("select * from users")).not.toBe(
      fingerprintSQL("select * from orders"),
    );
  });
});

// ── extractPatternInfo ─────────────────────────────────────────────

describe("extractPatternInfo", () => {
  test("extracts tables from simple query", () => {
    const info = extractPatternInfo("SELECT * FROM users");
    expect(info).not.toBeNull();
    expect(info!.tables).toContain("users");
    expect(info!.primaryTable).toBe("users");
  });

  test("detects aggregation with GROUP BY", () => {
    const info = extractPatternInfo(
      "SELECT status, COUNT(*) FROM users GROUP BY status",
    );
    expect(info).not.toBeNull();
    expect(info!.hasAggregation).toBe(true);
    expect(info!.hasGroupBy).toBe(true);
    expect(info!.description).toContain("Aggregation");
  });

  test("detects summary (aggregation without GROUP BY)", () => {
    const info = extractPatternInfo("SELECT COUNT(*) FROM users");
    expect(info).not.toBeNull();
    expect(info!.hasAggregation).toBe(true);
    expect(info!.hasGroupBy).toBe(false);
    expect(info!.description).toContain("Summary");
  });

  test("detects joins", () => {
    const info = extractPatternInfo(
      "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id",
    );
    expect(info).not.toBeNull();
    expect(info!.hasJoins).toBe(true);
    expect(info!.tables.length).toBeGreaterThanOrEqual(2);
    expect(info!.description).toContain("joins");
  });

  test("returns null for unparseable SQL", () => {
    expect(extractPatternInfo("NOT VALID SQL AT ALL")).toBeNull();
  });

  test("returns null for non-SELECT statements", () => {
    // Parser may reject DML — either null or parse error is acceptable
    const info = extractPatternInfo("INSERT INTO users (name) VALUES ('a')");
    expect(info).toBeNull();
  });

  test("works with MySQL dialect", () => {
    const info = extractPatternInfo(
      "SELECT * FROM users WHERE id = 1",
      "MySQL",
    );
    expect(info).not.toBeNull();
    expect(info!.tables).toContain("users");
  });
});

// ── loadYamlQueryPatterns ──────────────────────────────────────────

describe("loadYamlQueryPatterns", () => {
  test("loads patterns from demo semantic directory", () => {
    // Use import.meta.dir for reliable resolution regardless of CWD
    const demoRoot = path.resolve(
      import.meta.dir,
      "../../../../cli/data/demo-semantic",
    );
    const patterns = loadYamlQueryPatterns(demoRoot);
    // The demo entities have query_patterns — should find at least some
    expect(patterns.size).toBeGreaterThan(0);
  });

  test("returns empty set for non-existent directory", () => {
    const patterns = loadYamlQueryPatterns("/tmp/does-not-exist-atlas-test");
    expect(patterns.size).toBe(0);
  });

  test("normalized patterns are deduplicated", () => {
    const demoRoot = path.resolve(
      import.meta.dir,
      "../../../../cli/data/demo-semantic",
    );
    const patterns = loadYamlQueryPatterns(demoRoot);
    // All entries should be lowercase (normalized)
    for (const p of patterns) {
      expect(p).toBe(p.toLowerCase());
    }
  });
});
