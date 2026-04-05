import { describe, expect, test } from "bun:test";
import { analyzeSemanticLayer } from "../analyzer";
import type { AnalysisContext } from "../types";

function makeContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    profiles: [],
    entities: [],
    glossary: [],
    auditPatterns: [],
    rejectedKeys: new Set(),
    ...overrides,
  };
}

describe("analyzeSemanticLayer", () => {
  test("returns empty array for empty context", () => {
    const results = analyzeSemanticLayer(makeContext());
    expect(results).toEqual([]);
  });

  test("sorts results by score descending", () => {
    const ctx = makeContext({
      profiles: [{
        table_name: "orders",
        object_type: "table",
        row_count: 100,
        columns: [
          {
            name: "id",
            type: "integer",
            nullable: false,
            unique_count: 100,
            null_count: 0,
            sample_values: [],
            is_primary_key: true,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: false,
            profiler_notes: [],
          },
          {
            name: "status",
            type: "text",
            nullable: false,
            unique_count: 3,
            null_count: 0,
            sample_values: ["active", "pending", "closed"],
            is_primary_key: false,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: true,
            profiler_notes: [],
          },
          {
            name: "amount",
            type: "numeric",
            nullable: false,
            unique_count: 50,
            null_count: 0,
            sample_values: [],
            is_primary_key: false,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: false,
            profiler_notes: [],
          },
        ],
        primary_key_columns: ["id"],
        foreign_keys: [],
        inferred_foreign_keys: [],
        profiler_notes: [],
        table_flags: { possibly_abandoned: false, possibly_denormalized: false },
      }],
      entities: [{
        name: "orders",
        table: "orders",
        dimensions: [],
        measures: [],
        joins: [],
        query_patterns: [],
      }],
    });

    const results = analyzeSemanticLayer(ctx);
    expect(results.length).toBeGreaterThan(0);

    // Verify sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test("deduplicates by entity + amendmentType + name", () => {
    // This test verifies dedup works — any duplicate results from
    // overlapping category analyzers should be removed
    const ctx = makeContext({
      profiles: [{
        table_name: "orders",
        object_type: "table",
        row_count: 100,
        columns: [{
          name: "total",
          type: "numeric",
          nullable: false,
          unique_count: 50,
          null_count: 0,
          sample_values: [],
          is_primary_key: false,
          is_foreign_key: false,
          fk_target_table: null,
          fk_target_column: null,
          is_enum_like: false,
          profiler_notes: [],
        }],
        primary_key_columns: [],
        foreign_keys: [],
        inferred_foreign_keys: [],
        profiler_notes: [],
        table_flags: { possibly_abandoned: false, possibly_denormalized: false },
      }],
      entities: [{
        name: "orders",
        table: "orders",
        dimensions: [],
        measures: [],
        joins: [],
        query_patterns: [],
      }],
    });

    const results = analyzeSemanticLayer(ctx);

    // Check no duplicates
    const keys = results.map(
      (r) => `${r.entityName}:${r.amendmentType}:${(r.amendment as Record<string, unknown>).name ?? ""}`,
    );
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});
