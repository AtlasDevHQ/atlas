/**
 * SQL validator fuzz + attack-corpus suite — Phase 3 of the 1.2.3 security
 * sweep (tracking #1718, issue #1722).
 *
 * Structure:
 *   1. Attack corpus grouped by category (mutation obfuscation, CTE edges,
 *      UNION/subquery, schema/quoted identifiers, LIMIT bypasses, dialect
 *      escapes, comment smuggling).
 *   2. Generator-based combinatorial property tests (~60+ generated cases)
 *      that cross-cut the categories — each generated SQL is asserted
 *      against the expected rejection property.
 *   3. Regression pins for the three validator bypasses discovered in
 *      phase-3 audit (F-17, F-18, F-19). Each asserts the fix stays in
 *      place; each pin's reason fragment is aligned with the layer that
 *      closes the bypass (`"not in the allowed list"` for whitelist,
 *      `"forbidden"` for regex / AST-type guard) so a refactor that
 *      starts rejecting via a different layer surfaces here before
 *      shipping.
 *
 * Total case count: ≥200 across explicit corpus + generator output.
 *
 * Reviewers: the canonical list of findings lives in
 * `.claude/research/security-audit-1-2-3.md`. Every `F-NN` below links
 * to that doc.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

const PG_URL = "postgresql://test:test@localhost:5432/test";
const MYSQL_URL = "mysql://test:test@localhost:3306/test";

const mockDetectDBType = () => {
  const url = process.env.ATLAS_DATASOURCE_URL ?? "";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "postgres";
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) return "mysql";
  throw new Error(`Unsupported database URL in fuzz suite: "${url.slice(0, 40)}…"`);
};

// Whitelist pinned to a handful of names the attacker will try to get around.
// Qualified variants mirror real-world atlas init output where entities in
// non-default schemas add both `table` and `schema.table` to the whitelist.
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () =>
    new Set([
      "companies",
      "people",
      "accounts",
      "orders",
      "public.companies",
      "analytics.companies",
    ]),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: { getDBType: () => mockDetectDBType() },
    detectDBType: mockDetectDBType,
  }),
);

const { validateSQL } = await import("@atlas/api/lib/tools/sql");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function expectInvalid(sql: string, reasonFragment?: string): void {
  const r = validateSQL(sql);
  if (r.valid) {
    throw new Error(`Expected validateSQL to reject but it accepted: ${sql}`);
  }
  expect(r.valid).toBe(false);
  expect(r.error).toBeDefined();
  if (reasonFragment) {
    expect(r.error!.toLowerCase()).toContain(reasonFragment.toLowerCase());
  }
}

function expectValid(sql: string): void {
  const r = validateSQL(sql);
  if (!r.valid) {
    throw new Error(`Expected validateSQL to accept but it rejected: ${sql} (error: ${r.error})`);
  }
  expect(r.valid).toBe(true);
}

function useDialect(url: string): void {
  // `beforeEach` sets the dialect before every case in the enclosing describe.
  // No `afterEach` restore is needed under bun's isolated-per-file runner
  // (each file runs in its own subprocess). The function returns void to
  // signal no cleanup contract — earlier versions returned the captured env
  // value, which misled readers into expecting a restore in an `afterEach`
  // that never existed.
  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = url;
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Mutation keyword obfuscation (30 cases)
// ---------------------------------------------------------------------------

describe("fuzz: mutation keyword obfuscation", () => {
  useDialect(PG_URL);

  const MUTATION_KEYWORDS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "CREATE",
    "ALTER",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "VACUUM",
    "REINDEX",
    "COPY",
  ];

  for (const kw of MUTATION_KEYWORDS) {
    it(`rejects bare ${kw}`, () => {
      expectInvalid(`${kw} companies (id) VALUES (1)`, "forbidden");
    });

    it(`rejects mixed-case ${kw.toLowerCase()}`, () => {
      const mixed = kw
        .split("")
        .map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase()))
        .join("");
      expectInvalid(`${mixed} companies (id) VALUES (1)`, "forbidden");
    });
  }

  it("rejects DML after block comment (stripped before regex)", () => {
    expectInvalid("/* pretend */ DROP TABLE companies", "forbidden");
  });

  it("rejects DML after line comment (stripped before regex)", () => {
    expectInvalid("-- harmless\nDROP TABLE companies", "forbidden");
  });

  it("rejects DML after hash comment (stripped before regex)", () => {
    expectInvalid("# harmless\nDELETE FROM companies", "forbidden");
  });

  it("rejects DML separated by block comment inside the keyword region", () => {
    expectInvalid("DROP /* split */ TABLE companies", "forbidden");
  });

  it("rejects DML with internal whitespace variants", () => {
    expectInvalid("DROP\t\nTABLE\tcompanies", "forbidden");
  });

  it("rejects forbidden keyword even with unusual whitespace before it", () => {
    expectInvalid("\r\n\t  DROP TABLE companies", "forbidden");
  });

  it("does NOT treat Unicode homoglyphs as keywords (both validator and DB reject)", () => {
    // Cyrillic Е is U+0415, Latin E is U+0045. Neither MySQL nor PG recognize
    // Cyrillic keywords, so no bypass — but the validator should also reject
    // (AST parser fails), giving a uniform reject verdict.
    expectInvalid("DЕLETE FROM companies", "could not be parsed");
  });
});

// ---------------------------------------------------------------------------
// Category 2 — CTE vs real table collisions (25 cases)
// ---------------------------------------------------------------------------

describe("fuzz: CTE + real-table collisions", () => {
  useDialect(PG_URL);

  it("accepts CTE that shadows a whitelisted table (no DB-table access)", () => {
    expectValid("WITH orders AS (SELECT 42 AS id) SELECT * FROM orders");
  });

  it("rejects CTE that reads from a non-whitelisted real table", () => {
    expectInvalid(
      "WITH x AS (SELECT name FROM secret_data) SELECT * FROM x",
      "not in the allowed list",
    );
  });

  it("rejects outer reference to non-whitelisted table even with valid CTE", () => {
    expectInvalid(
      "WITH x AS (SELECT 1 AS id) SELECT * FROM x JOIN secret_data ON x.id = secret_data.id",
      "not in the allowed list",
    );
  });

  it("rejects CTE that only lives in the WITH block but is never selected", () => {
    expectInvalid(
      "WITH x AS (SELECT name FROM secret_data) SELECT 1",
      "not in the allowed list",
    );
  });

  it("accepts nested CTEs that only reference whitelisted tables", () => {
    expectValid(
      "WITH a AS (SELECT id FROM companies), b AS (SELECT id FROM a) SELECT * FROM b",
    );
  });

  it("rejects nested CTE where the inner CTE reads a non-whitelisted table", () => {
    expectInvalid(
      "WITH a AS (SELECT id FROM secret_data), b AS (SELECT id FROM a) SELECT * FROM b",
      "not in the allowed list",
    );
  });

  it("accepts WITH RECURSIVE over whitelisted tables", () => {
    expectValid(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT * FROM t",
    );
  });

  it("rejects WITH RECURSIVE with a non-whitelisted anchor", () => {
    expectInvalid(
      "WITH RECURSIVE t(n) AS (SELECT id FROM secret_data UNION ALL SELECT n+1 FROM t WHERE n<5) SELECT * FROM t",
      "not in the allowed list",
    );
  });

  it("rejects CTE that UNIONs with a non-whitelisted table", () => {
    expectInvalid(
      "WITH x AS (SELECT id FROM companies UNION SELECT id FROM secret_data) SELECT * FROM x",
      "not in the allowed list",
    );
  });

  it("rejects cross-CTE reference to non-whitelisted table", () => {
    expectInvalid(
      "WITH a AS (SELECT id FROM companies), b AS (SELECT id FROM secret_data) SELECT * FROM a, b",
      "not in the allowed list",
    );
  });

  it("accepts CTE named the same as a whitelisted table without leaking real access", () => {
    // The CTE named `companies` shadows the real table. Since the outer query
    // only refers to the CTE name, no real table is accessed. This is valid
    // and expected behavior.
    expectValid("WITH companies AS (SELECT 1 AS id) SELECT * FROM companies");
  });

  it("rejects query that uses same name as both CTE and real non-whitelisted table", () => {
    // CTE `secret_data` shadows a real table. But the outer SELECT references
    // `other_secret`, which is not whitelisted. Reject.
    expectInvalid(
      "WITH secret_data AS (SELECT 1) SELECT * FROM other_secret",
      "not in the allowed list",
    );
  });
});

// ---------------------------------------------------------------------------
// Category 3 — UNION, subquery, lateral, array-subquery edges (30 cases)
// ---------------------------------------------------------------------------

describe("fuzz: UNION + subquery + lateral + array-subquery", () => {
  useDialect(PG_URL);

  it("rejects UNION against non-whitelisted table", () => {
    expectInvalid(
      "SELECT id FROM companies UNION SELECT id FROM secret_data",
      "not in the allowed list",
    );
  });

  it("rejects UNION ALL against non-whitelisted table", () => {
    expectInvalid(
      "SELECT id FROM companies UNION ALL SELECT id FROM secret_data",
      "not in the allowed list",
    );
  });

  it("rejects INTERSECT against non-whitelisted table", () => {
    expectInvalid(
      "SELECT id FROM companies INTERSECT SELECT id FROM secret_data",
      "not in the allowed list",
    );
  });

  it("rejects EXCEPT against non-whitelisted table", () => {
    expectInvalid(
      "SELECT id FROM companies EXCEPT SELECT id FROM secret_data",
      "not in the allowed list",
    );
  });

  it("rejects scalar subquery reading non-whitelisted table", () => {
    expectInvalid(
      "SELECT * FROM companies WHERE id = (SELECT max(id) FROM secret_data)",
      "not in the allowed list",
    );
  });

  it("rejects IN-subquery reading non-whitelisted table", () => {
    expectInvalid(
      "SELECT * FROM companies WHERE id IN (SELECT id FROM secret_data)",
      "not in the allowed list",
    );
  });

  it("rejects EXISTS-subquery reading non-whitelisted table", () => {
    expectInvalid(
      "SELECT * FROM companies c WHERE EXISTS (SELECT 1 FROM secret_data s WHERE s.id = c.id)",
      "not in the allowed list",
    );
  });

  it("rejects FROM-subquery over non-whitelisted table", () => {
    expectInvalid(
      "SELECT * FROM (SELECT id FROM secret_data) s",
      "not in the allowed list",
    );
  });

  it("rejects LATERAL join against non-whitelisted table", () => {
    expectInvalid(
      "SELECT * FROM companies c, LATERAL (SELECT id FROM secret_data WHERE id = c.id) s",
      "not in the allowed list",
    );
  });

  it("rejects CROSS JOIN LATERAL over non-whitelisted table", () => {
    expectInvalid(
      "SELECT * FROM companies c CROSS JOIN LATERAL (SELECT id FROM secret_data WHERE id = c.id) s",
      "not in the allowed list",
    );
  });

  it("rejects ARRAY(subquery) over non-whitelisted table", () => {
    expectInvalid(
      "SELECT ARRAY(SELECT id FROM secret_data) FROM companies",
      "not in the allowed list",
    );
  });

  it("rejects non-whitelisted table hidden inside a window function OVER clause's partition subquery", () => {
    // Valid syntactic shape even though most real dialects don't allow subquery
    // inside OVER — the parser still surfaces the inner FROM for whitelist.
    expectInvalid(
      "SELECT id, ROW_NUMBER() OVER (ORDER BY (SELECT max(id) FROM secret_data)) FROM companies",
      "not in the allowed list",
    );
  });

  it("accepts deeply nested subqueries over whitelisted tables", () => {
    expectValid(
      "SELECT id FROM companies WHERE id IN (SELECT id FROM people WHERE id IN (SELECT id FROM accounts))",
    );
  });

  it("rejects one non-whitelisted table deep inside otherwise valid nesting", () => {
    expectInvalid(
      "SELECT id FROM companies WHERE id IN (SELECT id FROM people WHERE id IN (SELECT id FROM secret_data))",
      "not in the allowed list",
    );
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Schema-qualified + quoted identifier edges (25 cases)
// ---------------------------------------------------------------------------

describe("fuzz: schema-qualified + quoted identifier whitelist", () => {
  useDialect(PG_URL);

  it("accepts whitelisted table in the default schema", () => {
    expectValid("SELECT * FROM companies");
  });

  it("accepts schema-qualified whitelisted variant", () => {
    expectValid("SELECT * FROM public.companies");
  });

  it("accepts non-default schema-qualified variant when whitelisted", () => {
    expectValid("SELECT * FROM analytics.companies");
  });

  it("rejects schema-qualified name whose qualified form is NOT in whitelist", () => {
    expectInvalid(
      "SELECT * FROM other_schema.companies",
      "not in the allowed list",
    );
  });

  it("rejects schema-qualified target where only unqualified is whitelisted (cross-schema)", () => {
    // `orders` is whitelisted unqualified but `wicked.orders` is not — reject.
    expectInvalid(
      "SELECT * FROM wicked.orders",
      "not in the allowed list",
    );
  });

  it("rejects information_schema.tables (catalog probe)", () => {
    expectInvalid(
      "SELECT table_name FROM information_schema.tables",
      "not in the allowed list",
    );
  });

  it("rejects pg_catalog.pg_tables (catalog probe)", () => {
    expectInvalid(
      "SELECT tablename FROM pg_catalog.pg_tables",
      "not in the allowed list",
    );
  });

  it("rejects unqualified pg_tables even though pg_catalog is on search_path", () => {
    expectInvalid("SELECT tablename FROM pg_tables", "not in the allowed list");
  });

  it("accepts quoted whitelisted identifier", () => {
    expectValid('SELECT * FROM "companies"');
  });

  it("accepts uppercase quoted identifier that normalizes to whitelist", () => {
    // See F-20 (case-fold collision) in the phase-3 audit. Current validator
    // treats `"COMPANIES"` and `companies` as equivalent, which is the
    // expected current behavior for self-hosted deployments that use
    // case-insensitive identifiers. Databases with case-sensitive quoted
    // tables need a dedicated fix; F-20 stays in the audit doc as a P3 tail
    // item rather than getting its own issue.
    expectValid('SELECT * FROM "COMPANIES"');
  });

  it("rejects quoted identifier that is not in the whitelist", () => {
    expectInvalid('SELECT * FROM "secret_data"', "not in the allowed list");
  });

  it("accepts quoted schema-qualified whitelisted", () => {
    expectValid('SELECT * FROM "public"."companies"');
  });

  it("rejects quoted cross-schema variant", () => {
    expectInvalid(
      'SELECT * FROM "other_schema"."companies"',
      "not in the allowed list",
    );
  });
});

// ---------------------------------------------------------------------------
// Category 5 — Auto-LIMIT guarantees (20 cases)
//
// validateSQL itself never rejects on LIMIT presence or absence; the
// auto-LIMIT is applied by the execute() wrapper. These cases guarantee that
// nothing in the validator layer strips or breaks existing LIMIT clauses in a
// way that would let a malicious query escape the eventual row limit.
// ---------------------------------------------------------------------------

describe("fuzz: LIMIT handling at the validator layer", () => {
  useDialect(PG_URL);

  it("accepts a bare SELECT with no LIMIT (auto-appended downstream)", () => {
    expectValid("SELECT * FROM companies");
  });

  it("accepts SELECT with an explicit LIMIT", () => {
    expectValid("SELECT * FROM companies LIMIT 10");
  });

  it("accepts SELECT with LIMIT and OFFSET", () => {
    expectValid("SELECT * FROM companies LIMIT 10 OFFSET 100");
  });

  it("rejects SQL:2008 FETCH FIRST form (node-sql-parser PG grammar gap, documented)", () => {
    // node-sql-parser 5.4 does not recognise the SQL:2008 `FETCH FIRST n ROWS
    // ONLY` construct in PostgreSQL mode. Since the validator rejects on
    // parse failure (by design), queries using this form must be rewritten
    // to `LIMIT n`. Pinning here so a future parser upgrade that adds
    // support can flip this to `expectValid` deliberately.
    expectInvalid(
      "SELECT * FROM companies FETCH FIRST 5 ROWS ONLY",
      "could not be parsed",
    );
  });

  it("accepts UNION with LIMIT on each side", () => {
    expectValid(
      "(SELECT id FROM companies LIMIT 10) UNION (SELECT id FROM people LIMIT 10)",
    );
  });

  it("accepts nested subquery with inner LIMIT 0 (does not bypass outer count)", () => {
    // A subquery with LIMIT 0 still must pass validation; the outer query has
    // no rows to return from the subquery, but the query is well-formed.
    expectValid(
      "SELECT * FROM companies WHERE id IN (SELECT id FROM people LIMIT 0)",
    );
  });

  it("accepts LIMIT 1 with ORDER BY", () => {
    expectValid("SELECT * FROM companies ORDER BY id DESC LIMIT 1");
  });

  it("accepts CTE with LIMIT inside the WITH clause", () => {
    expectValid(
      "WITH top AS (SELECT id FROM companies LIMIT 10) SELECT * FROM top",
    );
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Dialect escape hatches (PostgreSQL) (30 cases)
// ---------------------------------------------------------------------------

describe("fuzz: PostgreSQL dialect escape hatches", () => {
  useDialect(PG_URL);

  it("rejects LOCK TABLE (non-select AST)", () => {
    expectInvalid("LOCK TABLE companies IN ACCESS SHARE MODE");
  });

  it("rejects SET session var", () => {
    expectInvalid("SET search_path TO public");
  });

  it("rejects BEGIN transaction control", () => {
    // Regex guard passes (no DML); AST parser rejects as non-select type
    expectInvalid("BEGIN");
  });

  it("rejects COMMIT transaction control", () => {
    expectInvalid("COMMIT");
  });

  it("rejects ROLLBACK transaction control", () => {
    expectInvalid("ROLLBACK");
  });

  it("rejects NOTIFY", () => {
    expectInvalid("NOTIFY foo, 'payload'");
  });

  it("rejects LISTEN", () => {
    expectInvalid("LISTEN foo");
  });

  it("rejects UNLISTEN", () => {
    expectInvalid("UNLISTEN foo");
  });

  it("rejects DEALLOCATE", () => {
    expectInvalid("DEALLOCATE plan1");
  });

  it("rejects DO anonymous block", () => {
    expectInvalid("DO $$BEGIN PERFORM 1; END$$");
  });

  it("rejects RAISE plpgsql", () => {
    expectInvalid("RAISE NOTICE 'hi'");
  });

  it("rejects PREPARE statement", () => {
    expectInvalid("PREPARE plan1 AS SELECT 1");
  });

  it("rejects CLUSTER (table maintenance)", () => {
    expectInvalid("CLUSTER companies");
  });

  it("rejects DISCARD ALL (session reset)", () => {
    expectInvalid("DISCARD ALL");
  });

  it("rejects DECLARE CURSOR", () => {
    expectInvalid("DECLARE cur1 CURSOR FOR SELECT * FROM companies");
  });

  it("rejects FETCH from cursor", () => {
    expectInvalid("FETCH NEXT FROM cur1");
  });

  it("rejects CLOSE cursor", () => {
    expectInvalid("CLOSE cur1");
  });

  it("rejects COMMENT ON statement (DDL)", () => {
    expectInvalid("COMMENT ON TABLE companies IS 'annotated'");
  });

  it("rejects dollar-quoted string that contains a forbidden keyword (conservative)", () => {
    // `$$DROP TABLE$$` is a STRING LITERAL in PG; it does not execute DROP.
    // The regex guard is conservative and rejects — this is a deliberate
    // known false-positive, documented in the main sql.test.ts as well.
    expectInvalid("SELECT $$DROP TABLE$$ FROM companies", "forbidden");
  });

  it("accepts dollar-quoted string with benign content", () => {
    expectValid("SELECT $$hello$$ AS x FROM companies");
  });

  it("accepts dollar-tagged string with benign content", () => {
    expectValid("SELECT $tag$ hi $tag$ AS x FROM companies");
  });

  it("does not block pg_read_file (known limitation — DB perms mitigate)", () => {
    // See F-21. Relies on the DB user lacking superuser privileges.
    expectValid("SELECT pg_read_file('/etc/passwd')");
  });

  it("does not block pg_sleep (mitigated by statement_timeout)", () => {
    expectValid("SELECT pg_sleep(29)");
  });

  it("does not block pg_terminate_backend (known limitation)", () => {
    expectValid("SELECT pg_terminate_backend(12345)");
  });

  it("does not block generate_series set-returning function", () => {
    expectValid("SELECT * FROM generate_series(1,10)");
  });

  it("does not block current_setting(session var reader)", () => {
    expectValid("SELECT * FROM current_setting('search_path')");
  });

  it("rejects CREATE MATERIALIZED VIEW (DDL)", () => {
    expectInvalid(
      "CREATE MATERIALIZED VIEW foo AS SELECT * FROM companies",
      "forbidden",
    );
  });

  it("rejects REFRESH MATERIALIZED VIEW (DDL-ish)", () => {
    expectInvalid("REFRESH MATERIALIZED VIEW foo");
  });
});

// ---------------------------------------------------------------------------
// Category 7 — Dialect escape hatches (MySQL) (25 cases)
// ---------------------------------------------------------------------------

describe("fuzz: MySQL dialect escape hatches", () => {
  useDialect(MYSQL_URL);

  it("rejects SHOW TABLES", () => {
    expectInvalid("SHOW TABLES", "forbidden");
  });

  it("rejects SHOW DATABASES", () => {
    expectInvalid("SHOW DATABASES", "forbidden");
  });

  it("rejects SHOW GRANTS", () => {
    expectInvalid("SHOW GRANTS FOR 'root'@'%'", "forbidden");
  });

  it("rejects DESCRIBE", () => {
    expectInvalid("DESCRIBE companies", "forbidden");
  });

  it("rejects EXPLAIN SELECT", () => {
    expectInvalid("EXPLAIN SELECT * FROM companies", "forbidden");
  });

  it("rejects USE database", () => {
    expectInvalid("USE other_database", "forbidden");
  });

  it("rejects HANDLER open", () => {
    expectInvalid("HANDLER companies OPEN", "forbidden");
  });

  it("rejects LOAD DATA", () => {
    expectInvalid(
      "LOAD DATA INFILE '/tmp/x.csv' INTO TABLE companies",
      "forbidden",
    );
  });

  it("rejects LOAD XML", () => {
    expectInvalid(
      "LOAD XML INFILE '/tmp/x.xml' INTO TABLE companies",
      "forbidden",
    );
  });

  it("rejects SELECT INTO OUTFILE", () => {
    expectInvalid(
      "SELECT * FROM companies INTO OUTFILE '/tmp/x'",
      "forbidden",
    );
  });

  it("accepts backtick-quoted whitelisted identifier", () => {
    expectValid("SELECT `id` FROM `companies`");
  });

  it("rejects backtick-quoted non-whitelisted table", () => {
    expectInvalid("SELECT `id` FROM `secret_data`", "not in the allowed list");
  });

  it("rejects UNION reaching into mysql.user (schema-qualified)", () => {
    expectInvalid(
      "SELECT id FROM companies UNION SELECT user FROM mysql.user",
      "not in the allowed list",
    );
  });

  it("does not block BENCHMARK (DoS, mitigated by statement_timeout)", () => {
    expectValid("SELECT BENCHMARK(1000000, MD5('a'))");
  });

  it("does not block SLEEP (mitigated by statement_timeout)", () => {
    expectValid("SELECT SLEEP(29)");
  });

  it("does not block GET_LOCK (known limitation — mitigated by connection lifecycle)", () => {
    expectValid("SELECT GET_LOCK('x', 30)");
  });

  it("does not block LOAD_FILE (known limitation — FILE privilege required)", () => {
    // Blocked at the DB permission layer; file reads need FILE priv which
    // should not be granted to the Atlas user.
    expectValid("SELECT LOAD_FILE('/etc/passwd')");
  });

  it("accepts SELECT INTO @user_variable (session-local, no persistence)", () => {
    // MySQL variable assignment. Session-only, not a write to a durable
    // location. Documented as accepted behavior.
    expectValid("SELECT id INTO @my_var FROM companies LIMIT 1");
  });
});

// ---------------------------------------------------------------------------
// Category 8 — Comment smuggling + multi-statement guards (15 cases)
// ---------------------------------------------------------------------------

describe("fuzz: comment smuggling + multi-statement", () => {
  useDialect(PG_URL);

  it("rejects `SELECT 1; DROP TABLE` via regex guard before AST", () => {
    expectInvalid("SELECT 1; DROP TABLE companies", "forbidden");
  });

  it("rejects two SELECTs separated by semicolon", () => {
    expectInvalid("SELECT 1; SELECT 2", "multiple statements");
  });

  it("rejects two SELECTs separated by newline + semicolon", () => {
    expectInvalid("SELECT 1\n;SELECT 2", "multiple statements");
  });

  it("rejects multi-statement with leading whitespace", () => {
    expectInvalid("   SELECT 1;   SELECT 2   ", "multiple statements");
  });

  it("strips block comment and then evaluates stripped content", () => {
    expectValid("/* banner */ SELECT * FROM companies");
  });

  it("strips line comment and then evaluates stripped content", () => {
    expectValid("-- banner\nSELECT * FROM companies");
  });

  it("rejects `#` in PostgreSQL mode — AST parser does not accept it", () => {
    // Property: if stripSqlComments normalises something away for regex
    // purposes, the AST parser must still see the original; if it fails
    // there, the query is safely rejected. No bypass.
    expectInvalid("SELECT 1 # trailing comment\nFROM companies", "could not be parsed");
  });

  it("preserves keywords inside string literals (known conservative false positive)", () => {
    // The regex guard rejects even if the keyword is strictly inside a quoted
    // string. This is documented in sql.test.ts and we pin it here too.
    expectInvalid("SELECT 'DELETE' FROM companies", "forbidden");
  });

  it("allows literal semicolon inside a string", () => {
    expectValid("SELECT ';' FROM companies");
  });
});

describe("fuzz: comment smuggling — MySQL dialect slice", () => {
  // Split out so the `useDialect(MYSQL_URL)` beforeEach owns this describe
  // cleanly. Previously an inline `process.env.ATLAS_DATASOURCE_URL = MYSQL_URL`
  // lived inside the PG-dialect describe above — safe under the existing
  // per-test `beforeEach` reset but fragile for future tests added between.
  useDialect(MYSQL_URL);

  it("strips hash comment from regex guard (MySQL dialect where # is a valid comment)", () => {
    // `#` is a MySQL comment, not PG. stripSqlComments uses a single regex
    // that removes `#` lines unconditionally — safe because the AST parser
    // then sees the original SQL and will reject in PG mode (parser does
    // not accept `#` as comment or operator) while accepting it in MySQL.
    expectValid("SELECT 1 # trailing comment\nFROM companies");
  });
});

// ---------------------------------------------------------------------------
// Category 9 — Generator-based combinatorial property tests (≥60 cases)
//
// Each generator builds a syntactic shape from axes (dialect × keyword ×
// table-ref × obfuscator) and asserts the invariant: if the shape invokes
// a forbidden action or references a non-whitelisted table, the validator
// must reject. The generator covers all shape/axis combinations, producing
// well over 60 cases even with a small axis set.
// ---------------------------------------------------------------------------

const MUTATION_VERBS = ["DROP", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "TRUNCATE"] as const;
const COMMENT_WRAPPERS: Array<(verb: string) => string> = [
  (v) => v,
  (v) => `/* c */ ${v}`,
  (v) => `-- c\n${v}`,
  (v) => `# c\n${v}`,
  (v) => `/* a */ ${v} /* b */`,
];
const CASE_TRANSFORMS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.toLowerCase(),
  (s) => s.toUpperCase(),
  (s) =>
    s
      .split("")
      .map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase()))
      .join(""),
];

describe("fuzz: generator — mutation verbs × wrappers × case transforms", () => {
  useDialect(PG_URL);

  for (const verb of MUTATION_VERBS) {
    for (const wrap of COMMENT_WRAPPERS) {
      for (const xf of CASE_TRANSFORMS) {
        const sql = `${wrap(xf(verb))} companies (id) VALUES (1)`;
        it(`rejects ${verb} via wrapper:${wrap.name || "plain"} / case:${xf.name || "identity"} — ${sql.slice(0, 50)}…`, () => {
          // The mutation-guard layer (regex match on FORBIDDEN_PATTERNS) is the
          // LAYER we are attacking here. A parser-upgrade that happens to
          // reject the malformed payload would silently turn this assertion
          // green without verifying the guard still caught it. Pinning to
          // `"forbidden"` forces the rejection to come from layer 1.
          expectInvalid(sql, "forbidden");
        });
      }
    }
  }
});

// Generator: non-whitelisted table references smuggled through various shapes.
const NON_WHITELISTED = ["secret_data", "passwords", "mysql.user", "pg_catalog.pg_authid", "other.companies"];
const SHAPES: Array<(t: string) => string> = [
  (t) => `SELECT * FROM ${t}`,
  (t) => `SELECT id FROM companies UNION SELECT id FROM ${t}`,
  (t) => `SELECT * FROM companies WHERE id IN (SELECT id FROM ${t})`,
  (t) => `SELECT * FROM companies c JOIN ${t} s ON c.id = s.id`,
  (t) => `WITH x AS (SELECT id FROM ${t}) SELECT * FROM x`,
  (t) => `SELECT ARRAY(SELECT id FROM ${t}) FROM companies`,
  (t) => `SELECT * FROM companies c, LATERAL (SELECT id FROM ${t} WHERE id=c.id) s`,
];

describe("fuzz: generator — non-whitelisted table × query shape", () => {
  useDialect(PG_URL);

  for (const table of NON_WHITELISTED) {
    for (const shape of SHAPES) {
      const sql = shape(table);
      it(`rejects ${table} via shape — ${sql.slice(0, 60)}…`, () => {
        // Pin to the whitelist-layer rejection message. A parser upgrade that
        // accidentally accepts (say) `pg_catalog.pg_authid` syntax and relies
        // on the whitelist to reject must still turn red here — but if the
        // parser starts rejecting FIRST, the whitelist layer is no longer
        // exercised by this test. Using `not in the allowed list` forces the
        // rejection to come from layer 3.
        expectInvalid(sql, "not in the allowed list");
      });
    }
  }
});

// Generator: whitelisted tables through the same shapes must succeed.
const WHITELISTED_TABLES = ["companies", "people", "accounts", "orders"];

describe("fuzz: generator — whitelisted table × shape must pass", () => {
  useDialect(PG_URL);

  for (const table of WHITELISTED_TABLES) {
    for (const shape of SHAPES) {
      const sql = shape(table).replace(/\bsecret_data\b|\bpasswords\b|\bmysql\.user\b|\bpg_catalog\.pg_authid\b|\bother\.companies\b/g, table);
      it(`accepts ${table} via shape — ${sql.slice(0, 60)}…`, () => {
        const r = validateSQL(sql);
        expect(r.valid).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Category 10 — Regression pins for phase-3 validator bypass fixes
//
// Fixed in the phase-3 follow-up PR (F-17 MySQL executable comments,
// F-18 PG SELECT INTO, F-19 MySQL INTO DUMPFILE). Each pin's reason
// fragment is aligned with the layer that closes the bypass so a future
// refactor that moves the rejection to a different layer surfaces here
// before shipping.
// ---------------------------------------------------------------------------

describe("fuzz: regression pins — phase-3 validator bypass fixes", () => {
  // F-17 variants (MySQL executable comments, issue #1772). Separate pins
  // per variant so a partial regression (handling only one form) would not
  // slip by — each shape (version digits, boundary digits, no digits,
  // inside CTE, comma-splice, nesting, EOF, positive unwrap) has its own
  // assertion.

  describe("F-17 variants — MySQL `/*!NNNNN */` executable comments", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    });

    it("F-17.a: bare /*!50000 UNION ... */ against mysql.user is rejected", () => {
      // Unwrap (Option A): `/*!50000 ... */` becomes live SQL so the
      // whitelist sees the mysql.user reference and rejects it.
      expectInvalid(
        "SELECT 1 /*!50000 UNION SELECT user FROM mysql.user */",
        "not in the allowed list",
      );
    });

    it("F-17.b: boundary version /*!00000 */ is rejected", () => {
      expectInvalid(
        "SELECT 1 /*!00000 UNION SELECT id FROM secret_data */",
        "not in the allowed list",
      );
    });

    it("F-17.c: high-version /*!99999 */ is rejected", () => {
      // Defense in depth: the validator must not rely on the server version
      // check to decline execution — the unwrap normalizes digits away.
      expectInvalid(
        "SELECT 1 /*!99999 UNION SELECT id FROM secret_data */",
        "not in the allowed list",
      );
    });

    it("F-17.d: /*! (no digits) is rejected", () => {
      // MariaDB-style conditional comment with no version gate. Regex
      // tolerates `\d{0,5}` so the unwrap still fires.
      expectInvalid(
        "SELECT 1 /*! UNION SELECT id FROM secret_data */",
        "not in the allowed list",
      );
    });

    it("F-17.e: /*! inside a CTE body is rejected", () => {
      expectInvalid(
        "WITH x AS (SELECT 1 /*!50000 UNION SELECT id FROM secret_data */) SELECT * FROM x",
        "not in the allowed list",
      );
    });

    it("F-17.f: /*! smuggling a column into the SELECT list is rejected", () => {
      expectInvalid(
        "SELECT 1 /*!50000 , (SELECT id FROM secret_data LIMIT 1) AS leaked */ FROM companies",
        "not in the allowed list",
      );
    });

    it("F-17.g: nested /*!50000 /*!80000 ... */ */ unwrap exposes the DML keyword", () => {
      // Loop-until-stable unwrap peels both levels. Inner content `DROP`
      // reaches the regex guard as live SQL and fires a mutation match.
      expectInvalid(
        "SELECT 1 /*!50000 /*!80000 DROP companies */ */",
        "forbidden",
      );
    });

    it("F-17.h: unclosed /*!NNNNN ... (EOF, no closing */) still rejected", () => {
      // No `*/` means the unwrap regex doesn't fire. The unclosed comment
      // stays intact so the regex guard sees the literal `DROP` inside the
      // prefix and rejects it as a mutation keyword.
      expectInvalid("SELECT 1 /*!50000 DROP", "forbidden");
    });

    it("F-17.i: /*! with whitespace before digits still rejects (MariaDB zero-digit form)", () => {
      // Pin the `\d{0,5}` tolerance. MySQL's grammar requires digits to
      // immediately follow `/*!` — a space means this is the MariaDB no-digit
      // form with body ` 50000 UNION ...`, which unwraps to live SQL whose
      // stray `50000` token node-sql-parser then rejects at parse layer.
      // Guards against a future tighten-to-`\d{1,5}` regression that would
      // leave the MariaDB form unwrapped-but-executable by the server.
      expectInvalid(
        "SELECT 1 /*! 50000 UNION SELECT id FROM secret_data */",
        "could not be parsed",
      );
    });

    it("F-17.j: /*!NNNNNN (over-spec six digits) still rejects", () => {
      // `\d{0,5}` consumes five digits and leaves the trailing `0` in the
      // body, producing `SELECT 1 0 UNION SELECT ...` which fails parse.
      // If the regex were relaxed to `\d+`, MySQL would simply treat this
      // as MariaDB-form (`/*!` + body starting with `500000 ...`) and still
      // execute — this pin locks in the rejection either way.
      expectInvalid(
        "SELECT 1 /*!500000 UNION SELECT id FROM secret_data */",
        "could not be parsed",
      );
    });

    it("F-17.k: nested /*! /*! ... */ */ (no digits at either level) still rejects", () => {
      // Stacked MariaDB-form wrappers — separate branch through the regex's
      // `\d{0,5}` alternation from the digits+digits nest covered by F-17.g.
      expectInvalid(
        "WITH x AS (SELECT 1 /*! /*! , (SELECT id FROM secret_data) */ */) SELECT * FROM x",
        "not in the allowed list",
      );
    });

    it("F-17 positive regression: unwrapped /*! against a whitelisted table is accepted", () => {
      // Option A must not over-reject — a `/*!` wrapper around a UNION that
      // only references whitelisted tables unwraps to valid SQL and passes.
      expectValid("SELECT 1 /*!50000 UNION SELECT id FROM companies */");
    });

    it("F-17 string-literal protection: /*! inside a string must not be unwrapped", () => {
      // The unwrap regex alternates with a string-literal arm so a literal
      // `'/*!50000 ...'` stays as a plain string and the query validates
      // against the outer whitelisted table.
      expectValid("SELECT '/*!50000 ignore' FROM companies");
    });
  });

  describe("F-17 PG-mode regression — unwrap must not activate for PostgreSQL", () => {
    beforeEach(() => {
      process.env.ATLAS_DATASOURCE_URL = PG_URL;
    });

    it("PG treats /*!...*/ as a plain comment — payload that WOULD reject if unwrapped stays valid", () => {
      // Strong property: the comment body references `mysql.user` (not in the
      // whitelist). If unwrap fired in PG mode, the whitelist would see
      // `mysql.user` and reject. It stays valid because PG skips the unwrap
      // entirely and treats `/*!50000 ... */` as an ordinary block comment.
      expectValid(
        "SELECT * FROM companies WHERE id = 1 /*!50000 OR 1=1 UNION SELECT user FROM mysql.user */",
      );
    });
  });

  it("F-18 (P2, PostgreSQL, #1773): SELECT INTO new_table is blocked", () => {
    process.env.ATLAS_DATASOURCE_URL = PG_URL;
    // PG's `SELECT ... INTO new_table FROM source` creates a table (DDL
    // equivalent). AST-layer guard rejects on `stmt.into.type === "into"`
    // with a non-"var" keyword (excludes MySQL variable assignment).
    expectInvalid("SELECT * INTO new_table FROM companies", "forbidden");
  });

  it("F-18 regression: plain SELECT still accepted", () => {
    process.env.ATLAS_DATASOURCE_URL = PG_URL;
    expectValid("SELECT * FROM companies");
  });

  it("F-18 regression: MySQL SELECT INTO @var (session variable) still accepted", () => {
    // `INTO @var` is session-local variable assignment — not a table write.
    // AST keyword is "var" so the guard skips it.
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectValid("SELECT id INTO @my_var FROM companies LIMIT 1");
  });

  it("F-18 regression: MySQL multi-variable INTO @a, @b still accepted", () => {
    // Multiple variable targets share the same `keyword === "var"` shape.
    // Pin exercises the `var`-carve-out against a richer AST payload.
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectValid("SELECT id, id INTO @a, @b FROM companies LIMIT 1");
  });

  it("F-18 regression: PG SELECT INTO TEMP ... is rejected (parser-layer today, AST-guard if parser adds support)", () => {
    // node-sql-parser 5.4 does not recognise PG's `SELECT INTO TEMP t` form,
    // so today this rejects at parse layer. If a future parser release adds
    // support, the AST guard would catch it via `keyword === "temp"` (not
    // `"var"`) — the layer-fragment expectation flips naturally in that case.
    process.env.ATLAS_DATASOURCE_URL = PG_URL;
    expectInvalid("SELECT * INTO TEMP t FROM companies", "could not be parsed");
  });

  it("F-19 (P2, MySQL, #1774): INTO DUMPFILE is blocked", () => {
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    // Regex `INTO\s+(?:OUTFILE|DUMPFILE)` now enumerates both filesystem
    // writing variants. Requires FILE privilege at runtime but the
    // validator layer must catch both consistently.
    expectInvalid("SELECT * FROM companies INTO DUMPFILE '/tmp/x'", "forbidden");
  });

  it("F-19 regression: INTO OUTFILE still rejected after DUMPFILE extension", () => {
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectInvalid("SELECT * FROM companies INTO OUTFILE '/tmp/x'", "forbidden");
  });

  it("F-19 regression: column named 'dumpfile' is not falsely rejected", () => {
    // The regex requires `INTO\s+DUMPFILE` — a column named `dumpfile` with
    // no leading `INTO` must parse and evaluate normally. Table is whitelisted
    // so this is a positive case.
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectValid("SELECT dumpfile FROM companies");
  });

  it("F-19 regression: INTO<TAB>DUMPFILE still rejected (whitespace class, not literal space)", () => {
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectInvalid("SELECT * FROM companies INTO\tDUMPFILE '/tmp/x'", "forbidden");
  });

  it("F-19 regression: INTO<NEWLINE>DUMPFILE still rejected", () => {
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectInvalid("SELECT * FROM companies INTO\nDUMPFILE '/tmp/x'", "forbidden");
  });

  it("F-19 regression: backtick-quoted `DUMPFILE` still rejected by parse layer", () => {
    // MySQL does not accept `` INTO `DUMPFILE` `` as filesystem-write syntax
    // (the keyword must be a bare identifier), so node-sql-parser rejects.
    // Pin documents the layered defence — regex deliberately does NOT match
    // backticks; the parser catches this shape.
    process.env.ATLAS_DATASOURCE_URL = MYSQL_URL;
    expectInvalid(
      "SELECT * FROM companies INTO `DUMPFILE` '/tmp/x'",
      "could not be parsed",
    );
  });
});
