/**
 * Tests for per-connection table whitelists in semantic.ts.
 *
 * Uses temp directories with entity YAMLs to test the partitioning logic
 * via the `entitiesDir` DI parameter, avoiding dependency on the global
 * semantic/ directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

// Cache-busting import for fresh module instance
const semModPath = resolve(__dirname, "../semantic/whitelist.ts");
const semMod = await import(`${semModPath}?t=${Date.now()}`);
const getWhitelistedTables = semMod.getWhitelistedTables as typeof import("../semantic/whitelist").getWhitelistedTables;
const _resetWhitelists = semMod._resetWhitelists as typeof import("../semantic/whitelist")._resetWhitelists;
const registerPluginEntities = semMod.registerPluginEntities as typeof import("../semantic/whitelist").registerPluginEntities;
const _resetPluginEntities = semMod._resetPluginEntities as typeof import("../semantic/whitelist")._resetPluginEntities;
const tableWhitelistKeys = semMod.tableWhitelistKeys as typeof import("../semantic/whitelist").tableWhitelistKeys;
const getCrossSourceJoins = semMod.getCrossSourceJoins as typeof import("../semantic/whitelist").getCrossSourceJoins;

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

function writeEntity(dir: string, filename: string, content: string) {
  writeFileSync(join(dir, filename), content);
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

  // #3317: an ES/OpenSearch index-pattern entity can have a dotted base
  // (e.g. `filebeat-7.10.0-2024.01.01` collapses to `filebeat-7.10.0-*`). The
  // SQL `schema.table` last-segment split must NOT fire on it — that injected a
  // bogus `0-*` whitelist key and widened the allow-list.
  it("dotted ES index pattern → only the full-name key, no bogus fragment", () => {
    const dir = ensureEntitiesDir(`es-pattern-${testCounter}`);
    writeFileSync(
      resolve(dir, "filebeat.yml"),
      `table: filebeat-7.10.0-*\ncolumns:\n  message:\n    type: text\n`,
    );

    const tables = getWhitelistedTables("default", dir);
    // Full pattern name validates (SQL `FROM "filebeat-7.10.0-*"` and the DSL
    // `index: "filebeat-7.10.0-*"` both look it up lowercased).
    expect(tables.has("filebeat-7.10.0-*")).toBe(true);
    // The dotted-split fragment must be absent.
    expect(tables.has("0-*")).toBe(false);
    expect(tables.size).toBe(1);
  });

  // #3317: the same over-grant for a non-wildcard dotted ES name (data stream /
  // dotted dataset) — `logs-nginx.access-default` must not inject `access-default`.
  it("dotted ES data-stream name → only the full-name key, no bogus fragment", () => {
    const dir = ensureEntitiesDir(`es-stream-${testCounter}`);
    writeFileSync(
      resolve(dir, "stream.yml"),
      `table: logs-nginx.access-default\ncolumns:\n  message:\n    type: text\n`,
    );

    const tables = getWhitelistedTables("default", dir);
    expect(tables.has("logs-nginx.access-default")).toBe(true);
    expect(tables.has("access-default")).toBe(false);
    expect(tables.size).toBe(1);
  });

  // #3317: an `identifier_style: opaque` marker (which ES entities always carry)
  // closes the name-undecidable residual — a pure word-dotted ES name that the
  // name heuristic alone would split is registered as the full name only.
  it("identifier_style: opaque suppresses the dot-split end-to-end (disk path)", () => {
    const dir = ensureEntitiesDir(`es-opaque-${testCounter}`);
    writeFileSync(
      resolve(dir, "stream.yml"),
      `table: logs.app\nidentifier_style: opaque\ncolumns:\n  message:\n    type: text\n`,
    );

    const tables = getWhitelistedTables("default", dir);
    expect(tables.has("logs.app")).toBe(true);
    expect(tables.has("app")).toBe(false);
    expect(tables.size).toBe(1);
  });
});

describe("tableWhitelistKeys", () => {
  it("SQL schema.table → full + unqualified last-segment keys", () => {
    expect(tableWhitelistKeys("public.orders").sort()).toEqual(["orders", "public.orders"]);
  });

  it("bare table name → single key", () => {
    expect(tableWhitelistKeys("orders")).toEqual(["orders"]);
  });

  // #3317 review: a malformed empty `table:` must register no whitelist key.
  it("empty table name → no keys (no bogus empty-string entry)", () => {
    expect(tableWhitelistKeys("")).toEqual([]);
    expect(tableWhitelistKeys("", { opaque: true })).toEqual([]);
  });

  it("strips identifier quotes and lowercases", () => {
    expect(tableWhitelistKeys(`"User"`)).toEqual(["user"]);
    expect(tableWhitelistKeys('analytics."Events"').sort()).toEqual(["analytics.events", "events"]);
  });

  it("3-part SQL identifier (db.schema.table) → full + unqualified", () => {
    expect(tableWhitelistKeys("warehouse.public.orders").sort()).toEqual([
      "orders",
      "warehouse.public.orders",
    ]);
  });

  // #3317: a `-`/`*`/`?` or digit-leading segment can't appear in a bare SQL
  // identifier, so a dotted ES name carrying one is NOT schema-qualified — skip
  // the last-segment split that would inject a bogus fragment.
  it("dotted ES wildcard pattern → only the full name (no `0-*` fragment)", () => {
    expect(tableWhitelistKeys("filebeat-7.10.0-*")).toEqual(["filebeat-7.10.0-*"]);
  });

  it("ES pattern with `?` wildcard → only the full name", () => {
    expect(tableWhitelistKeys("logs-2024.01.0?")).toEqual(["logs-2024.01.0?"]);
  });

  it("dotted concrete date-suffixed index → only the full name (no `01` fragment)", () => {
    expect(tableWhitelistKeys("metrics-2024.01.01")).toEqual(["metrics-2024.01.01"]);
  });

  it("dotted data-stream / alias name with a dash → only the full name", () => {
    expect(tableWhitelistKeys("logs-nginx.access-default")).toEqual([
      "logs-nginx.access-default",
    ]);
  });

  it("dotted name with a digit-leading segment → only the full name", () => {
    // `metrics.2024.01` has no dash/wildcard, but `2024`/`01` are digit-leading
    // so it is not a SQL schema.table — still no bogus `01` fragment.
    expect(tableWhitelistKeys("metrics.2024.01")).toEqual(["metrics.2024.01"]);
  });

  // Heuristic fallback (no marker): a pure word-dotted name is name-undecidable
  // — indistinguishable from `schema.table` — so it still splits. The opaque
  // marker (below) is what closes this for ES entities.
  it("pure word-dotted name without marker → still splits (heuristic fallback)", () => {
    expect(tableWhitelistKeys("logs.app").sort()).toEqual(["app", "logs.app"]);
  });

  // #3317: the `identifier_style: opaque` marker is authoritative — it forces
  // full-name-only even for a name the heuristic would treat as SQL, closing
  // the pure word-dotted residual.
  it("opaque marker → full name only, even for a word-dotted name", () => {
    expect(tableWhitelistKeys("logs.app", { opaque: true })).toEqual(["logs.app"]);
  });

  it("opaque marker → suppresses the unqualified key for a SQL-looking name", () => {
    expect(tableWhitelistKeys("public.orders", { opaque: true })).toEqual(["public.orders"]);
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

  // #3317: plugin-registered ES index-pattern entities must not get the bogus
  // dotted-split key either (registerPluginEntities is one of the three paths).
  it("dotted ES index pattern → only the full-name key (plugin path)", () => {
    registerPluginEntities("es-plugin", [
      { name: "filebeat", yaml: "table: filebeat-7.10.0-*\ndimensions:\n  message:\n    type: text\n" },
    ]);

    const dir = ensureEntitiesDir(`plugin-es-pattern-${testCounter}`);
    const tables = getWhitelistedTables("es-plugin", dir);
    expect(tables.has("filebeat-7.10.0-*")).toBe(true);
    expect(tables.has("0-*")).toBe(false);
    expect(tables.size).toBe(1);
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

// ---------------------------------------------------------------------------
// Per-source semantic layer loading (merged from semantic-multisource.test.ts).
//
// The multi-source directory layout: per-source subdirectories
// (e.g. `semantic/warehouse/entities/`) auto-derive the connection ID from the
// directory name. These cases drive the `semanticRoot` parameter rather than
// the `entitiesDir` one used above.
// ---------------------------------------------------------------------------

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
    const root = ensureEntitiesDir(`multisource-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`multisource-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`multisource-${testCounter}/warehouse/entities`);

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
    const root = ensureEntitiesDir(`dirname-${testCounter}`);
    ensureEntitiesDir(`dirname-${testCounter}/entities`);
    const salesforceEntities = ensureEntitiesDir(`dirname-${testCounter}/salesforce/entities`);

    // No explicit connection field — should be inferred as "salesforce"
    writeEntity(salesforceEntities, "accounts.yml", `table: accounts\ncolumns:\n  id:\n    type: integer\n`);

    const sfTables = getWhitelistedTables("salesforce", undefined, root);
    expect(sfTables.has("accounts")).toBe(true);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("accounts")).toBe(false);
  });

  it("explicit connection field in YAML overrides directory-based inference", () => {
    const root = ensureEntitiesDir(`override-${testCounter}`);
    ensureEntitiesDir(`override-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`override-${testCounter}/warehouse/entities`);

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
    const root = ensureEntitiesDir(`compat-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`compat-${testCounter}/entities`);

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
    const root = ensureEntitiesDir(`unknown-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`unknown-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`unknown-${testCounter}/warehouse/entities`);

    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(warehouseEntities, "events.yml", `table: events\ncolumns:\n  id:\n    type: integer\n`);

    const unknownTables = getWhitelistedTables("nonexistent", undefined, root);
    expect(unknownTables.size).toBe(0);
  });

  it("reserved directories (entities, metrics) are not treated as source names", () => {
    const root = ensureEntitiesDir(`reserved-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`reserved-${testCounter}/entities`);
    ensureEntitiesDir(`reserved-${testCounter}/metrics`);

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
    const root = ensureEntitiesDir(`multi-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`multi-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`multi-${testCounter}/warehouse/entities`);
    const salesforceEntities = ensureEntitiesDir(`multi-${testCounter}/salesforce/entities`);

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
    const root = ensureEntitiesDir(`schema-${testCounter}`);
    ensureEntitiesDir(`schema-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`schema-${testCounter}/warehouse/entities`);

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
    const root = ensureEntitiesDir(`empty-${testCounter}`);
    const tables = getWhitelistedTables("default", undefined, root);
    expect(tables.size).toBe(0);
  });

  it("non-existent semantic root → empty set", () => {
    const tables = getWhitelistedTables("default", undefined, "/tmp/nonexistent-atlas-multisource-test");
    expect(tables.size).toBe(0);
  });

  it("subdirectory without entities/ subfolder is ignored", () => {
    const root = ensureEntitiesDir(`noentities-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`noentities-${testCounter}/entities`);
    // Create a subdirectory without an entities/ subfolder
    ensureEntitiesDir(`noentities-${testCounter}/warehouse`);

    writeEntity(defaultEntities, "users.yml", `table: users\ncolumns:\n  id:\n    type: integer\n`);

    // Should not crash, warehouse just has no tables
    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(defaultTables.has("users")).toBe(true);
  });

  it("same table name in default and source → correctly isolated", () => {
    const root = ensureEntitiesDir(`samename-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`samename-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`samename-${testCounter}/warehouse/entities`);

    writeEntity(defaultEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);
    writeEntity(warehouseEntities, "orders.yml", `table: orders\ncolumns:\n  id:\n    type: integer\n`);

    const defaultTables = getWhitelistedTables("default", undefined, root);
    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);

    expect(defaultTables.has("orders")).toBe(true);
    expect(warehouseTables.has("orders")).toBe(true);
    expect(defaultTables).not.toBe(warehouseTables);
  });

  it("quoted reserved-keyword table names (e.g. Postgres \"user\") are whitelisted unquoted", () => {
    // Better Auth's `user` table is a Postgres reserved keyword. Importers
    // quote it in the YAML (`table: '"user"'`) so the round-trip survives,
    // but `node-sql-parser` strips the quotes when extracting tables from
    // `FROM "user"`. The whitelist must store the unquoted form or every
    // lookup misses.
    const root = ensureEntitiesDir(`quoted-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`quoted-${testCounter}/entities`);

    writeEntity(defaultEntities, "user.yml", `table: '"user"'\ncolumns:\n  id:\n    type: text\n`);
    writeEntity(defaultEntities, "events.yml", "table: '`events`'\ncolumns:\n  id:\n    type: integer\n");
    writeEntity(
      defaultEntities,
      "audit.yml",
      `table: 'public."audit_log"'\ncolumns:\n  id:\n    type: integer\n`,
    );

    const tables = getWhitelistedTables("default", undefined, root);
    expect(tables.has("user")).toBe(true);
    expect(tables.has("events")).toBe(true);
    expect(tables.has("audit_log")).toBe(true);
    expect(tables.has("public.audit_log")).toBe(true);
    // Quoted forms must NOT survive — they'd never match parser output
    expect(tables.has('"user"')).toBe(false);
    expect(tables.has('public."audit_log"')).toBe(false);
  });

  it("reserved directories with entities/ subfolder are still excluded", () => {
    const root = ensureEntitiesDir(`reserved-strict-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`reserved-strict-${testCounter}/entities`);
    // Create metrics/entities/ — should be blocked by RESERVED_DIRS, not by missing dir
    const metricsEntities = ensureEntitiesDir(`reserved-strict-${testCounter}/metrics/entities`);

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
    const root = ensureEntitiesDir(`csj-basic-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`csj-basic-${testCounter}/entities`);

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
    const root = ensureEntitiesDir(`csj-compat-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`csj-compat-${testCounter}/entities`);

    writeEntity(defaultEntities, "orders.yml", "table: orders\ncolumns:\n  id:\n    type: integer\n");

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(0);
  });

  it("multiple cross-source joins on one entity", () => {
    const root = ensureEntitiesDir(`csj-multi-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`csj-multi-${testCounter}/entities`);

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
    const root = ensureEntitiesDir(`csj-across-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`csj-across-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`csj-across-${testCounter}/warehouse/entities`);

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
    const root = ensureEntitiesDir(`csj-explicit-${testCounter}`);
    ensureEntitiesDir(`csj-explicit-${testCounter}/entities`);
    const warehouseEntities = ensureEntitiesDir(`csj-explicit-${testCounter}/warehouse/entities`);

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
    const root = ensureEntitiesDir(`csj-invalid-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`csj-invalid-${testCounter}/entities`);

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
    const root = ensureEntitiesDir(`csj-partial-${testCounter}`);
    const defaultEntities = ensureEntitiesDir(`csj-partial-${testCounter}/entities`);

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
    const tmpRoot = ensureEntitiesDir(`csj-cache-${testCounter}`);
    const entitiesDir = ensureEntitiesDir(`csj-cache-${testCounter}/semantic/entities`);

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

    // Point the default semantic root at the fixture so getWhitelistedTables()
    // without args finds it. This used to `process.chdir(tmpRoot)`, which only
    // worked while the root resolved from cwd; ATLAS_SEMANTIC_ROOT is the
    // documented override and is what the test preload now sets (#4655).
    const originalRoot = process.env.ATLAS_SEMANTIC_ROOT;
    process.env.ATLAS_SEMANTIC_ROOT = join(tmpRoot, "semantic");
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
      if (originalRoot === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
      else process.env.ATLAS_SEMANTIC_ROOT = originalRoot;
    }
  });
});
