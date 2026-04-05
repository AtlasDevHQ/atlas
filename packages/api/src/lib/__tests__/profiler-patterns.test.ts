/**
 * Tests for profiler pattern detection — semantic type inference,
 * enhanced join discovery, and measure type suggestions.
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
  detectSemanticType,
  inferSemanticTypes,
  inferJoinsFromNamingConventions,
  suggestMeasureType,
  describeMeasure,
} from "@atlas/api/lib/profiler-patterns";
import { analyzeTableProfiles, generateEntityYAML, generateMetricYAML } from "@atlas/api/lib/profiler";
import type { ColumnProfile, TableProfile } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const columns = overrides?.columns ?? [];
  return {
    table_name: "test_table",
    object_type: "table",
    row_count: 1000,
    columns,
    primary_key_columns: columns.filter((c) => c.is_primary_key).map((c) => c.name),
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

// =====================================================================
// detectSemanticType — Currency
// =====================================================================

describe("detectSemanticType: currency", () => {
  it("detects currency from column name patterns", () => {
    const tests = ["amount", "price", "total_cost", "revenue", "fee", "salary", "balance"];
    for (const name of tests) {
      const col = makeColumn({ name, type: "numeric" });
      expect(detectSemanticType(col, 1000)).toBe("currency");
    }
  });

  it("detects currency from sample values with $ prefix", () => {
    const col = makeColumn({
      name: "value",
      type: "numeric",
      sample_values: ["$100.00", "$25.50", "$1,234.00"],
    });
    expect(detectSemanticType(col, 1000)).toBe("currency");
  });

  it("detects currency from sample values with 2 decimal places", () => {
    const col = makeColumn({
      name: "value",
      type: "numeric",
      sample_values: ["100.00", "25.50", "1234.99"],
    });
    expect(detectSemanticType(col, 1000)).toBe("currency");
  });

  it("does not detect currency on PK columns", () => {
    const col = makeColumn({ name: "amount", type: "integer", is_primary_key: true });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });

  it("does not detect currency on FK columns", () => {
    const col = makeColumn({ name: "amount", type: "integer", is_foreign_key: true });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });

  it("does not detect currency on string columns", () => {
    const col = makeColumn({ name: "amount", type: "text" });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });

  it("requires at least 2 matching sample values", () => {
    const col = makeColumn({
      name: "value",
      type: "numeric",
      sample_values: ["$100.00"],
    });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });
});

// =====================================================================
// detectSemanticType — Percentage
// =====================================================================

describe("detectSemanticType: percentage", () => {
  it("detects percentage from column name patterns", () => {
    const tests = ["success_rate", "click_rate", "open_rate", "conversion", "churn", "utilization"];
    for (const name of tests) {
      const col = makeColumn({ name, type: "numeric" });
      expect(detectSemanticType(col, 1000)).toBe("percentage");
    }
  });

  it("detects pct suffix", () => {
    const col = makeColumn({ name: "discount_pct", type: "numeric" });
    expect(detectSemanticType(col, 1000)).toBe("percentage");
  });

  it("does not detect percentage on string columns", () => {
    const col = makeColumn({ name: "success_rate", type: "text" });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });
});

// =====================================================================
// detectSemanticType — Email
// =====================================================================

describe("detectSemanticType: email", () => {
  it("detects email from sample values", () => {
    const col = makeColumn({
      name: "contact",
      type: "text",
      sample_values: ["alice@example.com", "bob@company.org", "carol@test.net"],
    });
    expect(detectSemanticType(col, 1000)).toBe("email");
  });

  it("requires majority of samples to match", () => {
    const col = makeColumn({
      name: "notes",
      type: "text",
      sample_values: ["alice@example.com", "just some text", "more text", "another text"],
    });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });

  it("requires at least 2 sample values", () => {
    const col = makeColumn({
      name: "email",
      type: "text",
      sample_values: ["alice@example.com"],
    });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });
});

// =====================================================================
// detectSemanticType — URL
// =====================================================================

describe("detectSemanticType: url", () => {
  it("detects url from column name patterns", () => {
    const tests = ["website_url", "profile_link", "homepage", "callback_uri"];
    for (const name of tests) {
      const col = makeColumn({ name, type: "text" });
      expect(detectSemanticType(col, 1000)).toBe("url");
    }
  });

  it("detects url from sample values", () => {
    const col = makeColumn({
      name: "source",
      type: "text",
      sample_values: ["https://example.com", "http://test.org/page", "https://api.service.io/v1"],
    });
    expect(detectSemanticType(col, 1000)).toBe("url");
  });

  it("does not detect url on numeric columns", () => {
    const col = makeColumn({ name: "url_count", type: "integer" });
    // url_count has "url" in name but is numeric — should not be url
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });
});

// =====================================================================
// detectSemanticType — Phone
// =====================================================================

describe("detectSemanticType: phone", () => {
  it("detects phone from column name patterns", () => {
    const col = makeColumn({ name: "phone_number", type: "text" });
    expect(detectSemanticType(col, 1000)).toBe("phone");
  });

  it("detects phone from sample values with high cardinality", () => {
    const col = makeColumn({
      name: "contact_info",
      type: "text",
      unique_count: 500,
      sample_values: ["+1-555-0100", "(555) 012-3456", "555.123.4567"],
    });
    expect(detectSemanticType(col, 1000)).toBe("phone");
  });

  it("does not detect phone on enum-like columns", () => {
    const col = makeColumn({
      name: "phone_type",
      type: "text",
      is_enum_like: true,
      sample_values: ["mobile", "home", "work"],
    });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });
});

// =====================================================================
// detectSemanticType — Timestamp
// =====================================================================

describe("detectSemanticType: timestamp", () => {
  it("detects timestamp from SQL type", () => {
    const types = [
      "timestamp",
      "timestamp with time zone",
      "timestamp without time zone",
      "timestamptz",
    ];
    for (const type of types) {
      const col = makeColumn({ name: "created_at", type });
      expect(detectSemanticType(col, 1000)).toBe("timestamp");
    }
  });

  it("does not flag plain date as timestamp", () => {
    const col = makeColumn({ name: "birth_date", type: "date" });
    expect(detectSemanticType(col, 1000)).toBeUndefined();
  });
});

// =====================================================================
// inferSemanticTypes (integration)
// =====================================================================

describe("inferSemanticTypes", () => {
  it("sets semantic_type on columns and adds profiler notes", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({ name: "email", type: "text", sample_values: ["a@b.com", "c@d.org"] }),
        makeColumn({ name: "revenue", type: "numeric" }),
        makeColumn({ name: "created_at", type: "timestamp" }),
      ],
    });

    inferSemanticTypes([profile]);

    expect(profile.columns[0].semantic_type).toBe("email");
    expect(profile.columns[0].profiler_notes).toContain("Detected semantic type: email");
    expect(profile.columns[1].semantic_type).toBe("currency");
    expect(profile.columns[2].semantic_type).toBe("timestamp");
  });

  it("does not overwrite existing profiler_notes", () => {
    const profile = makeProfile({
      columns: [
        makeColumn({
          name: "price",
          type: "numeric",
          profiler_notes: ["existing note"],
        }),
      ],
    });

    inferSemanticTypes([profile]);

    expect(profile.columns[0].profiler_notes).toContain("existing note");
    expect(profile.columns[0].profiler_notes).toContain("Detected semantic type: currency");
  });
});

// =====================================================================
// inferJoinsFromNamingConventions
// =====================================================================

describe("inferJoinsFromNamingConventions", () => {
  it("infers FK from _uuid suffix", () => {
    const users = makeProfile({
      table_name: "users",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "uuid", type: "uuid" }),
      ],
      primary_key_columns: ["id"],
    });
    const orders = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "user_uuid", type: "uuid" }),
      ],
      primary_key_columns: ["id"],
    });

    inferJoinsFromNamingConventions([users, orders]);

    expect(orders.inferred_foreign_keys.length).toBe(1);
    expect(orders.inferred_foreign_keys[0].to_table).toBe("users");
    expect(orders.inferred_foreign_keys[0].to_column).toBe("uuid");
  });

  it("infers FK from _code suffix", () => {
    const countries = makeProfile({
      table_name: "countries",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });
    const orders = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "country_code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });

    inferJoinsFromNamingConventions([countries, orders]);

    expect(orders.inferred_foreign_keys.length).toBe(1);
    expect(orders.inferred_foreign_keys[0].to_table).toBe("countries");
    expect(orders.inferred_foreign_keys[0].to_column).toBe("code");
  });

  it("falls back to id column when suffix column not found", () => {
    const users = makeProfile({
      table_name: "users",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
      ],
      primary_key_columns: ["id"],
    });
    const orders = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "user_key", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    inferJoinsFromNamingConventions([users, orders]);

    expect(orders.inferred_foreign_keys.length).toBe(1);
    expect(orders.inferred_foreign_keys[0].to_column).toBe("id");
  });

  it("does not duplicate joins already inferred by _id pattern", () => {
    const users = makeProfile({
      table_name: "users",
      columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const orders = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "user_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
      inferred_foreign_keys: [
        { from_column: "user_id", to_table: "users", to_column: "id", source: "inferred" },
      ],
    });

    inferJoinsFromNamingConventions([users, orders]);

    // Should not add a duplicate
    expect(orders.inferred_foreign_keys.length).toBe(1);
  });

  it("does not infer self-referencing joins", () => {
    const categories = makeProfile({
      table_name: "categories",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "category_code", type: "text" }),
        makeColumn({ name: "code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });

    inferJoinsFromNamingConventions([categories]);

    expect(categories.inferred_foreign_keys.length).toBe(0);
  });

  it("skips views", () => {
    const users = makeProfile({
      table_name: "users",
      object_type: "view",
      columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const orders = makeProfile({
      table_name: "orders",
      object_type: "view",
      columns: [makeColumn({ name: "user_uuid", type: "uuid" })],
    });

    inferJoinsFromNamingConventions([users, orders]);

    expect(orders.inferred_foreign_keys.length).toBe(0);
  });

  it("handles pluralization in table name matching", () => {
    const company = makeProfile({
      table_name: "companies",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });
    const contacts = makeProfile({
      table_name: "contacts",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "company_code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });

    inferJoinsFromNamingConventions([company, contacts]);

    expect(contacts.inferred_foreign_keys.length).toBe(1);
    expect(contacts.inferred_foreign_keys[0].to_table).toBe("companies");
  });
});

// =====================================================================
// suggestMeasureType
// =====================================================================

describe("suggestMeasureType", () => {
  it("suggests sum for _count columns", () => {
    const col = makeColumn({ name: "login_count", type: "integer" });
    expect(suggestMeasureType(col)).toBe("sum");
  });

  it("suggests sum for _total columns", () => {
    const col = makeColumn({ name: "order_total", type: "numeric" });
    expect(suggestMeasureType(col)).toBe("sum");
  });

  it("suggests sum for _quantity columns", () => {
    const col = makeColumn({ name: "item_quantity", type: "integer" });
    expect(suggestMeasureType(col)).toBe("sum");
  });

  it("suggests avg for _rate columns", () => {
    const col = makeColumn({ name: "click_rate", type: "numeric" });
    expect(suggestMeasureType(col)).toBe("avg");
  });

  it("suggests avg for _score columns", () => {
    const col = makeColumn({ name: "satisfaction_score", type: "numeric" });
    expect(suggestMeasureType(col)).toBe("avg");
  });

  it("suggests avg for _ratio columns", () => {
    const col = makeColumn({ name: "debt_ratio", type: "numeric" });
    expect(suggestMeasureType(col)).toBe("avg");
  });

  it("suggests avg for percentage semantic type", () => {
    const col = makeColumn({ name: "some_metric", type: "numeric", semantic_type: "percentage" });
    expect(suggestMeasureType(col)).toBe("avg");
  });

  it("suggests sum_and_avg for generic numeric columns", () => {
    const col = makeColumn({ name: "revenue", type: "numeric" });
    expect(suggestMeasureType(col)).toBe("sum_and_avg");
  });

  it("suggests count_where for boolean columns", () => {
    const col = makeColumn({ name: "is_active", type: "boolean" });
    expect(suggestMeasureType(col)).toBe("count_where");
  });
});

// =====================================================================
// describeMeasure
// =====================================================================

describe("describeMeasure", () => {
  it("includes monetary label for currency", () => {
    const col = makeColumn({ name: "total_price", type: "numeric", semantic_type: "currency" });
    expect(describeMeasure(col, "sum")).toContain("monetary");
  });

  it("includes rate label for percentage", () => {
    const col = makeColumn({ name: "churn_rate", type: "numeric", semantic_type: "percentage" });
    expect(describeMeasure(col, "avg")).toContain("rate/percentage");
  });

  it("produces plain label for generic columns", () => {
    const col = makeColumn({ name: "widget_count", type: "integer" });
    const desc = describeMeasure(col, "sum");
    expect(desc).toContain("Sum of");
    expect(desc).toContain("widget count");
  });
});

// =====================================================================
// Integration: analyzeTableProfiles includes patterns
// =====================================================================

describe("analyzeTableProfiles with pattern detection", () => {
  it("sets semantic types on analyzed profiles", () => {
    const profile = makeProfile({
      table_name: "invoices",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "amount", type: "numeric" }),
        makeColumn({ name: "created_at", type: "timestamp with time zone" }),
        makeColumn({
          name: "customer_email",
          type: "text",
          sample_values: ["a@test.com", "b@test.com", "c@test.com"],
        }),
      ],
      primary_key_columns: ["id"],
    });

    const [result] = analyzeTableProfiles([profile]);

    const amountCol = result.columns.find((c) => c.name === "amount");
    expect(amountCol?.semantic_type).toBe("currency");

    const dateCol = result.columns.find((c) => c.name === "created_at");
    expect(dateCol?.semantic_type).toBe("timestamp");

    const emailCol = result.columns.find((c) => c.name === "customer_email");
    expect(emailCol?.semantic_type).toBe("email");
  });

  it("discovers joins from _uuid and _code suffixes", () => {
    const departments = makeProfile({
      table_name: "departments",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });
    const employees = makeProfile({
      table_name: "employees",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "department_code", type: "text" }),
      ],
      primary_key_columns: ["id"],
    });

    const results = analyzeTableProfiles([departments, employees]);
    const analyzedEmployees = results.find((p) => p.table_name === "employees")!;

    expect(analyzedEmployees.inferred_foreign_keys.length).toBe(1);
    expect(analyzedEmployees.inferred_foreign_keys[0].to_table).toBe("departments");
    expect(analyzedEmployees.inferred_foreign_keys[0].to_column).toBe("code");
  });
});

// =====================================================================
// Integration: YAML generation uses semantic types
// =====================================================================

describe("generateEntityYAML with semantic types", () => {
  it("includes semantic_type in dimension YAML", () => {
    const profile = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "total_amount", type: "numeric", semantic_type: "currency" }),
      ],
      primary_key_columns: ["id"],
    });

    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("semantic_type: currency");
  });

  it("generates only SUM for count-like columns", () => {
    const profile = makeProfile({
      table_name: "events",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "view_count", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("total_view_count");
    expect(yaml).not.toContain("avg_view_count");
  });

  it("generates only AVG for rate columns", () => {
    const profile = makeProfile({
      table_name: "campaigns",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "click_rate", type: "numeric", semantic_type: "percentage" }),
      ],
      primary_key_columns: ["id"],
    });

    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("avg_click_rate");
    expect(yaml).not.toContain("total_click_rate");
  });

  it("generates count_where for boolean columns", () => {
    const profile = makeProfile({
      table_name: "users",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "is_active", type: "boolean" }),
      ],
      primary_key_columns: ["id"],
    });

    const yaml = generateEntityYAML(profile, [profile], "postgres");

    expect(yaml).toContain("is_active_count");
    expect(yaml).toContain("count_where");
  });
});

// =====================================================================
// Integration: generateMetricYAML uses smarter inference
// =====================================================================

describe("generateMetricYAML with smart measures", () => {
  it("generates only SUM metrics for _total columns", () => {
    const profile = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "line_total", type: "numeric" }),
      ],
      primary_key_columns: ["id"],
    });

    const yaml = generateMetricYAML(profile);
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("total_line_total");
    expect(yaml!).not.toContain("avg_line_total");
  });

  it("generates only AVG metrics for _rate columns", () => {
    const profile = makeProfile({
      table_name: "campaigns",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "open_rate", type: "numeric", semantic_type: "percentage" }),
      ],
      primary_key_columns: ["id"],
    });

    const yaml = generateMetricYAML(profile);
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("avg_open_rate");
    expect(yaml!).not.toContain("total_open_rate");
  });
});
