/**
 * Unit tests for the PURE anchor resolver (#4519, PRD #4502).
 *
 * `resolveBriefingAnchor` maps a wire `ImproveAnchor` onto the rendered
 * `BriefingAnchor` the briefing front-loads, using only the entities + profiles
 * the loader already has — no I/O. These tests pin the load-bearing behaviors:
 * group filtering + inventory shape, entity match → YAML + profile, group
 * disambiguation, and the not-found → null contract.
 */

import { describe, it, expect } from "bun:test";
import { resolveBriefingAnchor } from "../anchor";
import type { ParsedEntity } from "../types";
import type { ColumnProfile, TableProfile } from "@useatlas/types";

function col(name: string): ColumnProfile {
  return {
    name,
    type: "text",
    nullable: true,
    unique_count: null,
    null_count: null,
    sample_values: [],
    is_primary_key: false,
    is_foreign_key: false,
    fk_target_table: null,
    fk_target_column: null,
    is_enum_like: false,
    profiler_notes: [],
  };
}

function entity(overrides: Partial<ParsedEntity> = {}): ParsedEntity {
  return {
    name: "orders",
    table: "orders",
    description: "Order records",
    dimensions: [
      { name: "id", sql: "id", type: "number" },
      { name: "status", sql: "status", type: "string" },
    ],
    measures: [{ name: "count", sql: "COUNT(*)", type: "count" }],
    joins: [{ name: "customer", sql: "customer_id = customers.id" }],
    query_patterns: [],
    ...overrides,
  };
}

function profile(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    table_name: "orders",
    object_type: "table",
    row_count: 1234567,
    columns: [col("id"), col("status")],
    primary_key_columns: ["id"],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

describe("resolveBriefingAnchor — group", () => {
  it("filters to the anchored group and builds a sorted inventory with coverage counts", () => {
    const entities = [
      entity({ name: "orders", table: "orders", connection: "prod" }),
      entity({ name: "customers", table: "customers", connection: "prod", measures: [], joins: [] }),
      entity({ name: "events", table: "events", connection: "analytics" }),
    ];
    const anchor = resolveBriefingAnchor({ kind: "group", group: "prod" }, entities, []);
    expect(anchor).not.toBeNull();
    if (anchor?.kind !== "group") throw new Error("expected a group anchor");
    expect(anchor.group).toBe("prod");
    // Only the two `prod` entities, sorted by name (customers before orders).
    expect(anchor.entities.map((e) => e.name)).toEqual(["customers", "orders"]);
    const orders = anchor.entities.find((e) => e.name === "orders");
    expect(orders).toMatchObject({ table: "orders", dimensionCount: 2, measureCount: 1, joinCount: 1 });
  });

  it("resolves the flat `default` group from entities with no group/connection", () => {
    const entities = [entity({ name: "orders", connection: undefined, group: undefined })];
    const anchor = resolveBriefingAnchor({ kind: "group", group: "default" }, entities, []);
    if (anchor?.kind !== "group") throw new Error("expected a group anchor");
    expect(anchor.entities.map((e) => e.name)).toEqual(["orders"]);
  });

  it("returns an empty inventory (never null) for a group with no entities", () => {
    const anchor = resolveBriefingAnchor({ kind: "group", group: "empty" }, [entity()], []);
    if (anchor?.kind !== "group") throw new Error("expected a group anchor");
    expect(anchor.entities).toEqual([]);
  });
});

describe("resolveBriefingAnchor — entity", () => {
  it("front-loads the entity's YAML and its matching table profile", () => {
    const entities = [entity({ name: "orders", table: "orders", connection: "prod" })];
    const anchor = resolveBriefingAnchor({ kind: "entity", entity: "orders" }, entities, [profile()]);
    if (anchor?.kind !== "entity") throw new Error("expected an entity anchor");
    expect(anchor.entity).toBe("orders");
    expect(anchor.group).toBe("prod");
    // YAML carries the entity's structure.
    expect(anchor.yaml).toContain("name: orders");
    expect(anchor.yaml).toContain("table: orders");
    expect(anchor.yaml).toContain("description: Order records");
    expect(anchor.yaml).toContain("dimensions:");
    // Profile summary from the matching TableProfile.
    expect(anchor.profile).toEqual({ table: "orders", rowCount: 1234567, columnCount: 2 });
  });

  it("resolves with a null profile when no tracked profile matches the table", () => {
    const anchor = resolveBriefingAnchor({ kind: "entity", entity: "orders" }, [entity()], []);
    if (anchor?.kind !== "entity") throw new Error("expected an entity anchor");
    expect(anchor.profile).toBeNull();
  });

  it("disambiguates by group when the same entity name spans groups", () => {
    const entities = [
      entity({ name: "orders", table: "orders_us", connection: "us" }),
      entity({ name: "orders", table: "orders_eu", connection: "eu" }),
    ];
    const anchor = resolveBriefingAnchor({ kind: "entity", entity: "orders", group: "eu" }, entities, []);
    if (anchor?.kind !== "entity") throw new Error("expected an entity anchor");
    expect(anchor.group).toBe("eu");
    expect(anchor.yaml).toContain("table: orders_eu");
  });

  it("returns null when the anchored entity is not in scope (starts unanchored)", () => {
    const anchor = resolveBriefingAnchor({ kind: "entity", entity: "ghost" }, [entity()], []);
    expect(anchor).toBeNull();
  });
});
