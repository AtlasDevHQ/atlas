import { describe, it, expect } from "bun:test";
import {
  mergeAdminEntities,
  parseRowToAdminSummary,
  type AdminEntitySummary,
} from "../admin-source";
import type { SemanticEntityRow } from "../entities";
import type { EntitySummary } from "../files";

const dbRow = (over: Partial<SemanticEntityRow> & Pick<SemanticEntityRow, "name" | "yaml_content">): SemanticEntityRow => ({
  id: over.id ?? `row-${over.name}`,
  org_id: over.org_id ?? "org-1",
  entity_type: over.entity_type ?? "entity",
  name: over.name,
  yaml_content: over.yaml_content,
  connection_id: over.connection_id ?? null,
  connection_group_id: over.connection_group_id ?? null,
  status: over.status ?? "published",
  created_at: over.created_at ?? "2026-01-01",
  updated_at: over.updated_at ?? "2026-01-02",
});

const diskSummary = (over: Partial<EntitySummary> & Pick<EntitySummary, "table">): EntitySummary => ({
  table: over.table,
  description: over.description ?? "",
  columnCount: over.columnCount ?? 0,
  joinCount: over.joinCount ?? 0,
  measureCount: over.measureCount ?? 0,
  connection: over.connection ?? null,
  type: over.type ?? null,
  source: over.source ?? "default",
});

describe("parseRowToAdminSummary", () => {
  it("projects a valid DB row to the admin summary shape with parsed YAML counts", () => {
    const row = dbRow({
      name: "users",
      connection_id: "warehouse",
      status: "draft",
      updated_at: "2026-03-01T00:00:00Z",
      yaml_content: `
table: users
description: User accounts
dimensions:
  id:
    type: integer
  email:
    type: string
joins:
  - name: to_orders
    sql: users.id = orders.user_id
measures:
  - name: count_users
    sql: COUNT(*)
`,
    });

    const summary = parseRowToAdminSummary(row);
    expect(summary).not.toBeNull();
    expect(summary).toEqual({
      name: "users",
      table: "users",
      description: "User accounts",
      columnCount: 2,
      joinCount: 1,
      measureCount: 1,
      connection: null,
      type: null,
      source: "warehouse",
      status: "draft",
      sourceKind: "db",
      connectionId: "warehouse",
      connectionGroupId: null,
      updatedAt: "2026-03-01T00:00:00Z",
    } satisfies AdminEntitySummary);
  });

  it("uses the entity's `name` field when distinct from `table`", () => {
    const row = dbRow({
      name: "user_accounts",
      yaml_content: "table: users\nname: user_accounts\n",
    });
    expect(parseRowToAdminSummary(row)?.name).toBe("user_accounts");
    expect(parseRowToAdminSummary(row)?.table).toBe("users");
  });

  it("falls back to the row name when the YAML has no `name` field", () => {
    const row = dbRow({ name: "orders", yaml_content: "table: orders\n" });
    expect(parseRowToAdminSummary(row)?.name).toBe("orders");
  });

  it("returns null and skips rows with unparseable YAML", () => {
    const row = dbRow({ name: "broken", yaml_content: 'table: "broken\n  : {{' });
    expect(parseRowToAdminSummary(row)).toBeNull();
  });

  it("returns null when YAML doesn't include a table field", () => {
    const row = dbRow({ name: "no_table", yaml_content: "description: nothing\n" });
    expect(parseRowToAdminSummary(row)).toBeNull();
  });

  it("returns null when YAML parses to a non-object", () => {
    for (const yaml of ["", "- one\n- two\n", "just a string", "null\n"]) {
      const row = dbRow({ name: "bad_shape", yaml_content: yaml });
      expect(parseRowToAdminSummary(row)).toBeNull();
    }
  });

  it("labels source as 'default' when connection_id is null", () => {
    const row = dbRow({ name: "kpi_terms", connection_id: null, yaml_content: "table: kpi_terms\n" });
    expect(parseRowToAdminSummary(row)?.source).toBe("default");
  });

  it("carries the YAML `connection:` hint independent of `connection_id`", () => {
    // The two columns are intentionally distinct: `connection_id` is the FK
    // the SQL whitelist routes by; `connection:` is the YAML-authored hint.
    // Conflating them would mask cross-source joins.
    const row = dbRow({
      name: "orders",
      connection_id: null,
      yaml_content: "table: orders\nconnection: warehouse\n",
    });
    const summary = parseRowToAdminSummary(row);
    expect(summary?.connection).toBe("warehouse");
    expect(summary?.connectionId).toBeNull();
  });

  it("carries the YAML `type:` field through to the summary", () => {
    const row = dbRow({
      name: "mrr",
      yaml_content: "table: subscription_events\ntype: metric\n",
    });
    expect(parseRowToAdminSummary(row)?.type).toBe("metric");
  });

  it("counts dimensions when authored as an array (not just an object map)", () => {
    const row = dbRow({
      name: "u",
      yaml_content: `
table: u
dimensions:
  - name: id
    type: integer
  - name: email
    type: string
`,
    });
    expect(parseRowToAdminSummary(row)?.columnCount).toBe(2);
  });
});

describe("mergeAdminEntities", () => {
  it("returns disk entries with status='published' and sourceKind='disk' when there are no DB rows", () => {
    const result = mergeAdminEntities({
      dbRows: [],
      diskEntities: [
        diskSummary({ table: "companies", description: "Customers", columnCount: 3, source: "default" }),
        diskSummary({ table: "orders", source: "warehouse", connection: "warehouse", joinCount: 1 }),
      ],
      diskWarnings: [],
    });

    expect(result.entities).toHaveLength(2);
    const companies = result.entities.find((e) => e.table === "companies");
    expect(companies?.status).toBe("published");
    expect(companies?.sourceKind).toBe("disk");
    expect(companies?.columnCount).toBe(3);
    expect(companies?.source).toBe("default");

    const orders = result.entities.find((e) => e.table === "orders");
    expect(orders?.connection).toBe("warehouse");
    expect(orders?.source).toBe("warehouse");
    expect(orders?.joinCount).toBe(1);
  });

  it("returns DB-row summaries with the full strict shape when DB has rows and disk is empty", () => {
    const result = mergeAdminEntities({
      dbRows: [
        dbRow({
          name: "users",
          status: "published",
          yaml_content: "table: users\ndescription: From DB\n",
        }),
      ],
      diskEntities: [],
      diskWarnings: [],
    });

    expect(result.entities).toHaveLength(1);
    // Strict equality so a future field growth on the projector trips
    // every consumer of the shape, not just `toMatchObject` subsets.
    expect(result.entities[0]).toEqual({
      name: "users",
      table: "users",
      description: "From DB",
      columnCount: 0,
      joinCount: 0,
      measureCount: 0,
      connection: null,
      type: null,
      source: "default",
      status: "published",
      sourceKind: "db",
      connectionId: null,
      connectionGroupId: null,
      updatedAt: "2026-01-02",
    } satisfies AdminEntitySummary);
  });

  it("DB row shadows disk entity when their summary `name` matches", () => {
    const result = mergeAdminEntities({
      dbRows: [
        dbRow({
          name: "users",
          status: "draft",
          yaml_content: "table: users\ndescription: From DB draft\n",
        }),
      ],
      diskEntities: [
        diskSummary({ table: "users", description: "From disk", source: "default" }),
      ],
      diskWarnings: [],
    });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].sourceKind).toBe("db");
    expect(result.entities[0].status).toBe("draft");
    expect(result.entities[0].description).toBe("From DB draft");
  });

  it("dedup key is summary `name`, not DB row `name` — divergent names produce two entries", () => {
    // A DB row with display name "user_accounts" over `table: users` and a
    // disk entity with `table: users` are genuinely different things and
    // should both appear. Collapsing them would hide one from the file tree.
    const result = mergeAdminEntities({
      dbRows: [
        dbRow({
          name: "user_accounts",
          yaml_content: "table: users\nname: user_accounts\n",
        }),
      ],
      diskEntities: [
        diskSummary({ table: "users", description: "Disk users" }),
      ],
      diskWarnings: [],
    });

    expect(result.entities).toHaveLength(2);
    expect(result.entities.map((e) => e.name).toSorted()).toEqual(["user_accounts", "users"]);
  });

  it("merges non-overlapping DB + disk rows into the same sorted list", () => {
    const result = mergeAdminEntities({
      dbRows: [
        dbRow({ name: "users", yaml_content: "table: users\n" }),
        dbRow({ name: "events", status: "draft", yaml_content: "table: events\n" }),
      ],
      diskEntities: [
        diskSummary({ table: "orders" }),
        diskSummary({ table: "companies" }),
      ],
      diskWarnings: [],
    });

    expect(result.entities.map((e) => e.name)).toEqual([
      "companies",
      "events",
      "orders",
      "users",
    ]);
  });

  it("preserves disk warnings unchanged so the route can surface them", () => {
    const result = mergeAdminEntities({
      dbRows: [],
      diskEntities: [],
      diskWarnings: ["entities/broken.yml: missing table field"],
    });
    expect(result.warnings).toEqual(["entities/broken.yml: missing table field"]);
  });

  it("drops DB rows that fail YAML/shape validation (logged at warn upstream)", () => {
    const result = mergeAdminEntities({
      dbRows: [
        dbRow({ name: "ok", yaml_content: "table: ok\n" }),
        dbRow({ name: "bad", yaml_content: "{{{ not yaml" }),
        dbRow({ name: "no_table", yaml_content: "description: nothing\n" }),
      ],
      diskEntities: [],
      diskWarnings: [],
    });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("ok");
  });
});
