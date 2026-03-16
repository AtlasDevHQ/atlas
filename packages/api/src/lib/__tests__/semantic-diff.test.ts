/**
 * Tests for semantic-diff.ts — pure diff logic.
 *
 * These tests verify mapSQLType, parseEntityYAML, and computeDiff
 * without any I/O or mocked modules.
 */

import { describe, it, expect } from "bun:test";
import {
  mapSQLType,
  parseEntityYAML,
  computeDiff,
  type EntitySnapshot,
} from "../semantic-diff";

// ---------------------------------------------------------------------------
// mapSQLType
// ---------------------------------------------------------------------------

describe("mapSQLType", () => {
  it("maps integer types to number", () => {
    expect(mapSQLType("integer")).toBe("number");
    expect(mapSQLType("bigint")).toBe("number");
    expect(mapSQLType("smallint")).toBe("number");
    expect(mapSQLType("INT")).toBe("number");
  });

  it("maps float/decimal types to number", () => {
    expect(mapSQLType("float")).toBe("number");
    expect(mapSQLType("real")).toBe("number");
    expect(mapSQLType("numeric")).toBe("number");
    expect(mapSQLType("decimal(10,2)")).toBe("number");
    expect(mapSQLType("double precision")).toBe("number");
  });

  it("maps boolean types", () => {
    expect(mapSQLType("boolean")).toBe("boolean");
    expect(mapSQLType("bool")).toBe("boolean");
  });

  it("maps date/time types to date", () => {
    expect(mapSQLType("date")).toBe("date");
    expect(mapSQLType("timestamp")).toBe("date");
    expect(mapSQLType("timestamp with time zone")).toBe("date");
    expect(mapSQLType("time")).toBe("date");
  });

  it("maps text types to string", () => {
    expect(mapSQLType("text")).toBe("string");
    expect(mapSQLType("varchar")).toBe("string");
    expect(mapSQLType("character varying")).toBe("string");
    expect(mapSQLType("uuid")).toBe("string");
    expect(mapSQLType("jsonb")).toBe("string");
  });

  it("maps interval and money to string", () => {
    expect(mapSQLType("interval")).toBe("string");
    expect(mapSQLType("money")).toBe("string");
  });

  it("handles ClickHouse Nullable/LowCardinality wrappers", () => {
    expect(mapSQLType("Nullable(Int64)")).toBe("number");
    expect(mapSQLType("LowCardinality(String)")).toBe("string");
    expect(mapSQLType("Nullable(DateTime)")).toBe("date");
  });
});

// ---------------------------------------------------------------------------
// parseEntityYAML
// ---------------------------------------------------------------------------

describe("parseEntityYAML", () => {
  it("extracts columns from dimensions", () => {
    const snap = parseEntityYAML({
      table: "users",
      dimensions: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        { name: "created_at", type: "date" },
      ],
    });

    expect(snap.table).toBe("users");
    expect(snap.columns.size).toBe(3);
    expect(snap.columns.get("id")).toBe("number");
    expect(snap.columns.get("name")).toBe("string");
    expect(snap.columns.get("created_at")).toBe("date");
  });

  it("skips virtual dimensions", () => {
    const snap = parseEntityYAML({
      table: "users",
      dimensions: [
        { name: "id", type: "number" },
        { name: "full_name", type: "string", virtual: true },
      ],
    });

    expect(snap.columns.size).toBe(1);
    expect(snap.columns.has("full_name")).toBe(false);
  });

  it("extracts foreign keys from joins", () => {
    const snap = parseEntityYAML({
      table: "orders",
      dimensions: [{ name: "id", type: "number" }],
      joins: [
        {
          target_entity: "UserAccount",
          join_columns: { from: "user_id", to: "id" },
        },
      ],
    });

    expect(snap.foreignKeys.size).toBe(1);
    expect(snap.foreignKeys.has("user_id→user_account.id")).toBe(true);
  });

  it("handles missing dimensions gracefully", () => {
    const snap = parseEntityYAML({ table: "empty" });
    expect(snap.table).toBe("empty");
    expect(snap.columns.size).toBe(0);
  });

  it("handles non-array dimensions gracefully", () => {
    const snap = parseEntityYAML({
      table: "bad",
      dimensions: { id: { type: "number" } },
    });
    expect(snap.columns.size).toBe(0);
  });

  it("handles non-array joins gracefully", () => {
    const snap = parseEntityYAML({
      table: "orders",
      dimensions: [{ name: "id", type: "number" }],
      joins: "invalid",
    });
    expect(snap.columns.size).toBe(1);
    expect(snap.foreignKeys.size).toBe(0);
  });

  it("skips dimensions without name or type", () => {
    const snap = parseEntityYAML({
      table: "t",
      dimensions: [
        { name: "valid", type: "string" },
        { name: 42, type: "number" },
        { sql: "COUNT(*)" },
      ],
    });
    expect(snap.columns.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeDiff
// ---------------------------------------------------------------------------

function makeSnapshot(table: string, cols: Record<string, string>): EntitySnapshot {
  return {
    table,
    columns: new Map(Object.entries(cols)),
    foreignKeys: new Set(),
  };
}

describe("computeDiff", () => {
  it("returns no drift when snapshots match", () => {
    const db = new Map([["users", makeSnapshot("users", { id: "number", name: "string" })]]);
    const yaml = new Map([["users", makeSnapshot("users", { id: "number", name: "string" })]]);

    const result = computeDiff(db, yaml);
    expect(result.newTables).toEqual([]);
    expect(result.removedTables).toEqual([]);
    expect(result.tableDiffs).toEqual([]);
    expect(result.unchangedCount).toBe(1);
  });

  it("detects new tables in DB", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
      ["orders", makeSnapshot("orders", { id: "number" })],
    ]);
    const yaml = new Map([["users", makeSnapshot("users", { id: "number" })]]);

    const result = computeDiff(db, yaml);
    expect(result.newTables).toEqual(["orders"]);
    expect(result.unchangedCount).toBe(1);
  });

  it("detects removed tables from YAML", () => {
    const db = new Map([["users", makeSnapshot("users", { id: "number" })]]);
    const yaml = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
      ["archived", makeSnapshot("archived", { id: "number" })],
    ]);

    const result = computeDiff(db, yaml);
    expect(result.removedTables).toEqual(["archived"]);
  });

  it("detects added columns", () => {
    const db = new Map([["users", makeSnapshot("users", { id: "number", email: "string" })]]);
    const yaml = new Map([["users", makeSnapshot("users", { id: "number" })]]);

    const result = computeDiff(db, yaml);
    expect(result.tableDiffs).toHaveLength(1);
    expect(result.tableDiffs[0].table).toBe("users");
    expect(result.tableDiffs[0].addedColumns).toEqual([{ name: "email", type: "string" }]);
    expect(result.tableDiffs[0].removedColumns).toEqual([]);
    expect(result.tableDiffs[0].typeChanges).toEqual([]);
  });

  it("detects removed columns", () => {
    const db = new Map([["users", makeSnapshot("users", { id: "number" })]]);
    const yaml = new Map([["users", makeSnapshot("users", { id: "number", deleted_at: "date" })]]);

    const result = computeDiff(db, yaml);
    expect(result.tableDiffs).toHaveLength(1);
    expect(result.tableDiffs[0].removedColumns).toEqual([{ name: "deleted_at", type: "date" }]);
  });

  it("detects type changes", () => {
    const db = new Map([["users", makeSnapshot("users", { id: "number", status: "number" })]]);
    const yaml = new Map([["users", makeSnapshot("users", { id: "number", status: "string" })]]);

    const result = computeDiff(db, yaml);
    expect(result.tableDiffs).toHaveLength(1);
    expect(result.tableDiffs[0].typeChanges).toEqual([
      { name: "status", yamlType: "string", dbType: "number" },
    ]);
  });

  it("handles all drift types simultaneously", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number", email: "string", role: "number" })],
      ["products", makeSnapshot("products", { id: "number" })],
    ]);
    const yaml = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string", role: "string" })],
      ["legacy", makeSnapshot("legacy", { id: "number" })],
    ]);

    const result = computeDiff(db, yaml);
    expect(result.newTables).toEqual(["products"]);
    expect(result.removedTables).toEqual(["legacy"]);
    expect(result.tableDiffs).toHaveLength(1);
    expect(result.tableDiffs[0].addedColumns).toEqual([{ name: "email", type: "string" }]);
    expect(result.tableDiffs[0].removedColumns).toEqual([{ name: "name", type: "string" }]);
    expect(result.tableDiffs[0].typeChanges).toEqual([
      { name: "role", yamlType: "string", dbType: "number" },
    ]);
    expect(result.unchangedCount).toBe(0);
  });

  it("returns empty diff for empty inputs", () => {
    const result = computeDiff(new Map(), new Map());
    expect(result.newTables).toEqual([]);
    expect(result.removedTables).toEqual([]);
    expect(result.tableDiffs).toEqual([]);
    expect(result.unchangedCount).toBe(0);
  });

  it("sorts table names alphabetically", () => {
    const db = new Map([
      ["zebra", makeSnapshot("zebra", { id: "number" })],
      ["alpha", makeSnapshot("alpha", { id: "number" })],
    ]);
    const yaml = new Map<string, EntitySnapshot>();

    const result = computeDiff(db, yaml);
    expect(result.newTables).toEqual(["alpha", "zebra"]);
  });
});
