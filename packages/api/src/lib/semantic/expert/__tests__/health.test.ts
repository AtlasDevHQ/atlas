import { describe, it, expect } from "bun:test";
import { computeSemanticHealth } from "../health";
import type { AnalysisContext, ParsedEntity, GlossaryTerm } from "../types";
import type { TableProfile } from "@useatlas/types";

function makeEntity(overrides: Partial<ParsedEntity> = {}): ParsedEntity {
  return {
    name: "orders",
    table: "orders",
    description: "Order records",
    dimensions: [
      { name: "id", sql: "id", type: "number", description: "Primary key" },
      { name: "status", sql: "status", type: "string", description: "Order status" },
    ],
    measures: [
      { name: "count", sql: "COUNT(*)", type: "count", description: "Number of orders" },
    ],
    joins: [
      { name: "to_customers", sql: "orders.customer_id = customers.id", description: "orders.customer_id → customers.id" },
    ],
    query_patterns: [],
    ...overrides,
  };
}

function makeProfile(table: string, columns: string[] = ["id", "status"]): TableProfile {
  return {
    table_name: table,
    object_type: "table" as const,
    row_count: 1000,
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    columns: columns.map((col) => ({
      name: col,
      type: "text",
      nullable: false,
      unique_count: 100,
      null_count: 0,
      sample_values: ["a", "b"],
      is_primary_key: false,
      is_foreign_key: false,
      fk_target_table: null,
      fk_target_column: null,
      is_enum_like: false,
      profiler_notes: [],
    })),
  };
}

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

describe("computeSemanticHealth", () => {
  it("returns all 100s for an empty context", () => {
    const score = computeSemanticHealth(makeContext());
    expect(score.overall).toBe(100);
    expect(score.coverage).toBe(100);
    expect(score.descriptionQuality).toBe(100);
    expect(score.measureCoverage).toBe(100);
    expect(score.joinCoverage).toBe(100);
    expect(score.entityCount).toBe(0);
    expect(score.dimensionCount).toBe(0);
    expect(score.measureCount).toBe(0);
    expect(score.glossaryTermCount).toBe(0);
  });

  it("returns high scores for a well-documented entity", () => {
    const entity = makeEntity();
    const profile = makeProfile("orders", ["id", "status"]);
    const score = computeSemanticHealth(
      makeContext({ entities: [entity], profiles: [profile] }),
    );
    expect(score.overall).toBeGreaterThanOrEqual(80);
    expect(score.entityCount).toBe(1);
    expect(score.dimensionCount).toBe(2);
    expect(score.measureCount).toBe(1);
  });

  it("penalizes entities with no measures", () => {
    const entity = makeEntity({ measures: [] });
    const score = computeSemanticHealth(
      makeContext({ entities: [entity] }),
    );
    expect(score.measureCoverage).toBe(0);
  });

  it("penalizes empty descriptions", () => {
    const entity = makeEntity({
      dimensions: [
        { name: "id", sql: "id", type: "number" },
        { name: "status", sql: "status", type: "string", description: "The status column." },
      ],
    });
    const score = computeSemanticHealth(
      makeContext({ entities: [entity] }),
    );
    // Both dimensions have poor descriptions (missing or auto-generated)
    expect(score.descriptionQuality).toBeLessThan(100);
  });

  it("counts glossary terms", () => {
    const glossary: GlossaryTerm[] = [
      { term: "MRR", definition: "Monthly recurring revenue" },
      { term: "churn", definition: "Customer cancellation" },
    ];
    const score = computeSemanticHealth(makeContext({ glossary }));
    expect(score.glossaryTermCount).toBe(2);
  });

  it("coverage gap reduces coverage score", () => {
    // Profile has 3 columns but entity only covers 2
    const entity = makeEntity();
    const profile = makeProfile("orders", ["id", "status", "amount"]);
    const score = computeSemanticHealth(
      makeContext({ entities: [entity], profiles: [profile] }),
    );
    expect(score.coverage).toBeLessThan(100);
  });

  it("multiple entities counted correctly", () => {
    const e1 = makeEntity({ name: "orders", table: "orders" });
    const e2 = makeEntity({
      name: "customers",
      table: "customers",
      dimensions: [{ name: "id", sql: "id", type: "number", description: "ID" }],
      measures: [],
      joins: [],
    });
    const score = computeSemanticHealth(
      makeContext({ entities: [e1, e2] }),
    );
    expect(score.entityCount).toBe(2);
    expect(score.dimensionCount).toBe(3); // 2 from orders + 1 from customers
    expect(score.measureCount).toBe(1); // only orders has measures
    expect(score.measureCoverage).toBe(50); // 1/2 entities have measures
  });
});
