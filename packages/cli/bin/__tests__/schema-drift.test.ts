import { describe, expect, test } from "bun:test";
import {
  parseEntityYAML,
  profileToSnapshot,
  computeDiff,
  formatDiff,
  mapSQLType,
} from "../atlas";
import type { TableProfile, ColumnProfile, EntitySnapshot } from "../atlas";

// --- Helpers ---

function makeColumn(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    name: "col",
    type: "text",
    nullable: false,
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

function makeProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    table_name: "test_table",
    object_type: "table" as const,
    row_count: 100,
    columns: [makeColumn({ name: "id", is_primary_key: true })],
    primary_key_columns: ["id"],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

function makeSnapshot(
  table: string,
  columns: Record<string, string>,
  fks: string[] = [],
): EntitySnapshot {
  return {
    table,
    columns: new Map(Object.entries(columns)),
    foreignKeys: new Set(fks),
  };
}

// --- parseEntityYAML ---

describe("parseEntityYAML", () => {
  test("extracts table name and columns from dimensions", () => {
    const doc = {
      name: "Companies",
      table: "companies",
      dimensions: [
        { name: "id", sql: "id", type: "number" },
        { name: "name", sql: "name", type: "string" },
        { name: "revenue", sql: "revenue", type: "number" },
      ],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.table).toBe("companies");
    expect(snap.columns.size).toBe(3);
    expect(snap.columns.get("id")).toBe("number");
    expect(snap.columns.get("name")).toBe("string");
    expect(snap.columns.get("revenue")).toBe("number");
  });

  test("skips virtual dimensions", () => {
    const doc = {
      table: "people",
      dimensions: [
        { name: "id", sql: "id", type: "number" },
        { name: "age_bucket", sql: "CASE WHEN ...", type: "string", virtual: true },
        { name: "hire_date_year", sql: "EXTRACT(YEAR FROM hire_date)", type: "number", virtual: true },
      ],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.columns.size).toBe(1);
    expect(snap.columns.has("id")).toBe(true);
    expect(snap.columns.has("age_bucket")).toBe(false);
  });

  test("extracts FKs from joins", () => {
    const doc = {
      table: "accounts",
      dimensions: [
        { name: "id", sql: "id", type: "number" },
        { name: "company_id", sql: "company_id", type: "number" },
      ],
      joins: [
        {
          target_entity: "Companies",
          relationship: "many_to_one",
          join_columns: { from: "company_id", to: "id" },
        },
      ],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.foreignKeys.size).toBe(1);
    expect(snap.foreignKeys.has("company_id→companies.id")).toBe(true);
  });

  test("handles multi-word entity names in FK targets", () => {
    const doc = {
      table: "order_items",
      dimensions: [
        { name: "id", sql: "id", type: "number" },
        { name: "sales_order_id", sql: "sales_order_id", type: "number" },
      ],
      joins: [
        {
          target_entity: "SalesOrders",
          relationship: "many_to_one",
          join_columns: { from: "sales_order_id", to: "id" },
        },
      ],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.foreignKeys.has("sales_order_id→sales_orders.id")).toBe(true);
  });

  test("handles missing joins and dimensions gracefully", () => {
    const doc = { table: "empty_table" };
    const snap = parseEntityYAML(doc);
    expect(snap.table).toBe("empty_table");
    expect(snap.columns.size).toBe(0);
    expect(snap.foreignKeys.size).toBe(0);
  });

  test("skips malformed dimensions (missing name or type)", () => {
    const doc = {
      table: "test_table",
      dimensions: [
        { name: "id", sql: "id", type: "number" },
        { name: "bad", sql: "bad" },              // missing type
        { sql: "also_bad", type: "string" },       // missing name
        { name: 123, sql: "nope", type: "string" }, // non-string name
      ],
    };
    const snap = parseEntityYAML(doc);
    expect(snap.columns.size).toBe(1);
    expect(snap.columns.has("id")).toBe(true);
  });
});

// --- profileToSnapshot ---

describe("profileToSnapshot", () => {
  test("view profiles produce snapshots with empty FK sets", () => {
    const profile = makeProfile({
      table_name: "order_summary",
      object_type: "view",
      columns: [
        makeColumn({ name: "cnt", type: "integer" }),
        makeColumn({ name: "total", type: "real" }),
      ],
      primary_key_columns: [],
      foreign_keys: [],
      inferred_foreign_keys: [],
    });
    const snap = profileToSnapshot(profile);
    expect(snap.table).toBe("order_summary");
    expect(snap.columns.size).toBe(2);
    expect(snap.columns.get("cnt")).toBe("number");
    expect(snap.foreignKeys.size).toBe(0);
  });

  test("maps column types using mapSQLType", () => {
    const profile = makeProfile({
      table_name: "users",
      columns: [
        makeColumn({ name: "id", type: "integer" }),
        makeColumn({ name: "name", type: "varchar(255)" }),
        makeColumn({ name: "created_at", type: "timestamp" }),
        makeColumn({ name: "active", type: "boolean" }),
      ],
    });
    const snap = profileToSnapshot(profile);
    expect(snap.columns.get("id")).toBe("number");
    expect(snap.columns.get("name")).toBe("string");
    expect(snap.columns.get("created_at")).toBe("date");
    expect(snap.columns.get("active")).toBe("boolean");
  });

  test("combines constraint and inferred FKs", () => {
    const profile = makeProfile({
      table_name: "orders",
      foreign_keys: [
        { from_column: "customer_id", to_table: "customers", to_column: "id", source: "constraint" },
      ],
      inferred_foreign_keys: [
        { from_column: "product_id", to_table: "products", to_column: "id", source: "inferred" },
      ],
    });
    const snap = profileToSnapshot(profile);
    expect(snap.foreignKeys.has("customer_id→customers.id")).toBe(true);
    expect(snap.foreignKeys.has("product_id→products.id")).toBe(true);
  });
});

// --- computeDiff ---

describe("computeDiff", () => {
  test("no drift — identical snapshots", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual([]);
    expect(diff.removedTables).toEqual([]);
    expect(diff.tableDiffs).toEqual([]);
  });

  test("detects new table in DB", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
      ["audit_logs", makeSnapshot("audit_logs", { id: "number", action: "string" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual(["audit_logs"]);
    expect(diff.removedTables).toEqual([]);
    expect(diff.tableDiffs).toEqual([]);
  });

  test("detects removed table from YAML", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
      ["old_accounts", makeSnapshot("old_accounts", { id: "number" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual([]);
    expect(diff.removedTables).toEqual(["old_accounts"]);
  });

  test("detects added column", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string", email: "string" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].addedColumns).toEqual([{ name: "email", type: "string" }]);
  });

  test("detects removed column", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number", legacy_code: "string" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].removedColumns).toEqual([{ name: "legacy_code", type: "string" }]);
  });

  test("detects type change", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number", revenue: "number" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number", revenue: "string" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].typeChanges).toEqual([
      { name: "revenue", yamlType: "string", dbType: "number" },
    ]);
  });

  test("detects FK added", () => {
    const db = new Map([
      ["orders", makeSnapshot("orders", { id: "number" }, ["customer_id→customers.id"])],
    ]);
    const yml = new Map([
      ["orders", makeSnapshot("orders", { id: "number" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].addedFKs).toEqual(["customer_id→customers.id"]);
  });

  test("detects FK removed", () => {
    const db = new Map([
      ["orders", makeSnapshot("orders", { id: "number" })],
    ]);
    const yml = new Map([
      ["orders", makeSnapshot("orders", { id: "number" }, ["customer_id→customers.id"])],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toHaveLength(1);
    expect(diff.tableDiffs[0].removedFKs).toEqual(["customer_id→customers.id"]);
  });

  test("mixed changes across multiple tables", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string", email: "string" })],
      ["orders", makeSnapshot("orders", { id: "number", total: "number" }, ["user_id→users.id"])],
      ["new_table", makeSnapshot("new_table", { id: "number" })],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string", old_col: "boolean" })],
      ["orders", makeSnapshot("orders", { id: "number", total: "string" })],
      ["deleted_table", makeSnapshot("deleted_table", { id: "number" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual(["new_table"]);
    expect(diff.removedTables).toEqual(["deleted_table"]);
    expect(diff.tableDiffs).toHaveLength(2);

    const usersDiff = diff.tableDiffs.find((td) => td.table === "users")!;
    expect(usersDiff.addedColumns).toEqual([{ name: "email", type: "string" }]);
    expect(usersDiff.removedColumns).toEqual([{ name: "old_col", type: "boolean" }]);

    const ordersDiff = diff.tableDiffs.find((td) => td.table === "orders")!;
    expect(ordersDiff.typeChanges).toEqual([{ name: "total", yamlType: "string", dbType: "number" }]);
    expect(ordersDiff.addedFKs).toEqual(["user_id→users.id"]);
  });

  test("no diff for shared table with identical schema", () => {
    const db = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string" }, ["company_id→companies.id"])],
    ]);
    const yml = new Map([
      ["users", makeSnapshot("users", { id: "number", name: "string" }, ["company_id→companies.id"])],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.tableDiffs).toEqual([]);
  });

  test("both maps empty → no drift", () => {
    const db = new Map<string, EntitySnapshot>();
    const yml = new Map<string, EntitySnapshot>();
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual([]);
    expect(diff.removedTables).toEqual([]);
    expect(diff.tableDiffs).toEqual([]);
  });

  test("DB populated + YAML empty → all tables are new (sorted)", () => {
    const db = new Map([
      ["zebras", makeSnapshot("zebras", { id: "number" })],
      ["alpacas", makeSnapshot("alpacas", { id: "number" })],
    ]);
    const yml = new Map<string, EntitySnapshot>();
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual(["alpacas", "zebras"]);
    expect(diff.removedTables).toEqual([]);
    expect(diff.tableDiffs).toEqual([]);
  });

  test("DB empty + YAML populated → all tables are removed", () => {
    const db = new Map<string, EntitySnapshot>();
    const yml = new Map([
      ["orders", makeSnapshot("orders", { id: "number" })],
      ["customers", makeSnapshot("customers", { id: "number" })],
    ]);
    const diff = computeDiff(db, yml);
    expect(diff.newTables).toEqual([]);
    expect(diff.removedTables).toEqual(["customers", "orders"]);
    expect(diff.tableDiffs).toEqual([]);
  });
});

// --- formatDiff ---

describe("formatDiff", () => {
  test("no drift message", () => {
    const diff = { newTables: [], removedTables: [], tableDiffs: [] };
    const output = formatDiff(diff);
    expect(output).toContain("No drift detected");
  });

  test("formats new tables", () => {
    const diff = { newTables: ["audit_logs"], removedTables: [], tableDiffs: [] };
    const dbSnaps = new Map([
      ["audit_logs", makeSnapshot("audit_logs", { id: "number", action: "string" })],
    ]);
    const output = formatDiff(diff, dbSnaps);
    expect(output).toContain("+ audit_logs (2 columns)");
    expect(output).toContain("Summary: 1 new table");
  });

  test("formats removed tables", () => {
    const diff = { newTables: [], removedTables: ["old_stuff"], tableDiffs: [] };
    const output = formatDiff(diff);
    expect(output).toContain("- old_stuff");
    expect(output).toContain("Summary: 1 removed");
  });

  test("formats column changes", () => {
    const diff = {
      newTables: [],
      removedTables: [],
      tableDiffs: [
        {
          table: "users",
          addedColumns: [{ name: "email", type: "string" }],
          removedColumns: [{ name: "old_col", type: "string" }],
          typeChanges: [{ name: "revenue", yamlType: "string", dbType: "number" }],
          addedFKs: ["company_id→companies.id"],
          removedFKs: [],
          metadataChanges: [],
        },
      ],
    };
    const output = formatDiff(diff);
    expect(output).toContain("+ added column: email (string)");
    expect(output).toContain("- removed column: old_col (string)");
    expect(output).toContain("~ type changed: revenue — YAML: string, DB: number");
    expect(output).toContain("+ added FK: company_id→companies.id");
    expect(output).toContain("1 changed (1 column added, 1 removed, 1 type change, 1 FK added)");
  });

  test("formats removed FKs", () => {
    const diff = {
      newTables: [],
      removedTables: [],
      tableDiffs: [
        {
          table: "orders",
          addedColumns: [],
          removedColumns: [],
          typeChanges: [],
          addedFKs: [],
          removedFKs: ["old_ref→old_table.id"],
          metadataChanges: [],
        },
      ],
    };
    const output = formatDiff(diff);
    expect(output).toContain("- removed FK: old_ref→old_table.id");
    expect(output).toContain("1 FK removed");
  });

  test("pluralization with multiple new tables and added columns", () => {
    const diff = {
      newTables: ["table_a", "table_b"],
      removedTables: [],
      tableDiffs: [
        {
          table: "users",
          addedColumns: [
            { name: "email", type: "string" },
            { name: "phone", type: "string" },
          ],
          removedColumns: [],
          typeChanges: [],
          addedFKs: [],
          removedFKs: [],
          metadataChanges: [],
        },
      ],
    };
    const output = formatDiff(diff);
    expect(output).toContain("2 new tables");
    expect(output).toContain("2 columns added");
  });

  test("no dbSnapshots for new tables — no column count in output", () => {
    const diff = {
      newTables: ["audit_logs"],
      removedTables: [],
      tableDiffs: [],
    };
    const output = formatDiff(diff);
    expect(output).toContain("audit_logs");
    expect(output).not.toContain("columns)");
  });
});

// --- mapSQLType (used by diff) ---

describe("mapSQLType", () => {
  test("integer types → number", () => {
    expect(mapSQLType("integer")).toBe("number");
    expect(mapSQLType("INT")).toBe("number");
    expect(mapSQLType("bigint")).toBe("number");
  });

  test("float types → number", () => {
    expect(mapSQLType("float")).toBe("number");
    expect(mapSQLType("real")).toBe("number");
    expect(mapSQLType("numeric(10,2)")).toBe("number");
    expect(mapSQLType("decimal")).toBe("number");
  });

  test("boolean → boolean", () => {
    expect(mapSQLType("boolean")).toBe("boolean");
    expect(mapSQLType("bool")).toBe("boolean");
  });

  test("date/time types → date", () => {
    expect(mapSQLType("date")).toBe("date");
    expect(mapSQLType("timestamp")).toBe("date");
    expect(mapSQLType("timestamptz")).toBe("date");
    expect(mapSQLType("time")).toBe("date");
  });

  test("text types → string", () => {
    expect(mapSQLType("text")).toBe("string");
    expect(mapSQLType("varchar(255)")).toBe("string");
    expect(mapSQLType("character varying")).toBe("string");
  });

  test("interval type → string (not number)", () => {
    expect(mapSQLType("interval")).toBe("string");
    expect(mapSQLType("INTERVAL")).toBe("string");
    expect(mapSQLType("interval day to second")).toBe("string");
  });

  test("exotic/unknown types fallback → string", () => {
    expect(mapSQLType("jsonb")).toBe("string");
    expect(mapSQLType("uuid")).toBe("string");
    expect(mapSQLType("bytea")).toBe("string");
    expect(mapSQLType("inet")).toBe("string");
    expect(mapSQLType("tsvector")).toBe("string");
    expect(mapSQLType("USER-DEFINED")).toBe("string");
  });
});
