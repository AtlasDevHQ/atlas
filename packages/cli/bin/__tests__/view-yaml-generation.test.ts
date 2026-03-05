import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import type { TableProfile, ColumnProfile } from "../atlas";
import { generateEntityYAML, generateMetricYAML } from "../atlas";

// --- Helpers ---

function makeColumn(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
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

function makeViewProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    table_name: "order_summary",
    object_type: "view" as const,
    row_count: 1500,
    columns: [
      makeColumn({ name: "region", type: "text", sample_values: ["US", "EU", "APAC"] }),
      makeColumn({ name: "total_orders", type: "integer" }),
      makeColumn({ name: "total_revenue", type: "numeric", sample_values: ["12345.67", "98765.43"] }),
      makeColumn({ name: "avg_order_value", type: "real" }),
    ],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

// --- generateEntityYAML with view profiles ---

describe("generateEntityYAML (views)", () => {
  test("produces type 'view' for view profiles", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.type).toBe("view");
  });

  test("does not include measures section for views", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.measures).toBeUndefined();
  });

  test("does not include query_patterns section for views", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.query_patterns).toBeUndefined();
  });

  test("description starts with 'Database view:'", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(typeof doc.description).toBe("string");
    expect((doc.description as string).startsWith("Database view:")).toBe(true);
  });

  test("grain mentions 'view'", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(typeof doc.grain).toBe("string");
    expect((doc.grain as string).toLowerCase()).toContain("view");
  });

  test("use_cases includes database view note", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const useCases = doc.use_cases as string[];
    expect(Array.isArray(useCases)).toBe(true);
    expect(useCases.some((uc) => uc.toLowerCase().includes("database view"))).toBe(true);
  });

  test("dimensions are still generated for view columns", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const dimensions = doc.dimensions as Record<string, unknown>[];
    expect(Array.isArray(dimensions)).toBe(true);
    // Should have at least the 4 base columns (may also have virtual dims)
    const baseNames = dimensions.filter((d) => !d.virtual).map((d) => d.name);
    expect(baseNames).toContain("region");
    expect(baseNames).toContain("total_orders");
    expect(baseNames).toContain("total_revenue");
    expect(baseNames).toContain("avg_order_value");
  });

  test("no joins are generated for view with no FKs", () => {
    const profile = makeViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.joins).toBeUndefined();
  });
});

// --- generateMetricYAML with view profiles ---

describe("generateMetricYAML (views)", () => {
  test("returns null for view profiles even with numeric columns", () => {
    const profile = makeViewProfile();
    const result = generateMetricYAML(profile);

    expect(result).toBeNull();
  });

  test("returns null for view profiles with no numeric columns", () => {
    const profile = makeViewProfile({
      columns: [
        makeColumn({ name: "name", type: "text" }),
        makeColumn({ name: "status", type: "text" }),
      ],
    });
    const result = generateMetricYAML(profile);

    expect(result).toBeNull();
  });
});
