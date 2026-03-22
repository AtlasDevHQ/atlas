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
  type TableProfile,
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

  it("includes connection source when provided", () => {
    const profile = makeTestProfile("users", { withPk: true });
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public", "warehouse");
    expect(yaml).toContain("connection: warehouse");
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
    expect(yaml!).toContain("total_total");
    expect(yaml!).toContain("avg_total");
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
