/**
 * Unit tests for the applyAmendment pure function in apply.ts.
 *
 * Tests all 8 amendment types plus error cases.
 */

import { describe, it, expect } from "bun:test";
import type { AnalysisResult } from "../types";
import { createAnalysisResult } from "../scoring";
import { applyAmendment } from "../apply";

function makeResult(
  entity: string,
  type: AnalysisResult["amendmentType"],
  amendment: Record<string, unknown>,
): AnalysisResult {
  return createAnalysisResult({
    category: "missing_measures",
    entityName: entity,
    amendmentType: type,
    amendment,
    rationale: "test",
    impact: 0.8,
    confidence: 0.7,
    staleness: 0,
  });
}

const baseEntity = {
  table: "orders",
  description: "Orders table",
  dimensions: [
    { name: "id", sql: "id", type: "number", description: "Primary key" },
    { name: "status", sql: "status", type: "string", description: "Order status" },
  ],
  measures: [
    { name: "order_count", sql: "id", type: "count_distinct" },
  ],
  joins: [] as Record<string, unknown>[],
  query_patterns: [] as Record<string, unknown>[],
};

describe("applyAmendment", () => {
  it("adds a dimension", () => {
    const result = makeResult("orders", "add_dimension", {
      name: "total_cents", sql: "total_cents", type: "number",
    });
    const updated = applyAmendment(baseEntity, result);
    const dims = updated.dimensions as Array<Record<string, unknown>>;
    expect(dims).toHaveLength(3);
    expect(dims[2].name).toBe("total_cents");
  });

  it("adds a measure", () => {
    const result = makeResult("orders", "add_measure", {
      name: "total_revenue", sql: "SUM(total_cents)", type: "sum",
    });
    const updated = applyAmendment(baseEntity, result);
    const measures = updated.measures as Array<Record<string, unknown>>;
    expect(measures).toHaveLength(2);
    expect(measures[1].name).toBe("total_revenue");
  });

  it("adds a join", () => {
    const result = makeResult("orders", "add_join", {
      name: "to_users", sql: "orders.user_id = users.id",
    });
    const updated = applyAmendment(baseEntity, result);
    const joins = updated.joins as Array<Record<string, unknown>>;
    expect(joins).toHaveLength(1);
    expect(joins[0].name).toBe("to_users");
  });

  it("adds a query pattern", () => {
    const result = makeResult("orders", "add_query_pattern", {
      name: "revenue_by_month", sql: "SELECT ...", description: "Monthly revenue",
    });
    const updated = applyAmendment(baseEntity, result);
    const patterns = updated.query_patterns as Array<Record<string, unknown>>;
    expect(patterns).toHaveLength(1);
    expect(patterns[0].name).toBe("revenue_by_month");
  });

  it("updates table description", () => {
    const result = makeResult("orders", "update_description", {
      field: "table", description: "Customer purchase orders",
    });
    const updated = applyAmendment(baseEntity, result);
    expect(updated.description).toBe("Customer purchase orders");
  });

  it("updates dimension description", () => {
    const result = makeResult("orders", "update_description", {
      dimension: "status",
      description: "Fulfillment status: pending, shipped, delivered",
    });
    const updated = applyAmendment(baseEntity, result);
    const dims = updated.dimensions as Array<Record<string, unknown>>;
    const status = dims.find((d) => d.name === "status");
    expect(status?.description).toBe("Fulfillment status: pending, shipped, delivered");
  });

  it("throws when dimension not found for update_description", () => {
    const result = makeResult("orders", "update_description", {
      dimension: "nonexistent", description: "Should not apply",
    });
    expect(() => applyAmendment(baseEntity, result)).toThrow("nonexistent");
  });

  it("throws for invalid update_description with no field or dimension", () => {
    const result = makeResult("orders", "update_description", {
      field: "unknown_field",
    });
    expect(() => applyAmendment(baseEntity, result)).toThrow("Invalid update_description");
  });

  it("updates an existing dimension", () => {
    const result = makeResult("orders", "update_dimension", {
      name: "status", type: "string", description: "Updated",
      sample_values: ["active", "inactive"],
    });
    const updated = applyAmendment(baseEntity, result);
    const dims = updated.dimensions as Array<Record<string, unknown>>;
    const status = dims.find((d) => d.name === "status");
    expect(status?.description).toBe("Updated");
    expect(status?.sample_values).toEqual(["active", "inactive"]);
  });

  it("throws when dimension not found for update_dimension", () => {
    const result = makeResult("orders", "update_dimension", {
      name: "nonexistent", type: "string",
    });
    expect(() => applyAmendment(baseEntity, result)).toThrow("nonexistent");
  });

  it("adds a virtual dimension with virtual=true", () => {
    const result = makeResult("orders", "add_virtual_dimension", {
      name: "order_month", sql: "EXTRACT(MONTH FROM created_at)", type: "number",
    });
    const updated = applyAmendment(baseEntity, result);
    const dims = updated.dimensions as Array<Record<string, unknown>>;
    const vdim = dims.find((d) => d.name === "order_month");
    expect(vdim).toBeTruthy();
    expect(vdim?.virtual).toBe(true);
  });

  it("does not modify entity for add_glossary_term", () => {
    const result = makeResult("orders", "add_glossary_term", {
      term: "MRR", definition: "Monthly Recurring Revenue",
    });
    const updated = applyAmendment(baseEntity, result);
    expect(updated.dimensions).toHaveLength(2);
    expect(updated.measures).toHaveLength(1);
  });

  it("throws for unsupported amendment type", () => {
    const result = makeResult("orders", "add_dimension", {
      name: "test",
    });
    // Force an invalid type to test the default case
    (result as unknown as Record<string, unknown>).amendmentType = "remove_dimension";
    expect(() => applyAmendment(baseEntity, result)).toThrow("Unsupported amendment type");
  });

  it("does not mutate the original entity", () => {
    const original = structuredClone(baseEntity);
    const result = makeResult("orders", "add_measure", {
      name: "total", sql: "SUM(1)", type: "sum",
    });
    applyAmendment(baseEntity, result);
    expect(baseEntity).toEqual(original);
  });

  // ── Idempotency / re-apply (#3636 review) ──────────────────────────
  // The add_* handlers must not produce duplicate entries when the same
  // amendment is approved twice, and must converge (last-write-wins on
  // identity) when an updated version of the same-named entry is approved.

  it("re-applying the same add_dimension does not duplicate it", () => {
    const result = makeResult("orders", "add_dimension", {
      name: "total_cents", sql: "total_cents", type: "number",
    });
    const once = applyAmendment(baseEntity, result);
    const twice = applyAmendment(once, result);
    const dims = twice.dimensions as Array<Record<string, unknown>>;
    expect(dims).toHaveLength(3); // not 4
    expect(dims.filter((d) => d.name === "total_cents")).toHaveLength(1);
  });

  it("re-applying an updated add_dimension replaces the prior entry (last-write-wins)", () => {
    const v1 = applyAmendment(baseEntity, makeResult("orders", "add_dimension", {
      name: "total_cents", sql: "total_cents", type: "number",
    }));
    const v2 = applyAmendment(v1, makeResult("orders", "add_dimension", {
      name: "total_cents", sql: "amount_cents", type: "number", description: "fixed",
    }));
    const dims = v2.dimensions as Array<Record<string, unknown>>;
    expect(dims.filter((d) => d.name === "total_cents")).toHaveLength(1);
    const target = dims.find((d) => d.name === "total_cents")!;
    expect(target.sql).toBe("amount_cents");
    expect(target.description).toBe("fixed");
  });

  it("re-applying the same add_join (by target_entity) does not duplicate it", () => {
    const result = makeResult("orders", "add_join", {
      target_entity: "customers", relationship: "many_to_one",
    });
    const twice = applyAmendment(applyAmendment(baseEntity, result), result);
    const joins = twice.joins as Array<Record<string, unknown>>;
    expect(joins.filter((j) => j.target_entity === "customers")).toHaveLength(1);
  });

  it("re-applying the same add_virtual_dimension does not duplicate it", () => {
    const result = makeResult("orders", "add_virtual_dimension", {
      name: "revenue_bucket", sql: "CASE WHEN total_cents > 10000 THEN 'high' ELSE 'low' END", type: "string",
    });
    const twice = applyAmendment(applyAmendment(baseEntity, result), result);
    const dims = twice.dimensions as Array<Record<string, unknown>>;
    const matches = dims.filter((d) => d.name === "revenue_bucket");
    expect(matches).toHaveLength(1);
    expect(matches[0].virtual).toBe(true);
  });

  it("appends when the entry has no identity value (cannot dedup)", () => {
    // A query_pattern with no `name` can't be deduped — appending twice is
    // the documented fallback, not a silent drop.
    const result = makeResult("orders", "add_query_pattern", {
      description: "top orders", sql: "SELECT * FROM orders LIMIT 10",
    });
    const twice = applyAmendment(applyAmendment(baseEntity, result), result);
    expect(twice.query_patterns as unknown[]).toHaveLength(2);
  });
});
