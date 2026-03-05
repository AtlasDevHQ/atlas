/**
 * Tests for per-source semantic layer loading in semantic.ts.
 *
 * Verifies the multi-source directory layout where per-source subdirectories
 * (e.g. `semantic/warehouse/entities/`) auto-derive the connection ID from
 * the directory name.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

// Cache-busting import for fresh module instance
const semModPath = resolve(__dirname, "../semantic.ts");
const semMod = await import(`${semModPath}?t=multisource-${Date.now()}`);
const getWhitelistedTables = semMod.getWhitelistedTables as typeof import("../semantic").getWhitelistedTables;
const _resetWhitelists = semMod._resetWhitelists as typeof import("../semantic")._resetWhitelists;
const getCrossSourceJoins = semMod.getCrossSourceJoins as typeof import("../semantic").getCrossSourceJoins;

const tmpBase = resolve(__dirname, ".tmp-semantic-multisource-test");
let testCounter = 0;

function ensureDir(subdir: string): string {
  const dir = resolve(tmpBase, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpBase() {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

function writeEntity(dir: string, filename: string, content: string) {
  writeFileSync(join(dir, filename), content);
}

describe("per-source semantic layer loading", () => {
  beforeEach(() => {
    _resetWhitelists();
    testCounter++;
  });

  afterEach(() => {
    _resetWhitelists();
    cleanTmpBase();
  });

  it("loads default entities from root/entities/ and per-source from subdirectories", () => {
    const root = ensureDir(`multisource-${testCounter}`);
    const defaultEntities = ensureDir(`multisource-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`multisource-${testCounter}/warehouse/entities`);

    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(warehouseEntities, "events.yml", `table: events\ncolumns:\n  id:\n    type: integer\n`);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);

    expect(defaultTables.has("users")).toBe(true);
    expect(defaultTables.has("events")).toBe(false);
    expect(warehouseTables.has("events")).toBe(true);
    expect(warehouseTables.has("users")).toBe(false);
  });

  it("directory name becomes connection ID for entities without explicit connection field", () => {
    const root = ensureDir(`dirname-${testCounter}`);
    ensureDir(`dirname-${testCounter}/entities`);
    const salesforceEntities = ensureDir(`dirname-${testCounter}/salesforce/entities`);

    // No explicit connection field — should be inferred as "salesforce"
    writeEntity(salesforceEntities, "accounts.yml", `table: accounts\ncolumns:\n  id:\n    type: integer\n`);

    const sfTables = getWhitelistedTables("salesforce", undefined, root);
    expect(sfTables.has("accounts")).toBe(true);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("accounts")).toBe(false);
  });

  it("explicit connection field in YAML overrides directory-based inference", () => {
    const root = ensureDir(`override-${testCounter}`);
    ensureDir(`override-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`override-${testCounter}/warehouse/entities`);

    // Entity is in warehouse/ dir but explicitly targets "analytics" connection
    writeEntity(
      warehouseEntities,
      "events.yml",
      `table: events\nconnection: analytics\ncolumns:\n  id:\n    type: integer\n`,
    );

    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);
    expect(warehouseTables.has("events")).toBe(false);

    const analyticsTables = getWhitelistedTables("analytics", undefined, root);
    expect(analyticsTables.has("events")).toBe(true);
  });

  it("backward compat: no subdirectories → shared whitelist mode", () => {
    const root = ensureDir(`compat-${testCounter}`);
    const defaultEntities = ensureDir(`compat-${testCounter}/entities`);

    // No connection fields, no subdirectories — all connections share the same whitelist
    writeEntity(defaultEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    const anyTables = getWhitelistedTables("anything", undefined, root);

    expect(defaultTables.has("orders")).toBe(true);
    expect(defaultTables.has("users")).toBe(true);
    // Backward compat: non-default connections get the same tables
    expect(anyTables.has("orders")).toBe(true);
    expect(anyTables.has("users")).toBe(true);
  });

  it("unknown connection IDs get empty whitelists in partitioned mode", () => {
    const root = ensureDir(`unknown-${testCounter}`);
    const defaultEntities = ensureDir(`unknown-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`unknown-${testCounter}/warehouse/entities`);

    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(warehouseEntities, "events.yml", `table: events\ncolumns:\n  id:\n    type: integer\n`);

    const unknownTables = getWhitelistedTables("nonexistent", undefined, root);
    expect(unknownTables.size).toBe(0);
  });

  it("reserved directories (entities, metrics) are not treated as source names", () => {
    const root = ensureDir(`reserved-${testCounter}`);
    const defaultEntities = ensureDir(`reserved-${testCounter}/entities`);
    ensureDir(`reserved-${testCounter}/metrics`);

    writeEntity(defaultEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);

    // "entities" and "metrics" should not be treated as connection IDs
    const entitiesTables = getWhitelistedTables("entities", undefined, root);
    const metricsTables = getWhitelistedTables("metrics", undefined, root);

    // In shared mode (no partitioning), these would still get the default tables
    // but they should NOT have any tables from a dir called "entities" or "metrics"
    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("orders")).toBe(true);
    // No partitioning triggered so backward compat shares
    expect(entitiesTables.has("orders")).toBe(true);
    expect(metricsTables.has("orders")).toBe(true);
  });

  it("multiple per-source subdirectories coexist", () => {
    const root = ensureDir(`multi-${testCounter}`);
    const defaultEntities = ensureDir(`multi-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`multi-${testCounter}/warehouse/entities`);
    const salesforceEntities = ensureDir(`multi-${testCounter}/salesforce/entities`);

    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(warehouseEntities, "events.yml", `table: events\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(salesforceEntities, "accounts.yml", `table: accounts\ncolumns:\n  id:\n    type: integer\n`);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);
    const salesforceTables = getWhitelistedTables("salesforce", undefined, root);

    expect(defaultTables.has("users")).toBe(true);
    expect(defaultTables.has("events")).toBe(false);
    expect(defaultTables.has("accounts")).toBe(false);

    expect(warehouseTables.has("events")).toBe(true);
    expect(warehouseTables.has("users")).toBe(false);
    expect(warehouseTables.has("accounts")).toBe(false);

    expect(salesforceTables.has("accounts")).toBe(true);
    expect(salesforceTables.has("users")).toBe(false);
    expect(salesforceTables.has("events")).toBe(false);
  });

  it("schema-qualified tables work with per-source loading", () => {
    const root = ensureDir(`schema-${testCounter}`);
    ensureDir(`schema-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`schema-${testCounter}/warehouse/entities`);

    writeEntity(
      warehouseEntities,
      "analytics_orders.yml",
      `table: analytics.orders\ncolumns:\n  id:\n    type: integer\n`,
    );

    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);
    expect(warehouseTables.has("analytics.orders")).toBe(true);
    expect(warehouseTables.has("orders")).toBe(true);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("analytics.orders")).toBe(false);
  });

  it("empty semantic root → empty set", () => {
    const root = ensureDir(`empty-${testCounter}`);
    const tables = getWhitelistedTables("default", undefined, root);
    expect(tables.size).toBe(0);
  });

  it("non-existent semantic root → empty set", () => {
    const tables = getWhitelistedTables("default", undefined, "/tmp/nonexistent-atlas-multisource-test");
    expect(tables.size).toBe(0);
  });

  it("legacy entitiesDir param still works (backward compat)", () => {
    // This verifies that existing tests using entitiesDir continue to work
    const dir = ensureDir(`legacy-${testCounter}`);
    writeEntity(dir, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);

    const tables = getWhitelistedTables("default", dir);
    expect(tables.has("orders")).toBe(true);
  });

  it("subdirectory without entities/ subfolder is ignored", () => {
    const root = ensureDir(`noentities-${testCounter}`);
    const defaultEntities = ensureDir(`noentities-${testCounter}/entities`);
    // Create a subdirectory without an entities/ subfolder
    ensureDir(`noentities-${testCounter}/warehouse`);

    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);

    // Should not crash, warehouse just has no tables
    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("users")).toBe(true);
  });

  it("same table name in default and source → correctly isolated", () => {
    const root = ensureDir(`samename-${testCounter}`);
    const defaultEntities = ensureDir(`samename-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`samename-${testCounter}/warehouse/entities`);

    writeEntity(defaultEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(warehouseEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);

    expect(defaultTables.has("orders")).toBe(true);
    expect(warehouseTables.has("orders")).toBe(true);
    expect(defaultTables).not.toBe(warehouseTables);
  });

  it("reserved directories with entities/ subfolder are still excluded", () => {
    const root = ensureDir(`reserved-strict-${testCounter}`);
    const defaultEntities = ensureDir(`reserved-strict-${testCounter}/entities`);
    // Create metrics/entities/ — should be blocked by RESERVED_DIRS, not by missing dir
    const metricsEntities = ensureDir(`reserved-strict-${testCounter}/metrics/entities`);

    writeEntity(defaultEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(metricsEntities, "shadow.yml", `table: shadow\ncolumns:\n  id:\n    type: integer\n`);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("orders")).toBe(true);

    // "metrics" is reserved — should NOT be treated as a source
    const metricsTables = getWhitelistedTables("metrics", undefined, root);
    expect(metricsTables.has("shadow")).toBe(false);
  });
});

describe("cross-source join hints", () => {
  beforeEach(() => {
    _resetWhitelists();
    testCounter++;
  });

  afterEach(() => {
    _resetWhitelists();
    cleanTmpBase();
  });

  it("entity with cross_source_joins is parsed", () => {
    const root = ensureDir(`csj-basic-${testCounter}`);
    const defaultEntities = ensureDir(`csj-basic-${testCounter}/entities`);

    writeEntity(
      defaultEntities,
      "users.yml",
      [
        "table: users",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: warehouse",
        "    target_table: events",
        "    on: users.id = events.user_id",
        "    relationship: one_to_many",
        '    description: User activity events',
      ].join("\n"),
    );

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(1);
    expect(joins[0].fromSource).toBe("default");
    expect(joins[0].fromTable).toBe("users");
    expect(joins[0].toSource).toBe("warehouse");
    expect(joins[0].toTable).toBe("events");
    expect(joins[0].on).toBe("users.id = events.user_id");
    expect(joins[0].relationship).toBe("one_to_many");
    expect(joins[0].description).toBe("User activity events");
  });

  it("entity without cross_source_joins returns empty array (backward compat)", () => {
    const root = ensureDir(`csj-compat-${testCounter}`);
    const defaultEntities = ensureDir(`csj-compat-${testCounter}/entities`);

    writeEntity(defaultEntities, "orders.yml", "table: orders\ncolumns:\n  id:\n    type: integer\n");

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(0);
  });

  it("multiple cross-source joins on one entity", () => {
    const root = ensureDir(`csj-multi-${testCounter}`);
    const defaultEntities = ensureDir(`csj-multi-${testCounter}/entities`);

    writeEntity(
      defaultEntities,
      "users.yml",
      [
        "table: users",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: warehouse",
        "    target_table: events",
        "    on: users.id = events.user_id",
        "    relationship: one_to_many",
        "  - source: salesforce",
        "    target_table: contacts",
        "    on: users.email = contacts.email",
        "    relationship: one_to_one",
      ].join("\n"),
    );

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(2);
    expect(joins[0].toSource).toBe("warehouse");
    expect(joins[1].toSource).toBe("salesforce");
  });

  it("cross-source joins from multiple entities across sources", () => {
    const root = ensureDir(`csj-across-${testCounter}`);
    const defaultEntities = ensureDir(`csj-across-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`csj-across-${testCounter}/warehouse/entities`);

    writeEntity(
      defaultEntities,
      "users.yml",
      [
        "table: users",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: warehouse",
        "    target_table: events",
        "    on: users.id = events.user_id",
        "    relationship: one_to_many",
      ].join("\n"),
    );

    writeEntity(
      warehouseEntities,
      "events.yml",
      [
        "table: events",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: default",
        "    target_table: users",
        "    on: events.user_id = users.id",
        "    relationship: many_to_one",
      ].join("\n"),
    );

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(2);

    const fromDefault = joins.find((j) => j.fromSource === "default");
    const fromWarehouse = joins.find((j) => j.fromSource === "warehouse");

    expect(fromDefault).toBeDefined();
    expect(fromDefault!.fromTable).toBe("users");
    expect(fromDefault!.toSource).toBe("warehouse");

    expect(fromWarehouse).toBeDefined();
    expect(fromWarehouse!.fromTable).toBe("events");
    expect(fromWarehouse!.toSource).toBe("default");
  });

  it("explicit connection field used as fromSource (not directory name)", () => {
    const root = ensureDir(`csj-explicit-${testCounter}`);
    ensureDir(`csj-explicit-${testCounter}/entities`);
    const warehouseEntities = ensureDir(`csj-explicit-${testCounter}/warehouse/entities`);

    // Entity lives in warehouse/ dir but declares connection: analytics
    writeEntity(
      warehouseEntities,
      "events.yml",
      [
        "table: events",
        "connection: analytics",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: default",
        "    target_table: users",
        "    on: events.user_id = users.id",
        "    relationship: many_to_one",
      ].join("\n"),
    );

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(1);
    // fromSource should be "analytics" (from connection field), not "warehouse" (from directory)
    expect(joins[0].fromSource).toBe("analytics");
  });

  it("invalid cross_source_joins entry skipped gracefully — entity stays whitelisted", () => {
    const root = ensureDir(`csj-invalid-${testCounter}`);
    const defaultEntities = ensureDir(`csj-invalid-${testCounter}/entities`);

    // Missing required fields (target_table, on, relationship) — the malformed
    // join entry is skipped, but the entity itself remains in the whitelist
    // because cross_source_joins validation is separate from core entity parsing.
    writeEntity(
      defaultEntities,
      "users.yml",
      [
        "table: users",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: warehouse",
        // missing target_table, on, relationship
      ].join("\n"),
    );

    // A valid entity in the same directory should still load fine
    writeEntity(
      defaultEntities,
      "orders.yml",
      "table: orders\ncolumns:\n  id:\n    type: integer\n",
    );

    const tables = getWhitelistedTables("default", undefined, root);
    // The entity stays in the whitelist — only the bad join entry is skipped
    expect(tables.has("users")).toBe(true);
    expect(tables.has("orders")).toBe(true);

    const joins = getCrossSourceJoins(root);
    // No valid joins from the users entity (all were invalid)
    expect(joins.filter((j) => j.fromTable === "users")).toHaveLength(0);
  });

  it("partial invalid joins — valid entries collected, invalid entries skipped, entity stays whitelisted", () => {
    const root = ensureDir(`csj-partial-${testCounter}`);
    const defaultEntities = ensureDir(`csj-partial-${testCounter}/entities`);

    // Two cross_source_joins: one valid, one missing required fields.
    // The valid one should be collected, the invalid one skipped, and the
    // entity should remain in the whitelist.
    writeEntity(
      defaultEntities,
      "users.yml",
      [
        "table: users",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: warehouse",
        "    target_table: events",
        "    on: users.id = events.user_id",
        "    relationship: one_to_many",
        "  - source: salesforce",
        // missing target_table, on, relationship
      ].join("\n"),
    );

    const tables = getWhitelistedTables("default", undefined, root);
    expect(tables.has("users")).toBe(true);

    const joins = getCrossSourceJoins(root);
    const userJoins = joins.filter((j) => j.fromTable === "users");
    expect(userJoins).toHaveLength(1);
    expect(userJoins[0].toSource).toBe("warehouse");
    expect(userJoins[0].toTable).toBe("events");
  });

  it("getCrossSourceJoins() without args uses global cache populated by getWhitelistedTables()", () => {
    // Set up a temp directory that looks like a semantic root at process.cwd()/semantic
    const tmpRoot = ensureDir(`csj-cache-${testCounter}`);
    const entitiesDir = ensureDir(`csj-cache-${testCounter}/semantic/entities`);

    writeEntity(
      entitiesDir,
      "users.yml",
      [
        "table: users",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: warehouse",
        "    target_table: events",
        "    on: users.id = events.user_id",
        "    relationship: one_to_many",
        "    description: User activity events",
      ].join("\n"),
    );

    // Temporarily change CWD so getWhitelistedTables() without args finds semantic/
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      // Call without custom paths — populates global cache (_tablesByConnection + _crossSourceJoins)
      const tables = getWhitelistedTables();
      expect(tables.has("users")).toBe(true);

      // Call getCrossSourceJoins() without args — reads from global cache
      const joins = getCrossSourceJoins();
      expect(joins).toHaveLength(1);
      expect(joins[0].fromSource).toBe("default");
      expect(joins[0].fromTable).toBe("users");
      expect(joins[0].toSource).toBe("warehouse");
      expect(joins[0].toTable).toBe("events");
      expect(joins[0].on).toBe("users.id = events.user_id");
      expect(joins[0].relationship).toBe("one_to_many");
      expect(joins[0].description).toBe("User activity events");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
