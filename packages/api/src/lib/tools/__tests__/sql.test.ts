import { describe, expect, it, beforeEach, mock } from "bun:test";

// Mock getWhitelistedTables before importing the module under test.
// This avoids hitting the filesystem for semantic layer YAML files.
// The whitelist includes both unqualified names (e.g. "companies") for default-schema
// queries and qualified names (e.g. "public.companies", "analytics.companies") for
// explicit schema-qualified queries. This mirrors real usage where atlas init adds
// qualified entries for non-public schemas.
mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () =>
    new Set(["companies", "people", "accounts", "public.companies", "analytics.companies", "orders"]),
  _resetWhitelists: () => {},
}));

// Mock the DB connection — validateSQL doesn't need it, but the module
// imports it at the top level.
const mockDBConnection = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};

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

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: () => mockDetectDBType(),
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
  },
  detectDBType: mockDetectDBType,
}));

// Import after mocks are registered
const { validateSQL } = await import("@atlas/api/lib/tools/sql");

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
  // Reset env between tests that tweak ATLAS_TABLE_WHITELIST.
  // Force PostgreSQL mode — existing tests were written for it.
  const origEnv = { ...process.env, ATLAS_DATASOURCE_URL: "postgresql://test:test@localhost:5432/test" };
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

    it("accepts COALESCE", () => {
      expectValid("SELECT COALESCE(name, 'unknown') FROM companies");
    });

    it("accepts nested CTEs", () => {
      expectValid(`
        WITH a AS (SELECT id FROM companies),
             b AS (SELECT id FROM a)
        SELECT * FROM b
      `);
    });

    it("accepts semicolons inside string literals", () => {
      // Semicolons in data values are legitimate — the AST parser handles
      // them correctly as part of the string, not as statement separators.
      expectValid("SELECT * FROM companies WHERE name = 'foo;bar'");
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

  // ----- Blocked privilege / admin commands -----------------------------------

  describe("blocked privilege and admin commands", () => {
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

    it("rejects CALL", () => {
      expectInvalid("CALL some_procedure()", "forbidden");
    });

    it("rejects COPY", () => {
      expectInvalid("COPY companies TO '/tmp/data.csv'", "forbidden");
    });

    it("rejects LOAD", () => {
      expectInvalid("LOAD DATA INFILE '/tmp/data.csv' INTO TABLE companies", "forbidden");
    });

    it("rejects VACUUM", () => {
      expectInvalid("VACUUM companies", "forbidden");
    });

    it("rejects REINDEX", () => {
      expectInvalid("REINDEX TABLE companies", "forbidden");
    });

    it("rejects OPTIMIZE TABLE", () => {
      expectInvalid("OPTIMIZE TABLE companies", "forbidden");
    });

    it("rejects INTO OUTFILE", () => {
      expectInvalid(
        "SELECT * INTO OUTFILE '/tmp/dump.csv' FROM companies",
        "forbidden"
      );
    });
  });

  // ----- Multi-statement injection -------------------------------------------

  describe("multi-statement injection", () => {
    it("rejects semicolon-separated SELECT + DML", () => {
      // DML caught by regex guard before AST even runs
      expectInvalid("SELECT 1; DROP TABLE companies", "forbidden");
    });

    it("rejects two SELECT statements", () => {
      expectInvalid("SELECT 1; SELECT 2", "multiple statements");
    });

    it("rejects two statements with string literals", () => {
      expectInvalid("SELECT '1'; SELECT '2'", "multiple statements");
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
      // The regex guard passes (no forbidden keywords) and the parser
      // handles inline comments, so this is valid.
      expectValid("SELECT /* this is a comment */ 1");
    });
  });

  // ----- AST parse failure (reject unparseable) ------------------------------

  describe("AST parse failure — reject unparseable", () => {
    it("rejects SELECT ... FOR UPDATE (locking clause)", () => {
      // FOR UPDATE acquires row-level locks, violating read-only intent.
      // Caught by the regex guard because "UPDATE" is a forbidden keyword.
      expectInvalid(
        "SELECT * FROM companies FOR UPDATE",
        "forbidden"
      );
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

    it("rejects non-whitelisted tables in subqueries", () => {
      expectInvalid(
        "SELECT * FROM companies WHERE id IN (SELECT id FROM secret_data)",
        "not in the allowed list"
      );
    });

    it("does not reject CTE names as non-whitelisted tables", () => {
      // "my_temp" is not in the whitelist, but it's a CTE name —
      // the validator extracts CTE names and excludes them from the check.
      expectValid(
        "WITH my_temp AS (SELECT id FROM companies) SELECT * FROM my_temp"
      );
    });

    it("allows all tables when whitelist is disabled", () => {
      process.env.ATLAS_TABLE_WHITELIST = "false";
      expectValid("SELECT * FROM anything_goes");
    });
  });

  // ----- Schema-qualified table names ----------------------------------------

  describe("schema-qualified table names", () => {
    it("accepts schema-qualified name when in whitelist", () => {
      expectValid("SELECT * FROM public.companies");
    });

    it("accepts non-public schema-qualified name when in whitelist", () => {
      expectValid("SELECT * FROM analytics.companies");
    });

    it("rejects schema-qualified name when schema.table not in whitelist", () => {
      expectInvalid(
        "SELECT * FROM secret.passwords",
        "not in the allowed list"
      );
    });

    it("accepts joins mixing qualified and unqualified names", () => {
      expectValid(
        "SELECT c.name, o.id FROM public.companies c JOIN orders o ON c.id = o.company_id"
      );
    });

    it("rejects schema-qualified table when only unqualified name is whitelisted (whitelist bypass)", () => {
      // "companies" (unqualified) is whitelisted, but "secret.companies" is NOT.
      // This must be rejected to prevent cross-schema access.
      expectInvalid(
        "SELECT * FROM secret.companies",
        "not in the allowed list"
      );
    });

    it("does not show 'null.' prefix in error messages for unqualified tables", () => {
      const result = validateSQL("SELECT * FROM nonexistent_table");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("null.");
      expect(result.error).toContain("nonexistent_table");
    });

    it("accepts case-insensitive schema-qualified names (PUBLIC.Companies)", () => {
      expectValid("SELECT * FROM PUBLIC.Companies");
    });

    it("accepts case-insensitive schema-qualified names (ANALYTICS.COMPANIES)", () => {
      expectValid("SELECT * FROM ANALYTICS.COMPANIES");
    });
  });

  // ----- Auto-LIMIT ---------------------------------------------------------

  describe("auto-LIMIT", () => {
    // Auto-LIMIT is applied in the tool's execute function, not in validateSQL.
    // These tests verify that validateSQL itself doesn't reject queries with
    // or without LIMIT — the limit logic is tested separately.

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

    it("accepts extremely long queries without crashing", () => {
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

    it("rejects forbidden keywords inside string literals (known false positive)", () => {
      // The regex guard runs before AST parsing, so it catches "DELETE"
      // even inside a WHERE string value. This is a deliberate conservative
      // choice — security over usability. The agent can work around this by
      // using different filter values or column aliases.
      expectInvalid(
        "SELECT * FROM companies WHERE status = 'DELETE'",
        "forbidden"
      );
    });
  });

  // ----- Known limitations ---------------------------------------------------

  describe("known limitations", () => {
    it("does not block dangerous PostgreSQL functions (mitigated by statement_timeout and DB permissions)", () => {
      // Functions like pg_sleep, pg_read_file, pg_terminate_backend pass
      // validation because there is no function blocklist. Mitigation:
      // - pg_sleep: bounded by statement_timeout (default 30s)
      // - pg_read_file/pg_ls_dir: require superuser or explicit GRANT
      // - pg_terminate_backend: requires pg_signal_backend role
      // The DB user should have minimal permissions in production.
      expectValid("SELECT pg_sleep(1) FROM companies");
    });
  });

  // ----- MySQL-specific validation --------------------------------------------

  describe("MySQL-specific", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
    });

    it("rejects HANDLER statement", () => {
      expectInvalid("HANDLER companies OPEN", "forbidden");
    });

    it("rejects SHOW TABLES", () => {
      expectInvalid("SHOW TABLES", "forbidden");
    });

    it("rejects SHOW DATABASES", () => {
      expectInvalid("SHOW DATABASES", "forbidden");
    });

    it("rejects DESCRIBE", () => {
      expectInvalid("DESCRIBE companies", "forbidden");
    });

    it("rejects EXPLAIN", () => {
      expectInvalid("EXPLAIN SELECT * FROM companies", "forbidden");
    });

    it("rejects LOAD DATA", () => {
      expectInvalid(
        "LOAD DATA INFILE '/tmp/data.csv' INTO TABLE companies",
        "forbidden"
      );
    });

    it("rejects LOAD XML", () => {
      expectInvalid(
        "LOAD XML INFILE '/tmp/data.xml' INTO TABLE companies",
        "forbidden"
      );
    });

    it("rejects USE database", () => {
      expectInvalid("USE other_database", "forbidden");
    });

    it("rejects mixed-case HANDLER", () => {
      expectInvalid("HaNdLeR companies OPEN", "forbidden");
    });
  });

  // ----- MySQL parser mode ---------------------------------------------------

  describe("MySQL parser mode", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
    });

    it("accepts a simple SELECT in MySQL mode", () => {
      expectValid("SELECT id, name FROM companies");
    });

    it("accepts SELECT with JOIN in MySQL mode", () => {
      expectValid(
        "SELECT c.name, p.name FROM companies c JOIN people p ON c.id = p.company_id"
      );
    });

    it("accepts CTEs in MySQL mode", () => {
      expectValid(
        "WITH top AS (SELECT id, name FROM companies LIMIT 10) SELECT * FROM top"
      );
    });

    it("accepts subqueries in MySQL mode", () => {
      expectValid(
        "SELECT * FROM companies WHERE id IN (SELECT company_id FROM people)"
      );
    });

    it("rejects INSERT in MySQL mode", () => {
      expectInvalid(
        "INSERT INTO companies (name) VALUES ('Evil')",
        "forbidden"
      );
    });

    it("rejects non-whitelisted tables in MySQL mode", () => {
      expectInvalid(
        "SELECT * FROM secret_data",
        "not in the allowed list"
      );
    });

    it("accepts MySQL-specific functions (DATE_FORMAT) in MySQL mode", () => {
      expectValid("SELECT DATE_FORMAT(NOW(), '%Y-%m') as month FROM companies");
    });

    it("accepts MySQL-specific functions (IFNULL) in MySQL mode", () => {
      expectValid("SELECT IFNULL(name, 'unknown') FROM companies");
    });

    it("accepts MySQL-specific functions (GROUP_CONCAT) in MySQL mode", () => {
      expectValid("SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM companies");
    });

    it("accepts backtick-quoted identifiers in MySQL mode", () => {
      expectValid("SELECT `id`, `name` FROM companies");
    });

    it("does not reject CTE names as non-whitelisted tables in MySQL mode", () => {
      expectValid(
        "WITH my_temp AS (SELECT id FROM companies) SELECT * FROM my_temp"
      );
    });

    it("accepts UNION of SELECTs in MySQL mode", () => {
      expectValid(
        "SELECT name FROM companies UNION ALL SELECT name FROM people"
      );
    });
  });

  // ----- Cross-DB guard: MySQL patterns don't fire in PostgreSQL mode ---------

  describe("cross-database regex guard isolation", () => {
    it("rejects HANDLER in PostgreSQL mode via AST parser, not regex guard", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = validateSQL("HANDLER companies OPEN");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("rejects SHOW in PostgreSQL mode via AST parser, not regex guard", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = validateSQL("SHOW TABLES");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("rejects DESCRIBE in PostgreSQL mode via AST parser, not regex guard", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = validateSQL("DESCRIBE companies");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("rejects USE in PostgreSQL mode via AST parser, not regex guard", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
      const result = validateSQL("USE other_database");
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain("Forbidden SQL operation detected");
    });

    it("still blocks HANDLER in MySQL mode via regex guard", () => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
      expectInvalid("HANDLER companies OPEN", "forbidden");
    });
  });

  // ----- Formerly SQLite commands still rejected by AST ----------------------

  describe("formerly SQLite-specific commands still rejected via AST", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    });

    it("rejects PRAGMA in PostgreSQL mode", () => {
      expectInvalid("PRAGMA table_info(companies)", "could not be parsed");
    });

    it("rejects ATTACH DATABASE in PostgreSQL mode", () => {
      expectInvalid("ATTACH DATABASE '/tmp/evil.db' AS evil", "could not be parsed");
    });

    it("rejects DETACH DATABASE in PostgreSQL mode", () => {
      expectInvalid("DETACH DATABASE evil", "could not be parsed");
    });

    it("rejects PRAGMA in MySQL mode", () => {
      process.env.ATLAS_DATASOURCE_URL = "mysql://test:test@localhost:3306/test";
      expectInvalid("PRAGMA table_info(companies)", "could not be parsed");
    });
  });

  // Note: ClickHouse, DuckDB, and Snowflake-specific validation tests were removed
  // because those adapters are now plugins. See plugins/{clickhouse,snowflake,duckdb}-datasource/.
});

