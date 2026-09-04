/**
 * Tests for shared profiler library — pure functions for YAML generation,
 * type mapping, heuristics, and pluralization.
 */
import { describe, it, expect } from "bun:test";
import {
  mapSQLType,
  mapSalesforceFieldType,
  singularize,
  pluralize,
  entityName,
  mysqlQuoteIdent,
  isView,
  isMatView,
  isViewLike,
  isFatalConnectionError,
  checkFailureThreshold,
  analyzeTableProfiles,
  generateEntityYAML,
  generateCatalogYAML,
  generateGlossaryYAML,
  generateMetricYAML,
  outputDirForDatasource,
  outputDirForGroup,
  type TableProfile,
  type ColumnProfile,
  type ProfilingResult,
} from "../profiler";
import * as path from "path";

// ---------------------------------------------------------------------------
// mapSQLType
// ---------------------------------------------------------------------------

describe("mapSQLType", () => {
  it("maps integer types to number", () => {
    expect(mapSQLType("integer")).toBe("number");
    expect(mapSQLType("bigint")).toBe("number");
    expect(mapSQLType("int")).toBe("number");
    expect(mapSQLType("smallint")).toBe("number");
  });

  it("maps float types to number", () => {
    expect(mapSQLType("float")).toBe("number");
    expect(mapSQLType("double precision")).toBe("number");
    expect(mapSQLType("numeric")).toBe("number");
    expect(mapSQLType("decimal")).toBe("number");
    expect(mapSQLType("real")).toBe("number");
  });

  it("maps boolean types", () => {
    expect(mapSQLType("boolean")).toBe("boolean");
    expect(mapSQLType("bool")).toBe("boolean");
  });

  it("maps date/time types", () => {
    expect(mapSQLType("date")).toBe("date");
    expect(mapSQLType("timestamp")).toBe("date");
    expect(mapSQLType("timestamp with time zone")).toBe("date");
    expect(mapSQLType("datetime")).toBe("date");
    expect(mapSQLType("time")).toBe("date");
  });

  it("maps text types to string", () => {
    expect(mapSQLType("text")).toBe("string");
    expect(mapSQLType("character varying")).toBe("string");
    expect(mapSQLType("varchar")).toBe("string");
    expect(mapSQLType("uuid")).toBe("string");
  });

  it("maps interval and money to string", () => {
    expect(mapSQLType("interval")).toBe("string");
    expect(mapSQLType("money")).toBe("string");
  });

  it("unwraps ClickHouse Nullable/LowCardinality", () => {
    expect(mapSQLType("Nullable(Int32)")).toBe("number");
    expect(mapSQLType("LowCardinality(String)")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// mapSalesforceFieldType
// ---------------------------------------------------------------------------

describe("mapSalesforceFieldType", () => {
  it("maps Salesforce types", () => {
    expect(mapSalesforceFieldType("int")).toBe("integer");
    expect(mapSalesforceFieldType("double")).toBe("real");
    expect(mapSalesforceFieldType("currency")).toBe("real");
    expect(mapSalesforceFieldType("boolean")).toBe("boolean");
    expect(mapSalesforceFieldType("date")).toBe("date");
    expect(mapSalesforceFieldType("string")).toBe("string");
    expect(mapSalesforceFieldType("reference")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Pluralization
// ---------------------------------------------------------------------------

describe("pluralize", () => {
  it("handles regular plurals", () => {
    expect(pluralize("user")).toBe("users");
    expect(pluralize("order")).toBe("orders");
  });

  it("handles -y ending", () => {
    expect(pluralize("company")).toBe("companies");
  });

  it("handles -s/-x/-z endings", () => {
    expect(pluralize("address")).toBe("addresses");
    expect(pluralize("box")).toBe("boxes");
  });

  it("handles irregular plurals", () => {
    expect(pluralize("person")).toBe("people");
    expect(pluralize("child")).toBe("children");
  });
});

describe("singularize", () => {
  it("handles regular singulars", () => {
    expect(singularize("users")).toBe("user");
    expect(singularize("orders")).toBe("order");
  });

  it("handles -ies ending", () => {
    expect(singularize("companies")).toBe("company");
  });

  it("handles irregular singulars", () => {
    expect(singularize("people")).toBe("person");
    expect(singularize("children")).toBe("child");
  });

  it("preserves words ending in -ss, -us, -is", () => {
    expect(singularize("address")).toBe("address");
    expect(singularize("status")).toBe("status");
  });
});

// ---------------------------------------------------------------------------
// entityName
// ---------------------------------------------------------------------------

describe("entityName", () => {
  it("converts snake_case to PascalCase", () => {
    expect(entityName("user_accounts")).toBe("UserAccounts");
    expect(entityName("orders")).toBe("Orders");
    expect(entityName("order_line_items")).toBe("OrderLineItems");
  });
});

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

describe("view helpers", () => {
  const makeProfile = (type: "table" | "view" | "materialized_view"): TableProfile => ({
    table_name: "test",
    object_type: type,
    row_count: 0,
    columns: [],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  });

  it("isView identifies views", () => {
    expect(isView(makeProfile("view"))).toBe(true);
    expect(isView(makeProfile("table"))).toBe(false);
    expect(isView(makeProfile("materialized_view"))).toBe(false);
  });

  it("isMatView identifies materialized views", () => {
    expect(isMatView(makeProfile("materialized_view"))).toBe(true);
    expect(isMatView(makeProfile("table"))).toBe(false);
  });

  it("isViewLike identifies both view types", () => {
    expect(isViewLike(makeProfile("view"))).toBe(true);
    expect(isViewLike(makeProfile("materialized_view"))).toBe(true);
    expect(isViewLike(makeProfile("table"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFatalConnectionError
// ---------------------------------------------------------------------------

describe("isFatalConnectionError", () => {
  it("detects ECONNREFUSED", () => {
    expect(isFatalConnectionError(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("detects error codes", () => {
    const err = new Error("connection failed") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    expect(isFatalConnectionError(err)).toBe(true);
  });

  it("rejects normal errors", () => {
    expect(isFatalConnectionError(new Error("column not found"))).toBe(false);
  });

  it("handles non-Error values", () => {
    expect(isFatalConnectionError("ECONNREFUSED")).toBe(true);
    expect(isFatalConnectionError("something else")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkFailureThreshold
// ---------------------------------------------------------------------------

describe("checkFailureThreshold", () => {
  it("does not abort when no errors", () => {
    const result: ProfilingResult = { profiles: [makeTestProfile("t1")], errors: [] };
    expect(checkFailureThreshold(result, false)).toEqual({ shouldAbort: false, failureRate: 0 });
  });

  it("aborts when failure rate exceeds 20%", () => {
    const result: ProfilingResult = {
      profiles: [makeTestProfile("t1")],
      errors: [
        { table: "t2", error: "fail" },
        { table: "t3", error: "fail" },
      ],
    };
    const check = checkFailureThreshold(result, false);
    expect(check.shouldAbort).toBe(true);
    expect(check.failureRate).toBeCloseTo(0.667, 2);
  });

  it("does not abort when force is set", () => {
    const result: ProfilingResult = {
      profiles: [],
      errors: [{ table: "t1", error: "fail" }],
    };
    expect(checkFailureThreshold(result, true).shouldAbort).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeTableProfiles (heuristics)
// ---------------------------------------------------------------------------

describe("analyzeTableProfiles", () => {
  it("infers foreign keys from _id columns", () => {
    const users = makeTestProfile("users", { withPk: true });
    const orders = makeTestProfile("orders", {
      columns: [
        makeColumn("id", "integer", { isPk: true }),
        makeColumn("user_id", "integer"),
      ],
    });

    const result = analyzeTableProfiles([users, orders]);
    const analyzedOrders = result.find((p) => p.table_name === "orders")!;

    expect(analyzedOrders.inferred_foreign_keys.length).toBe(1);
    expect(analyzedOrders.inferred_foreign_keys[0].to_table).toBe("users");
  });

  it("does not mutate the input profiles", () => {
    const legacy = makeTestProfile("old_accounts");
    const snapshot = JSON.parse(JSON.stringify(legacy));
    analyzeTableProfiles([legacy]);
    expect(legacy).toEqual(snapshot);
  });

  it("detects abandoned tables", () => {
    const legacy = makeTestProfile("old_accounts");
    const [result] = analyzeTableProfiles([legacy]);
    expect(result.table_flags.possibly_abandoned).toBe(true);
  });

  it("detects denormalized tables", () => {
    const summary = makeTestProfile("sales_summary");
    const [result] = analyzeTableProfiles([summary]);
    expect(result.table_flags.possibly_denormalized).toBe(true);
  });

  it("detects enum inconsistency", () => {
    const profile = makeTestProfile("products", {
      columns: [
        makeColumn("id", "integer", { isPk: true }),
        makeColumn("status", "text", {
          isEnumLike: true,
          sampleValues: ["Active", "active", "ACTIVE"],
        }),
      ],
    });

    const [result] = analyzeTableProfiles([profile]);

    const statusCol = result.columns.find((c) => c.name === "status");
    expect(statusCol?.profiler_notes.some((n) => n.startsWith("Case-inconsistent"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// YAML generation
// ---------------------------------------------------------------------------

describe("generateEntityYAML", () => {
  it("generates valid YAML for a simple table", () => {
    const profile = makeTestProfile("users", {
      withPk: true,
      columns: [
        makeColumn("id", "integer", { isPk: true }),
        makeColumn("name", "text"),
        makeColumn("email", "text"),
      ],
    });

    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("name: Users");
    expect(yaml).toContain("table: users");
    expect(yaml).toContain("dimensions:");
    expect(yaml).toContain("Primary key");
  });

  it("includes the canonical group field when a group is provided", () => {
    // #3285: the generator emits `group:` (ADR-0012), not the deprecated
    // `connection:` alias.
    const profile = makeTestProfile("users", { withPk: true });
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public", "warehouse");
    expect(yaml).toContain("group: warehouse");
    expect(yaml).not.toContain("connection:");
  });
});

describe("generateCatalogYAML", () => {
  it("generates catalog with entity list", () => {
    const profiles = [
      makeTestProfile("users", { withPk: true }),
      makeTestProfile("orders", { withPk: true }),
    ];
    const yaml = generateCatalogYAML(profiles);
    expect(yaml).toContain("version: '1.0'");
    expect(yaml).toContain("Users");
    expect(yaml).toContain("Orders");
  });
});

describe("generateGlossaryYAML", () => {
  it("generates glossary with ambiguous terms", () => {
    const profiles = [
      makeTestProfile("users", {
        columns: [
          makeColumn("id", "integer", { isPk: true }),
          makeColumn("status", "text"),
        ],
      }),
      makeTestProfile("orders", {
        columns: [
          makeColumn("id", "integer", { isPk: true }),
          makeColumn("status", "text"),
        ],
      }),
    ];
    const yaml = generateGlossaryYAML(profiles);
    expect(yaml).toContain("ambiguous");
    expect(yaml).toContain("status");
  });
});

describe("generateMetricYAML", () => {
  it("returns null for tables without numeric columns", () => {
    const profile = makeTestProfile("users", {
      columns: [
        makeColumn("id", "integer", { isPk: true }),
        makeColumn("name", "text"),
      ],
    });
    expect(generateMetricYAML(profile)).toBeNull();
  });

  it("generates metrics for tables with numeric columns", () => {
    const profile = makeTestProfile("orders", {
      columns: [
        makeColumn("id", "integer", { isPk: true }),
        makeColumn("total", "numeric"),
      ],
    });
    const yaml = generateMetricYAML(profile);
    expect(yaml).not.toBeNull();
    // "total" matches sum-only pattern — no avg generated
    expect(yaml!).toContain("total_total");
  });

  it("returns null for views", () => {
    const profile = makeTestProfile("order_summary", {
      objectType: "view",
      columns: [
        makeColumn("total", "numeric"),
      ],
    });
    expect(generateMetricYAML(profile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// outputDirForDatasource
// ---------------------------------------------------------------------------

describe("outputDirForDatasource", () => {
  it("returns semantic/ for default without orgId", () => {
    const result = outputDirForDatasource("default");
    expect(result).toMatch(/semantic$/);
  });

  it("returns semantic/{id}/ for non-default without orgId", () => {
    const result = outputDirForDatasource("warehouse");
    expect(result).toMatch(/semantic[/\\]warehouse$/);
  });

  it("returns semantic/.orgs/{orgId}/ for default with orgId", () => {
    const result = outputDirForDatasource("default", "org-123");
    expect(result).toContain(path.join(".orgs", "org-123"));
  });

  it("returns semantic/.orgs/{orgId}/{id}/ for non-default with orgId", () => {
    const result = outputDirForDatasource("warehouse", "org-123");
    expect(result).toContain(path.join(".orgs", "org-123", "warehouse"));
  });
});

// ---------------------------------------------------------------------------
// outputDirForGroup — canonical ADR-0012 groups/ namespace (#3234)
// ---------------------------------------------------------------------------

describe("outputDirForGroup", () => {
  it("returns the flat semantic/ root for the default group", () => {
    expect(outputDirForGroup(undefined)).toMatch(/semantic$/);
    expect(outputDirForGroup(null)).toMatch(/semantic$/);
    expect(outputDirForGroup("default")).toMatch(/semantic$/);
  });

  it("returns semantic/groups/<group>/ for a non-default group", () => {
    const result = outputDirForGroup("warehouse");
    expect(result).toMatch(/semantic[/\\]groups[/\\]warehouse$/);
  });

  it("nests the default group flat under .orgs/<orgId>/", () => {
    const result = outputDirForGroup(undefined, "org-123");
    expect(result).toContain(path.join(".orgs", "org-123"));
    expect(result).not.toContain(path.join("org-123", "groups"));
  });

  it("nests a non-default group under .orgs/<orgId>/groups/<group>/", () => {
    const result = outputDirForGroup("warehouse", "org-123");
    expect(result).toContain(path.join(".orgs", "org-123", "groups", "warehouse"));
  });

  it("produces the canonical groups/<group> suffix the #3232 loader reads", () => {
    // The CLI/wizard write to outputDirForGroup; the loader (getEntityDirs)
    // reads groups/<group>/. This pins the two halves agree: a non-default
    // group dir is exactly groups/<group> relative to the default root.
    const rel = path.relative(outputDirForGroup(undefined), outputDirForGroup("warehouse"));
    expect(rel).toBe(path.join("groups", "warehouse"));
    // The default group adds zero nesting (round-trips to the flat root).
    expect(path.relative(outputDirForGroup(undefined), outputDirForGroup("default"))).toBe("");
  });

  it("rejects group names containing path separators or traversal", () => {
    expect(() => outputDirForGroup("../escape")).toThrow();
    expect(() => outputDirForGroup("a/b")).toThrow();
    expect(() => outputDirForGroup("..")).toThrow();
  });

  it("rejects an orgId containing path separators or traversal (both helpers)", () => {
    // orgId becomes a path segment under .orgs/ — an --org/ATLAS_ORG_ID value
    // like "../../outside" must not escape the semantic root.
    expect(() => outputDirForGroup(undefined, "../../outside")).toThrow();
    expect(() => outputDirForGroup("warehouse", "a/b")).toThrow();
    expect(() => outputDirForDatasource("warehouse", "..")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeColumn(
  name: string,
  type: string,
  opts?: {
    isPk?: boolean;
    isFk?: boolean;
    fkTarget?: string;
    isEnumLike?: boolean;
    sampleValues?: string[];
  },
) {
  return {
    name,
    type,
    nullable: !opts?.isPk,
    unique_count: opts?.isPk ? 100 : 50,
    null_count: 0,
    sample_values: opts?.sampleValues ?? [],
    is_primary_key: opts?.isPk ?? false,
    is_foreign_key: opts?.isFk ?? false,
    fk_target_table: opts?.fkTarget ?? null,
    fk_target_column: opts?.fkTarget ? "id" : null,
    is_enum_like: opts?.isEnumLike ?? false,
    profiler_notes: [],
  };
}

function makeTestProfile(
  tableName: string,
  opts?: {
    withPk?: boolean;
    objectType?: "table" | "view" | "materialized_view";
    columns?: ReturnType<typeof makeColumn>[];
  },
): TableProfile {
  const columns = opts?.columns ?? (opts?.withPk
    ? [makeColumn("id", "integer", { isPk: true })]
    : []);
  return {
    table_name: tableName,
    object_type: opts?.objectType ?? "table",
    row_count: 100,
    columns,
    primary_key_columns: columns.filter((c) => c.is_primary_key).map((c) => c.name),
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  };
}

// ---------------------------------------------------------------------------
// Edge cases (merged from profiler-edge-cases.test.ts)
//
// YAML generation (entity, catalog, metric, glossary), MySQL backtick escaping
// (mysqlQuoteIdent), entityName, mapSQLType boundary cases, and edge conditions
// (empty columns, zero rows, long names, views). The helpers below shadow the
// module-level makeColumn/makeTestProfile on purpose — they take Partial<...>
// overrides rather than positional args.
// ---------------------------------------------------------------------------

describe("profiler edge cases", () => {

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
    it("maps timestamp variants to date", () => {
      expect(mapSQLType("timestamp without time zone")).toBe("date");
      expect(mapSQLType("timestamptz")).toBe("date");
      expect(mapSQLType("timestamp with time zone")).toBe("date");
    });
  });
});
