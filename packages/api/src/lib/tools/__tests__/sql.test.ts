import { describe, expect, it, beforeEach, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Mock getWhitelistedTables before importing the module under test.
// This avoids hitting the filesystem for semantic layer YAML files.
// The whitelist includes both unqualified names (e.g. "companies") for default-schema
// queries and qualified names (e.g. "public.companies", "analytics.companies") for
// explicit schema-qualified queries. This mirrors real usage where atlas init adds
// qualified entries for non-public schemas.
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () =>
    new Set(["companies", "people", "accounts", "public.companies", "analytics.companies", "orders"]),
  _resetWhitelists: () => {},
}));

const mockDetectDBType = () => {
  const url = process.env.ATLAS_DATASOURCE_URL ?? "";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    return "postgres";
  }
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
    return "mysql";
  }
  throw new Error(`Unsupported database URL: "${url.slice(0, 40)}…".`);
};

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      getDBType: () => mockDetectDBType(),
    },
    detectDBType: mockDetectDBType,
  }),
);

// Import after mocks are registered
const { validateSQL } = await import("@atlas/api/lib/tools/sql");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function expectValid(sql: string) {
  const result = await validateSQL(sql);
  expect(result.valid).toBe(true);
}

async function expectInvalid(sql: string, messageSubstring?: string) {
  const result = await validateSQL(sql);
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
  // Reset env between tests that tweak ATLAS_TABLE_WHITELIST.
  // Force PostgreSQL mode — existing tests were written for it.
  const origEnv = { ...process.env, ATLAS_DATASOURCE_URL: "postgresql://test:test@localhost:5432/test" };
  beforeEach(() => {
    process.env = { ...origEnv };
  });

  // ----- Valid SELECT queries ------------------------------------------------

  describe("valid SELECT queries", () => {
    it("accepts a simple SELECT", async () => {
      await expectValid("SELECT id, name FROM companies");
    });

    it("accepts SELECT *", async () => {
      await expectValid("SELECT * FROM companies");
    });

    it("accepts SELECT with WHERE", async () => {
      await expectValid("SELECT id FROM companies WHERE name = 'Acme'");
    });

    it("accepts SELECT with JOIN", async () => {
      await expectValid(
        "SELECT c.name, p.name FROM companies c JOIN people p ON c.id = p.company_id"
      );
    });

    it("accepts LEFT JOIN", async () => {
      await expectValid(
        "SELECT c.name, a.type FROM companies c LEFT JOIN accounts a ON c.id = a.company_id"
      );
    });

    it("accepts subqueries", async () => {
      await expectValid(
        "SELECT * FROM companies WHERE id IN (SELECT company_id FROM people)"
      );
    });

    it("accepts CTEs (WITH ... AS)", async () => {
      await expectValid(
        "WITH top AS (SELECT id, name FROM companies LIMIT 10) SELECT * FROM top"
      );
    });

    it("accepts aggregate functions", async () => {
      await expectValid(
        "SELECT COUNT(*), SUM(id), AVG(id), MIN(id), MAX(id) FROM companies"
      );
    });

    it("accepts GROUP BY and HAVING", async () => {
      await expectValid(
        "SELECT name, COUNT(*) as cnt FROM companies GROUP BY name HAVING COUNT(*) > 1"
      );
    });

    it("accepts window functions", async () => {
      await expectValid(
        "SELECT name, ROW_NUMBER() OVER (ORDER BY id) FROM companies"
      );
    });

    it("accepts CASE expressions", async () => {
      await expectValid(
        "SELECT CASE WHEN id > 10 THEN 'big' ELSE 'small' END AS size FROM companies"
      );
    });

    it("accepts ORDER BY and LIMIT", async () => {
      await expectValid("SELECT * FROM companies ORDER BY name ASC LIMIT 50");
    });

    it("accepts DISTINCT", async () => {
      await expectValid("SELECT DISTINCT name FROM companies");
    });

    it("accepts UNION of SELECTs", async () => {
      await expectValid(
        "SELECT name FROM companies UNION ALL SELECT name FROM people"
      );
    });

    it("accepts trailing semicolon (stripped)", async () => {
      await expectValid("SELECT 1 ;");
    });

    it("accepts trailing semicolon with whitespace", async () => {
      await expectValid("SELECT 1 ;   ");
    });

    it("accepts COALESCE", async () => {
      await expectValid("SELECT COALESCE(name, 'unknown') FROM companies");
    });

    it("accepts nested CTEs", async () => {
      await expectValid(`
        WITH a AS (SELECT id FROM companies),
             b AS (SELECT id FROM a)
        SELECT * FROM b
      `);
    });

    it("accepts semicolons inside string literals", async () => {
      // Semicolons in data values are legitimate — the AST parser handles
      // them correctly as part of the string, not as statement separators.
      await expectValid("SELECT * FROM companies WHERE name = 'foo;bar'");
    });
  });

  // ----- Blocked DML/DDL ----------------------------------------------------

  describe("blocked DML/DDL", () => {
    it("rejects INSERT", async () => {
      await expectInvalid(
        "INSERT INTO companies (name) VALUES ('Evil')",
        "forbidden"
      );
    });

    it("rejects UPDATE", async () => {
      await expectInvalid("UPDATE companies SET name = 'Evil'", "forbidden");
    });

    it("rejects DELETE", async () => {
      await expectInvalid("DELETE FROM companies WHERE id = 1", "forbidden");
    });

    it("rejects DROP TABLE", async () => {
      await expectInvalid("DROP TABLE companies", "forbidden");
    });

    it("rejects CREATE TABLE", async () => {
      await expectInvalid(
        "CREATE TABLE evil (id int)",
        "forbidden"
      );
    });

    it("rejects ALTER TABLE", async () => {
      await expectInvalid("ALTER TABLE companies ADD COLUMN evil text", "forbidden");
    });

    it("rejects TRUNCATE", async () => {
      await expectInvalid("TRUNCATE companies", "forbidden");
    });
  });

  // ----- Blocked privilege / admin commands -----------------------------------

  describe("blocked privilege and admin commands", () => {
    it("rejects GRANT", async () => {
      await expectInvalid("GRANT ALL ON companies TO evil", "forbidden");
    });

    it("rejects REVOKE", async () => {
      await expectInvalid("REVOKE ALL ON companies FROM evil", "forbidden");
    });

    it("rejects EXEC", async () => {
      await expectInvalid("EXEC sp_executesql N'DROP TABLE companies'", "forbidden");
    });

    it("rejects EXECUTE", async () => {
      await expectInvalid("EXECUTE sp_addrolemember 'db_owner', 'evil'", "forbidden");
    });

    it("rejects CALL", async () => {
      await expectInvalid("CALL some_procedure()", "forbidden");
    });

    it("rejects COPY", async () => {
      await expectInvalid("COPY companies TO '/tmp/data.csv'", "forbidden");
    });

    it("rejects LOAD", async () => {
      await expectInvalid("LOAD DATA INFILE '/tmp/data.csv' INTO TABLE companies", "forbidden");
    });

    it("rejects VACUUM", async () => {
      await expectInvalid("VACUUM companies", "forbidden");
    });

    it("rejects REINDEX", async () => {
      await expectInvalid("REINDEX TABLE companies", "forbidden");
    });

    it("rejects OPTIMIZE TABLE", async () => {
      await expectInvalid("OPTIMIZE TABLE companies", "forbidden");
    });

    it("rejects INTO OUTFILE", async () => {
      await expectInvalid(
        "SELECT * INTO OUTFILE '/tmp/dump.csv' FROM companies",
        "forbidden"
      );
    });
  });

  // ----- Multi-statement injection -------------------------------------------

  describe("multi-statement injection", () => {
    it("rejects semicolon-separated SELECT + DML", async () => {
      // DML caught by regex guard before AST even runs
      await expectInvalid("SELECT 1; DROP TABLE companies", "forbidden");
    });

    it("rejects two SELECT statements", async () => {
      await expectInvalid("SELECT 1; SELECT 2", "multiple statements");
    });

    it("rejects two statements with string literals", async () => {
      await expectInvalid("SELECT '1'; SELECT '2'", "multiple statements");
    });
  });

  // ----- Comment-based bypass attempts ---------------------------------------

  describe("comment-based bypass attempts", () => {
    it("rejects DML hidden after block comment", async () => {
      await expectInvalid(
        "DROP /* harmless */ TABLE companies",
        "forbidden"
      );
    });

    it("rejects DML with inline comment", async () => {
      await expectInvalid(
        "DELETE -- just a select\nFROM companies",
        "forbidden"
      );
    });

    it("allows SELECT with harmless comments", async () => {
      // The regex guard passes (no forbidden keywords) and the parser
      // handles inline comments, so this is valid.
      await expectValid("SELECT /* this is a comment */ 1");
    });
  });

  // ----- AST parse failure (reject unparseable) ------------------------------

  describe("AST parse failure — reject unparseable", () => {
    it("rejects SELECT ... FOR UPDATE (locking clause)", async () => {
      // FOR UPDATE acquires row-level locks, violating read-only intent.
      // Caught by the regex guard because "UPDATE" is a forbidden keyword.
      await expectInvalid(
        "SELECT * FROM companies FOR UPDATE",
        "forbidden"
      );
    });

    it("rejects completely unparseable gibberish", async () => {
      await expectInvalid(
        "XYZZY PLUGH 42",
        "could not be parsed"
      );
    });

    it("rejects partial SQL that confuses the parser", async () => {
      await expectInvalid(
        "SELECT FROM WHERE",
        "could not be parsed"
      );
    });
  });

  // ----- Table whitelist -----------------------------------------------------

  describe("table whitelist", () => {
    it("allows queries on whitelisted tables", async () => {
      await expectValid("SELECT * FROM companies");
    });

    it("allows queries joining whitelisted tables", async () => {
      await expectValid(
        "SELECT c.name FROM companies c JOIN people p ON c.id = p.company_id"
      );
    });

    it("rejects queries on non-whitelisted tables", async () => {
      await expectInvalid(
        "SELECT * FROM secret_data",
        "not in the allowed list"
      );
    });

    it("rejects when any joined table is not whitelisted", async () => {
      await expectInvalid(
        "SELECT * FROM companies c JOIN secret_data s ON c.id = s.company_id",
        "not in the allowed list"
      );
    });

    it("rejects non-whitelisted tables in subqueries", async () => {
      await expectInvalid(
        "SELECT * FROM companies WHERE id IN (SELECT id FROM secret_data)",
        "not in the allowed list"
      );
    });

    it("does not reject CTE names as non-whitelisted tables", async () => {
      // "my_temp" is not in the whitelist, but it's a CTE name —
      // the validator extracts CTE names and excludes them from the check.
      await expectValid(
        "WITH my_temp AS (SELECT id FROM companies) SELECT * FROM my_temp"
      );
    });

    it("allows all tables when whitelist is disabled", async () => {
      process.env.ATLAS_TABLE_WHITELIST = "false";
      await expectValid("SELECT * FROM anything_goes");
    });
  });

  // ----- Schema-qualified table names ----------------------------------------

  describe("schema-qualified table names", () => {
    it("accepts schema-qualified name when in whitelist", async () => {
      await expectValid("SELECT * FROM public.companies");
    });

    it("accepts non-public schema-qualified name when in whitelist", async () => {
      await expectValid("SELECT * FROM analytics.companies");
    });

    it("rejects schema-qualified name when schema.table not in whitelist", async () => {
      await expectInvalid(
        "SELECT * FROM secret.passwords",
        "not in the allowed list"
      );
    });

    it("accepts joins mixing qualified and unqualified names", async () => {
      await expectValid(
        "SELECT c.name, o.id FROM public.companies c JOIN orders o ON c.id = o.company_id"
      );
    });

    it("rejects schema-qualified table when only unqualified name is whitelisted (whitelist bypass)", async () => {
      // "companies" (unqualified) is whitelisted, but "secret.companies" is NOT.
      // This must be rejected to prevent cross-schema access.
      await expectInvalid(
        "SELECT * FROM secret.companies",
        "not in the allowed list"
      );
    });

    it("does not show 'null.' prefix in error messages for unqualified tables", async () => {
      const result = await validateSQL("SELECT * FROM nonexistent_table");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("null.");
      expect(result.error).toContain("nonexistent_table");
    });

    it("accepts case-insensitive schema-qualified names (PUBLIC.Companies)", async () => {
      await expectValid("SELECT * FROM PUBLIC.Companies");
    });

    it("accepts case-insensitive schema-qualified names (ANALYTICS.COMPANIES)", async () => {
      await expectValid("SELECT * FROM ANALYTICS.COMPANIES");
    });
  });

  // ----- Auto-LIMIT ---------------------------------------------------------

  describe("auto-LIMIT", () => {
    // Auto-LIMIT is applied in the tool's execute function, not in validateSQL.
    // These tests verify that validateSQL itself doesn't reject queries with
    // or without LIMIT — the limit logic is tested separately.

    it("accepts queries with explicit LIMIT", async () => {
      await expectValid("SELECT * FROM companies LIMIT 10");
    });

    it("accepts queries without LIMIT (auto-appended later)", async () => {
      await expectValid("SELECT * FROM companies");
    });
  });

  // ----- Edge cases ----------------------------------------------------------

  describe("edge cases", () => {
    it("rejects empty string", async () => {
      const result = await validateSQL("");
      expect(result.valid).toBe(false);
    });

    it("rejects whitespace-only", async () => {
      const result = await validateSQL("   \n\t  ");
      expect(result.valid).toBe(false);
    });

    it("accepts extremely long queries without crashing", async () => {
      const longQuery = `SELECT ${Array(500).fill("1").join(", ")} FROM companies`;
      await expectValid(longQuery);
    });

    it("handles unicode in string literals", async () => {
      await expectValid("SELECT * FROM companies WHERE name = '日本語テスト'");
    });

    it("handles unicode table names that aren't whitelisted", async () => {
      await expectInvalid('SELECT * FROM "données_secrètes"');
    });

    it("rejects a query that is just a number", async () => {
      const result = await validateSQL("42");
      expect(result.valid).toBe(false);
    });

    it("case-insensitive detection of forbidden keywords", async () => {
      await expectInvalid("insert INTO companies (name) VALUES ('x')", "forbidden");
      await expectInvalid("InSeRt INTO companies (name) VALUES ('x')", "forbidden");
    });

    it("rejects UPDATE disguised with mixed case", async () => {
      await expectInvalid("uPdAtE companies SET name = 'x'", "forbidden");
    });

    it("rejects forbidden keywords inside string literals (known false positive)", async () => {
      // The regex guard runs before AST parsing, so it catches "DELETE"
      // even inside a WHERE string value. This is a deliberate conservative
      // choice — security over usability. The agent can work around this by
      // using different filter values or column aliases.
      await expectInvalid(
        "SELECT * FROM companies WHERE status = 'DELETE'",
        "forbidden"
      );
    });
  });

  // ----- Known limitations ---------------------------------------------------

  describe("known limitations", () => {
    it("does not block dangerous PostgreSQL functions (mitigated by statement_timeout and DB permissions)", async () => {
      // Functions like pg_sleep, pg_read_file, pg_terminate_backend pass
      // validation because there is no function blocklist. Mitigation:
      // - pg_sleep: bounded by statement_timeout (default 30s)
      // - pg_read_file/pg_ls_dir: require superuser or explicit GRANT
      // - pg_terminate_backend: requires pg_signal_backend role
      // The DB user should have minimal permissions in production.
      await expectValid("SELECT pg_sleep(1) FROM companies");
    });
  });

  // ----- MySQL-specific validation --------------------------------------------

  describe("MySQL-specific", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
    });

    it("rejects HANDLER statement", async () => {
      await expectInvalid("HANDLER companies OPEN", "forbidden");
    });

    it("rejects SHOW TABLES", async () => {
      await expectInvalid("SHOW TABLES", "forbidden");
    });

    it("rejects SHOW DATABASES", async () => {
      await expectInvalid("SHOW DATABASES", "forbidden");
    });

    it("rejects DESCRIBE", async () => {
      await expectInvalid("DESCRIBE companies", "forbidden");
    });

    it("rejects EXPLAIN", async () => {
      await expectInvalid("EXPLAIN SELECT * FROM companies", "forbidden");
    });

    it("rejects LOAD DATA", async () => {
      await expectInvalid(
        "LOAD DATA INFILE '/tmp/data.csv' INTO TABLE companies",
        "forbidden"
      );
    });

    it("rejects LOAD XML", async () => {
      await expectInvalid(
        "LOAD XML INFILE '/tmp/data.xml' INTO TABLE companies",
        "forbidden"
      );
    });

    it("rejects USE database", async () => {
      await expectInvalid("USE other_database", "forbidden");
    });

    it("rejects mixed-case HANDLER", async () => {
      await expectInvalid("HaNdLeR companies OPEN", "forbidden");
    });
  });

  // ----- MySQL parser mode ---------------------------------------------------

  describe("MySQL parser mode", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
    });

    it("accepts a simple SELECT in MySQL mode", async () => {
      await expectValid("SELECT id, name FROM companies");
    });

    it("accepts SELECT with JOIN in MySQL mode", async () => {
      await expectValid(
        "SELECT c.name, p.name FROM companies c JOIN people p ON c.id = p.company_id"
      );
    });

    it("accepts CTEs in MySQL mode", async () => {
      await expectValid(
        "WITH top AS (SELECT id, name FROM companies LIMIT 10) SELECT * FROM top"
      );
    });

    it("accepts subqueries in MySQL mode", async () => {
      await expectValid(
        "SELECT * FROM companies WHERE id IN (SELECT company_id FROM people)"
      );
    });

    it("rejects INSERT in MySQL mode", async () => {
      await expectInvalid(
        "INSERT INTO companies (name) VALUES ('Evil')",
        "forbidden"
      );
    });

    it("rejects non-whitelisted tables in MySQL mode", async () => {
      await expectInvalid(
        "SELECT * FROM secret_data",
        "not in the allowed list"
      );
    });

    it("accepts MySQL-specific functions (DATE_FORMAT) in MySQL mode", async () => {
      await expectValid("SELECT DATE_FORMAT(NOW(), '%Y-%m') as month FROM companies");
    });

    it("accepts MySQL-specific functions (IFNULL) in MySQL mode", async () => {
      await expectValid("SELECT IFNULL(name, 'unknown') FROM companies");
    });

    it("accepts MySQL-specific functions (GROUP_CONCAT) in MySQL mode", async () => {
      await expectValid("SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM companies");
    });

    it("accepts backtick-quoted identifiers in MySQL mode", async () => {
      await expectValid("SELECT `id`, `name` FROM companies");
    });

    it("does not reject CTE names as non-whitelisted tables in MySQL mode", async () => {
      await expectValid(
        "WITH my_temp AS (SELECT id FROM companies) SELECT * FROM my_temp"
      );
    });

    it("accepts UNION of SELECTs in MySQL mode", async () => {
      await expectValid(
        "SELECT name FROM companies UNION ALL SELECT name FROM people"
      );
    });
  });

  // ----- Cross-DB guard: MySQL patterns don't fire in PostgreSQL mode ---------

  describe("cross-database regex guard isolation", () => {
    it("rejects HANDLER in PostgreSQL mode via AST parser, not regex guard", async () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = await validateSQL("HANDLER companies OPEN");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("rejects SHOW in PostgreSQL mode via AST parser, not regex guard", async () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = await validateSQL("SHOW TABLES");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("rejects DESCRIBE in PostgreSQL mode via AST parser, not regex guard", async () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = await validateSQL("DESCRIBE companies");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("rejects USE in PostgreSQL mode via AST parser, not regex guard", async () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = await validateSQL("USE other_database");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("still blocks HANDLER in MySQL mode via regex guard", async () => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
      await expectInvalid("HANDLER companies OPEN", "forbidden");
    });
  });

  // ----- Formerly SQLite commands still rejected by AST ----------------------

  describe("formerly SQLite-specific commands still rejected via AST", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    });

    it("rejects PRAGMA in PostgreSQL mode", async () => {
      await expectInvalid("PRAGMA table_info(companies)", "could not be parsed");
    });

    it("rejects ATTACH DATABASE in PostgreSQL mode", async () => {
      await expectInvalid("ATTACH DATABASE '/tmp/evil.db' AS evil", "could not be parsed");
    });

    it("rejects DETACH DATABASE in PostgreSQL mode", async () => {
      await expectInvalid("DETACH DATABASE evil", "could not be parsed");
    });

    it("rejects PRAGMA in MySQL mode", async () => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
      await expectInvalid("PRAGMA table_info(companies)", "could not be parsed");
    });
  });

  // Note: ClickHouse, DuckDB, and Snowflake-specific validation tests were removed
  // because those adapters are now plugins. See plugins/{clickhouse,snowflake,duckdb}-datasource/.
});

