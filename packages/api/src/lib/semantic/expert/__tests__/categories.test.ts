import { describe, expect, test } from "bun:test";
import type { TableProfile, ColumnProfile } from "@useatlas/types";
import type { AnalysisContext, ParsedEntity } from "../types";
import {
  findCoverageGaps,
  findDescriptionIssues,
  findTypeInaccuracies,
  findMissingMeasures,
  findMissingJoins,
  findGlossaryGaps,
  findStaleSampleValues,
  findQueryPatternGaps,
  findVirtualDimensionOpportunities,
} from "../categories";

// ── Helpers ──────────────────────────────────────────────────────

function makeColumn(overrides: Partial<ColumnProfile> & { name: string }): ColumnProfile {
  return {
    type: "text",
    nullable: false,
    unique_count: 10,
    null_count: 0,
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

function makeProfile(overrides: Partial<TableProfile> & { table_name: string }): TableProfile {
  return {
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

function makeEntity(overrides: Partial<ParsedEntity> & { name: string }): ParsedEntity {
  return {
    table: overrides.name,
    dimensions: [],
    measures: [],
    joins: [],
    query_patterns: [],
    ...overrides,
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

// ── Tests ────────────────────────────────────────────────────────

describe("findCoverageGaps", () => {
  test("returns add_dimension for undocumented columns", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [
          makeColumn({ name: "id", is_primary_key: true }),
          makeColumn({ name: "status" }),
          makeColumn({ name: "total" }),
        ],
      })],
      entities: [makeEntity({
        name: "orders",
        dimensions: [{ name: "status", sql: "status", type: "string" }],
      })],
    });

    const results = findCoverageGaps(ctx);
    expect(results.length).toBe(1);
    expect(results[0].amendmentType).toBe("add_dimension");
    expect((results[0].amendment as Record<string, unknown>).name).toBe("total");
  });

  test("skips primary key columns", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "id", is_primary_key: true })],
      })],
      entities: [makeEntity({ name: "orders" })],
    });

    const results = findCoverageGaps(ctx);
    expect(results.length).toBe(0);
  });

  test("returns empty when entity has no matching profile", () => {
    const ctx = makeContext({
      profiles: [makeProfile({ table_name: "other" })],
      entities: [makeEntity({ name: "orders" })],
    });
    expect(findCoverageGaps(ctx)).toEqual([]);
  });
});

describe("findDescriptionIssues", () => {
  test("flags empty table description", () => {
    const ctx = makeContext({
      entities: [makeEntity({ name: "orders" })],
    });
    const results = findDescriptionIssues(ctx);
    expect(results.some((r) => r.amendmentType === "update_description")).toBe(true);
  });

  test("flags auto-generated description", () => {
    const ctx = makeContext({
      entities: [makeEntity({ name: "orders", description: "The orders column" })],
    });
    const results = findDescriptionIssues(ctx);
    expect(results.length).toBeGreaterThan(0);
  });

  test("does not flag human-written description", () => {
    const ctx = makeContext({
      entities: [makeEntity({
        name: "orders",
        description: "Customer purchase transactions with line items and totals",
      })],
    });
    const results = findDescriptionIssues(ctx);
    // Should not flag table-level description (may still flag dimension descriptions)
    const tableFlags = results.filter((r) =>
      (r.amendment as Record<string, unknown>).field === "table",
    );
    expect(tableFlags.length).toBe(0);
  });
});

describe("findTypeInaccuracies", () => {
  test("detects type mismatch", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "total", type: "numeric" })],
      })],
      entities: [makeEntity({
        name: "orders",
        dimensions: [{ name: "total", sql: "total", type: "string" }],
      })],
    });

    const results = findTypeInaccuracies(ctx);
    expect(results.length).toBe(1);
    expect(results[0].amendmentType).toBe("update_dimension");
  });

  test("no result when types match", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "total", type: "numeric" })],
      })],
      entities: [makeEntity({
        name: "orders",
        dimensions: [{ name: "total", sql: "total", type: "number" }],
      })],
    });

    expect(findTypeInaccuracies(ctx)).toEqual([]);
  });
});

describe("findMissingMeasures", () => {
  test("suggests measure for numeric column without one", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "amount", type: "numeric" })],
      })],
      entities: [makeEntity({ name: "orders" })],
    });

    const results = findMissingMeasures(ctx);
    expect(results.length).toBe(1);
    expect(results[0].amendmentType).toBe("add_measure");
  });

  test("skips primary keys", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "id", type: "integer", is_primary_key: true })],
      })],
      entities: [makeEntity({ name: "orders" })],
    });

    expect(findMissingMeasures(ctx)).toEqual([]);
  });

  test("skips non-numeric columns", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({ name: "status", type: "text" })],
      })],
      entities: [makeEntity({ name: "orders" })],
    });

    expect(findMissingMeasures(ctx)).toEqual([]);
  });
});

describe("findMissingJoins", () => {
  test("suggests join for FK not in entity", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        foreign_keys: [{
          from_column: "user_id",
          to_table: "users",
          to_column: "id",
          source: "constraint",
        }],
      })],
      entities: [
        makeEntity({ name: "orders" }),
        makeEntity({ name: "users" }),
      ],
    });

    const results = findMissingJoins(ctx);
    expect(results.length).toBe(1);
    expect(results[0].confidence).toBe(0.95); // constraint = high confidence
  });

  test("inferred FKs get lower confidence", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        inferred_foreign_keys: [{
          from_column: "product_id",
          to_table: "products",
          to_column: "id",
          source: "inferred",
        }],
      })],
      entities: [
        makeEntity({ name: "orders" }),
        makeEntity({ name: "products" }),
      ],
    });

    const results = findMissingJoins(ctx);
    expect(results.length).toBe(1);
    expect(results[0].confidence).toBe(0.6);
  });
});

describe("findGlossaryGaps", () => {
  test("detects business abbreviation not in glossary", () => {
    const ctx = makeContext({
      entities: [makeEntity({
        name: "metrics",
        dimensions: [{ name: "monthly_mrr", sql: "monthly_mrr", type: "number" }],
      })],
    });

    const results = findGlossaryGaps(ctx);
    expect(results.length).toBe(1);
    expect((results[0].amendment as Record<string, unknown>).term).toBe("mrr");
  });

  test("skips abbreviation already in glossary", () => {
    const ctx = makeContext({
      entities: [makeEntity({
        name: "metrics",
        dimensions: [{ name: "monthly_mrr", sql: "monthly_mrr", type: "number" }],
      })],
      glossary: [{ term: "mrr", definition: "Monthly Recurring Revenue" }],
    });

    expect(findGlossaryGaps(ctx)).toEqual([]);
  });
});

describe("findStaleSampleValues", () => {
  test("detects stale samples", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({
          name: "status",
          sample_values: ["active", "closed"],
        })],
      })],
      entities: [makeEntity({
        name: "orders",
        dimensions: [{
          name: "status",
          sql: "status",
          type: "string",
          sample_values: ["active", "pending", "obsolete"],
        }],
      })],
    });

    const results = findStaleSampleValues(ctx);
    expect(results.length).toBe(1);
    expect(results[0].rationale).toContain("pending");
  });

  test("no result when samples match", () => {
    const ctx = makeContext({
      profiles: [makeProfile({
        table_name: "orders",
        columns: [makeColumn({
          name: "status",
          sample_values: ["active", "pending"],
        })],
      })],
      entities: [makeEntity({
        name: "orders",
        dimensions: [{
          name: "status",
          sql: "status",
          type: "string",
          sample_values: ["active", "pending"],
        }],
      })],
    });

    expect(findStaleSampleValues(ctx)).toEqual([]);
  });
});

describe("findQueryPatternGaps", () => {
  test("returns empty when no audit patterns", () => {
    const ctx = makeContext({
      entities: [makeEntity({ name: "orders" })],
    });
    expect(findQueryPatternGaps(ctx)).toEqual([]);
  });

  test("suggests pattern for frequent queries", () => {
    const ctx = makeContext({
      entities: [makeEntity({ name: "orders", table: "orders" })],
      auditPatterns: [{
        sql: "SELECT COUNT(*) FROM orders WHERE status = 'active'",
        count: 10,
        tables: ["orders"],
        lastSeen: "2026-04-01",
      }],
    });

    const results = findQueryPatternGaps(ctx);
    expect(results.length).toBe(1);
    expect(results[0].amendmentType).toBe("add_query_pattern");
  });

  test("ignores low-frequency patterns", () => {
    const ctx = makeContext({
      entities: [makeEntity({ name: "orders", table: "orders" })],
      auditPatterns: [{
        sql: "SELECT * FROM orders LIMIT 1",
        count: 2, // Below threshold of 3
        tables: ["orders"],
        lastSeen: "2026-04-01",
      }],
    });

    expect(findQueryPatternGaps(ctx)).toEqual([]);
  });
});

describe("findVirtualDimensionOpportunities", () => {
  test("returns empty when no audit patterns", () => {
    expect(findVirtualDimensionOpportunities(makeContext())).toEqual([]);
  });

  test("detects EXTRACT patterns", () => {
    const ctx = makeContext({
      entities: [makeEntity({
        name: "orders",
        table: "orders",
        dimensions: [{ name: "created_at", sql: "created_at", type: "timestamp" }],
      })],
      auditPatterns: [{
        sql: "SELECT EXTRACT(MONTH FROM created_at) FROM orders",
        count: 5,
        tables: ["orders"],
        lastSeen: "2026-04-01",
      }],
    });

    const results = findVirtualDimensionOpportunities(ctx);
    expect(results.length).toBe(1);
    expect(results[0].amendmentType).toBe("add_virtual_dimension");
    expect((results[0].amendment as Record<string, unknown>).name).toBe("created_at_month");
  });
});
