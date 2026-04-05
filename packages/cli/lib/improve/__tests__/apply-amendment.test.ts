import { describe, expect, test } from "bun:test";
import { createAnalysisResult } from "@atlas/api/lib/semantic/expert";
import { applyAmendmentToEntity } from "../apply-amendment";
import type { AnalysisResult } from "@atlas/api/lib/semantic/expert";

function makeResult(overrides: Partial<AnalysisResult> & Pick<AnalysisResult, "amendmentType" | "amendment">): AnalysisResult {
  return createAnalysisResult({
    category: "coverage_gaps",
    entityName: "orders",
    rationale: "test",
    impact: 0.8,
    confidence: 0.7,
    staleness: 0,
    ...overrides,
  });
}

describe("applyAmendmentToEntity", () => {
  test("add_dimension appends to dimensions array", () => {
    const entity = { table: "orders", dimensions: [{ name: "id", sql: "id", type: "number" }] };
    const result = makeResult({
      amendmentType: "add_dimension",
      amendment: { name: "status", sql: "status", type: "string" },
    });

    const { updated, warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toBeUndefined();
    expect(updated.dimensions).toHaveLength(2);
    expect((updated.dimensions as Record<string, unknown>[])[1]).toEqual({ name: "status", sql: "status", type: "string" });
  });

  test("add_measure appends to measures array", () => {
    const entity = { table: "orders", measures: [] };
    const result = makeResult({
      amendmentType: "add_measure",
      amendment: { name: "total_revenue", sql: "total_cents / 100.0", type: "sum" },
    });

    const { updated, warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toBeUndefined();
    expect(updated.measures).toHaveLength(1);
  });

  test("add_join appends to joins array", () => {
    const entity = { table: "orders", joins: [] };
    const result = makeResult({
      amendmentType: "add_join",
      amendment: { name: "to_users", sql: "orders.user_id = users.id" },
    });

    const { updated } = applyAmendmentToEntity(entity, result);
    expect(updated.joins).toHaveLength(1);
  });

  test("add_query_pattern appends to query_patterns array", () => {
    const entity = { table: "orders" };
    const result = makeResult({
      amendmentType: "add_query_pattern",
      amendment: { name: "top_orders", sql: "SELECT * FROM orders ORDER BY total DESC LIMIT 10" },
    });

    const { updated } = applyAmendmentToEntity(entity, result);
    expect(updated.query_patterns).toHaveLength(1);
  });

  test("update_description with field=table updates table description", () => {
    const entity = { table: "orders", description: "The orders table" };
    const result = makeResult({
      amendmentType: "update_description",
      amendment: { field: "table", description: "Customer purchase orders with line items" },
    });

    const { updated, warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toBeUndefined();
    expect(updated.description).toBe("Customer purchase orders with line items");
  });

  test("update_description with dimension updates dimension description", () => {
    const entity = {
      table: "orders",
      dimensions: [{ name: "status", sql: "status", type: "string", description: "The status column" }],
    };
    const result = makeResult({
      amendmentType: "update_description",
      amendment: { dimension: "status", description: "Order fulfillment status: pending, shipped, delivered" },
    });

    const { updated, warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toBeUndefined();
    expect((updated.dimensions as Record<string, unknown>[])[0].description).toBe(
      "Order fulfillment status: pending, shipped, delivered",
    );
  });

  test("update_description returns warning when target dimension not found", () => {
    const entity = { table: "orders", dimensions: [{ name: "status", sql: "status", type: "string" }] };
    const result = makeResult({
      amendmentType: "update_description",
      amendment: { dimension: "nonexistent", description: "..." },
    });

    const { warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toContain("nonexistent");
    expect(warning).toContain("not found");
  });

  test("update_description returns warning for unrecognized target", () => {
    const entity = { table: "orders" };
    const result = makeResult({
      amendmentType: "update_description",
      amendment: { field: "unknown_field", description: "..." },
    });

    const { warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toContain("unrecognized target");
  });

  test("update_dimension updates matching dimension", () => {
    const entity = {
      table: "orders",
      dimensions: [{ name: "amount", sql: "amount", type: "string" }],
    };
    const result = makeResult({
      amendmentType: "update_dimension",
      amendment: { name: "amount", type: "number" },
    });

    const { updated, warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toBeUndefined();
    expect((updated.dimensions as Record<string, unknown>[])[0].type).toBe("number");
  });

  test("update_dimension returns warning when dimension not found", () => {
    const entity = { table: "orders", dimensions: [] };
    const result = makeResult({
      amendmentType: "update_dimension",
      amendment: { name: "nonexistent", type: "number" },
    });

    const { warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toContain("nonexistent");
    expect(warning).toContain("not found");
  });

  test("add_virtual_dimension appends with virtual: true", () => {
    const entity = { table: "orders", dimensions: [] };
    const result = makeResult({
      amendmentType: "add_virtual_dimension",
      amendment: { name: "created_month", sql: "EXTRACT(MONTH FROM created_at)", type: "number" },
    });

    const { updated } = applyAmendmentToEntity(entity, result);
    const dim = (updated.dimensions as Record<string, unknown>[])[0];
    expect(dim.virtual).toBe(true);
    expect(dim.name).toBe("created_month");
  });

  test("add_glossary_term is a no-op on entity", () => {
    const entity = { table: "orders", dimensions: [{ name: "id", sql: "id", type: "number" }] };
    const result = makeResult({
      amendmentType: "add_glossary_term",
      amendment: { term: "acv", definition: "Annual Contract Value" },
    });

    const { updated, warning } = applyAmendmentToEntity(entity, result);
    expect(warning).toBeUndefined();
    // Entity should be unchanged (except it's a clone)
    expect(updated.dimensions).toHaveLength(1);
  });

  test("does not mutate original entity", () => {
    const entity = { table: "orders", measures: [{ name: "count", sql: "id", type: "count" }] };
    const result = makeResult({
      amendmentType: "add_measure",
      amendment: { name: "total", sql: "amount", type: "sum" },
    });

    applyAmendmentToEntity(entity, result);
    expect((entity.measures as Record<string, unknown>[]).length).toBe(1);
  });

  test("creates arrays when they don't exist", () => {
    const entity = { table: "orders" };
    const result = makeResult({
      amendmentType: "add_dimension",
      amendment: { name: "status", sql: "status", type: "string" },
    });

    const { updated } = applyAmendmentToEntity(entity, result);
    expect(updated.dimensions).toHaveLength(1);
  });
});
