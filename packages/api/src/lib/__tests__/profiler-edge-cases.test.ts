/**
 * Edge case tests for profiler pure functions.
 *
 * Tests YAML generation (entity, catalog, metric, glossary), MySQL backtick
 * escaping (mysqlQuoteIdent), entityName, mapSQLType boundary cases,
 * and edge conditions (empty columns, zero rows, long names, views).
 */

import { describe, it, expect, mock } from "bun:test";

// Mock logger to avoid pino output at import time
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

import {
  generateEntityYAML,
  generateCatalogYAML,
  generateMetricYAML,
  generateGlossaryYAML,
  entityName,
  mysqlQuoteIdent,
  mapSQLType,
  type TableProfile,
  type ColumnProfile,
} from "@atlas/api/lib/profiler";

// --- Helpers ---

function makeColumn(overrides?: Partial<ColumnProfile>): ColumnProfile {
  return {
    name: "col",
    type: "text",
    nullable: false,
    unique_count: null,
    null_count: null,
    sample_values: [],
    is_primary_key: false,
    is_foreign_key: false,
    fk_target_table: null,
    fk_target_column: null,
    is_enum_like: false,
    profiler_notes: [],
    ...overrides,
  };
}

function makeProfile(overrides?: Partial<TableProfile>): TableProfile {
  return {
    table_name: "users",
    object_type: "table",
    row_count: 100,
    columns: [],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

// =====================================================================
// entityName
// =====================================================================

describe("entityName", () => {
  it("converts snake_case to PascalCase", () => {
    expect(entityName("user_accounts")).toBe("UserAccounts");
  });

  it("handles single word", () => {
    expect(entityName("users")).toBe("Users");
  });

  it("handles table name with dots (no splitting)", () => {
    // Dots are not split — only underscores
    expect(entityName("user.accounts")).toBe("User.accounts");
  });

  it("handles table name with hyphens (no splitting)", () => {
    expect(entityName("order-items")).toBe("Order-items");
  });

  it("handles very long table name", () => {
    const longName = "a_" + "b".repeat(200);
    const result = entityName(longName);
    expect(result.length).toBeGreaterThan(200);
    expect(result.startsWith("A")).toBe(true);
  });

  it("handles name with consecutive underscores", () => {
    expect(entityName("user__accounts")).toBe("UserAccounts");
  });
});

// =====================================================================
// mysqlQuoteIdent
// =====================================================================

describe("mysqlQuoteIdent", () => {
  it("wraps simple name in backticks", () => {
    expect(mysqlQuoteIdent("users")).toBe("`users`");
  });

  it("escapes embedded backticks by doubling them", () => {
    expect(mysqlQuoteIdent("user`s")).toBe("`user``s`");
  });

  it("handles multiple embedded backticks", () => {
    expect(mysqlQuoteIdent("a`b`c")).toBe("`a``b``c`");
  });

  it("handles name that is just a backtick", () => {
    expect(mysqlQuoteIdent("`")).toBe("````");
  });

  it("handles empty string", () => {
    expect(mysqlQuoteIdent("")).toBe("``");
  });

  it("handles name with spaces", () => {
    expect(mysqlQuoteIdent("my table")).toBe("`my table`");
  });

  it("handles name with dots", () => {
    expect(mysqlQuoteIdent("schema.table")).toBe("`schema.table`");
  });

  it("handles name with hyphens", () => {
    expect(mysqlQuoteIdent("order-items")).toBe("`order-items`");
  });
});

// =====================================================================
// generateEntityYAML — edge cases
// =====================================================================

describe("generateEntityYAML edge cases", () => {
  it("handles empty columns array", () => {
    const profile = makeProfile({ columns: [] });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("name: Users");
    expect(yaml).toContain("table: users");
    expect(yaml).toContain("dimensions: []");
  });

  it("handles table with zero rows", () => {
    const profile = makeProfile({ row_count: 0 });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("0 rows");
  });

  it("handles table name with dots", () => {
    const profile = makeProfile({ table_name: "user.accounts" });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("table: user.accounts");
    expect(yaml).toContain("name: User.accounts");
  });

  it("handles table name with hyphens", () => {
    const profile = makeProfile({ table_name: "order-items" });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("table: order-items");
  });

  it("handles very long table name", () => {
    const longName = "a".repeat(200);
    const profile = makeProfile({ table_name: longName });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    // YAML dumps long values with multiline `>-` syntax; verify the name is present
    expect(yaml).toContain(longName);
  });

  it("handles non-public schema", () => {
    const profile = makeProfile({ table_name: "accounts" });
    const yaml = generateEntityYAML(profile, [profile], "postgres", "analytics");

    expect(yaml).toContain("table: analytics.accounts");
  });

  it("generates MySQL-style virtual dimensions for numeric columns", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "amount", type: "decimal" }),
      ],
    });
    const yaml = generateEntityYAML(profile, [profile], "mysql");

    expect(yaml).toContain("amount_bucket");
    // MySQL uses CASE WHEN with subquery AVG, not PERCENTILE_CONT
    expect(yaml).toContain("AVG(amount)");
    expect(yaml).not.toContain("PERCENTILE_CONT");
  });

  it("generates Postgres-style virtual dimensions for numeric columns", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "revenue", type: "numeric" }),
      ],
    });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("revenue_bucket");
    expect(yaml).toContain("PERCENTILE_CONT");
  });

  it("generates MySQL-style date extraction for date columns", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "created_at", type: "datetime" }),
      ],
    });
    const yaml = generateEntityYAML(profile, [profile], "mysql");

    expect(yaml).toContain("YEAR(created_at)");
    expect(yaml).toContain("DATE_FORMAT(created_at");
  });

  it("generates Postgres-style date extraction for date columns", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "created_at", type: "timestamp" }),
      ],
    });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("EXTRACT(YEAR");
    expect(yaml).toContain("TO_CHAR(created_at");
  });

  it("includes source connection in YAML when specified", () => {
    const profile = makeProfile();
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public", "analytics-db");

    expect(yaml).toContain("connection: analytics-db");
  });

  it("skips measures for views", () => {
    const profile = makeProfile({
      object_type: "view",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "amount", type: "decimal" }),
      ],
    });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    // Views should not have measures
    expect(yaml).not.toContain("measures:");
    expect(yaml).toContain("Database view:");
  });

  it("skips measures for materialized views", () => {
    const profile = makeProfile({
      object_type: "materialized_view",
      columns: [
        makeColumn({ name: "total", type: "numeric" }),
      ],
    });
    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).not.toContain("measures:");
    expect(yaml).toContain("Materialized view:");
  });
});

// =====================================================================
// generateMetricYAML
// =====================================================================

describe("generateMetricYAML", () => {
  it("returns null for views", () => {
    const profile = makeProfile({
      object_type: "view",
      columns: [makeColumn({ name: "amount", type: "numeric" })],
    });
    expect(generateMetricYAML(profile)).toBeNull();
  });

  it("returns null for materialized views", () => {
    const profile = makeProfile({
      object_type: "materialized_view",
      columns: [makeColumn({ name: "total", type: "integer" })],
    });
    expect(generateMetricYAML(profile)).toBeNull();
  });

  it("returns null when no numeric columns", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "name", type: "text" }),
        makeColumn({ name: "email", type: "varchar" }),
      ],
    });
    expect(generateMetricYAML(profile)).toBeNull();
  });

  it("excludes PK and FK columns from metrics", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "org_id", type: "integer", is_foreign_key: true }),
        makeColumn({ name: "user_id", type: "integer" }), // ends in _id — excluded
      ],
    });
    expect(generateMetricYAML(profile)).toBeNull();
  });

  it("generates metrics for tables with numeric columns", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "amount", type: "decimal" }),
      ],
      primary_key_columns: ["id"],
    });
    const result = generateMetricYAML(profile);
    expect(result).not.toBeNull();
    expect(result!).toContain("total_amount");
    expect(result!).toContain("avg_amount");
    expect(result!).toContain("users_count");
  });

  it("uses schema-qualified table name for non-public schemas", () => {
    const profile = makeProfile({
      columns: [makeColumn({ name: "revenue", type: "numeric" })],
    });
    const result = generateMetricYAML(profile, "analytics");
    expect(result).not.toBeNull();
    expect(result!).toContain("analytics.users");
  });
});

// =====================================================================
// generateCatalogYAML
// =====================================================================

describe("generateCatalogYAML", () => {
  it("handles empty profiles array", () => {
    const yaml = generateCatalogYAML([]);
    expect(yaml).toContain("version: '1.0'");
    expect(yaml).toContain("entities: []");
  });

  it("generates catalog entries with grain and description", () => {
    const profile = makeProfile({
      row_count: 5000,
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
      ],
    });
    const yaml = generateCatalogYAML([profile]);
    expect(yaml).toContain("name: Users");
    expect(yaml).toContain("entities/users.yml");
    expect(yaml).toContain("5,000 rows");
  });

  it("flags abandoned tables in tech_debt", () => {
    const profile = makeProfile({
      table_flags: { possibly_abandoned: true, possibly_denormalized: false },
    });
    const yaml = generateCatalogYAML([profile]);
    expect(yaml).toContain("tech_debt");
    expect(yaml).toContain("possibly_abandoned");
  });

  it("flags denormalized tables in tech_debt", () => {
    const profile = makeProfile({
      table_flags: { possibly_abandoned: false, possibly_denormalized: true },
    });
    const yaml = generateCatalogYAML([profile]);
    expect(yaml).toContain("tech_debt");
    expect(yaml).toContain("possibly_denormalized");
  });
});

// =====================================================================
// generateGlossaryYAML
// =====================================================================

describe("generateGlossaryYAML", () => {
  it("marks columns appearing in multiple tables as ambiguous", () => {
    const profiles = [
      makeProfile({
        table_name: "users",
        columns: [makeColumn({ name: "status", type: "text" })],
      }),
      makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "status", type: "text" })],
      }),
    ];
    const yaml = generateGlossaryYAML(profiles);
    expect(yaml).toContain("ambiguous");
    expect(yaml).toContain("status");
    expect(yaml).toContain("users.status");
    expect(yaml).toContain("orders.status");
  });

  it("does not mark unique columns as ambiguous", () => {
    const profiles = [
      makeProfile({
        table_name: "users",
        columns: [makeColumn({ name: "email", type: "text" })],
      }),
      makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "total", type: "decimal" })],
      }),
    ];
    const yaml = generateGlossaryYAML(profiles);
    expect(yaml).not.toContain("ambiguous");
  });

  it("skips PK and FK columns", () => {
    const profiles = [
      makeProfile({
        table_name: "users",
        columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      }),
      makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      }),
    ];
    const yaml = generateGlossaryYAML(profiles);
    // id is a PK in both tables — should be skipped, not marked ambiguous
    expect(yaml).not.toContain("ambiguous");
  });
});

// =====================================================================
// mapSQLType — boundary cases
// =====================================================================

describe("mapSQLType edge cases", () => {
  it("maps interval to string (not number)", () => {
    expect(mapSQLType("interval")).toBe("string");
  });

  it("maps money to string", () => {
    expect(mapSQLType("money")).toBe("string");
  });

  it("unwraps Nullable() wrapper", () => {
    expect(mapSQLType("Nullable(Int32)")).toBe("number");
  });

  it("unwraps LowCardinality() wrapper", () => {
    expect(mapSQLType("LowCardinality(String)")).toBe("string");
  });

  it("maps timestamp variants to date", () => {
    expect(mapSQLType("timestamp without time zone")).toBe("date");
    expect(mapSQLType("timestamptz")).toBe("date");
    expect(mapSQLType("timestamp with time zone")).toBe("date");
  });
});
