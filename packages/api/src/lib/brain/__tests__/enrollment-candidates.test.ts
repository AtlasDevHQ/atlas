/**
 * The enrollment picker's semantic-layer read (#5196, ADR-0039).
 *
 * ## Why this file exists, stated as the failure it catches
 *
 * `enrollment-candidates.ts` is the load-bearing half of ADR-0039's *"a person
 * chose the members"* argument: both halves of a pair are picked from a list, so
 * a typo cannot enroll a pair the producer will never look up. It is also the
 * enroll route's 404 gate.
 *
 * Until this file existed the module had NO test. The `-pg` suite bypasses it
 * (it seeds `brain_enrollment` with raw SQL) and the route suite replaces it
 * with `mock.module`. So a regression in `namedEntries`' map-form branch —
 * dropping `!Array.isArray` from `isRecord`, or swapping `Object.entries` for
 * `Object.keys` — makes `loadEnrollableDimensions` return `[]` for every
 * map-form entity, which means:
 *
 *   - `GET /dimensions` answers 200 with an empty list → the picker renders
 *     *"That entity declares none"*
 *   - `POST /enroll` answers **404 for every valid pair**
 *
 * The feature is entirely dead, the admin is told their warehouse has nothing
 * enrollable, **and every other suite in this PR stays green.** That is
 * ADR-0039's own named failure mode — *"leaves M4 exactly as dead as it is
 * today, with every test green"* — one layer up from where it was guarded.
 *
 * The map form is real rather than defensive: `okf/export.ts` normalizes the
 * same two shapes and its suite covers the map case explicitly.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let listResult: {
  // `connectionId` is `AdminEntitySummary`'s own spelling of the connection
  // GROUP — the field's name says connection and its value is a group id, which
  // is the confusion `WarehouseConnectionId` was branded to stop one module
  // over. The picker reads it as the group, so the fixture carries it.
  entities: {
    name: string;
    connectionId: string | null;
    table: string;
    description: string | null;
  }[];
  warnings: string[];
} = { entities: [], warnings: [] };
let entityDetail: { entity: Record<string, unknown> } | null = null;
let listThrows: Error | null = null;
let detailThrows: Error | null = null;
const warnCalls: unknown[] = [];

// Mock-ALL-exports. The real module also exports three error classes and two
// pure helpers; a partial factory link-fails the moment this module reaches for
// one, and `AdminEntityYamlError`'s subclasses are exactly what a future
// `instanceof` arm here would need.
void mock.module("@atlas/api/lib/semantic/admin-source", () => ({
  AdminEntityYamlError: class extends Error {},
  AdminEntityYamlParseError: class extends Error {},
  AdminEntityYamlShapeError: class extends Error {},
  parseRowToAdminSummary: () => null,
  mergeAdminEntities: () => ({ entities: [], warnings: [] }),
  listAdminEntities: async () => {
    if (listThrows) throw listThrows;
    return listResult;
  },
  getAdminEntity: async () => {
    if (detailThrows) throw detailThrows;
    return entityDetail;
  },
}));

void mock.module("@atlas/api/lib/logger", () => {
  const logger = {
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: () => {},
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

const { loadEnrollableDimensions, loadEnrollableEntities } = await import(
  "@atlas/api/lib/brain/enrollment-candidates"
);

const ORG = "org-1";

afterEach(() => {
  listResult = { entities: [], warnings: [] };
  entityDetail = null;
  listThrows = null;
  detailThrows = null;
  warnCalls.length = 0;
});

describe("loadEnrollableDimensions — the two YAML shapes", () => {
  /**
   * ⚠️ The two shapes are asserted to produce THE SAME candidate set, rather
   * than each against its own hand-written expectation.
   *
   * Hand-writing both sides is the agree-by-construction trap: a broken map
   * branch would be "fixed" by editing the expectation beside it. Comparing the
   * two branches against each other means a regression in either one goes red
   * against a working sibling, which is the only version that can falsify.
   */
  it("the array form and the name-keyed map form yield identical candidates", async () => {
    entityDetail = {
      entity: {
        table: "accounts",
        dimensions: [
          { name: "arr_band", type: "string", description: "revenue tier" },
          { name: "status", type: "string" },
        ],
      },
    };
    const fromArray = await loadEnrollableDimensions(ORG, "accounts");

    entityDetail = {
      entity: {
        table: "accounts",
        dimensions: {
          arr_band: { type: "string", description: "revenue tier" },
          status: { type: "string" },
        },
      },
    };
    const fromMap = await loadEnrollableDimensions(ORG, "accounts");

    expect(fromArray).toEqual(fromMap);
    // The positive control. Without it, two branches that both return `[]`
    // satisfy the equality above perfectly — which is the exact regression this
    // file exists to catch.
    expect(fromArray).toEqual([
      { name: "arr_band", kind: "dimension", type: "string", description: "revenue tier" },
      { name: "status", kind: "dimension", type: "string", description: null },
    ]);
  });

  it("measures are labelled, not merged into dimensions", async () => {
    entityDetail = {
      entity: {
        table: "accounts",
        dimensions: [{ name: "status", type: "string" }],
        measures: [{ name: "mrr", type: "number" }],
      },
    };
    const candidates = await loadEnrollableDimensions(ORG, "accounts");
    // Narrowed with an assertion rather than `!`: `null` means the fixture's
    // entity did not resolve, which is a different failure from the one under
    // test and should name itself instead of surfacing as a TypeError below.
    expect(candidates).not.toBeNull();
    if (candidates === null) return;
    expect(candidates.find((c) => c.name === "mrr")?.kind).toBe("measure");
    // Positive control on the other arm: a build that labelled everything
    // `"measure"` would pass the assertion above.
    expect(candidates.find((c) => c.name === "status")?.kind).toBe("dimension");
  });

  it("a name declared as both is ONE candidate, and it keeps the dimension kind", async () => {
    // The tie-break is positional — the dedupe filter runs before the sort, and
    // dimensions are spread first. Asserting the `kind` rather than just the
    // length is what makes a reordered spread go red: labelling a per-row value
    // as an aggregate misdescribes it on the surface an admin uses to decide
    // what Atlas may remember.
    entityDetail = {
      entity: {
        table: "accounts",
        dimensions: [{ name: "arr", type: "string" }],
        measures: [{ name: "arr", type: "number" }],
      },
    };
    const candidates = await loadEnrollableDimensions(ORG, "accounts");
    // Narrowed with an assertion rather than `!`: `null` means the fixture's
    // entity did not resolve, which is a different failure from the one under
    // test and should name itself instead of surfacing as a TypeError below.
    expect(candidates).not.toBeNull();
    if (candidates === null) return;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("dimension");
  });

  it("an unnamed entry is dropped and its named sibling survives", async () => {
    entityDetail = {
      entity: {
        table: "accounts",
        dimensions: [
          { type: "string" },
          { name: "", type: "string" },
          { name: "status", type: "string" },
        ],
      },
    };
    const candidates = await loadEnrollableDimensions(ORG, "accounts");
    // Narrowed with an assertion rather than `!`: `null` means the fixture's
    // entity did not resolve, which is a different failure from the one under
    // test and should name itself instead of surfacing as a TypeError below.
    expect(candidates).not.toBeNull();
    if (candidates === null) return;
    // The sibling is the control: without it a function returning `[]` passes.
    expect(candidates.map((c) => c.name)).toEqual(["status"]);
  });

  it("sorts by name so the picker does not follow YAML authoring order", async () => {
    entityDetail = {
      entity: {
        table: "accounts",
        dimensions: [{ name: "zeta" }, { name: "alpha" }, { name: "mid" }],
      },
    };
    const candidates = await loadEnrollableDimensions(ORG, "accounts");
    // Narrowed with an assertion rather than `!`: `null` means the fixture's
    // entity did not resolve, which is a different failure from the one under
    // test and should name itself instead of surfacing as a TypeError below.
    expect(candidates).not.toBeNull();
    if (candidates === null) return;
    expect(candidates.map((c) => c.name)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("loadEnrollableDimensions — absent vs empty", () => {
  it("a missing entity is null and a declaring-nothing entity is an empty list", async () => {
    entityDetail = null;
    expect(await loadEnrollableDimensions(ORG, "ghosts")).toBeNull();

    // Same run, opposite state. This is the 404-vs-200 split the route asserts
    // against a hardcoded mock; nothing else proves the real module produces it.
    entityDetail = { entity: { table: "accounts" } };
    expect(await loadEnrollableDimensions(ORG, "accounts")).toEqual([]);
  });

  it("a non-object dimensions block yields an empty list rather than throwing", async () => {
    entityDetail = { entity: { table: "accounts", dimensions: "not-a-block" } };
    expect(await loadEnrollableDimensions(ORG, "accounts")).toEqual([]);
  });
});

describe("errors propagate — an unreadable layer is never an empty one", () => {
  it("a failing entity list rejects instead of resolving empty", async () => {
    listThrows = new Error("db down");
    await expect(loadEnrollableEntities(ORG)).rejects.toThrow("db down");
  });

  it("a failing entity detail rejects instead of resolving null", async () => {
    // `null` is a MEANINGFUL answer here (the route turns it into a 404), so a
    // swallowed error would tell an admin their entity does not exist at the
    // moment the semantic layer could not be read.
    detailThrows = new Error("yaml exploded");
    await expect(loadEnrollableDimensions(ORG, "accounts")).rejects.toThrow("yaml exploded");
  });
});

describe("loadEnrollableEntities", () => {
  it("offers one name held in several connection groups as SEVERAL options (#5286)", async () => {
    // ⚠️ **The inverse of what this test asserted until #5286, and the reversal
    // is the fix.** A multi-group workspace (#2412) returns one row per group,
    // and this module used to collapse them "because the pair this surface
    // stores is `(workspace_id, entity, dimension)` with no group column, so the
    // duplicates are not a distinction the storage could record even if they
    // picked one." Migration 0205 gave it that column.
    //
    // What the collapse actually did was hand the admin ONE option for TWO
    // entities over two databases. Whichever they meant, the row could not
    // record it, and the producer refused the pair on every run afterwards —
    // measured on staging, where the only producible entity is published under
    // three groups.
    listResult = {
      entities: [
        { name: "accounts", connectionId: "g-prod", table: "prod.accounts", description: "prod" },
        { name: "accounts", connectionId: "g-staging", table: "staging.accounts", description: "staging" },
        { name: "subscriptions", connectionId: null, table: "prod.subscriptions", description: "" },
      ],
      warnings: [],
    };
    const options = await loadEnrollableEntities(ORG);

    // THREE options, and the two `accounts` are distinguishable — same name,
    // different group, different table.
    expect(options).toEqual([
      { name: "accounts", group: "g-prod", table: "prod.accounts", description: "prod" },
      { name: "accounts", group: "g-staging", table: "staging.accounts", description: "staging" },
      { name: "subscriptions", group: null, table: "prod.subscriptions", description: null },
    ]);

    // POSITIVE CONTROL on the distinction itself. `toEqual` above would pass on
    // an implementation that returned three rows carrying the same group, which
    // is the collapse wearing a different shape: the picker would render two
    // identical options again and the write would name one scope for both.
    expect(new Set(options.filter((o) => o.name === "accounts").map((o) => o.group)).size).toBe(2);
  });

  it("withholds a FLAT-SCOPED row whose name a grouped row also carries (#5286)", async () => {
    // ⚠️ The one option this module still refuses to offer, and refusing is the
    // honest answer rather than a leftover collapse.
    //
    // `null` is doing two jobs in the stored column — "the flat scope" and "this
    // enrollment predates the group column" — and where a name has BOTH a flat
    // row and a grouped one those two readings pick DIFFERENT databases. So
    // `mapEntitiesToConnectionIds` refuses that pair `ambiguous-group` on every
    // run, and it is right to: guessing means producing claims from the
    // `__global__` demo database into a customer's brain.
    //
    // Offering an option whose every click stores cleanly and reaches nothing is
    // exactly what this surface exists to prevent, so it is not offered.
    listResult = {
      entities: [
        // The `__global__` demo row the workspace has shadowed…
        { name: "plans", connectionId: null, table: "demo.plans", description: null },
        // …and the workspace's own, which stays.
        { name: "plans", connectionId: "g-eu", table: "prod.plans", description: null },
        // A flat row with NO grouped sibling is untouched — a workspace that
        // groups nothing loses nothing.
        { name: "accounts", connectionId: null, table: "accounts", description: null },
      ],
      warnings: [],
    };
    const options = await loadEnrollableEntities(ORG);

    expect(options.map((o) => [o.name, o.group])).toEqual([
      ["plans", "g-eu"],
      ["accounts", null],
    ]);
  });

  it("keeps BOTH grouped rows when neither is flat — only the flat one is unaddressable", async () => {
    // The control that stops the rule above from becoming a de-dup by name
    // again. Two grouped rows are two addressable entities and both are offered;
    // it is only the `null` that cannot be told apart from "no group recorded".
    listResult = {
      entities: [
        { name: "test_orders", connectionId: "g-clickhouse", table: "o", description: null },
        { name: "test_orders", connectionId: "g-mysql", table: "o", description: null },
      ],
      warnings: [],
    };
    const options = await loadEnrollableEntities(ORG);
    expect(options.map((o) => o.group)).toEqual(["g-clickhouse", "g-mysql"]);
  });

  it("scopes the dimension read to the group it was asked for (#5286)", async () => {
    // The other half. `getAdminEntity` throws `AmbiguousEntityError` for a
    // stem-only lookup spanning two groups, which is why the route used to
    // answer 409 — so passing the group through is what makes an option the
    // picker offers actually enrollable.
    const seen: unknown[] = [];
    entityDetail = { entity: { table: "accounts", dimensions: [{ name: "tier" }] } };
    void mock.module("@atlas/api/lib/semantic/admin-source", () => ({
      AdminEntityYamlError: class extends Error {},
      AdminEntityYamlParseError: class extends Error {},
      AdminEntityYamlShapeError: class extends Error {},
      parseRowToAdminSummary: () => null,
      mergeAdminEntities: () => ({ entities: [], warnings: [] }),
      listAdminEntities: async () => listResult,
      getAdminEntity: async (opts: unknown) => {
        seen.push(opts);
        return entityDetail;
      },
    }));
    const { loadEnrollableDimensions: scoped } = await import(
      "@atlas/api/lib/brain/enrollment-candidates"
    );

    await scoped(ORG, "accounts", "g-staging");
    expect(seen).toEqual([
      { name: "accounts", orgId: ORG, mode: "published", connectionGroupId: "g-staging" },
    ]);

    // The flat scope travels as an explicit `null`, and the OMITTED case stays
    // `undefined` — `getAdminEntity` reads those as two different lookups (the
    // legacy null-group rows versus unique-or-throw), so collapsing them here
    // would silently re-scope every caller that has no group to offer.
    seen.length = 0;
    await scoped(ORG, "accounts", null);
    await scoped(ORG, "accounts");
    expect(seen).toEqual([
      { name: "accounts", orgId: ORG, mode: "published", connectionGroupId: null },
      { name: "accounts", orgId: ORG, mode: "published", connectionGroupId: undefined },
    ]);
  });

  it("logs skipped semantic-layer entries instead of dropping them silently", async () => {
    listResult = {
      entities: [{ name: "accounts", connectionId: null, table: "accounts", description: "" }],
      warnings: ["orders.yaml: unparseable"],
    };
    await loadEnrollableEntities(ORG);
    expect(warnCalls).toHaveLength(1);

    // Positive control on the other side: a module that logged on EVERY call
    // would pass the assertion above and make the warning meaningless.
    warnCalls.length = 0;
    listResult = {
      entities: [{ name: "accounts", connectionId: null, table: "accounts", description: "" }],
      warnings: [],
    };
    await loadEnrollableEntities(ORG);
    expect(warnCalls).toHaveLength(0);
  });
});
