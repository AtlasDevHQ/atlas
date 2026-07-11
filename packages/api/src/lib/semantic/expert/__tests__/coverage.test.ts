/**
 * Unit tests for the PURE coverage matrix (#4521, PRD #4502).
 *
 * `computeCoverage` maps a connection's baseline `TableProfile[]` (the physical
 * schema) against the group's `ParsedEntity[]` (the semantic store) into a
 * per-table / per-column coverage matrix — no I/O. These pin the load-bearing
 * behaviors: the covered / partially-covered / uncovered table states (AC1), the
 * column→dimension match with described/sampled quality, PK exclusion from the
 * coverable denominator, and the modeling entity's group carried through for the
 * column anchor.
 */

import { describe, it, expect } from "bun:test";
import { computeCoverage } from "../coverage";
import type { ParsedEntity } from "../types";
import type { ColumnProfile, TableProfile } from "@useatlas/types";

function col(name: string, overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    name,
    type: "text",
    nullable: true,
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

function profile(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    table_name: "orders",
    object_type: "table",
    row_count: 4321,
    columns: [col("id", { is_primary_key: true }), col("status"), col("amount", { type: "numeric" })],
    primary_key_columns: ["id"],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

function entity(overrides: Partial<ParsedEntity> = {}): ParsedEntity {
  return {
    name: "orders",
    table: "orders",
    description: "Order records",
    dimensions: [
      { name: "status", sql: "status", type: "string", description: "The lifecycle status" },
    ],
    measures: [],
    joins: [],
    query_patterns: [],
    ...overrides,
  };
}

describe("computeCoverage — table states (AC1)", () => {
  it("reports a table with no modeling entity as uncovered", () => {
    const matrix = computeCoverage([profile()], []);
    expect(matrix.tables).toHaveLength(1);
    const t = matrix.tables[0];
    expect(t.state).toBe("uncovered");
    expect(t.entity).toBeNull();
    expect(t.group).toBeNull();
    // Every column is uncovered when there's no entity.
    expect(t.columns.every((c) => !c.covered)).toBe(true);
    expect(matrix.summary).toEqual({ coveredTables: 0, partialTables: 0, uncoveredTables: 1, totalTables: 1 });
  });

  it("reports a partially-covered table when some coverable columns lack dimensions", () => {
    // status is a dimension; amount is not; id is a PK (excluded).
    const matrix = computeCoverage([profile()], [entity()]);
    const t = matrix.tables[0];
    expect(t.state).toBe("partial");
    expect(t.entity).toBe("orders");
    expect(t.coverableColumnCount).toBe(2); // status + amount (id excluded)
    expect(t.coveredColumnCount).toBe(1); // status only
    expect(matrix.summary.partialTables).toBe(1);
  });

  it("reports a fully-covered table when every coverable column is a dimension", () => {
    const full = entity({
      dimensions: [
        { name: "status", sql: "status", type: "string" },
        { name: "amount", sql: "amount", type: "number" },
      ],
    });
    const matrix = computeCoverage([profile()], [full]);
    const t = matrix.tables[0];
    expect(t.state).toBe("covered");
    expect(t.coveredColumnCount).toBe(2);
    expect(t.coverableColumnCount).toBe(2);
    expect(matrix.summary.coveredTables).toBe(1);
  });

  it("treats a PK-only table modeled by an entity as covered (nothing to model)", () => {
    const pkOnly = profile({ columns: [col("id", { is_primary_key: true })] });
    const matrix = computeCoverage([pkOnly], [entity({ dimensions: [] })]);
    const t = matrix.tables[0];
    expect(t.coverableColumnCount).toBe(0);
    expect(t.state).toBe("covered");
  });
});

describe("computeCoverage — column quality", () => {
  it("marks a covered column described + sampled from its dimension", () => {
    const rich = entity({
      dimensions: [
        {
          name: "status",
          sql: "status",
          type: "string",
          description: "The lifecycle status",
          sample_values: ["open", "closed"],
        },
      ],
    });
    const matrix = computeCoverage([profile()], [rich]);
    const status = matrix.tables[0].columns.find((c) => c.column === "status");
    expect(status).toMatchObject({ covered: true, dimension: "status", described: true, sampled: true });
  });

  it("counts an auto-generated description as undescribed", () => {
    const auto = entity({
      dimensions: [{ name: "status", sql: "status", type: "string", description: "The status column" }],
    });
    const status = computeCoverage([profile()], [auto]).tables[0].columns.find((c) => c.column === "status");
    expect(status?.covered).toBe(true);
    expect(status?.described).toBe(false);
  });

  it("matches the column→dimension link case-insensitively on the dimension sql", () => {
    const cased = entity({ dimensions: [{ name: "Status", sql: "STATUS", type: "string", description: "x" }] });
    const p = profile({ columns: [col("status")] });
    const status = computeCoverage([p], [cased]).tables[0].columns.find((c) => c.column === "status");
    expect(status?.covered).toBe(true);
    expect(status?.dimension).toBe("Status");
  });

  it("flags primary-key columns without counting them against coverage", () => {
    const id = computeCoverage([profile()], [entity()]).tables[0].columns.find((c) => c.column === "id");
    expect(id).toMatchObject({ isPrimaryKey: true, covered: false });
  });
});

describe("computeCoverage — grouping + ordering", () => {
  it("carries the modeling entity's group through for the column anchor", () => {
    const grouped = entity({ connection: "grp_prod", group: undefined });
    const matrix = computeCoverage([profile()], [grouped]);
    expect(matrix.tables[0].group).toBe("grp_prod");
  });

  it("matches an entity by name when its table differs, and preserves profile order", () => {
    const profiles = [profile({ table_name: "b_table" }), profile({ table_name: "a_table" })];
    const byName = entity({ name: "a_table", table: "physical_a" });
    const matrix = computeCoverage(profiles, [byName]);
    // Profile order preserved (b before a), not re-sorted.
    expect(matrix.tables.map((t) => t.table)).toEqual(["b_table", "a_table"]);
    // The name-matched table resolves to the entity.
    expect(matrix.tables.find((t) => t.table === "a_table")?.entity).toBe("a_table");
  });
});
