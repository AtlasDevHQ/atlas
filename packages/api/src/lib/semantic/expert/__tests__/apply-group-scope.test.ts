/**
 * Regression: the expert apply path is group-aware end-to-end (#3284).
 *
 * Proves `applyAmendmentToEntity` targets the Connection group the amendment
 * was analyzed against — never a 409-ambiguity for a name shared across groups,
 * and never a wrong-scope (default) write:
 *
 *   1. an explicit group scopes the `getEntity` lookup, so a name in 2+ groups
 *      resolves cleanly instead of throwing `AmbiguousEntityError` (the bug);
 *   2. the write-back (upsert + version + disk sync) always uses the resolved
 *      row's OWN `connection_group_id`, so an amendment for a group entity can
 *      never land in the default scope;
 *   3. the legacy interactive path (group undefined) keeps the unscoped lookup
 *      and still writes back to the resolved row's group.
 *
 * Mocks the DB/disk layer so we assert routing, not persistence.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// Minimal stand-in for the tagged error the route layer maps to 409. The apply
// code's `instanceof AmbiguousEntityError` resolves to THIS class (it imports
// it from the mocked entities module), so a throw here is recognized.
class AmbiguousEntityError extends Error {
  readonly groups: (string | null)[];
  constructor(opts: { message: string; groups: (string | null)[] }) {
    super(opts.message);
    this.name = "AmbiguousEntityError";
    this.groups = opts.groups;
  }
}

type Row = { id: string; connection_group_id: string | null; yaml_content: string };

// Simulated `semantic_entities` rows:
//   "orders"   — exists in BOTH the default (null) scope AND group "eu_prod"
//                (the multi-group reality that 409s an unscoped lookup).
//   "products" — exists in exactly ONE group ("eu_prod"); an unscoped lookup
//                resolves it without ambiguity.
function lookupRow(name: string, group: string | null | undefined): Row | null {
  if (name === "orders") {
    if (group === undefined) {
      throw new AmbiguousEntityError({ message: "orders exists in 2 environments", groups: [null, "eu_prod"] });
    }
    if (group === "eu_prod") return { id: "orders-eu", connection_group_id: "eu_prod", yaml_content: "table: orders\n" };
    if (group === null) return { id: "orders-default", connection_group_id: null, yaml_content: "table: orders\n" };
    return null;
  }
  if (name === "products") {
    if (group === undefined || group === "eu_prod") {
      return { id: "products-eu", connection_group_id: "eu_prod", yaml_content: "table: products\n" };
    }
    return null;
  }
  return null;
}

// Explicit parameter signatures so `.mock.calls[n][i]` is well-typed (a bare
// `mock(async () => {})` infers a zero-arity call tuple, which tsgo rejects on
// positional argument assertions).
const getEntity = mock(
  async (_org: string, _type: string, name: string, group?: string | null): Promise<Row | null> =>
    lookupRow(name, group),
);
const upsertEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _yaml: string, _group?: string | null): Promise<void> => {},
);
const createVersion = mock(
  async (
    _id: string, _org: string, _type: string, _name: string, _yaml: string,
    _summary: string | null, _authorId: string | null, _authorLabel: string | null,
  ): Promise<string> => "version-1",
);
const generateChangeSummary = mock(async (_before: string, _after: string): Promise<string> => "summary");
const invalidateOrgWhitelist = mock((_org: string): void => {});
const syncEntityToDisk = mock(
  async (_org: string, _name: string, _type: string, _yaml: string, _group?: string | null): Promise<void> => {},
);

// Factories MUST be synchronous (bun loader deadlocks on an async mock.module
// factory that awaits internally) — each returns a plain object referencing the
// spies above.
mock.module("@atlas/api/lib/semantic/entities", () => ({
  getEntity,
  upsertEntityForGroup,
  createVersion,
  generateChangeSummary,
  AmbiguousEntityError,
}));
mock.module("@atlas/api/lib/semantic", () => ({ invalidateOrgWhitelist }));
mock.module("@atlas/api/lib/semantic/sync", () => ({ syncEntityToDisk }));
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { applyAmendmentToEntity } = await import(`../apply.ts?t=${Date.now()}`);

import type { AnalysisResult } from "../types";

function amendment(entityName: string, group: string | undefined): AnalysisResult {
  return {
    category: "coverage_gaps",
    entityName,
    group,
    amendmentType: "add_dimension",
    amendment: { name: "region", sql: "region", type: "string" },
    rationale: "add region dimension",
    impact: 0.6,
    confidence: 0.9,
    staleness: 0,
    score: 0.54,
  };
}

describe("applyAmendmentToEntity — group-aware routing (#3284)", () => {
  beforeEach(() => {
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    syncEntityToDisk.mockClear();
  });

  it("scopes the lookup AND every write to the explicit group (no 409, no default-scope write)", async () => {
    await applyAmendmentToEntity("org-1", amendment("orders", "eu_prod"), "req-1");

    // Lookup scoped to "eu_prod" — never the unscoped ambiguity check.
    expect(getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "entity", "orders", "eu_prod"]);
    // Upsert + version + disk sync all target "eu_prod", NOT the default (null).
    expect(upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod");
    expect(syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
    expect(createVersion.mock.calls[0][0]).toBe("orders-eu"); // versioned the eu_prod row
  });

  it("maps the 'default' group label to a NULL-scoped lookup + write", async () => {
    await applyAmendmentToEntity("org-1", amendment("orders", "default"), "req-2");

    expect(getEntity.mock.calls[0][3]).toBeNull(); // explicit null scope, not undefined
    expect(upsertEntityForGroup.mock.calls[0][4]).toBeNull();
    expect(syncEntityToDisk.mock.calls[0][4]).toBeNull();
    expect(createVersion.mock.calls[0][0]).toBe("orders-default");
  });

  it("the OLD unscoped lookup would 409 on a name shared across groups — the bug the explicit group fixes", async () => {
    // group=undefined reproduces the pre-#3284 behavior: the unscoped lookup
    // throws AmbiguousEntityError, which the route maps to 409.
    await expect(applyAmendmentToEntity("org-1", amendment("orders", undefined), "req-3")).rejects.toThrow(
      "exists in 2 environments",
    );
    expect(upsertEntityForGroup).not.toHaveBeenCalled(); // never wrote
  });

  it("interactive path (group undefined, single-group entity) writes back to the resolved row's OWN group", async () => {
    // "products" lives only in eu_prod; the unscoped lookup resolves it, and the
    // write-back uses the row's connection_group_id ("eu_prod") — never default.
    await applyAmendmentToEntity("org-1", amendment("products", undefined), "req-4");

    expect(getEntity.mock.calls[0][3]).toBeUndefined(); // unscoped lookup preserved
    expect(upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod"); // row's own group, not null
    expect(syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
  });
});
