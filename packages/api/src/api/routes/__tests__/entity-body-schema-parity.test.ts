/**
 * Parity guard: the structured editor's body schema vs the semantic layer's own
 * entity shape (#5402).
 *
 * ## The class this closes
 *
 * `EntityShape` (`lib/semantic/shapes.ts`) is what the LAYER says an entity is.
 * `EntityBodySchema` (`routes/admin-semantic.ts`) is what the EDITOR — the
 * surface the admin UI writes through — can represent. They are two lists that
 * must agree, and until this file nothing checked that they did.
 *
 * They diverged the first time it was possible to diverge. `v0.2.16` added
 * `filter` to `EntityShape` and the warehouse producer (#5329); the editor never
 * learned it, and because `EntityBodySchema` is a plain `z.object` (not
 * `.passthrough()`), a structured PUT stripped it at validation — no 400, no
 * warning. Measured on the real dogfood `organization` entity, the same write
 * also dropped `type`, `grain`, six `use_cases`, and `virtual: true` on four
 * dimensions.
 *
 * ⚠️ **THIS GUARD IS THE POINT, not the round-trip test beside it.** A lossless
 * round-trip test proves today's document survives; it says nothing about the
 * NEXT entity-level key, which would go in exactly the way `filter` did and pass
 * every existing test. This file fails the moment the two lists disagree and
 * names the key that diverged.
 *
 * ## Why an allowlist rather than "every key must be in the body"
 *
 * Two of `EntityShape`'s keys are deliberately NOT body fields, and an
 * exclusion with a stated reason is the only honest way to say so. An
 * unexplained exclusion is how a guard stops meaning anything, so each entry
 * below carries its reason and the test asserts the reason is non-empty.
 */

import { describe, it, expect } from "bun:test";
import { EntityShape } from "@atlas/api/lib/semantic/shapes";
import {
  ENTITY_YAML_KEYS,
  ENTITY_YAML_DIMENSION_KEYS,
} from "@useatlas/schemas/semantic-entity-yaml";
import {
  EntityBodySchema,
  CARRIED_ENTITY_KEYS,
  EDITOR_MANAGED_ENTITY_KEYS,
} from "@atlas/api/api/routes/admin-semantic";

/**
 * `EntityShape` keys the editor body deliberately does not carry, each with the
 * reason it is unrepresentable rather than merely missing.
 *
 * ⚠️ Adding an entry here is a DECISION, not a way to quiet the guard. If the
 * reason is "we haven't got to it yet", the correct move is to add the field to
 * `EntityBodySchema` — that is a one-line change and the whole reason this guard
 * points at a schema rather than at a doc.
 */
const DELIBERATELY_NOT_IN_BODY: Record<string, string> = {
  group:
    "Scope, not content. The row's group is carried by `connectionGroupId` " +
    "(or resolved from `connectionId`) and written by `upsertDraftEntityForGroup` " +
    "— a `group:` key in the body could disagree with the row it lands in (#2412, #3854).",
  connection:
    "The deprecated alias of `group` (ADR-0012). Still parsed on read for " +
    "back-compat; offering it as a NEW write path would mint documents in the " +
    "vocabulary the layer is migrating off.",
};

/** Declared (non-passthrough) keys of a zod object schema. */
function declaredKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

describe("EntityBodySchema ↔ EntityShape parity (#5402)", () => {
  const layerKeys = declaredKeys(EntityShape);
  const bodyKeys = new Set(declaredKeys(EntityBodySchema));

  // VACUITY FLOOR. A guard whose product is the negative "nothing diverged"
  // must not emit it after enumerating nothing — `.shape` moving or being
  // renamed by a zod upgrade would otherwise turn this file permanently green.
  it("enumerates a non-empty key set from both schemas", () => {
    expect(layerKeys.length).toBeGreaterThan(3);
    expect(bodyKeys.size).toBeGreaterThan(3);
    expect(layerKeys).toContain("table");
    expect(bodyKeys.has("table")).toBe(true);
  });

  it("every key the layer declares is either representable in the editor body or excluded with a stated reason", () => {
    const undeclared = layerKeys.filter(
      (key) => !bodyKeys.has(key) && !(key in DELIBERATELY_NOT_IN_BODY),
    );
    expect(undeclared).toEqual([]);
  });

  it("carries `filter` — the key whose divergence surfaced this guard", () => {
    // Named on its own rather than left to the loop above: `filter` is the
    // measured instance, and a regression on it specifically should say so.
    expect(layerKeys).toContain("filter");
    expect(bodyKeys.has("filter")).toBe(true);
  });

  it("every exclusion states a reason", () => {
    for (const [key, reason] of Object.entries(DELIBERATELY_NOT_IN_BODY)) {
      expect(reason.length).toBeGreaterThan(20);
      // An exclusion for a key the layer no longer declares is stale — it would
      // sit here excusing a divergence that no longer exists, and quietly excuse
      // a future key that reuses the name.
      expect(layerKeys).toContain(key);
    }
  });

  it("accepts an entity-level `filter` instead of stripping it", () => {
    const parsed = EntityBodySchema.parse({
      table: "organization",
      filter: "deleted_at IS NULL",
    });
    expect(parsed.filter).toBe("deleted_at IS NULL");
  });
});

/**
 * ⚠️ `EntityShape` is `.passthrough()` and declares only five keys, so the axis
 * above covers exactly one path — a key added to that `z.object`, as `filter`
 * was. It says nothing about `type`, `grain`, `use_cases`, or any DIMENSION key.
 *
 * The shared entity-YAML vocabulary contract is the second enumerable anchor
 * (`@useatlas/schemas/semantic-entity-yaml`, #3628). It is the list both YAML
 * renderers must speak, so a key there that the editor cannot represent is the
 * same divergence one level down.
 *
 * Honest limit, stated rather than papered over: `grain` and `use_cases` are
 * declared only in `ParsedEntity`, a TypeScript interface in `search.ts`, which
 * is not enumerable at runtime. Nothing here can guard them. They are held by
 * the round-trip test in `admin.test.ts` and — structurally — by preservation,
 * which carries any key regardless of whether a list knows its name.
 */
describe("EntityBodySchema ↔ shared entity-YAML vocabulary (#5402)", () => {
  const bodyKeys = new Set(declaredKeys(EntityBodySchema));
  const dimensionKeys = new Set(
    declaredKeys(EntityBodySchema.shape.dimensions.unwrap().element),
  );

  it("enumerates a non-empty dimension key set", () => {
    expect(dimensionKeys.size).toBeGreaterThan(4);
    expect(dimensionKeys.has("name")).toBe(true);
  });

  it("every shared top-level key is representable in the editor body", () => {
    // `name` is excluded: it is the row key in the URL path, not a body field.
    const shared = Object.values(ENTITY_YAML_KEYS).filter((k) => k !== ENTITY_YAML_KEYS.name);
    expect(shared.filter((k) => !bodyKeys.has(k))).toEqual([]);
  });

  it("every shared dimension key is representable in the editor's DimensionSchema", () => {
    const shared = Object.values(ENTITY_YAML_DIMENSION_KEYS);
    expect(shared.filter((k) => !dimensionKeys.has(k))).toEqual([]);
  });

  it("carries `virtual` — the dimension key whose loss is a false statement", () => {
    // Not covered by either vocabulary above (it is not in the shared contract),
    // so it is asserted by name. Losing it makes the layer claim a CASE
    // expression is a real column.
    expect(dimensionKeys.has("virtual")).toBe(true);
  });
});

/**
 * The editor's own internal lists must agree with the body it accepts.
 *
 * ⚠️ A key can be accepted on the wire and still dropped on the floor: being in
 * `EDITOR_MANAGED_ENTITY_KEYS` excludes it from the preservation sweep, and
 * only `CARRIED_ENTITY_KEYS` causes it to be WRITTEN. A field added to
 * `EntityBodySchema` and to neither list would validate, be excluded from
 * nothing, and quietly never appear — a fresh instance of #5402 that the
 * `EntityShape` axis cannot see, because it is entirely inside this route.
 */
describe("EntityBodySchema ↔ the editor's own managed-key lists (#5402)", () => {
  // Scope inputs, not document content — they never reach the YAML.
  const SCOPE_FIELDS = new Set(["connectionId", "connectionGroupId"]);
  const contentFields = declaredKeys(EntityBodySchema).filter((k) => !SCOPE_FIELDS.has(k));

  it("every content field of the body is a managed key", () => {
    const managed = new Set<string>(EDITOR_MANAGED_ENTITY_KEYS);
    expect(contentFields.filter((k) => !managed.has(k))).toEqual([]);
  });

  it("every carried key is a field the body actually accepts", () => {
    const bodyKeys = new Set(declaredKeys(EntityBodySchema));
    expect(CARRIED_ENTITY_KEYS.filter((k) => !bodyKeys.has(k))).toEqual([]);
  });

  it("every managed key is either structural or carried", () => {
    // The structural four are built by hand from the body's arrays/scalars;
    // everything else must be carried, or it is managed-but-never-written.
    const STRUCTURAL = new Set(["table", "description", "dimensions", "measures", "joins", "query_patterns"]);
    const carried = new Set<string>(CARRIED_ENTITY_KEYS);
    expect(
      EDITOR_MANAGED_ENTITY_KEYS.filter((k) => !STRUCTURAL.has(k) && !carried.has(k)),
    ).toEqual([]);
  });
});
