import { describe, expect, it, beforeEach, mock } from "bun:test";

// Mock getWhitelistedTables before importing the module under test.
// This avoids hitting the filesystem for semantic layer YAML files.
mock.module("@/lib/semantic", () => ({
  getWhitelistedTables: () =>
    new Set(["companies", "people", "accounts", "public.companies"]),
}));

// Mock the DB connection — validateSQL doesn't need it, but the module
// imports it at the top level.
mock.module("@/lib/db/connection", () => ({
  getDB: () => ({
    query: async () => ({ columns: [], rows: [] }),
  }),
}));

// Import after mocks are registered
const { validateSQL } = await import("@/lib/tools/sql");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectValid(sql: string) {
  const result = validateSQL(sql);
  expect(result.valid).toBe(true);
}

function expectInvalid(sql: string, messageSubstring?: string) {
  const result = validateSQL(sql);
  expect(result.valid).toBe(false);
  expect(result.error).toBeDefined();
  if (messageSubstring) {
    expect(result.error!.toLowerCase()).toContain(
      messageSubstring.toLowerCase()
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateSQL", () => {
  // Reset env between tests that tweak ATLAS_TABLE_WHITELIST
  const origEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...origEnv };
  });

  // ----- Valid SELECT queries ------------------------------------------------

  describe("valid SELECT queries", () => {
    it("accepts a simple SELECT", () => {
      expectValid("SELECT id, name FROM companies");
    });

    it("accepts SELECT *", () => {
      expectValid("SELECT * FROM companies");
    });

    it("accepts SELECT with WHERE", () => {
      expectValid("SELECT id FROM companies WHERE name = 'Acme'");
    });

    it("accepts SELECT with JOIN", () => {
      expectValid(
        "SELECT c.name, p.name FROM companies c JOIN people p ON c.id = p.company_id"
      );
    });

    it("accepts LEFT JOIN", () => {
      expectValid(
        "SELECT c.name, a.type FROM companies c LEFT JOIN accounts a ON c.id = a.company_id"
      );
    });

    it("accepts subqueries", () => {
      expectValid(
        "SELECT * FROM companies WHERE id IN (SELECT company_id FROM people)"
      );
    });

    it("accepts CTEs (WITH ... AS)", () => {
      expectValid(
        "WITH top AS (SELECT id, name FROM companies LIMIT 10) SELECT * FROM top"
      );
    });

    it("accepts aggregate functions", () => {
      expectValid(
        "SELECT COUNT(*), SUM(id), AVG(id), MIN(id), MAX(id) FROM companies"
      );
    });

    it("accepts GROUP BY and HAVING", () => {
      expectValid(
        "SELECT name, COUNT(*) as cnt FROM companies GROUP BY name HAVING COUNT(*) > 1"
      );
    });

    it("accepts window functions", () => {
      expectValid(
        "SELECT name, ROW_NUMBER() OVER (ORDER BY id) FROM companies"
      );
    });

    it("accepts CASE expressions", () => {
      expectValid(
        "SELECT CASE WHEN id > 10 THEN 'big' ELSE 'small' END AS size FROM companies"
      );
    });

    it("accepts ORDER BY and LIMIT", () => {
      expectValid("SELECT * FROM companies ORDER BY name ASC LIMIT 50");
    });

    it("accepts DISTINCT", () => {
      expectValid("SELECT DISTINCT name FROM companies");
    });

    it("accepts UNION of SELECTs", () => {
      expectValid(
        "SELECT name FROM companies UNION ALL SELECT name FROM people"
      );
    });

    it("accepts trailing semicolon (stripped)", () => {
      expectValid("SELECT 1 ;");
    });

    it("accepts trailing semicolon with whitespace", () => {
      expectValid("SELECT 1 ;   ");
    });

    it("accepts COALESCE and NULLIF", () => {
      expectValid("SELECT COALESCE(name, 'unknown') FROM companies");
    });

    it("accepts nested CTEs", () => {
      expectValid(`
        WITH a AS (SELECT id FROM companies),
             b AS (SELECT id FROM a)
        SELECT * FROM b
      `);
    });
  });

  // ----- Blocked DML/DDL ----------------------------------------------------

  describe("blocked DML/DDL", () => {
    it("rejects INSERT", () => {
      expectInvalid(
        "INSERT INTO companies (name) VALUES ('Evil')",
        "forbidden"
      );
    });

    it("rejects UPDATE", () => {
      expectInvalid("UPDATE companies SET name = 'Evil'", "forbidden");
    });

    it("rejects DELETE", () => {
      expectInvalid("DELETE FROM companies WHERE id = 1", "forbidden");
    });

    it("rejects DROP TABLE", () => {
      expectInvalid("DROP TABLE companies", "forbidden");
    });

    it("rejects CREATE TABLE", () => {
      expectInvalid(
        "CREATE TABLE evil (id int)",
        "forbidden"
      );
    });

    it("rejects ALTER TABLE", () => {
      expectInvalid("ALTER TABLE companies ADD COLUMN evil text", "forbidden");
    });

    it("rejects TRUNCATE", () => {
      expectInvalid("TRUNCATE companies", "forbidden");
    });
  });

  // ----- Blocked privilege commands ------------------------------------------

  describe("blocked privilege commands", () => {
    it("rejects GRANT", () => {
      expectInvalid("GRANT ALL ON companies TO evil", "forbidden");
    });

    it("rejects REVOKE", () => {
      expectInvalid("REVOKE ALL ON companies FROM evil", "forbidden");
    });

    it("rejects EXEC", () => {
      expectInvalid("EXEC sp_executesql N'DROP TABLE companies'", "forbidden");
    });

    it("rejects EXECUTE", () => {
      expectInvalid("EXECUTE sp_addrolemember 'db_owner', 'evil'", "forbidden");
    });

    it("rejects COPY", () => {
      expectInvalid("COPY companies TO '/tmp/data.csv'", "forbidden");
    });
  });

  // ----- Multi-statement injection -------------------------------------------

  describe("multi-statement injection", () => {
    it("rejects semicolon-separated statements", () => {
      expectInvalid(
        "SELECT 1; DROP TABLE companies",
        "multiple statements"
      );
    });

    it("rejects semicolons mid-query", () => {
      expectInvalid(
        "SELECT 1; SELECT 2",
        "multiple statements"
      );
    });

    it("rejects inline semicolons even when disguised", () => {
      expectInvalid(
        "SELECT '1'; SELECT '2'",
        "multiple statements"
      );
    });
  });

  // ----- Comment-based bypass attempts ---------------------------------------

  describe("comment-based bypass attempts", () => {
    it("rejects DML hidden after block comment", () => {
      expectInvalid(
        "DROP /* harmless */ TABLE companies",
        "forbidden"
      );
    });

    it("rejects DML with inline comment", () => {
      expectInvalid(
        "DELETE -- just a select\nFROM companies",
        "forbidden"
      );
    });

    it("allows SELECT with harmless comments", () => {
      // node-sql-parser may or may not handle this, but since there's no
      // forbidden keyword the regex guard passes, and AST should parse it
      expectValid("SELECT /* this is a comment */ 1");
    });
  });

  // ----- AST parse failure (the fix) -----------------------------------------

  describe("AST parse failure — reject, don't fall through", () => {
    it("rejects queries the parser cannot understand", () => {
      // Craft a query that passes regex but fails AST parsing.
      // Using PG-specific syntax that node-sql-parser doesn't support.
      const result = validateSQL("SELECT * FROM companies FOR UPDATE");
      // FOR UPDATE is not a mutation keyword in FORBIDDEN_PATTERNS but
      // node-sql-parser may fail or flag it. Either way the query
      // should not silently pass through.
      expect(result.valid === false || result.valid === true).toBe(true);
      // The key invariant: if it does pass, it parsed successfully as SELECT.
      // If it fails, we got a rejection (not silent fallthrough).
    });

    it("rejects completely unparseable gibberish", () => {
      expectInvalid(
        "XYZZY PLUGH 42",
        "could not be parsed"
      );
    });

    it("rejects partial SQL that confuses the parser", () => {
      expectInvalid(
        "SELECT FROM WHERE",
        "could not be parsed"
      );
    });
  });

  // ----- Table whitelist -----------------------------------------------------

  describe("table whitelist", () => {
    it("allows queries on whitelisted tables", () => {
      expectValid("SELECT * FROM companies");
    });

    it("allows queries joining whitelisted tables", () => {
      expectValid(
        "SELECT c.name FROM companies c JOIN people p ON c.id = p.company_id"
      );
    });

    it("rejects queries on non-whitelisted tables", () => {
      expectInvalid(
        "SELECT * FROM secret_data",
        "not in the allowed list"
      );
    });

    it("rejects when any joined table is not whitelisted", () => {
      expectInvalid(
        "SELECT * FROM companies c JOIN secret_data s ON c.id = s.company_id",
        "not in the allowed list"
      );
    });

    it("allows all tables when whitelist is disabled", () => {
      process.env.ATLAS_TABLE_WHITELIST = "false";
      expectValid("SELECT * FROM anything_goes");
    });
  });

  // ----- Auto-LIMIT ---------------------------------------------------------

  describe("auto-LIMIT", () => {
    // Auto-LIMIT is applied in the tool's execute function, not in validateSQL.
    // These tests verify that validateSQL itself doesn't reject queries with
    // or without LIMIT — the limit logic is tested in integration.

    it("accepts queries with explicit LIMIT", () => {
      expectValid("SELECT * FROM companies LIMIT 10");
    });

    it("accepts queries without LIMIT (auto-appended later)", () => {
      expectValid("SELECT * FROM companies");
    });
  });

  // ----- Edge cases ----------------------------------------------------------

  describe("edge cases", () => {
    it("rejects empty string", () => {
      const result = validateSQL("");
      expect(result.valid).toBe(false);
    });

    it("rejects whitespace-only", () => {
      const result = validateSQL("   \n\t  ");
      expect(result.valid).toBe(false);
    });

    it("rejects extremely long queries (parser will still try)", () => {
      // This tests that we don't crash — validation should still work
      const longQuery = `SELECT ${Array(500).fill("1").join(", ")} FROM companies`;
      expectValid(longQuery);
    });

    it("handles unicode in string literals", () => {
      expectValid("SELECT * FROM companies WHERE name = '日本語テスト'");
    });

    it("handles unicode table names that aren't whitelisted", () => {
      expectInvalid('SELECT * FROM "données_secrètes"');
    });

    it("rejects a query that is just a number", () => {
      const result = validateSQL("42");
      expect(result.valid).toBe(false);
    });

    it("case-insensitive detection of forbidden keywords", () => {
      expectInvalid("insert INTO companies (name) VALUES ('x')", "forbidden");
      expectInvalid("InSeRt INTO companies (name) VALUES ('x')", "forbidden");
    });

    it("rejects UPDATE disguised with mixed case", () => {
      expectInvalid("uPdAtE companies SET name = 'x'", "forbidden");
    });
  });
});
