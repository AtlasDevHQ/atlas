import { describe, expect, test } from "bun:test";
import * as path from "path";
import {
  outputDirForDatasource,
  generateEntityYAML,
} from "../atlas";
import type { TableProfile, ColumnProfile } from "../atlas";

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

function makeProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    table_name: "test_table",
    object_type: "table" as const,
    row_count: 100,
    columns: [makeColumn({ name: "id", is_primary_key: true })],
    primary_key_columns: ["id"],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

// --- Output directory computation ---

describe("outputDirForDatasource", () => {
  test('"default" maps to semantic/', () => {
    const dir = outputDirForDatasource("default");
    expect(dir).toBe(path.resolve("semantic"));
  });

  test('non-default maps to semantic/{id}/', () => {
    const dir = outputDirForDatasource("warehouse");
    expect(dir).toBe(path.resolve("semantic", "warehouse"));
  });

  test('another non-default name', () => {
    const dir = outputDirForDatasource("analytics");
    expect(dir).toBe(path.resolve("semantic", "analytics"));
  });
});

// --- Entity YAML connection: field ---

describe("entity YAML connection field", () => {
  const profile = makeProfile({
    table_name: "orders",
    columns: [
      makeColumn({ name: "id", is_primary_key: true, type: "integer" }),
      makeColumn({ name: "amount", type: "numeric" }),
    ],
    primary_key_columns: ["id"],
  });

  test("default source omits connection: field", () => {
    // source=undefined → no connection field
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public", undefined);
    expect(yaml).not.toContain("connection:");
  });

  test("named source includes connection: field", () => {
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public", "warehouse");
    expect(yaml).toContain("connection: warehouse");
  });

  test("different named source", () => {
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public", "analytics");
    expect(yaml).toContain("connection: analytics");
  });
});

// --- Schema resolution ---

describe("schema resolution", () => {
  const profile = makeProfile({
    table_name: "orders",
    columns: [
      makeColumn({ name: "id", is_primary_key: true, type: "integer" }),
    ],
    primary_key_columns: ["id"],
  });

  test("non-public schema qualifies table name", () => {
    const yaml = generateEntityYAML(profile, [profile], "postgres", "analytics");
    expect(yaml).toContain("table: analytics.orders");
  });

  test("public schema does not qualify table name", () => {
    const yaml = generateEntityYAML(profile, [profile], "postgres", "public");
    expect(yaml).toContain("table: orders");
    expect(yaml).not.toContain("table: public.orders");
  });
});
