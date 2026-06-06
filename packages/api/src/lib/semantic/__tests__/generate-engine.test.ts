/**
 * Shared mechanical generator — direct-path coverage (issue #3233).
 *
 * The exhaustive per-function cases live in the profiler suites
 * (lib/__tests__/profiler*.test.ts, cli/bin/__tests__/*), which exercise the
 * same code via the `@atlas/api/lib/profiler` re-export facade. This file
 * proves the relocated engine is reachable and correct through its NEW canonical
 * path — `@atlas/api/lib/semantic/generate` — the one the wizard and CLI now
 * import.
 */

import { describe, it, expect } from "bun:test";
import type { TableProfile, ColumnProfile } from "@useatlas/types";
import {
  analyzeTableProfiles,
  generateEntityYAML,
  generateCatalogYAML,
  generateMetricYAML,
  generateGlossaryYAML,
  isView,
  isMatView,
} from "../generate";
import * as yaml from "js-yaml";

function col(over: Partial<ColumnProfile> & Pick<ColumnProfile, "name" | "type">): ColumnProfile {
  return {
    name: over.name,
    type: over.type,
    nullable: over.nullable ?? false,
    unique_count: over.unique_count ?? null,
    null_count: over.null_count ?? null,
    sample_values: over.sample_values ?? [],
    is_primary_key: over.is_primary_key ?? false,
    is_foreign_key: over.is_foreign_key ?? false,
    fk_target_table: over.fk_target_table ?? null,
    fk_target_column: over.fk_target_column ?? null,
    is_enum_like: over.is_enum_like ?? false,
    profiler_notes: over.profiler_notes ?? [],
    ...(over.semantic_type ? { semantic_type: over.semantic_type } : {}),
  };
}

function profile(over: Partial<TableProfile> & Pick<TableProfile, "table_name">): TableProfile {
  return {
    table_name: over.table_name,
    object_type: over.object_type ?? "table",
    row_count: over.row_count ?? 100,
    columns: over.columns ?? [],
    primary_key_columns: over.primary_key_columns ?? [],
    foreign_keys: over.foreign_keys ?? [],
    inferred_foreign_keys: over.inferred_foreign_keys ?? [],
    profiler_notes: over.profiler_notes ?? [],
    table_flags: over.table_flags ?? { possibly_abandoned: false, possibly_denormalized: false },
    ...(over.matview_populated !== undefined ? { matview_populated: over.matview_populated } : {}),
    ...(over.partition_info ? { partition_info: over.partition_info } : {}),
  };
}

const orders = profile({
  table_name: "orders",
  row_count: 4200,
  columns: [
    col({ name: "id", type: "integer", is_primary_key: true, unique_count: 4200 }),
    col({ name: "customer_id", type: "integer" }),
    col({ name: "status", type: "text", is_enum_like: true, sample_values: ["paid", "pending", "refunded"], unique_count: 3 }),
    col({ name: "amount", type: "numeric", unique_count: 3800 }),
  ],
  primary_key_columns: ["id"],
});

const customers = profile({
  table_name: "customers",
  columns: [col({ name: "id", type: "integer", is_primary_key: true })],
  primary_key_columns: ["id"],
});

describe("shared generate engine (direct ../generate path)", () => {
  it("analyzeTableProfiles infers FKs by naming convention without mutating input", () => {
    const before = orders.inferred_foreign_keys.length;
    const [analyzedOrders] = analyzeTableProfiles([orders, customers]);
    expect(analyzedOrders.inferred_foreign_keys.some((fk) => fk.to_table === "customers")).toBe(true);
    // Input array is not mutated (fresh copies returned).
    expect(orders.inferred_foreign_keys.length).toBe(before);
  });

  it("generateEntityYAML emits a parseable entity with dimensions and a count measure", () => {
    const [analyzedOrders] = analyzeTableProfiles([orders, customers]);
    const out = generateEntityYAML(analyzedOrders, [analyzedOrders], "postgres");
    const parsed = yaml.load(out) as Record<string, unknown>;
    expect(parsed.name).toBe("Orders");
    expect(parsed.table).toBe("orders");
    expect(Array.isArray(parsed.dimensions)).toBe(true);
    const measures = parsed.measures as { name: string }[];
    expect(measures.some((m) => m.name === "order_count")).toBe(true);
  });

  it("generateCatalogYAML lists the entity and its metrics file", () => {
    const out = generateCatalogYAML([orders]);
    const parsed = yaml.load(out) as { entities: { name: string }[]; metrics?: { file: string }[] };
    expect(parsed.entities[0].name).toBe("Orders");
    expect(parsed.metrics?.[0].file).toBe("metrics/orders.yml");
  });

  it("generateMetricYAML returns null for tables without numeric columns, YAML otherwise", () => {
    expect(generateMetricYAML(customers)).toBeNull();
    const out = generateMetricYAML(orders);
    expect(out).not.toBeNull();
    const parsed = yaml.load(out!) as { metrics: { id: string }[] };
    expect(parsed.metrics.some((m) => m.id === "orders_count")).toBe(true);
  });

  it("generateGlossaryYAML defines enum-like categorical fields", () => {
    const out = generateGlossaryYAML([orders]);
    const parsed = yaml.load(out) as { terms: Record<string, { status: string }> };
    expect(parsed.terms.status?.status).toBe("defined");
  });

  it("isView / isMatView classify object_type", () => {
    expect(isView(profile({ table_name: "v", object_type: "view" }))).toBe(true);
    expect(isMatView(profile({ table_name: "mv", object_type: "materialized_view" }))).toBe(true);
    expect(isView(orders)).toBe(false);
  });
});
