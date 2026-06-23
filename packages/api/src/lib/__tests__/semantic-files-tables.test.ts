/**
 * Tests for discoverTables() in semantic-files.ts.
 *
 * Uses temp directories with entity YAMLs to test table discovery with
 * column details, covering both array and object-map dimension formats.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { discoverTables } from "../semantic/files";

const tmpBase = resolve(__dirname, ".tmp-tables-test");
let counter = 0;

function makeRoot(suffix: string): string {
  counter++;
  const root = resolve(tmpBase, `${suffix}-${counter}`);
  mkdirSync(resolve(root, "entities"), { recursive: true });
  return root;
}

function writeEntity(root: string, name: string, content: string, source?: string): void {
  const dir = source
    ? resolve(root, source, "entities")
    : resolve(root, "entities");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.yml`), content);
}

afterEach(() => {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

describe("discoverTables", () => {
  it("discovers entities with object-map dimensions", () => {
    const root = makeRoot("obj-map");
    writeEntity(root, "users", [
      "table: users",
      "description: Application users",
      "dimensions:",
      "  id:",
      "    type: number",
      "    description: Primary key",
      "  email:",
      "    type: string",
      "    description: User email address",
    ].join("\n"));

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("users");
    expect(tables[0].description).toBe("Application users");
    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].columns[0]).toEqual({ name: "id", type: "number", description: "Primary key" });
    expect(tables[0].columns[1]).toEqual({ name: "email", type: "string", description: "User email address" });
  });

  it("discovers entities with array-format dimensions", () => {
    const root = makeRoot("arr-fmt");
    writeEntity(root, "orders", [
      "table: orders",
      "description: Customer orders",
      "dimensions:",
      "  - name: id",
      "    type: number",
      "    description: Order ID",
      "  - name: created_at",
      "    type: timestamp",
      "    description: Order date",
    ].join("\n"));

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("orders");
    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].columns[0]).toEqual({ name: "id", type: "number", description: "Order ID" });
    expect(tables[0].columns[1]).toEqual({ name: "created_at", type: "timestamp", description: "Order date" });
  });

  it("discovers entities from per-source subdirectories", () => {
    const root = makeRoot("multi-src");
    writeEntity(root, "users", "table: users\ndescription: Default users\ndimensions:\n  id:\n    type: number\n    description: PK\n");
    writeEntity(root, "events", "table: events\ndescription: Warehouse events\ndimensions:\n  id:\n    type: number\n    description: Event ID\n", "warehouse");

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(2);
    const names = tables.map((t) => t.table).sort();
    expect(names).toEqual(["events", "users"]);
  });

  it("returns empty columns for entities with no dimensions", () => {
    const root = makeRoot("no-dims");
    writeEntity(root, "settings", "table: settings\ndescription: App settings\n");

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("settings");
    expect(tables[0].columns).toEqual([]);
  });

  it("skips entities with missing table field and emits warning", () => {
    const root = makeRoot("no-table");
    writeEntity(root, "bad", "description: no table field\ndimensions:\n  id:\n    type: number\n");
    writeEntity(root, "good", "table: good_table\ndescription: Valid\n");

    const { tables, warnings } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("good_table");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/missing required 'table' field:.*bad\.yml/);
  });

  it("skips malformed YAML files without crashing", () => {
    const root = makeRoot("malformed");
    writeEntity(root, "bad", "{{{not valid yaml");
    writeEntity(root, "good", "table: valid\ndescription: Valid table\n");

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("valid");
  });

  it("returns warnings for malformed YAML files", () => {
    const root = makeRoot("warn-malformed");
    writeEntity(root, "broken", "{{{not valid yaml");
    writeEntity(root, "good", "table: good_table\ndescription: Valid\n");

    const { tables, warnings } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("good_table");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Failed to parse entity:.*broken\.yml/);
  });

  it("returns no warnings when all files parse successfully", () => {
    const root = makeRoot("no-warnings");
    writeEntity(root, "ok", "table: ok_table\ndescription: Fine\n");

    const { tables, warnings } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("returns warnings for malformed YAML in per-source subdirectory", () => {
    const root = makeRoot("sub-warn");
    writeEntity(root, "ok", "table: ok_table\ndescription: Fine\n");
    writeEntity(root, "bad", "{{{not valid yaml", "warehouse");

    const { tables, warnings } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe("ok_table");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Failed to parse entity:.*bad\.yml/);
  });

  it("returns empty array and no warnings for non-existent root", () => {
    const { tables, warnings } = discoverTables("/tmp/nonexistent-atlas-tables-test");
    expect(tables).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("returns empty array and no warnings for empty entities directory", () => {
    const root = makeRoot("empty");
    const { tables, warnings } = discoverTables(root);
    expect(tables).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("defaults missing type to 'string' and missing description to ''", () => {
    const root = makeRoot("defaults");
    writeEntity(root, "bare", [
      "table: bare_table",
      "dimensions:",
      "  status:",
    ].join("\n"));

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].columns).toHaveLength(1);
    expect(tables[0].columns[0]).toEqual({ name: "status", type: "string", description: "" });
  });

  it("skips array dimensions without a name property", () => {
    const root = makeRoot("arr-no-name");
    writeEntity(root, "partial", [
      "table: partial",
      "dimensions:",
      "  - type: number",
      "    description: No name",
      "  - name: valid_col",
      "    type: string",
      "    description: Has name",
    ].join("\n"));

    const { tables } = discoverTables(root);
    expect(tables).toHaveLength(1);
    expect(tables[0].columns).toHaveLength(1);
    expect(tables[0].columns[0].name).toBe("valid_col");
  });

  // #3898 — when an `allowed` whitelist set is passed, the discovered list must
  // be filtered to exactly the tables that set permits, so `/tables` advertises
  // the SAME set validate-sql / executeSQL enforce.
  describe("allowed-whitelist filter (#3898)", () => {
    it("keeps only tables present in the allowed set", () => {
      const root = makeRoot("filter-basic");
      writeEntity(root, "payments", "table: payments\ndescription: pay\ndimensions:\n  id:\n    type: number\n");
      writeEntity(root, "orders", "table: orders\ndescription: ord\ndimensions:\n  id:\n    type: number\n");

      const { tables } = discoverTables(root, new Set(["orders"]));
      expect(tables.map((t) => t.table)).toEqual(["orders"]);
    });

    it("returns every table when no allowed set is passed (back-compat / whitelist-disabled)", () => {
      const root = makeRoot("filter-none");
      writeEntity(root, "payments", "table: payments\ndescription: pay\n");
      writeEntity(root, "orders", "table: orders\ndescription: ord\n");

      const { tables } = discoverTables(root);
      expect(tables.map((t) => t.table).sort()).toEqual(["orders", "payments"]);
    });

    it("returns no tables when the allowed set is empty (deny-all)", () => {
      const root = makeRoot("filter-empty");
      writeEntity(root, "payments", "table: payments\ndescription: pay\n");

      const { tables } = discoverTables(root, new Set());
      expect(tables).toEqual([]);
    });

    it("matches a schema-qualified entity table by its unqualified whitelist key", () => {
      // The whitelist registers both `public.orders` and the bare `orders` for a
      // SQL identifier; a discovered `public.orders` must match an allowed set
      // that carries either key.
      const root = makeRoot("filter-qualified");
      writeEntity(root, "orders", "table: public.orders\ndescription: ord\n");

      expect(discoverTables(root, new Set(["orders"])).tables.map((t) => t.table)).toEqual(["public.orders"]);
      expect(discoverTables(root, new Set(["public.orders"])).tables.map((t) => t.table)).toEqual(["public.orders"]);
    });

    it("matches an opaque (Elasticsearch) identifier only by its full name, not a dot-split fragment", () => {
      const root = makeRoot("filter-opaque");
      writeEntity(root, "logs", "table: logs-nginx.access-default\nidentifier_style: opaque\ndescription: es\n");

      // Full opaque name is allowed → included.
      expect(
        discoverTables(root, new Set(["logs-nginx.access-default"])).tables.map((t) => t.table),
      ).toEqual(["logs-nginx.access-default"]);
      // A dot-split fragment must NOT match an opaque identifier.
      expect(discoverTables(root, new Set(["access-default"])).tables).toEqual([]);
    });
  });
});
