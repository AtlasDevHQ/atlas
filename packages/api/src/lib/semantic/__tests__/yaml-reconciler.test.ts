import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import type { SemanticTableDiff } from "@useatlas/types";
import { reconcileEntityYaml, generateStarterEntityYaml } from "../yaml-reconciler";

// ---------------------------------------------------------------------------
// reconcileEntityYaml — pure (yaml, diff) → yaml
// ---------------------------------------------------------------------------

describe("reconcileEntityYaml", () => {
  const baseYaml = `table: orders
description: Customer orders
dimensions:
  - name: id
    sql: id
    type: number
    description: Primary key
    primary_key: true
  - name: customer_id
    sql: customer_id
    type: number
    description: FK to customers
    foreign_key: true
    sample_values:
      - "1"
      - "2"
  - name: total
    sql: total
    type: number
joins:
  - to: customers
    on: orders.customer_id = customers.id
measures:
  - name: total_revenue
    sql: SUM(total)
    type: sum
query_patterns:
  - name: monthly_revenue
    description: Revenue per month
    sql: SELECT date_trunc('month', created_at) AS m, SUM(total) FROM orders GROUP BY 1
`;

  test("column added → dimension appended with name + sql + type", () => {
    const diff: SemanticTableDiff = {
      table: "orders",
      addedColumns: [{ name: "shipped_at", type: "date" }],
      removedColumns: [],
      typeChanges: [],
    };
    const out = reconcileEntityYaml(baseYaml, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    const appended = dims.find((d) => d.name === "shipped_at");
    expect(appended).toBeDefined();
    expect(appended?.type).toBe("date");
    expect(appended?.sql).toBe("shipped_at");
  });

  test("column removed → dimension dropped by name", () => {
    const diff: SemanticTableDiff = {
      table: "orders",
      addedColumns: [],
      removedColumns: [{ name: "total", type: "number" }],
      typeChanges: [],
    };
    const out = reconcileEntityYaml(baseYaml, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    expect(dims.some((d) => d.name === "total")).toBe(false);
    expect(dims.some((d) => d.name === "id")).toBe(true);
    expect(dims.some((d) => d.name === "customer_id")).toBe(true);
  });

  test("type changed → existing dimension's type updated, other fields preserved", () => {
    const diff: SemanticTableDiff = {
      table: "orders",
      addedColumns: [],
      removedColumns: [],
      typeChanges: [{ name: "customer_id", yamlType: "number", dbType: "string" }],
    };
    const out = reconcileEntityYaml(baseYaml, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    const customer = dims.find((d) => d.name === "customer_id");
    expect(customer?.type).toBe("string");
    // Other fields preserved verbatim
    expect(customer?.description).toBe("FK to customers");
    expect(customer?.foreign_key).toBe(true);
    expect(customer?.sql).toBe("customer_id");
    expect(customer?.sample_values).toEqual(["1", "2"]);
  });

  test("user-authored top-level fields preserved verbatim", () => {
    const diff: SemanticTableDiff = {
      table: "orders",
      addedColumns: [{ name: "shipped_at", type: "date" }],
      removedColumns: [{ name: "total", type: "number" }],
      typeChanges: [{ name: "customer_id", yamlType: "number", dbType: "string" }],
    };
    const out = reconcileEntityYaml(baseYaml, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    expect(parsed.table).toBe("orders");
    expect(parsed.description).toBe("Customer orders");
    expect(parsed.joins).toEqual([
      { to: "customers", on: "orders.customer_id = customers.id" },
    ]);
    expect(parsed.measures).toEqual([
      { name: "total_revenue", sql: "SUM(total)", type: "sum" },
    ]);
    expect(parsed.query_patterns).toEqual([
      {
        name: "monthly_revenue",
        description: "Revenue per month",
        sql: "SELECT date_trunc('month', created_at) AS m, SUM(total) FROM orders GROUP BY 1",
      },
    ]);
  });

  test("preserves dimension's description / sample_values across add+remove+typeChange", () => {
    const diff: SemanticTableDiff = {
      table: "orders",
      addedColumns: [{ name: "shipped_at", type: "date" }],
      removedColumns: [{ name: "total", type: "number" }],
      typeChanges: [{ name: "id", yamlType: "number", dbType: "number" }],
    };
    const out = reconcileEntityYaml(baseYaml, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    const id = dims.find((d) => d.name === "id");
    expect(id?.description).toBe("Primary key");
    expect(id?.primary_key).toBe(true);
  });

  test("empty diff is a no-op (round-trips dimensions unchanged)", () => {
    const diff: SemanticTableDiff = {
      table: "orders",
      addedColumns: [],
      removedColumns: [],
      typeChanges: [],
    };
    const out = reconcileEntityYaml(baseYaml, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    expect(dims.map((d) => d.name)).toEqual(["id", "customer_id", "total"]);
  });

  test("handles entity YAML with no dimensions field (initializes empty list)", () => {
    const yamlIn = "table: barebones\ndescription: just a table\n";
    const diff: SemanticTableDiff = {
      table: "barebones",
      addedColumns: [{ name: "id", type: "number" }],
      removedColumns: [],
      typeChanges: [],
    };
    const out = reconcileEntityYaml(yamlIn, diff);
    const parsed = yaml.load(out) as Record<string, unknown>;
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    expect(dims).toHaveLength(1);
    expect(dims[0]?.name).toBe("id");
  });

  test("throws on malformed YAML rather than silently corrupting", () => {
    expect(() => reconcileEntityYaml("not: a:\nvalid: : : yaml", {
      table: "x",
      addedColumns: [],
      removedColumns: [],
      typeChanges: [],
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateStarterEntityYaml — pure (table, columns) → yaml
// ---------------------------------------------------------------------------

describe("generateStarterEntityYaml", () => {
  test("emits table + description placeholder + dimensions in column order", () => {
    const out = generateStarterEntityYaml("orders", [
      { name: "id", type: "number" },
      { name: "customer_id", type: "number" },
      { name: "created_at", type: "date" },
    ]);
    const parsed = yaml.load(out) as Record<string, unknown>;
    expect(parsed.table).toBe("orders");
    expect(typeof parsed.description).toBe("string");
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    expect(dims.map((d) => d.name)).toEqual(["id", "customer_id", "created_at"]);
    expect(dims[0]?.type).toBe("number");
    expect(dims[2]?.type).toBe("date");
    expect(dims[0]?.sql).toBe("id");
  });

  test("output round-trips through reconcileEntityYaml as a no-op", () => {
    const yamlOut = generateStarterEntityYaml("users", [
      { name: "id", type: "number" },
      { name: "email", type: "string" },
    ]);
    const reconciled = reconcileEntityYaml(yamlOut, {
      table: "users",
      addedColumns: [],
      removedColumns: [],
      typeChanges: [],
    });
    const before = yaml.load(yamlOut);
    const after = yaml.load(reconciled);
    expect(after).toEqual(before);
  });
});
