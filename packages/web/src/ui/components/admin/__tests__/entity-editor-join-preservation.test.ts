/**
 * The entity editor's read-modify-write must not delete joins it cannot draw
 * (#5402).
 *
 * The dialog renders a join as `name` + `sql`, both required. The semantic
 * layer's own generator writes joins as `target_entity` / `relationship` /
 * `join_columns` — no `name`, no `sql`. Mapping one of those into the form
 * produced `{ name: "", sql: "" }`, which fails the form's own `.min(1)`, so the
 * operator could not save the entity AT ALL; and if they somehow did, the
 * relationship join was gone.
 *
 * Fix: joins this form cannot represent bypass the form (`preserved_joins`) and
 * are re-emitted verbatim. These tests drive the two pure converters directly —
 * they are where the loss happened, and they need no DOM.
 */

import { describe, test, expect } from "bun:test";
import {
  entityToFormValues,
  formValuesToEntityBody,
} from "../entity-editor-dialog";
import type { EntityData } from "@/ui/lib/types";

/** The dogfood `organization` entity's joins, as the layer stores them. */
const RELATIONSHIP_JOIN = {
  target_entity: "User",
  relationship: "one_to_many",
  join_columns: { from: "id", to: "organization_id" },
  description: "Each organization has many users",
};

const SQL_JOIN = {
  name: "to_orders",
  sql: "organization.id = orders.organization_id",
  description: "Organization orders",
};

const entity = (joins: unknown[]): EntityData =>
  ({
    name: "organization",
    table: "organization",
    description: "Atlas customer organizations.",
    dimensions: [{ name: "id", sql: "id", type: "string" }],
    joins,
  }) as unknown as EntityData;

describe("entity editor join round-trip (#5402)", () => {
  test("a relationship-shaped join is parked, not mapped into an unsaveable row", () => {
    const values = entityToFormValues(entity([RELATIONSHIP_JOIN]));
    // ⚠️ The empty-row assertion is the one that matters: `{ name: "", sql: "" }`
    // is what made the form unsaveable, and it looked like a rendered join.
    expect(values.joins).toEqual([]);
    expect(values.preserved_joins).toEqual([RELATIONSHIP_JOIN]);
  });

  test("an editable join still reaches the form", () => {
    const values = entityToFormValues(entity([SQL_JOIN]));
    expect(values.joins).toEqual([
      { name: "to_orders", sql: "organization.id = orders.organization_id", description: "Organization orders" },
    ]);
    expect(values.preserved_joins).toEqual([]);
  });

  test("a save re-emits the parked join verbatim alongside the edited ones", () => {
    const values = entityToFormValues(entity([RELATIONSHIP_JOIN, SQL_JOIN]));
    const body = formValuesToEntityBody(values);
    expect(body.joins).toEqual([RELATIONSHIP_JOIN, {
      name: "to_orders",
      sql: "organization.id = orders.organization_id",
      description: "Organization orders",
    }]);
  });

  test("an entity with only unrenderable joins still sends them — never an empty array", () => {
    // ⚠️ `joins: []` is a DELETION to the route (absent preserves, empty
    // clears), so emitting one here would re-open the bug from the FE side even
    // with the backend fixed.
    const body = formValuesToEntityBody(entityToFormValues(entity([RELATIONSHIP_JOIN])));
    expect(body.joins).toEqual([RELATIONSHIP_JOIN]);
  });

  test("legacy `to`/`on` joins are still treated as editable", () => {
    // The converter's back-compat path predates this change and must survive it.
    const values = entityToFormValues(
      entity([{ to: "orders", on: "organization.id = orders.organization_id" }]),
    );
    expect(values.joins).toHaveLength(1);
    expect(values.joins?.[0]?.name).toBe("orders");
    expect(values.preserved_joins).toEqual([]);
  });
});
