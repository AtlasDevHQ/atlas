/**
 * Tests for per-connection table whitelists in semantic.ts.
 *
 * Uses temp directories with entity YAMLs to test the partitioning logic
 * via the `entitiesDir` DI parameter, avoiding dependency on the global
 * semantic/ directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

// Cache-busting import for fresh module instance
const semModPath = resolve(__dirname, "../semantic.ts");
const semMod = await import(`${semModPath}?t=${Date.now()}`);
const getWhitelistedTables = semMod.getWhitelistedTables as typeof import("../semantic").getWhitelistedTables;
const _resetWhitelists = semMod._resetWhitelists as typeof import("../semantic")._resetWhitelists;
const registerPluginEntities = semMod.registerPluginEntities as typeof import("../semantic").registerPluginEntities;
const _resetPluginEntities = semMod._resetPluginEntities as typeof import("../semantic")._resetPluginEntities;

const tmpBase = resolve(__dirname, ".tmp-semantic-test");
let testCounter = 0;

function ensureEntitiesDir(subdir: string): string {
  const dir = resolve(tmpBase, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpBase() {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

describe("per-connection whitelists", () => {
  beforeEach(() => {
    _resetWhitelists();
    testCounter++;
  });

  afterEach(() => {
    _resetWhitelists();
    cleanTmpBase();
  });

  it("no connection field → all connections share same whitelist (backward compat)", () => {
    const dir = ensureEntitiesDir(`compat-${testCounter}`);
    writeFileSync(
      resolve(dir, "orders.yml"),
      `table: orders\ncolumns:\n  id:\n    type: integer\n`,
    );
    writeFileSync(
      resolve(dir, "users.yml"),
      `table: users\ncolumns:\n  id:\n    type: integer\n`,
    );

    const defaultTables = getWhitelistedTables("default", dir);
    const warehouseTables = getWhitelistedTables("warehouse", dir);

    expect(defaultTables.has("orders")).toBe(true);
    expect(defaultTables.has("users")).toBe(true);
    // Backward compat: non-default connections get the same tables
    expect(warehouseTables.has("orders")).toBe(true);
    expect(warehouseTables.has("users")).toBe(true);
  });

  it("with connection fields → per-connection isolation", () => {
    const dir = ensureEntitiesDir(`partitioned-${testCounter}`);
    writeFileSync(
      resolve(dir, "orders.yml"),
      `table: orders\nconnection: default\ncolumns:\n  id:\n    type: integer\n`,
    );
    writeFileSync(
      resolve(dir, "events.yml"),
      `table: events\nconnection: warehouse\ncolumns:\n  id:\n    type: integer\n`,
    );

    const defaultTables = getWhitelistedTables("default", dir);
    const warehouseTables = getWhitelistedTables("warehouse", dir);

    // Each connection only sees its own tables
    expect(defaultTables.has("orders")).toBe(true);
    expect(defaultTables.has("events")).toBe(false);
    expect(warehouseTables.has("events")).toBe(true);
    expect(warehouseTables.has("orders")).toBe(false);
  });

  it("unknown connectionId → empty set in partitioned mode", () => {
    const dir = ensureEntitiesDir(`unknown-${testCounter}`);
    writeFileSync(
      resolve(dir, "orders.yml"),
      `table: orders\nconnection: default\ncolumns:\n  id:\n    type: integer\n`,
    );
    // Need a non-default connection to trigger partitioned mode
    writeFileSync(
      resolve(dir, "events.yml"),
      `table: events\nconnection: warehouse\ncolumns:\n  id:\n    type: integer\n`,
    );

    const unknownTables = getWhitelistedTables("nonexistent", dir);
    expect(unknownTables.size).toBe(0);
  });

  it("schema-qualified tables respect connection field", () => {
    const dir = ensureEntitiesDir(`schema-${testCounter}`);
    writeFileSync(
      resolve(dir, "analytics_orders.yml"),
      `table: analytics.orders\nconnection: warehouse\ncolumns:\n  id:\n    type: integer\n`,
    );

    const warehouseTables = getWhitelistedTables("warehouse", dir);
    expect(warehouseTables.has("analytics.orders")).toBe(true);
    expect(warehouseTables.has("orders")).toBe(true);

    const defaultTables = getWhitelistedTables("default", dir);
    expect(defaultTables.has("analytics.orders")).toBe(false);
    expect(defaultTables.has("orders")).toBe(false);
  });

  it("entities without connection field default to 'default'", () => {
    const dir = ensureEntitiesDir(`mixed-${testCounter}`);
    // This entity has no connection field → defaults to "default"
    writeFileSync(
      resolve(dir, "users.yml"),
      `table: users\ncolumns:\n  id:\n    type: integer\n`,
    );
    // This one explicitly targets warehouse
    writeFileSync(
      resolve(dir, "events.yml"),
      `table: events\nconnection: warehouse\ncolumns:\n  id:\n    type: integer\n`,
    );

    const defaultTables = getWhitelistedTables("default", dir);
    const warehouseTables = getWhitelistedTables("warehouse", dir);

    expect(defaultTables.has("users")).toBe(true);
    expect(defaultTables.has("events")).toBe(false);
    expect(warehouseTables.has("events")).toBe(true);
    expect(warehouseTables.has("users")).toBe(false);
  });

  it("_resetWhitelists() clears partition cache", () => {
    const dir = ensureEntitiesDir(`reset-${testCounter}`);
    writeFileSync(
      resolve(dir, "orders.yml"),
      `table: orders\ncolumns:\n  id:\n    type: integer\n`,
    );

    const first = getWhitelistedTables("default", dir);
    expect(first.has("orders")).toBe(true);

    // Reset and call again — should get a fresh result
    _resetWhitelists();

    const second = getWhitelistedTables("default", dir);
    expect(second.has("orders")).toBe(true);
    // Global cache path: after reset, a new call should work
  });

  it("empty entities directory → empty set", () => {
    const dir = ensureEntitiesDir(`empty-${testCounter}`);
    const tables = getWhitelistedTables("default", dir);
    expect(tables.size).toBe(0);
  });

  it("non-existent entities directory → empty set", () => {
    const tables = getWhitelistedTables("default", "/tmp/nonexistent-atlas-test");
    expect(tables.size).toBe(0);
  });

  it("all entities with connection: default → backward compat mode (shared)", () => {
    const dir = ensureEntitiesDir(`all-default-${testCounter}`);
    writeFileSync(resolve(dir, "orders.yml"), `table: orders\nconnection: default\ncolumns:\n  id:\n    type: integer\n`);
    writeFileSync(resolve(dir, "users.yml"), `table: users\nconnection: default\ncolumns:\n  id:\n    type: integer\n`);
    const defaultTables = getWhitelistedTables("default", dir);
    const warehouseTables = getWhitelistedTables("warehouse", dir);
    expect(defaultTables.has("orders")).toBe(true);
    expect(warehouseTables.has("orders")).toBe(true);
  });

  it("malformed YAML files are skipped", () => {
    const dir = ensureEntitiesDir(`malformed-${testCounter}`);
    writeFileSync(resolve(dir, "bad.yml"), `{{{not yaml`);
    writeFileSync(
      resolve(dir, "good.yml"),
      `table: good_table\ncolumns:\n  id:\n    type: integer\n`,
    );

    const tables = getWhitelistedTables("default", dir);
    expect(tables.has("good_table")).toBe(true);
    expect(tables.size).toBe(1); // Only the good table
  });
});

describe("registerPluginEntities", () => {
  beforeEach(() => {
    _resetWhitelists();
    _resetPluginEntities();
    testCounter++;
  });

  afterEach(() => {
    _resetWhitelists();
    _resetPluginEntities();
    cleanTmpBase();
  });

  it("adds plugin entity tables to whitelist", () => {
    registerPluginEntities("my-plugin", [
      { name: "orders", yaml: "table: orders\ndimensions:\n  id:\n    type: integer\n" },
      { name: "users", yaml: "table: users\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    // Use a temp dir with no disk entities so plugin entities are the only source
    const dir = ensureEntitiesDir(`plugin-only-${testCounter}`);
    const tables = getWhitelistedTables("my-plugin", dir);
    expect(tables.has("orders")).toBe(true);
    expect(tables.has("users")).toBe(true);
  });

  it("handles schema-qualified table names", () => {
    registerPluginEntities("bq-plugin", [
      { name: "analytics_events", yaml: "table: analytics.events\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    const dir = ensureEntitiesDir(`plugin-schema-${testCounter}`);
    const tables = getWhitelistedTables("bq-plugin", dir);
    expect(tables.has("analytics.events")).toBe(true);
    expect(tables.has("events")).toBe(true);
  });

  it("merges with disk-based entities", () => {
    const dir = ensureEntitiesDir(`plugin-merge-${testCounter}`);
    writeFileSync(
      resolve(dir, "disk_table.yml"),
      `table: disk_table\nconnection: my-plugin\ndimensions:\n  id:\n    type: integer\n`,
    );
    // Need a second connection to trigger partitioned mode
    writeFileSync(
      resolve(dir, "other_table.yml"),
      `table: other_table\nconnection: other\ndimensions:\n  id:\n    type: integer\n`,
    );

    registerPluginEntities("my-plugin", [
      { name: "plugin_table", yaml: "table: plugin_table\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    const tables = getWhitelistedTables("my-plugin", dir);
    expect(tables.has("disk_table")).toBe(true);
    expect(tables.has("plugin_table")).toBe(true);
  });

  it("skips malformed YAML entities gracefully", () => {
    registerPluginEntities("my-plugin", [
      { name: "bad", yaml: "{{{not valid yaml" },
      { name: "good", yaml: "table: good_table\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    const dir = ensureEntitiesDir(`plugin-malformed-${testCounter}`);
    const tables = getWhitelistedTables("my-plugin", dir);
    expect(tables.has("good_table")).toBe(true);
    expect(tables.size).toBe(1);
  });

  it("skips entities with missing table field", () => {
    registerPluginEntities("my-plugin", [
      { name: "no-table", yaml: "description: missing table field\n" },
      { name: "good", yaml: "table: valid_table\n" },
    ]);

    const dir = ensureEntitiesDir(`plugin-no-table-${testCounter}`);
    const tables = getWhitelistedTables("my-plugin", dir);
    expect(tables.has("valid_table")).toBe(true);
    expect(tables.size).toBe(1);
  });

  it("_resetPluginEntities clears plugin entities", () => {
    registerPluginEntities("my-plugin", [
      { name: "orders", yaml: "table: orders\n" },
    ]);

    _resetPluginEntities();

    const dir = ensureEntitiesDir(`plugin-reset-${testCounter}`);
    const tables = getWhitelistedTables("my-plugin", dir);
    expect(tables.has("orders")).toBe(false);
  });

  it("cache invalidation: plugin entities visible after registering post-cache", () => {
    const dir = ensureEntitiesDir(`plugin-cache-inv-${testCounter}`);
    writeFileSync(
      resolve(dir, "disk_table.yml"),
      `table: disk_table\nconnection: my-plugin\ndimensions:\n  id:\n    type: integer\n`,
    );
    // Need a second connection for partitioned mode
    writeFileSync(
      resolve(dir, "other.yml"),
      `table: other_table\nconnection: other\ndimensions:\n  id:\n    type: integer\n`,
    );

    // First call populates cache — plugin_table not yet registered
    const before = getWhitelistedTables("my-plugin", dir);
    expect(before.has("disk_table")).toBe(true);
    expect(before.has("plugin_table")).toBe(false);

    // Register plugin entities after cache is populated
    registerPluginEntities("my-plugin", [
      { name: "plugin_table", yaml: "table: plugin_table\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    // Second call must include the newly registered plugin entity
    const after = getWhitelistedTables("my-plugin", dir);
    expect(after.has("disk_table")).toBe(true);
    expect(after.has("plugin_table")).toBe(true);
  });

  it("duplicate registration is idempotent", () => {
    registerPluginEntities("my-plugin", [
      { name: "orders", yaml: "table: orders\ndimensions:\n  id:\n    type: integer\n" },
    ]);
    registerPluginEntities("my-plugin", [
      { name: "orders", yaml: "table: orders\ndimensions:\n  id:\n    type: integer\n" },
      { name: "users", yaml: "table: users\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    const dir = ensureEntitiesDir(`plugin-dup-${testCounter}`);
    const tables = getWhitelistedTables("my-plugin", dir);
    expect(tables.has("orders")).toBe(true);
    expect(tables.has("users")).toBe(true);
    // "orders" should appear only once in the set (Set semantics)
    const arr = Array.from(tables);
    expect(arr.filter((t) => t === "orders").length).toBe(1);
  });

  it("plugin entities do not contaminate the disk-only cache", () => {
    const dir = ensureEntitiesDir(`plugin-no-contaminate-${testCounter}`);
    writeFileSync(
      resolve(dir, "disk_table.yml"),
      `table: disk_table\nconnection: my-plugin\ndimensions:\n  id:\n    type: integer\n`,
    );
    writeFileSync(
      resolve(dir, "other.yml"),
      `table: other_table\nconnection: other\ndimensions:\n  id:\n    type: integer\n`,
    );

    registerPluginEntities("my-plugin", [
      { name: "plugin_table", yaml: "table: plugin_table\ndimensions:\n  id:\n    type: integer\n" },
    ]);

    // Get whitelist (merges disk + plugin)
    const merged = getWhitelistedTables("my-plugin", dir);
    expect(merged.has("plugin_table")).toBe(true);
    expect(merged.has("disk_table")).toBe(true);

    // Clear plugin entities and whitelist cache
    _resetPluginEntities();

    // Now the disk-only tables should NOT include plugin_table
    const diskOnly = getWhitelistedTables("my-plugin", dir);
    expect(diskOnly.has("disk_table")).toBe(true);
    expect(diskOnly.has("plugin_table")).toBe(false);
  });
});
