/**
 * Pins the click → drawer routing predicate (#2461). Catches regressions
 * where a refactor silently drops one of the drift states or breaks the
 * multi-environment match-key.
 */

import { describe, expect, test } from "bun:test";
import { driftDrawerTargetFor } from "../drift-routing";

const entities = [
  { name: "orders", connectionGroupId: null, drift: { state: "changed" as const, changeCount: 2 } },
  { name: "users", connectionGroupId: null, drift: { state: "in-sync" as const } },
  { name: "legacy", connectionGroupId: null, drift: { state: "removed" as const } },
  { name: "dbonly", connectionGroupId: null, drift: { state: "new" as const } },
  { name: "no_drift_data", connectionGroupId: null, drift: null },
  { name: "orders", connectionGroupId: "g_prod", drift: { state: "changed" as const, changeCount: 1 } },
];

describe("driftDrawerTargetFor", () => {
  test("returns the entity name for a `changed` row", () => {
    expect(
      driftDrawerTargetFor({ type: "entity", name: "orders" }, entities),
    ).toBe("orders");
  });

  test("returns the entity name for a `removed` row", () => {
    expect(
      driftDrawerTargetFor({ type: "entity", name: "legacy" }, entities),
    ).toBe("legacy");
  });

  test("returns the entity name for a `new` row (DB-only, future-proofs the predicate)", () => {
    expect(
      driftDrawerTargetFor({ type: "entity", name: "dbonly" }, entities),
    ).toBe("dbonly");
  });

  test("returns null for an `in-sync` row — the drawer must not open", () => {
    expect(
      driftDrawerTargetFor({ type: "entity", name: "users" }, entities),
    ).toBeNull();
  });

  test("returns null when the entity has no drift signal at all", () => {
    expect(
      driftDrawerTargetFor({ type: "entity", name: "no_drift_data" }, entities),
    ).toBeNull();
  });

  test("returns null when the entity is unknown", () => {
    expect(
      driftDrawerTargetFor({ type: "entity", name: "ghost" }, entities),
    ).toBeNull();
  });

  test("returns null for non-entity selections (catalog / glossary / metrics / null)", () => {
    expect(driftDrawerTargetFor(null, entities)).toBeNull();
    expect(driftDrawerTargetFor({ type: "catalog" }, entities)).toBeNull();
    expect(driftDrawerTargetFor({ type: "glossary" }, entities)).toBeNull();
    expect(driftDrawerTargetFor({ type: "metrics", file: "mrr" }, entities)).toBeNull();
  });

  test("disambiguates by connectionGroupId — same name, different group", () => {
    // Selecting the `g_prod` row should resolve to the prod drift row, not
    // the legacy / null-group one. Both happen to be `changed`, so the
    // negative test is "selecting `g_prod` doesn't fall back to the null
    // row by name alone".
    expect(
      driftDrawerTargetFor(
        { type: "entity", name: "orders", connectionGroupId: "g_prod" },
        entities,
      ),
    ).toBe("orders");
  });

  test("connectionGroupId mismatch returns null even when the name is in another group", () => {
    expect(
      driftDrawerTargetFor(
        { type: "entity", name: "orders", connectionGroupId: "g_stage" },
        entities,
      ),
    ).toBeNull();
  });

  test("undefined connectionGroupId on the selection matches the null-group row", () => {
    // Mirrors `isSelected` in the file tree — `null` and `undefined` both
    // mean "no group qualifier", so unqualified clicks resolve to the
    // legacy / unscoped row rather than dropping through.
    expect(
      driftDrawerTargetFor({ type: "entity", name: "orders" }, entities),
    ).toBe("orders");
  });
});
