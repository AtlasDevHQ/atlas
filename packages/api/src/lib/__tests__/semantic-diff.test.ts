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
  type DiffResult,
  type EntitySnapshot,
} from "../semantic/diff";
import { attachDrift } from "../semantic/drift";

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

  it("normalizes YAML semantic types into mapSQLType's target space", () => {
    // The DB side runs every column through `mapSQLType` (which collapses
    // every date-class SQL type into "date"). The YAML side must use the
    // same normalization or canonical YAML types like "timestamp" produce
    // false-positive drift against DB columns of type "timestamp with time
    // zone" (which `mapSQLType` reports as "date"). Repro: dharma's
    // post-recovery diff showed 13 phantom "Changed Tables" rows where
    // every `created_at`/`updated_at` claimed `YAML: timestamp → DB: date`.
    const snap = parseEntityYAML({
      table: "users",
      dimensions: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        // Three date-class aliases that all collapse to "date":
        { name: "created_at", type: "timestamp" },
        { name: "updated_at", type: "datetime" },
        { name: "due", type: "date" },
        { name: "active", type: "boolean" },
      ],
    });

    expect(snap.columns.get("id")).toBe("number");
    expect(snap.columns.get("name")).toBe("string");
    expect(snap.columns.get("created_at")).toBe("date");
    expect(snap.columns.get("updated_at")).toBe("date");
    expect(snap.columns.get("due")).toBe("date");
    expect(snap.columns.get("active")).toBe("boolean");
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

// ---------------------------------------------------------------------------
// attachDrift — slice 1 of #2458 / issue #2459
// ---------------------------------------------------------------------------

function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    newTables: [],
    removedTables: [],
    tableDiffs: [],
    unchangedCount: 0,
    ...overrides,
  };
}

describe("attachDrift", () => {
  it("marks every entity in-sync when the diff is empty", () => {
    const entities = [
      { name: "users", table: "users" },
      { name: "orders", table: "orders" },
    ];
    const result = attachDrift(entities, makeDiff(), { noIntrospectedTables: false });

    expect(result.noIntrospectedTables).toBe(false);
    expect(result.entities).toHaveLength(2);
    expect(result.entities.every((e) => e.drift?.state === "in-sync")).toBe(true);
    // The discriminated union prevents `changeCount` from existing on
    // `in-sync` rows — confirm the runtime shape matches that contract.
    const first = result.entities[0].drift;
    expect(first && "changeCount" in first).toBe(false);
  });

  it("maps per-entity state from a mixed diff", () => {
    const entities = [
      { name: "users", table: "users" },        // unchanged
      { name: "orders", table: "orders" },      // column drift
      { name: "legacy", table: "legacy" },      // dropped from DB
    ];
    const diff = makeDiff({
      removedTables: ["legacy"],
      tableDiffs: [{
        table: "orders",
        addedColumns: [{ name: "shipping_zip", type: "string" }],
        removedColumns: [{ name: "deprecated_total", type: "number" }],
        typeChanges: [{ name: "status", yamlType: "string", dbType: "number" }],
      }],
    });

    const result = attachDrift(entities, diff, { noIntrospectedTables: false });
    const byName = Object.fromEntries(result.entities.map((e) => [e.name, e]));

    expect(byName.users.drift).toEqual({ state: "in-sync" });
    expect(byName.orders.drift).toEqual({ state: "changed", changeCount: 3 });
    expect(byName.legacy.drift).toEqual({ state: "removed" });
    expect(result.noIntrospectedTables).toBe(false);
  });

  it("nulls every drift field and flags noIntrospectedTables when the DB is empty", () => {
    // The dogfood incident this slice exists to prevent: an introspection-
    // empty DB used to make every YAML entity look "removed". Reads zero,
    // shouts thirteen. attachDrift must short-circuit before the regular
    // diff comparison runs.
    const entities = [
      { name: "users", table: "users" },
      { name: "orders", table: "orders" },
      { name: "products", table: "products" },
    ];
    // We pass a non-empty `removedTables` to prove the flag short-circuits
    // — without the early return, every row would otherwise report `removed`.
    const diff = makeDiff({ removedTables: ["users", "orders", "products"] });

    const result = attachDrift(entities, diff, { noIntrospectedTables: true });

    expect(result.noIntrospectedTables).toBe(true);
    expect(result.entities).toHaveLength(3);
    expect(result.entities.every((e) => e.drift === null)).toBe(true);
  });

  it("preserves caller fields on every entity", () => {
    // attachDrift augments — it doesn't strip — so the file-tree projection
    // can pass through `name`, `connectionGroupId`, `draft`, etc.
    const entities = [
      { name: "users", table: "users", connectionGroupId: "g_prod", draft: true },
    ];
    const result = attachDrift(entities, makeDiff(), { noIntrospectedTables: false });

    expect(result.entities[0]).toMatchObject({
      name: "users",
      table: "users",
      connectionGroupId: "g_prod",
      draft: true,
      drift: { state: "in-sync" },
    });
  });

  it("omits changeCount for non-changed states", () => {
    // changeCount only applies to `changed`; the other three states should
    // carry the field absent so consumers can render "N column changes"
    // without guarding undefined for in-sync / removed rows.
    const entities = [
      { name: "users", table: "users" },
      { name: "legacy", table: "legacy" },
    ];
    const diff = makeDiff({ removedTables: ["legacy"] });
    const result = attachDrift(entities, diff, { noIntrospectedTables: false });

    expect(result.entities[0].drift).toEqual({ state: "in-sync" });
    expect(result.entities[1].drift).toEqual({ state: "removed" });
  });

  it("handles an empty entity list cleanly", () => {
    const result = attachDrift([], makeDiff(), { noIntrospectedTables: false });
    expect(result.entities).toEqual([]);
    expect(result.noIntrospectedTables).toBe(false);
  });
});
