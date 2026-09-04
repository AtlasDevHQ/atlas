/**
 * Object-type and multi-source behaviour of the `bin/atlas.ts` semantic-layer
 * generators: materialized views, partitioned tables, plain database views,
 * and the per-datasource output directory + `group:` field.
 *
 * Formerly three files against the same module, each carrying its own copy of
 * `makeColumn` / `makeProfile`: this one plus `view-yaml-generation.test.ts`
 * (the "database views" block below) and `multi-source.test.ts` (the
 * `outputDirForDatasource` / group-field / schema-resolution blocks at the
 * end). The profiler heuristics themselves live in `profiler-heuristics.test.ts`;
 * what stays here is only the view/matview EXCLUSION arm of each.
 */
import { describe, expect, test } from "bun:test";
import * as path from "path";
import * as yaml from "js-yaml";
import type { TableProfile, ColumnProfile, EntitySnapshot } from "../atlas";
import {
  generateEntityYAML,
  generateMetricYAML,
  generateCatalogYAML,
  isMatView,
  isViewLike,
  isView,
  outputDirForDatasource,
  parseEntityYAML,
  profileToSnapshot,
  computeDiff,
  formatDiff,
  inferForeignKeys,
  detectAbandonedTables,
  detectDenormalizedTables,
} from "../atlas";

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

function makeMatViewProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return makeProfile({
    table_name: "daily_summary",
    object_type: "materialized_view" as const,
    row_count: 500,
    columns: [
      makeColumn({ name: "date", type: "date", sample_values: ["2024-01-01", "2024-01-02"] }),
      makeColumn({ name: "total_orders", type: "integer" }),
      makeColumn({ name: "total_revenue", type: "numeric", sample_values: ["12345.67", "98765.43"] }),
    ],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    matview_populated: true,
    ...overrides,
  });
}

function makeViewProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return makeProfile({
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
    ...overrides,
  });
}

function makePartitionedProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return makeProfile({
    table_name: "events",
    object_type: "table" as const,
    row_count: 100000,
    columns: [
      makeColumn({ name: "id", type: "integer", is_primary_key: true }),
      makeColumn({ name: "created_at", type: "timestamp" }),
      makeColumn({ name: "event_type", type: "text", sample_values: ["click", "view", "purchase"], is_enum_like: true }),
    ],
    primary_key_columns: ["id"],
    partition_info: { strategy: "range", key: "created_at", children: ["events_2024q1", "events_2024q2"] },
    ...overrides,
  });
}

function makeSnapshot(
  table: string,
  columns: Record<string, string>,
  fks: string[] = [],
  meta: { objectType?: string; partitionStrategy?: string; partitionKey?: string } = {},
): EntitySnapshot {
  return {
    table,
    columns: new Map(Object.entries(columns)),
    foreignKeys: new Set(fks),
    ...meta,
  };
}

// --- isMatView / isViewLike / isView helpers ---

describe("isMatView", () => {
  test("returns true for materialized_view", () => {
    expect(isMatView(makeMatViewProfile())).toBe(true);
  });

  test("returns false for view", () => {
    expect(isMatView(makeProfile({ object_type: "view" }))).toBe(false);
  });

  test("returns false for table", () => {
    expect(isMatView(makeProfile({ object_type: "table" }))).toBe(false);
  });
});

describe("isViewLike", () => {
  test("returns true for view", () => {
    expect(isViewLike(makeProfile({ object_type: "view" }))).toBe(true);
  });

  test("returns true for materialized_view", () => {
    expect(isViewLike(makeMatViewProfile())).toBe(true);
  });

  test("returns false for table", () => {
    expect(isViewLike(makeProfile({ object_type: "table" }))).toBe(false);
  });
});

describe("isView with materialized_view", () => {
  test("returns false for materialized_view", () => {
    expect(isView(makeMatViewProfile())).toBe(false);
  });
});

// --- generateEntityYAML for matviews ---

describe("generateEntityYAML (materialized views)", () => {
  test("produces type 'materialized_view'", () => {
    const profile = makeMatViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.type).toBe("materialized_view");
  });

  test("does not include measures", () => {
    const profile = makeMatViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.measures).toBeUndefined();
  });

  test("does not include query_patterns", () => {
    const profile = makeMatViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.query_patterns).toBeUndefined();
  });

  test("description starts with 'Materialized view:'", () => {
    const profile = makeMatViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(typeof doc.description).toBe("string");
    expect((doc.description as string).startsWith("Materialized view:")).toBe(true);
  });

  test("grain mentions 'materialized view'", () => {
    const profile = makeMatViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(typeof doc.grain).toBe("string");
    expect((doc.grain as string).toLowerCase()).toContain("materialized view");
  });

  test("use_cases includes staleness warning", () => {
    const profile = makeMatViewProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const useCases = doc.use_cases as string[];
    expect(Array.isArray(useCases)).toBe(true);
    expect(useCases.some((uc) => uc.includes("materialized view") && uc.includes("stale"))).toBe(true);
  });

  test("unpopulated matview includes no-data warning", () => {
    const profile = makeMatViewProfile({ matview_populated: false });
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const useCases = doc.use_cases as string[];
    expect(useCases.some((uc) => uc.includes("never been refreshed"))).toBe(true);
  });

  test("populated matview does not include no-data warning", () => {
    const profile = makeMatViewProfile({ matview_populated: true });
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const useCases = doc.use_cases as string[];
    expect(useCases.some((uc) => uc.includes("never been refreshed"))).toBe(false);
  });
});

// --- generateEntityYAML for partitioned tables ---

describe("generateEntityYAML (partitioned tables)", () => {
  test("includes partitioned, partition_strategy, partition_key fields", () => {
    const profile = makePartitionedProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.partitioned).toBe(true);
    expect(doc.partition_strategy).toBe("range");
    expect(doc.partition_key).toBe("created_at");
  });

  test("use_cases includes partition hint", () => {
    const profile = makePartitionedProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const useCases = doc.use_cases as string[];
    expect(useCases.some((uc) => uc.includes("partitioned by range") && uc.includes("created_at"))).toBe(true);
  });

  test("non-partitioned table has no partition fields", () => {
    const profile = makeProfile();
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    expect(doc.partitioned).toBeUndefined();
    expect(doc.partition_strategy).toBeUndefined();
    expect(doc.partition_key).toBeUndefined();
  });
});

// --- generateMetricYAML for matviews ---

describe("generateMetricYAML (materialized views)", () => {
  test("returns null for matview profiles", () => {
    const profile = makeMatViewProfile();
    const result = generateMetricYAML(profile);

    expect(result).toBeNull();
  });
});

// --- generateCatalogYAML ---

describe("generateCatalogYAML (matview and partition)", () => {
  test("matview entry shows [materialized view]", () => {
    const profile = makeMatViewProfile();
    const result = generateCatalogYAML([profile]);
    const doc = yaml.load(result) as Record<string, unknown>;
    const entities = doc.entities as { description: string }[];

    expect(entities[0].description).toContain("[materialized view]");
  });

  test("partitioned table entry shows [partitioned by strategy]", () => {
    const profile = makePartitionedProfile();
    const result = generateCatalogYAML([profile]);
    const doc = yaml.load(result) as Record<string, unknown>;
    const entities = doc.entities as { description: string }[];

    expect(entities[0].description).toContain("[partitioned by range]");
  });

  test("matview entry grain mentions materialized view", () => {
    const profile = makeMatViewProfile();
    const result = generateCatalogYAML([profile]);
    const doc = yaml.load(result) as Record<string, unknown>;
    const entities = doc.entities as { grain: string }[];

    expect(entities[0].grain).toContain("materialized view");
  });

  test("metrics section excludes matviews", () => {
    const matview = makeMatViewProfile();
    const table = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "amount", type: "numeric" }),
      ],
    });
    const result = generateCatalogYAML([matview, table]);
    const doc = yaml.load(result) as Record<string, unknown>;
    const metrics = doc.metrics as { file: string }[] | undefined;

    // Only orders should have metrics, not the matview
    if (metrics) {
      expect(metrics.every((m) => !m.file.includes("daily_summary"))).toBe(true);
    }
  });
});

// --- Diff with matviews ---

describe("computeDiff (metadata changes)", () => {
  test("detects object type change", () => {
    const db = new Map([
      ["summary", makeSnapshot("summary", { id: "number" }, [], { objectType: "materialized_view" })],
    ]);
    const yml = new Map([
      ["summary", makeSnapshot("summary", { id: "number" }, [], { objectType: "view" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].metadataChanges).toContain("type changed: view → materialized_view");
  });

  test("detects partition strategy change", () => {
    const db = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { partitionStrategy: "list" })],
    ]);
    const yml = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { partitionStrategy: "range" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].metadataChanges).toContain("partition strategy changed: range → list");
  });

  test("detects partition key added", () => {
    const db = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { partitionStrategy: "range", partitionKey: "created_at" })],
    ]);
    const yml = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [])],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].metadataChanges.some((mc) => mc.includes("partition strategy added"))).toBe(true);
    expect(diff.tableDiffs[0].metadataChanges.some((mc) => mc.includes("partition key added"))).toBe(true);
  });

  test("new matview shows as new table", () => {
    const db = new Map([
      ["daily_summary", makeSnapshot("daily_summary", { date: "date", total: "number" }, [], { objectType: "materialized_view" })],
    ]);
    const yml = new Map<string, EntitySnapshot>();
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual(["daily_summary"]);
  });

  test("no metadata drift for identical snapshots", () => {
    const db = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { objectType: "fact_table", partitionStrategy: "range", partitionKey: "created_at" })],
    ]);
    const yml = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { objectType: "fact_table", partitionStrategy: "range", partitionKey: "created_at" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toEqual([]);
  });
});

describe("formatDiff (metadata changes)", () => {
  test("displays metadata changes", () => {
    const diff = {
      newTables: [],
      removedTables: [],
      tableDiffs: [
        {
          table: "summary",
          addedColumns: [],
          removedColumns: [],
          typeChanges: [],
          addedFKs: [],
          removedFKs: [],
          metadataChanges: ["type changed: view → materialized_view"],
        },
      ],
    };
    const output = formatDiff(diff);
    expect(output).toContain("~ type changed: view → materialized_view");
    expect(output).toContain("1 metadata change");
  });
});

// --- parseEntityYAML with metadata ---

describe("parseEntityYAML (metadata fields)", () => {
  test("extracts objectType from type field", () => {
    const doc = {
      table: "summary",
      type: "materialized_view",
      dimensions: [{ name: "id", sql: "id", type: "number" }],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.objectType).toBe("materialized_view");
  });

  test("extracts partition fields", () => {
    const doc = {
      table: "events",
      type: "fact_table",
      partitioned: true,
      partition_strategy: "range",
      partition_key: "created_at",
      dimensions: [{ name: "id", sql: "id", type: "number" }],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.partitionStrategy).toBe("range");
    expect(snap.partitionKey).toBe("created_at");
  });

  test("missing metadata fields are undefined", () => {
    const doc = {
      table: "simple",
      dimensions: [{ name: "id", sql: "id", type: "number" }],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.objectType).toBeUndefined();
    expect(snap.partitionStrategy).toBeUndefined();
    expect(snap.partitionKey).toBeUndefined();
  });
});

// --- profileToSnapshot with metadata ---

describe("profileToSnapshot (metadata)", () => {
  test("matview profile produces correct objectType", () => {
    const profile = makeMatViewProfile();
    const snap = profileToSnapshot(profile);
    expect(snap.objectType).toBe("materialized_view");
  });

  test("partitioned profile produces partition metadata", () => {
    const profile = makePartitionedProfile();
    const snap = profileToSnapshot(profile);
    expect(snap.objectType).toBe("fact_table");
    expect(snap.partitionStrategy).toBe("range");
    expect(snap.partitionKey).toBe("created_at");
  });

  test("regular table has no partition metadata", () => {
    const profile = makeProfile();
    const snap = profileToSnapshot(profile);
    expect(snap.objectType).toBe("fact_table");
    expect(snap.partitionStrategy).toBeUndefined();
    expect(snap.partitionKey).toBeUndefined();
  });

  test("view profile produces correct objectType", () => {
    const profile = makeProfile({ object_type: "view" as const, table_name: "active_users" });
    const snap = profileToSnapshot(profile);
    expect(snap.objectType).toBe("view");
  });
});

// --- Heuristic matview exclusion ---

describe("inferForeignKeys (matview exclusion)", () => {
  test("does not use materialized views as FK targets", () => {
    const matview = makeMatViewProfile({
      table_name: "users",
      columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const table = makeProfile({
      table_name: "orders",
      columns: [
        makeColumn({ name: "id", type: "integer", is_primary_key: true }),
        makeColumn({ name: "user_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });
    inferForeignKeys([matview, table]);
    expect(table.inferred_foreign_keys).toHaveLength(0);
  });

  test("does not infer FKs on materialized view columns", () => {
    const table = makeProfile({
      table_name: "users",
      columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const matview = makeMatViewProfile({
      table_name: "user_summary",
      columns: [
        makeColumn({ name: "date", type: "date" }),
        makeColumn({ name: "user_id", type: "integer" }),
      ],
      primary_key_columns: [],
    });
    inferForeignKeys([table, matview]);
    expect(matview.inferred_foreign_keys).toHaveLength(0);
  });
});

describe("detectAbandonedTables (matview exclusion)", () => {
  test("skips materialized views even with abandoned-looking names", () => {
    const profile = makeMatViewProfile({ table_name: "legacy_risk_scores" });
    detectAbandonedTables([profile]);
    expect(profile.table_flags.possibly_abandoned).toBe(false);
  });
});

describe("detectDenormalizedTables (matview exclusion)", () => {
  test("skips materialized views even with denormalized-looking names", () => {
    const profile = makeMatViewProfile({ table_name: "daily_scan_stats" });
    detectDenormalizedTables([profile]);
    expect(profile.table_flags.possibly_denormalized).toBe(false);
  });
});

// --- computeDiff undefined objectType edge cases ---

describe("computeDiff (undefined objectType edge cases)", () => {
  test("does NOT report type change when yml objectType is undefined", () => {
    const db = new Map([
      ["summary", makeSnapshot("summary", { id: "number" }, [], { objectType: "materialized_view" })],
    ]);
    const yml = new Map([
      ["summary", makeSnapshot("summary", { id: "number" }, [])],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(0);
  });

  test("does NOT report type change when db objectType is undefined", () => {
    const db = new Map([
      ["summary", makeSnapshot("summary", { id: "number" }, [])],
    ]);
    const yml = new Map([
      ["summary", makeSnapshot("summary", { id: "number" }, [], { objectType: "view" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(0);
  });
});

// --- Additional diff edge cases ---

describe("computeDiff (partition removal and change)", () => {
  test("detects partition strategy and key removed", () => {
    const db = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [])],
    ]);
    const yml = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { partitionStrategy: "range", partitionKey: "created_at" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].metadataChanges.some((mc) => mc.includes("partition strategy removed"))).toBe(true);
    expect(diff.tableDiffs[0].metadataChanges.some((mc) => mc.includes("partition key removed"))).toBe(true);
  });

  test("detects partition key changed", () => {
    const db = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { partitionStrategy: "range", partitionKey: "updated_at" })],
    ]);
    const yml = new Map([
      ["events", makeSnapshot("events", { id: "number" }, [], { partitionStrategy: "range", partitionKey: "created_at" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].metadataChanges).toContain("partition key changed: created_at → updated_at");
  });
});

// --- matview with undefined populated status ---

describe("generateEntityYAML (matview populated edge case)", () => {
  test("matview with undefined populated status does not include no-data warning", () => {
    const profile = makeMatViewProfile();
    delete (profile as unknown as Record<string, unknown>).matview_populated;
    const result = generateEntityYAML(profile, [profile], "postgres");
    const doc = yaml.load(result) as Record<string, unknown>;

    const useCases = doc.use_cases as string[];
    // Staleness warning should still be present
    expect(useCases.some((uc) => uc.includes("materialized view") && uc.includes("stale"))).toBe(true);
    // But "never been refreshed" should be absent when populated is undefined (not explicitly false)
    expect(useCases.some((uc) => uc.includes("never been refreshed"))).toBe(false);
  });
});

// --- formatDiff pluralization ---

describe("formatDiff (metadata pluralization)", () => {
  test("pluralizes metadata changes in summary", () => {
    const diff = {
      newTables: [],
      removedTables: [],
      tableDiffs: [
        {
          table: "events",
          addedColumns: [],
          removedColumns: [],
          typeChanges: [],
          addedFKs: [],
          removedFKs: [],
          metadataChanges: [
            "partition strategy changed: range → list",
            "partition key changed: created_at → updated_at",
          ],
        },
      ],
    };
    const output = formatDiff(diff);
    expect(output).toContain("2 metadata changes");
  });
});

// ===========================================================================
// Plain database views (formerly view-yaml-generation.test.ts)
// ===========================================================================

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

// ===========================================================================
// Multi-datasource output + group field (formerly multi-source.test.ts)
// ===========================================================================

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

// --- Entity YAML group: field (#3285, ADR-0012) ---

describe("entity YAML group field", () => {
  const profile = makeProfile({
    table_name: "orders",
    columns: [
      makeColumn({ name: "id", is_primary_key: true, type: "integer" }),
      makeColumn({ name: "amount", type: "numeric" }),
    ],
    primary_key_columns: ["id"],
  });

  test("default source omits the group field", () => {
    // source=undefined → no group field (neither canonical nor deprecated alias)
    const yamlText = generateEntityYAML(profile, [profile], "postgres", "public", undefined);
    expect(yamlText).not.toContain("group:");
    expect(yamlText).not.toContain("connection:");
  });

  test("named source emits the canonical group: field", () => {
    const yamlText = generateEntityYAML(profile, [profile], "postgres", "public", "warehouse");
    expect(yamlText).toContain("group: warehouse");
    expect(yamlText).not.toContain("connection:");
  });

  test("different named source", () => {
    const yamlText = generateEntityYAML(profile, [profile], "postgres", "public", "analytics");
    expect(yamlText).toContain("group: analytics");
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
    const yamlText = generateEntityYAML(profile, [profile], "postgres", "analytics");
    expect(yamlText).toContain("table: analytics.orders");
  });

  test("public schema does not qualify table name", () => {
    const yamlText = generateEntityYAML(profile, [profile], "postgres", "public");
    expect(yamlText).toContain("table: orders");
    expect(yamlText).not.toContain("table: public.orders");
  });
});
