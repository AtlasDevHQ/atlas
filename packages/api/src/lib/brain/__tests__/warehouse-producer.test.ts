/**
 * The tier-1 warehouse producer's decisions (#5042, ADR-0037 §4, ADR-0039).
 *
 * Everything here is a claim about what the producer WILL AND WILL NOT EMIT,
 * driven against injected seams — no database, no datasource, no semantic layer
 * on disk. The storage-level half (a fact landing `draft`, a re-emission minting
 * a tension edge and stamping no `valid_to`) is `warehouse-producer-pg.test.ts`;
 * neither file can stand in for the other. The log LEVELS are
 * `warehouse-producer-logging.test.ts`, which captures per level so a demotion
 * cannot pass.
 *
 * ## ⚠️ The two shapes every test here has to avoid
 *
 * **1. "No bad row appeared" is satisfied by a producer that emitted NOTHING AT
 * ALL** — the failure ADR-0039 predicts is invisible: *"a producer nobody enrolls
 * anything into leaves M4 exactly as dead as it is today, with every test green."*
 * So every refusal test carries a POSITIVE CONTROL on the same run, and the two
 * sides are given DIFFERENT SIZES so a fix that swapped them (or collapsed both to
 * zero) cannot pass on an accidental equality.
 *
 * **2. A fixture that makes two fields equal cannot tell them apart.** The first
 * cut of this file set `sql: name` on every dimension — the profiler's own default
 * — which made `predicate: dim.name` and `predicate: dim.sql` the same string
 * everywhere. Emitting `LOWER(raw_status)` as a predicate is precisely the
 * "qualified surface can never lexically match anything an LLM emits" failure the
 * bare name exists to prevent, and it was unfalsifiable. {@link entityYaml} now
 * defaults `sql` to a DIFFERENT string than `name`, so the split is exercised by
 * every fixture in the file rather than by one test that remembers to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  makeProducerReach,
  type EnrolledDimension,
} from "@atlas/api/lib/brain/enrollment";
import { identityKey, identityVocabulary, type ClaimVocabulary } from "@atlas/api/lib/brain/identity";
import {
  ENTITY_STORE_DELETE_SQL,
  ENTITY_STORE_INSERT_SQL,
  ENTITY_EDGE_PRODUCER,
  type EntityStoreEntry,
} from "@atlas/api/lib/brain/entity-store";
import type {
  AliasProducerCounters,
  AliasProposalInput,
} from "@atlas/api/lib/brain/vocabulary-decide";
import {
  CORROBORATION_LOOKUP_SQL,
  INSERT_FACT_SQL,
  INSERT_PROVENANCE_EDGE_SQL,
  RECONCILE_LOCK_SQL,
  TENSION_CANDIDATES_SQL,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import {
  DIMENSION_ALIAS_PREFIX,
  SUBJECT_ALIAS,
  WAREHOUSE_EPISODE_INSERT_SQL,
  WAREHOUSE_PRODUCER,
  WAREHOUSE_PRODUCER_PRINCIPAL,
  buildSnapshotSql,
  buildWarehouseClaims,
  defaultValidateSnapshotSql,
  parseWarehouseEntity,
  planWarehouseEmission,
  runWarehouseProducer,
  warehouseEntityResolver,
  warehouseRowId,
  warehouseSurface,
  type WarehouseEntity,
  type WarehouseEntityLookup,
  type WarehouseEntityPlan,
  type WarehouseProducerDeps,
  type SnapshotSqlVerdict,
  type WarehouseRowId,
  type WarehouseSnapshotRequest,
} from "@atlas/api/lib/brain/warehouse-producer";

const WORKSPACE = "ws-5042";
const SNAPSHOT_AT = new Date("2026-08-14T10:00:00.000Z");

// ── fixtures ────────────────────────────────────────────────────────────────

/** A dimension spec: a bare name (whose column is derived) or an explicit pair. */
type DimensionSpec = string | { readonly name: string; readonly sql: string };

/**
 * The COLUMN a bare dimension name maps to.
 *
 * ⚠️ Deliberately NOT the name. The profiler writes `sql: id` beside `name: id`,
 * which is why the first cut of this file looked right and proved nothing: with the
 * two equal, `predicate: dim.name` and `predicate: dim.sql` are indistinguishable,
 * and so are `SELECT ${dim.sql}` and `SELECT ${dim.name}`. Every fixture here uses
 * a renamed column so both swaps go red.
 */
const columnFor = (name: string) => `col_${name}`;

function entityYaml(spec: {
  table: string;
  connection?: string;
  primaryKey?: string | readonly string[];
  dimensions: readonly DimensionSpec[];
  measures?: readonly string[];
}): Record<string, unknown> {
  const keys = new Set(
    spec.primaryKey === undefined
      ? []
      : typeof spec.primaryKey === "string"
        ? [spec.primaryKey]
        : spec.primaryKey,
  );
  return {
    table: spec.table,
    ...(spec.connection === undefined ? {} : { connection: spec.connection }),
    dimensions: spec.dimensions.map((dim) => {
      const { name, sql } = typeof dim === "string" ? { name: dim, sql: columnFor(dim) } : dim;
      return { name, sql, ...(keys.has(name) ? { primary_key: true } : {}) };
    }),
    ...(spec.measures === undefined
      ? {}
      : { measures: spec.measures.map((name) => ({ name, sql: `sum(${name})` })) }),
  };
}

function parsed(name: string, spec: Parameters<typeof entityYaml>[0]): WarehouseEntity {
  const entity = parseWarehouseEntity(name, entityYaml(spec));
  if (entity === null) throw new Error(`fixture "${name}" did not parse`);
  return entity;
}

/** `planWarehouseEmission`'s input, for the common all-found case. */
function found(...entities: readonly WarehouseEntity[]): Map<string, WarehouseEntityLookup> {
  return new Map(entities.map((entity) => [entity.name, { kind: "found" as const, entity }]));
}

function planFor(
  entity: WarehouseEntity,
  dimensions: readonly string[],
  /** The dimension naming the entity (#5043). A NAME, so a typo is a throw. */
  naming?: string,
): WarehouseEntityPlan {
  const pick = (name: string) => {
    const dim = entity.dimensions.find((d) => d.name === name);
    if (dim === undefined) throw new Error(`fixture "${entity.name}" has no dimension "${name}"`);
    return dim;
  };
  const primaryKey = entity.dimensions.find((d) => d.primaryKey);
  if (primaryKey === undefined) throw new Error(`fixture "${entity.name}" declares no primary key`);
  const [first, ...rest] = dimensions.map(pick);
  if (first === undefined) throw new Error("a plan needs at least one dimension");
  return {
    entity,
    primaryKey,
    dimensions: [first, ...rest],
    namingDimension: naming === undefined ? null : pick(naming),
  };
}

/** `entity.dimension:reason`, the shape every refusal assertion compares on. */
const refusalKeys = (refusals: readonly { entity: string; dimension: string; reason: string }[]) =>
  refusals.map((r) => `${r.entity}.${r.dimension}:${r.reason}`).toSorted();

// ── the parse ───────────────────────────────────────────────────────────────

describe("parseWarehouseEntity", () => {
  test("reads the array shape and the name-keyed map shape identically", () => {
    const asArray = parseWarehouseEntity("Accounts", {
      table: "accounts",
      dimensions: [
        { name: "id", sql: "account_id", primary_key: true },
        { name: "status", sql: "lifecycle_status" },
      ],
    });
    const asMap = parseWarehouseEntity("Accounts", {
      table: "accounts",
      dimensions: {
        id: { sql: "account_id", primary_key: true },
        status: { sql: "lifecycle_status" },
      },
    });
    expect(asArray).toEqual(asMap);
    // Pinned positively as well as by equality: two nulls are also "identical",
    // and this file's whole hazard is a test that a producer emitting nothing
    // satisfies.
    expect(asArray?.dimensions).toEqual([
      { name: "id", sql: "account_id", primaryKey: true },
      { name: "status", sql: "lifecycle_status", primaryKey: false },
    ]);
  });

  test("falls back to the dimension NAME when the YAML declares no sql expression", () => {
    const entity = parseWarehouseEntity("Accounts", {
      table: "accounts",
      dimensions: [{ name: "status" }],
    });
    expect(entity?.dimensions[0]?.sql).toBe("status");
  });

  test("refuses an entity with no table — nothing can be read FROM undefined", () => {
    expect(parseWarehouseEntity("Accounts", { dimensions: [] })).toBeNull();
    expect(parseWarehouseEntity("Accounts", { table: "   " })).toBeNull();
  });

  test("measures are collected as names, distinctly from dimensions", () => {
    const entity = parsed("Orders", {
      table: "orders",
      primaryKey: "id",
      dimensions: ["id", "region"],
      measures: ["total_revenue"],
    });
    expect([...entity.measures]).toEqual(["total_revenue"]);
    expect(entity.dimensions.map((d) => d.name)).toEqual(["id", "region"]);
  });
});

// ── the plan, and the fail-closed rule ──────────────────────────────────────

describe("planWarehouseEmission — ADR-0037 §4's fail-closed ambiguity rule", () => {
  /**
   * The falsifier of record for acceptance criterion 3.
   *
   * ⚠️ The POSITIVE CONTROL is the whole test. A producer that refused every
   * pair, or that crashed before emitting anything, satisfies *"the ambiguous
   * dimension produced no plan"* perfectly — so the same run must be shown
   * emitting the unambiguous siblings, and the two entities are given DIFFERENT
   * numbers of them (1 and 2) so a fix that swapped or collapsed them cannot
   * pass on an accidental equality.
   */
  test("refuses an ambiguous dimension on BOTH entities while its unambiguous siblings still emit", () => {
    const accounts = parsed("Accounts", {
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "status", "tier"],
    });
    const contracts = parsed("Contracts", {
      table: "contracts",
      primaryKey: "id",
      dimensions: ["id", "status", "region", "owner"],
    });
    const reach = makeProducerReach([
      { entity: "Accounts", dimension: "status", naming: false },
      { entity: "Accounts", dimension: "tier", naming: false },
      { entity: "Contracts", dimension: "status", naming: false },
      { entity: "Contracts", dimension: "region", naming: false },
      { entity: "Contracts", dimension: "owner", naming: false },
    ]);

    const plan = planWarehouseEmission(reach, found(accounts, contracts));

    // The refusal: BOTH sides, never a winner — asserted as entity+dimension+reason
    // triples, so a swapped argument or a mislabelled reason cannot hide inside a
    // sorted multiset of reasons.
    expect(refusalKeys(plan.refused)).toEqual([
      "Accounts.status:ambiguous-dimension",
      "Contracts.status:ambiguous-dimension",
    ]);
    // …and it names the other entity, which is what makes it fixable.
    expect(plan.refused.find((r) => r.entity === "Accounts")?.message).toContain("Contracts");

    // The positive control: the same run still emits, with DIFFERENT counts per
    // entity so the two cannot be confused for one another.
    const emitted = new Map(
      plan.emit.map((e) => [e.entity.name, e.dimensions.map((d) => d.name).toSorted()]),
    );
    expect(emitted.get("Accounts")).toEqual(["tier"]);
    expect(emitted.get("Contracts")).toEqual(["owner", "region"]);
  });

  test("ambiguity is evaluated over PRODUCIBLE pairs, so a stale enrollment does not disable a live one", () => {
    const accounts = parsed("Accounts", {
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "status"],
    });
    const reach = makeProducerReach([
      { entity: "Accounts", dimension: "status", naming: false },
      // Enrolled, but the entity left the published semantic layer. The producer
      // is not producing from it, so `status` is not ambiguous.
      { entity: "Contracts", dimension: "status", naming: false },
    ]);

    const plan = planWarehouseEmission(
      reach,
      new Map<string, WarehouseEntityLookup>([
        ["Accounts", { kind: "found", entity: accounts }],
        ["Contracts", { kind: "not-published" }],
      ]),
    );

    expect(
      plan.emit.map((e) => `${e.entity.name}.${e.dimensions.map((d) => d.name).join(",")}`),
    ).toEqual(["Accounts.status"]);
    expect(refusalKeys(plan.refused)).toEqual(["Contracts.status:entity-not-published"]);
  });

  test("the comparison is case-sensitive, because a warehouse may hold both spellings", () => {
    const accounts = parsed("Accounts", {
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "status"],
    });
    const contracts = parsed("Contracts", {
      table: "contracts",
      primaryKey: "id",
      dimensions: ["id", "Status"],
    });
    const plan = planWarehouseEmission(
      makeProducerReach([
        { entity: "Accounts", dimension: "status", naming: false },
        { entity: "Contracts", dimension: "Status", naming: false },
      ]),
      found(accounts, contracts),
    );
    expect(plan.refused).toEqual([]);
    expect(plan.emit).toHaveLength(2);
  });

  test("an unenrolled dimension of an enrolled entity is never planned — the reach is the input", () => {
    const accounts = parsed("Accounts", {
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "status", "tier", "arr"],
    });
    const plan = planWarehouseEmission(
      makeProducerReach([{ entity: "Accounts", dimension: "tier", naming: false }]),
      found(accounts),
    );
    expect(plan.emit[0]?.dimensions.map((d) => d.name)).toEqual(["tier"]);
    expect(plan.refused).toEqual([]);
  });

  /**
   * Acceptance criterion 4, in the only form that can go red.
   *
   * ⚠️ The first cut of this test asserted `slotKey(x, a) === slotKey(x, a)` — a
   * value compared with itself — and `analytics.connection !== billing.connection`
   * on a fixture the test had just built. Neither can fail. What AC-4 actually
   * claims is that two entities in DIFFERENT connection groups produce ONE
   * predicate, because the vocabulary and the keys are workspace-scoped and carry
   * no group; the only repair it argues against is qualifying the predicate by
   * group. So the falsifiable form builds claims from both and compares the
   * predicates directly, with the groups differing in `detail`.
   */
  test("cross-group conflation is a property of the emitted PREDICATE, not of the group", () => {
    const analytics = parsed("Plans", {
      table: "analytics.plans",
      connection: "analytics",
      primaryKey: "id",
      dimensions: ["id", "price"],
    });
    const billing = parsed("Products", {
      table: "billing.products",
      connection: "billing",
      primaryKey: "id",
      dimensions: ["id", "price"],
    });
    const row = { [SUBJECT_ALIAS]: "row-1", [`${DIMENSION_ALIAS_PREFIX}0`]: "499" };
    const claimsFrom = (entity: WarehouseEntity) =>
      buildWarehouseClaims({
        workspaceId: WORKSPACE,
        plan: planFor(entity, ["price"]),
        rows: [row],
        snapshotAt: SNAPSHOT_AT,
      }).candidates;

    const [fromAnalytics] = claimsFrom(analytics);
    const [fromBilling] = claimsFrom(billing);

    // ONE predicate from two groups — the conflation AC-4 says is pre-existing.
    expect(fromAnalytics?.predicate).toBe("price");
    expect(fromBilling?.predicate).toBe(fromAnalytics?.predicate);
    // The group is present, and it is present in the place that does NOT key.
    expect(fromAnalytics?.detail?.connectionGroup).toBe("analytics");
    expect(fromBilling?.detail?.connectionGroup).toBe("billing");
    // Which is why the ambiguity rule has to refuse: there is no group-qualified
    // key for it to fall back to.
    const plan = planWarehouseEmission(
      makeProducerReach([
        { entity: "Plans", dimension: "price", naming: false },
        { entity: "Products", dimension: "price", naming: false },
      ]),
      found(analytics, billing),
    );
    expect(plan.emit).toEqual([]);
    expect(refusalKeys(plan.refused)).toEqual([
      "Plans.price:ambiguous-dimension",
      "Products.price:ambiguous-dimension",
    ]);
  });

  test("each structural refusal reports its own reason, against its own pair", () => {
    const noKey = parsed("NoKey", { table: "no_key", dimensions: ["status"] });
    const composite = parsed("Composite", {
      table: "composite",
      primaryKey: ["tenant_id", "id"],
      dimensions: ["tenant_id", "id", "status"],
    });
    const withMeasure = parsed("Orders", {
      table: "orders",
      primaryKey: "id",
      dimensions: ["id"],
      measures: ["total_revenue"],
    });
    const plan = planWarehouseEmission(
      makeProducerReach([
        { entity: "NoKey", dimension: "status", naming: false },
        { entity: "Composite", dimension: "status", naming: false },
        { entity: "Orders", dimension: "total_revenue", naming: false },
        { entity: "Orders", dimension: "typo", naming: false },
      ]),
      found(noKey, composite, withMeasure),
    );
    expect(plan.emit).toEqual([]);
    // ⚠️ Triples, not a sorted list of reasons. A sorted multiset of reasons
    // distinguishes WHICH reasons appeared and not which pair got which, so a true
    // swap of `no-primary-key` and `composite-primary-key` passed it.
    expect(refusalKeys(plan.refused)).toEqual([
      "Composite.status:composite-primary-key",
      "NoKey.status:no-primary-key",
      "Orders.total_revenue:measure-not-per-row",
      "Orders.typo:dimension-not-found",
    ]);
    // A measure is refused as a MEASURE and not as a typo — the two send an admin
    // to different places, and one of them is not their mistake.
    expect(plan.refused.find((r) => r.dimension === "total_revenue")?.message).toContain(
      "aggregate",
    );
  });

  test("a published-but-unreadable entity is NOT reported as unpublished", () => {
    // The remedy for `entity-not-published` is "publish the entity". For an entity
    // that IS published and merely unreadable — ambiguous across connection groups,
    // or a YAML with no `table:` — that advice is a no-op the admin can follow
    // forever.
    const accounts = parsed("Accounts", {
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "tier"],
    });
    const plan = planWarehouseEmission(
      makeProducerReach([
        { entity: "Broken", dimension: "status", naming: false },
        { entity: "Accounts", dimension: "tier", naming: false },
      ]),
      new Map<string, WarehouseEntityLookup>([
        ["Broken", { kind: "unreadable", cause: "load-threw", why: "it resolves in two connection groups." }],
        ["Accounts", { kind: "found", entity: accounts }],
      ]),
    );
    expect(refusalKeys(plan.refused)).toEqual(["Broken.status:entity-unreadable"]);
    expect(plan.refused[0]?.message).toContain("two connection groups");
    // The positive control — one entity being unreadable costs one entity.
    expect(plan.emit.map((e) => e.entity.name)).toEqual(["Accounts"]);
  });
});

// ── the snapshot query ──────────────────────────────────────────────────────

describe("buildSnapshotSql", () => {
  const accounts = parsed("Accounts", {
    table: "public.accounts",
    primaryKey: "id",
    dimensions: [
      { name: "id", sql: "account_id" },
      { name: "status", sql: "lifecycle_status" },
      { name: "tier", sql: "LOWER(plan_tier)" },
    ],
  });

  test("selects each dimension's COLUMN, never its name", () => {
    const sql = buildSnapshotSql(planFor(accounts, ["status", "tier"]), 5);
    expect(sql).toBe(
      `SELECT account_id AS ${SUBJECT_ALIAS}, lifecycle_status AS ${DIMENSION_ALIAS_PREFIX}0, ` +
        `LOWER(plan_tier) AS ${DIMENSION_ALIAS_PREFIX}1 FROM public.accounts LIMIT 6`,
    );
    // Stated separately because the equality above would also hold for a builder
    // that emitted names if the fixture set `sql === name` — which is exactly what
    // the first version of this file did.
    // Word-anchored: `"status AS"` is a SUBSTRING of `"lifecycle_status AS"`, so a
    // bare `not.toContain` fails against the correct output. What must not appear
    // is the dimension NAME in a column position.
    expect(sql).not.toMatch(/(^|[\s,])status AS/);
    expect(sql).not.toMatch(/(^|[\s,])tier AS/);
  });

  test("asks for cap + 1 rows, which is what makes the cap detectable", () => {
    // At exactly `cap` a truncated read and a table of that size are the same
    // result set. The extra row is the evidence, so this asserts the arithmetic
    // rather than the presence of a LIMIT.
    expect(buildSnapshotSql(planFor(accounts, ["status"]), 1)).toContain("LIMIT 2");
    expect(buildSnapshotSql(planFor(accounts, ["status"]), 250)).toContain("LIMIT 251");
  });

  /**
   * ⚠️ **The POSITIVE CONTROL for the whole SQL gate — and its first version could
   * never reach the gate at all.**
   *
   * `test-setup.ts` strips every `ATLAS_*` var in the global preload, so
   * `detectDBType()` throws and `validateSQL` returns *"No valid datasource
   * configured"* BEFORE the empty-query check, the forbidden-pattern regex, the
   * parser and the whitelist. The first cut asserted inside `if (!result.valid)`
   * against a regex that string can never match — so it passed for `DROP TABLE
   * users; SELECT 1` as readily as for a real statement, and DELETING THE PRODUCTION
   * GATE ENTIRELY left every suite green.
   *
   * Two things fix it. `ATLAS_DATASOURCE_URL` is set for this block so the gate is
   * actually reached (inside the hooks and restored after — the test-discipline
   * rule). And the assertions are UNCONDITIONAL, because an assertion inside
   * `if (!valid)` reports "pass" for exactly the case it was written to exclude.
   */
  describe("against the product's real SQL gate", () => {
    let priorDatasourceUrl: string | undefined;
    beforeAll(() => {
      priorDatasourceUrl = process.env.ATLAS_DATASOURCE_URL;
      process.env.ATLAS_DATASOURCE_URL = "postgresql://u:p@localhost:5432/never_connected";
    });
    afterAll(() => {
      if (priorDatasourceUrl === undefined) delete process.env.ATLAS_DATASOURCE_URL;
      else process.env.ATLAS_DATASOURCE_URL = priorDatasourceUrl;
    });

    const validate = (sql: string) =>
      defaultValidateSnapshotSql({
        workspaceId: WORKSPACE,
        entity: "Accounts",
        connectionId: undefined,
        sql,
      });
    const reason = (r: Awaited<ReturnType<typeof validate>>) => (r.valid ? "" : r.error);

    test("what it builds is never rejected for its FORM", async () => {
      const result = await validate(buildSnapshotSql(planFor(accounts, ["status", "tier"]), 10));
      // The tripwire the first version lacked: the gate must have been REACHED.
      // "No valid datasource" means it returned before reading the statement.
      expect(reason(result)).not.toContain("No valid datasource");
      // The whitelist is workspace-scoped and this workspace has none, so a
      // table-scoped rejection is the expected shape here. A FORM rejection would
      // reject in EVERY workspace — ADR-0039's dead producer.
      expect(reason(result)).not.toMatch(/semicolon|multiple statement|parse|syntax/i);
    });

    test("and a malformed statement IS rejected — the negative control", async () => {
      // Without this, "never rejected for its form" is satisfied by a gate that
      // rejects nothing for its form, ever.
      const result = await validate("SELECT 1; DROP TABLE accounts");
      expect(result.valid).toBe(false);
      expect(reason(result)).not.toContain("No valid datasource");
      // ⚠️ And the REASON survives the mint. `SQLValidationResult` makes `error`
      // required on its failing arm; while the verdict type made it optional, the
      // mint could drop it and every production refusal read "no reason given" —
      // absorbed at both ends by a `??`, so nothing went red.
      expect(reason(result).length).toBeGreaterThan(0);
    });
  });
});

// ── surfaces and ids ────────────────────────────────────────────────────────

describe("warehouseSurface", () => {
  test("carries the values a claim can be made of", () => {
    expect(warehouseSurface("Acme Corp")).toBe("Acme Corp");
    expect(warehouseSurface("  padded  ")).toBe("padded");
    expect(warehouseSurface(499)).toBe("499");
    expect(warehouseSurface(10n)).toBe("10");
    expect(warehouseSurface(true)).toBe("true");
    expect(warehouseSurface(new Date("2026-08-04T08:00:00.000Z"))).toBe("2026-08-04T08:00:00.000Z");
  });

  test("abstains on everything a claim cannot be made of", () => {
    expect(warehouseSurface(null)).toBeNull();
    expect(warehouseSurface(undefined)).toBeNull();
    expect(warehouseSurface("")).toBeNull();
    expect(warehouseSurface("   ")).toBeNull();
    expect(warehouseSurface(Number.NaN)).toBeNull();
    // A jsonb column, an array, a bytea. `String(…)` would land `[object Object]`
    // in a reviewer's queue as a fact about their company.
    // A NUL survives `trim()` and Postgres refuses it (22021), which aborts the
    // whole entity's transaction rather than dropping one cell. MySQL and
    // ClickHouse `text` both admit one, so this is reachable for two of the three
    // supported dialects.
    expect(warehouseSurface("acme\u0000corp")).toBeNull();
    expect(warehouseSurface({ a: 1 })).toBeNull();
    expect(warehouseSurface([1, 2])).toBeNull();
    expect(warehouseSurface(new Date("nonsense"))).toBeNull();
  });
});

describe("warehouseRowId", () => {
  test("is stable for the same row and distinct for every different one", () => {
    const base = warehouseRowId(WORKSPACE, "Accounts", "42");
    expect(warehouseRowId(WORKSPACE, "Accounts", "42")).toBe(base);
    expect(warehouseRowId(WORKSPACE, "Accounts", "43")).not.toBe(base);
    expect(warehouseRowId(WORKSPACE, "Contracts", "42")).not.toBe(base);
    expect(warehouseRowId("ws-other", "Accounts", "42")).not.toBe(base);
  });

  test("components cannot be re-cut into another row's id", () => {
    // With a printable separator these two hash identically, which is one id for
    // two different rows — the false `same` at the publish gate the seam's
    // globally-unique clause exists to forbid.
    expect(warehouseRowId(WORKSPACE, "a", "b:c")).not.toBe(warehouseRowId(WORKSPACE, "a:b", "c"));
    expect(warehouseRowId(WORKSPACE, "a", "b c")).not.toBe(warehouseRowId(WORKSPACE, "a b", "c"));
  });
});

// ── the claims ──────────────────────────────────────────────────────────────

describe("buildWarehouseClaims", () => {
  const accounts = parsed("Accounts", {
    table: "accounts",
    connection: "analytics",
    primaryKey: "id",
    dimensions: ["id", "status", "tier"],
  });
  const plan = planFor(accounts, ["status", "tier"]);

  function claimsFor(rows: readonly Record<string, unknown>[]) {
    return buildWarehouseClaims({ workspaceId: WORKSPACE, plan, rows, snapshotAt: SNAPSHOT_AT });
  }

  test("emits the BARE dimension name and keeps the column out of the predicate", () => {
    const { candidates } = claimsFor([
      {
        [SUBJECT_ALIAS]: "Acme Corp",
        [`${DIMENSION_ALIAS_PREFIX}0`]: "active",
        [`${DIMENSION_ALIAS_PREFIX}1`]: "gold",
      },
    ]);
    // The fixture's columns are `col_status` / `col_tier`, so emitting `dim.sql`
    // instead of `dim.name` fails here rather than passing on an equality.
    expect(candidates.map((c) => c.predicate)).toEqual(["status", "tier"]);
    expect(candidates.map((c) => c.predicate)).not.toEqual([columnFor("status"), columnFor("tier")]);
    // The qualification exists — it just does not touch the predicate.
    expect(candidates[0]?.detail).toMatchObject({
      entity: "Accounts",
      table: "accounts",
      connectionGroup: "analytics",
      dimension: "status",
      primaryKeyDimension: "id",
      primaryKey: "Acme Corp",
    });
  });

  test("declares `single` structurally and pins valid time to the snapshot instant", () => {
    const { candidates } = claimsFor([
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
    ]);
    expect(candidates[0]?.predicateCardinality).toBe("single");
    expect(candidates[0]?.validFrom).toEqual(SNAPSHOT_AT);
    // Nothing is DECLARED about the object — `object-cmp.ts` parses the surface on
    // its own terms, and the one declaration that would add information (`money`)
    // needs a currency the entity YAML does not carry.
    expect(candidates[0]?.objectType).toBeUndefined();
  });

  test("an ABSENT cell asserts nothing; an UNSURFACEABLE one is counted", () => {
    // The two are the same `null` out of `warehouseSurface` and they are not the
    // same event: a SQL NULL is the ordinary case, a `jsonb` cell is an enrollment
    // mistake that would otherwise produce a run reading rows, emitting nothing,
    // refusing nothing and logging nothing.
    const { candidates, unsurfaceableCells } = claimsFor([
      {
        [SUBJECT_ALIAS]: "Acme Corp",
        [`${DIMENSION_ALIAS_PREFIX}0`]: null,
        [`${DIMENSION_ALIAS_PREFIX}1`]: "gold",
      },
      {
        [SUBJECT_ALIAS]: "Globex",
        [`${DIMENSION_ALIAS_PREFIX}0`]: { nested: true },
        [`${DIMENSION_ALIAS_PREFIX}1`]: [1],
      },
    ]);
    expect(candidates.map((c) => `${c.subject}/${c.predicate}=${String(c.object)}`)).toEqual([
      "Acme Corp/tier=gold",
    ]);
    // Three abstains, of which exactly two are unsurfaceable — different numbers so
    // a fix that counted all abstains cannot pass.
    expect(unsurfaceableCells).toBe(2);
  });

  test("a BLANK string is absent, not a mistake — the split's own second layer", () => {
    // ⚠️ The first cut of the absent/unsurfaceable split put `''` and `'   '` on the
    // MISTAKE side, which re-instantiated the very collapse the split removes: an
    // empty string is what a CSV or ETL load writes where a source system has a NOT
    // NULL text default, so a perfectly benign column would inflate the counter on
    // every run forever AND make a real `jsonb` enrollment indistinguishable from
    // it — while the warn sent the operator hunting a `jsonb` column that need not
    // exist.
    //
    // The same argument covers a NON-FINITE number and an Invalid Date: `NaN` out of
    // a `double precision` column is that column's null, `0000-00-00` out of MySQL
    // is an Invalid Date, and in both the COLUMN is fine while one row is bad.
    //
    // Four ordinary-empty values and ONE genuine mistake, so the counter cannot pass
    // by counting all abstains (5) or none (0).
    const { candidates, unsurfaceableCells } = claimsFor([
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "", [`${DIMENSION_ALIAS_PREFIX}1`]: "   " },
      { [SUBJECT_ALIAS]: "Initech", [`${DIMENSION_ALIAS_PREFIX}0`]: Number.NaN, [`${DIMENSION_ALIAS_PREFIX}1`]: new Date("nonsense") },
      { [SUBJECT_ALIAS]: "Globex", [`${DIMENSION_ALIAS_PREFIX}0`]: { nested: true }, [`${DIMENSION_ALIAS_PREFIX}1`]: "gold" },
    ]);
    expect(candidates.map((c) => `${c.subject}/${c.predicate}`)).toEqual(["Globex/tier"]);
    expect(unsurfaceableCells).toBe(1);
  });

  test("a row with no usable primary key is counted — and an UNUSABLE key is counted apart from an absent one", () => {
    // ⚠️ The same split the cell position makes. Folded, a `bytea` primary key
    // reports `unidentifiedRows: 900` with no refusal and no log — the "reads nine
    // hundred rows and is indistinguishable from an empty column" failure, at the
    // position where it is worse, because nothing about that entity can EVER be
    // emitted.
    //
    // Two absent keys, one unusable, one good — four different numbers below.
    const { candidates, unidentifiedRows, collidingSubjectRows, unsurfaceableCells, unsurfaceableKeyRows } =
      claimsFor([
        { [SUBJECT_ALIAS]: null, [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
        { [SUBJECT_ALIAS]: "", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
        { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
        { [SUBJECT_ALIAS]: { json: true }, [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      ]);
    expect(candidates).toHaveLength(1);
    expect(unidentifiedRows).toBe(2);
    expect(unsurfaceableKeyRows).toBe(1);
    expect(collidingSubjectRows).toBe(0);
    expect(unsurfaceableCells).toBe(0);
  });

  test("a second row for one subject is dropped whole — including a genuine duplicate key", () => {
    // ⚠️ TWO cases, and the second is the one a comparison-based guard let through.
    // `42` / ` 42 ` are different rows with different ids; `dup` / `dup` are
    // different rows with the SAME id, which fell through and emitted a second full
    // candidate set for one subject while `single` cardinality was proposed for
    // that predicate in the same transaction.
    const { candidates, subjectIds, collidingSubjectRows } = claimsFor([
      { [SUBJECT_ALIAS]: "42", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      { [SUBJECT_ALIAS]: " 42 ", [`${DIMENSION_ALIAS_PREFIX}0`]: "churned" },
      { [SUBJECT_ALIAS]: "dup", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      { [SUBJECT_ALIAS]: "dup", [`${DIMENSION_ALIAS_PREFIX}0`]: "churned" },
    ]);
    expect(candidates.map((c) => `${c.subject}=${String(c.object)}`)).toEqual([
      "42=active",
      "dup=active",
    ]);
    expect(subjectIds.get("42")).toBe(warehouseRowId(WORKSPACE, "Accounts", "42"));
    expect(collidingSubjectRows).toBe(2);
  });

  test("the subject id is what reaches the resolver, and only for surfaces it knows", () => {
    const { subjectIds } = claimsFor([
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
    ]);
    const resolver = warehouseEntityResolver(subjectIds);
    const answer = resolver(new Set(["Acme Corp", "active", "Globex"]), { workspaceId: WORKSPACE });
    expect(answer).not.toBeInstanceOf(Promise);
    const resolved = answer instanceof Promise ? undefined : answer;
    expect(resolved?.get("Acme Corp")?.entityId).toBe(
      warehouseRowId(WORKSPACE, "Accounts", "Acme Corp"),
    );
    // An ABSENT key is the abstain. A blank id would be a contract violation the
    // reconcile seam flags `provisional`.
    expect(resolved?.has("active")).toBe(false);
    expect(resolved?.has("Globex")).toBe(false);
  });
});

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * A store that answers every statement the run issues, and records them all.
 *
 * It dispatches on the EXPORTED SQL constants where the statement is exported, so
 * an edited statement stops matching instead of silently taking a default arm.
 * The cardinality INSERT is not exported, so that one arm matches on the statement
 * text — stated rather than left for a reader to discover, because a SELECT against
 * the same table would otherwise widen it.
 */
class RunStore {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  transactions = 0;
  /** Set to make the episode insert report a conflict (the same instant, twice). */
  episodeConflict = false;
  /** Set to make the episode insert return a row this reader cannot use. */
  episodeReturnsGarbage = false;
  private seq = 0;

  readonly runner: ReconcileTransactionRunner = async <T>(
    fn: (tx: ReconcileExecutor) => Promise<T>,
  ): Promise<T> => {
    this.transactions++;
    return fn({ query: (sql, params) => this.query(sql, params ?? []) });
  };

  paramsFor(sql: string): readonly (readonly unknown[])[] {
    return this.calls.filter((c) => c.sql === sql).map((c) => c.params);
  }

  /** The entity-store rows this run wrote, one array per INSERT (#5043). */
  entityStoreWrites(): readonly (readonly unknown[])[] {
    return this.calls.filter((c) => c.sql === ENTITY_STORE_INSERT_SQL).map((c) => c.params);
  }

  entityStoreDeletes(): readonly (readonly unknown[])[] {
    return this.calls.filter((c) => c.sql === ENTITY_STORE_DELETE_SQL).map((c) => c.params);
  }

  cardinalityWrites(): readonly (readonly unknown[])[] {
    return this.calls
      .filter((c) => c.sql.includes("INSERT INTO brain_predicate_cardinality"))
      .map((c) => c.params);
  }

  private async query(sql: string, params: unknown[]): Promise<{ rows: readonly unknown[] }> {
    this.calls.push({ sql, params });
    if (sql === WAREHOUSE_EPISODE_INSERT_SQL) {
      if (this.episodeConflict) return { rows: [] };
      if (this.episodeReturnsGarbage) return { rows: [{ episode_id: 7 }] };
      return { rows: [{ id: `ep-${++this.seq}` }] };
    }
    if (sql === INSERT_FACT_SQL) return { rows: [{ id: `fact-${++this.seq}` }] };
    if (sql === RECONCILE_LOCK_SQL) return { rows: [] };
    if (sql === CORROBORATION_LOOKUP_SQL) return { rows: [] };
    if (sql === TENSION_CANDIDATES_SQL) return { rows: [] };
    if (sql === INSERT_PROVENANCE_EDGE_SQL) return { rows: [] };
    if (sql === ENTITY_STORE_DELETE_SQL) return { rows: [] };
    if (sql === ENTITY_STORE_INSERT_SQL) return { rows: [] };
    if (sql.includes("brain_predicate_cardinality")) return { rows: [{ inserted: 1 }] };
    throw new Error(`RunStore: unexpected statement\n${sql}`);
  }
}

interface RunHarness {
  readonly store: RunStore;
  readonly snapshots: WarehouseSnapshotRequest[];
  readonly validations: WarehouseSnapshotRequest[];
  /** Every entity-edge batch handed to the vocabulary seam (#5043). */
  readonly edgeBatches: (readonly AliasProposalInput[])[];
  readonly deps: WarehouseProducerDeps;
}

function harness(options: {
  pairs: readonly EnrolledDimension[];
  entities: Record<string, Record<string, unknown> | null>;
  /** Entity names whose lookup THROWS, as `getAdminEntity` does for an ambiguous name. */
  lookupThrows?: readonly string[];
  rows?: Record<string, readonly Record<string, unknown>[]>;
  snapshot?: (request: WarehouseSnapshotRequest) => Promise<readonly Record<string, unknown>[]>;
  /** Entity names whose built statement fails the SQL gate. */
  rejectSqlFor?: readonly string[];
  vocabulary?: ClaimVocabulary;
  rowCap?: number;
  /** Override the persisted store the edge pass reads (#5043). */
  entityStore?: () => Promise<readonly EntityStoreEntry[]>;
  /** What the vocabulary seam reports back. */
  edgeCounters?: AliasProducerCounters;
}): RunHarness {
  const store = new RunStore();
  const snapshots: WarehouseSnapshotRequest[] = [];
  const validations: WarehouseSnapshotRequest[] = [];
  const throwing = new Set(options.lookupThrows ?? []);
  const rejected = new Set(options.rejectSqlFor ?? []);
  const edgeBatches: (readonly AliasProposalInput[])[] = [];
  return {
    store,
    snapshots,
    validations,
    edgeBatches,
    deps: {
      loadReach: async () => makeProducerReach(options.pairs),
      loadEntity: async (_workspaceId, entity) => {
        if (throwing.has(entity)) throw new Error(`"${entity}" resolves in 2 connection groups`);
        return options.entities[entity] ?? null;
      },
      validateSnapshotSql: async (request) => {
        validations.push(request);
        return rejected.has(request.entity)
          ? { valid: false, error: `Table "${request.entity}" is not in the whitelist` }
      // ⚠️ A CAST, and it has to be. `SnapshotSqlVerdict`'s passing arm is branded
      // so no object literal can assert that the product's SQL gate said yes —
      // which is the whole point, since an unbranded `{valid: true}` made the seam
      // the same convention-enforced hole it replaced. The real gate is
      // workspace-whitelist-scoped and this suite has no whitelist, so the bypass
      // is deliberate, named here, and greppable as `as SnapshotSqlVerdict`.
          : ({ valid: true } as SnapshotSqlVerdict);
      },
      runSnapshot: async (request) => {
        snapshots.push(request);
        if (options.snapshot) return options.snapshot(request);
        return options.rows?.[request.entity] ?? [];
      },
      loadVocabulary: async () => options.vocabulary ?? identityVocabulary,
      withTransaction: store.runner,
      // The PERSISTED store, which is what the edge pass reads. Defaults to
      // "whatever this run wrote", which is the ordinary single-run case; a test
      // that needs a pre-existing entry from another entity supplies its own.
      loadEntityStore:
        options.entityStore ??
        (async () =>
          store
            .entityStoreWrites()
            .flatMap((params) => {
              const [, entity, , entityIds, keySurfaces, keyNorms, canonicalSurfaces, canonicalNorms] =
                params as [
                  string,
                  string,
                  string,
                  string[],
                  string[],
                  string[],
                  string[],
                  string[],
                ];
              return entityIds.map((entityId, i) => ({
                entityId: entityId as WarehouseRowId,
                entity,
                keySurface: keySurfaces[i] ?? "",
                keyNorm: keyNorms[i] ?? "",
                canonicalSurface: canonicalSurfaces[i] ?? "",
                canonicalNorm: canonicalNorms[i] ?? "",
              }));
            })),
      proposeAliasEdges: async (_ws, proposals) => {
        edgeBatches.push(proposals);
        return options.edgeCounters ?? EMPTY_EDGE_COUNTERS;
      },
      now: () => SNAPSHOT_AT,
      ...(options.rowCap === undefined ? {} : { rowCap: options.rowCap }),
    },
  };
}

const EMPTY_EDGE_COUNTERS: AliasProducerCounters = {
  queued: 0,
  autoApproved: 0,
  deduped: 0,
  alreadyApproved: 0,
  rejected: 0,
  refused: 0,
};

const run = (h: RunHarness) =>
  runWarehouseProducer({ workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" }, h.deps);

/** One row of an entity whose enrolled dimensions are `d0`, `d1`, … in plan order. */
const snapshotRow = (subject: unknown, ...values: readonly unknown[]) =>
  Object.fromEntries([
    [SUBJECT_ALIAS, subject],
    ...values.map((v, i) => [`${DIMENSION_ALIAS_PREFIX}${i}`, v] as const),
  ]);

describe("runWarehouseProducer", () => {
  test("reads only enrolled dimensions, and emits only for enrolled pairs", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({
          table: "accounts",
          primaryKey: "id",
          // `status` and `arr` exist and are NOT enrolled. A sweep would read them.
          dimensions: ["id", "status", "tier", "arr"],
        }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await run(h);

    // The query itself names the enrolled dimension's COLUMN and nothing else —
    // the strongest available form of "no code path emits for an unenrolled pair",
    // because an unenrolled column never leaves the warehouse.
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.sql).toContain(`${columnFor("tier")} AS`);
    expect(h.snapshots[0]?.sql).not.toContain(columnFor("status"));
    expect(h.snapshots[0]?.sql).not.toContain(columnFor("arr"));
    // …and the positive control: it did emit.
    expect(report.created).toBe(1);
    expect(h.store.paramsFor(INSERT_FACT_SQL)).toHaveLength(1);
  });

  test("validates the built statement BEFORE the snapshot seam is reached", async () => {
    const h = harness({
      pairs: [
        { entity: "Blocked", dimension: "status", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        Blocked: entityYaml({ table: "blocked", primaryKey: "id", dimensions: ["id", "status"] }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rejectSqlFor: ["Blocked"],
      rows: { Small: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await run(h);

    // The gate ran for BOTH entities, and the rejected one never reached the runner
    // — which is the property that survives a substituted runner.
    expect(h.validations.map((v) => v.entity).toSorted()).toEqual(["Blocked", "Small"]);
    expect(h.snapshots.map((s) => s.entity)).toEqual(["Small"]);
    expect(refusalKeys(report.refusals)).toEqual(["Blocked.status:snapshot-rejected"]);
    // ⚠️ The refusal must NOT promise a retry — this failure is permanent.
    expect(report.refusals[0]?.message).toContain("Re-running will not change");
    // …and it must carry the GATE'S OWN reason. Making `error` optional on the
    // verdict left every production refusal reading "no reason given" while this
    // test stayed green, because both sides absorbed the absence with a `??`.
    expect(report.refusals[0]?.message).toContain('Table "Blocked" is not in the whitelist');
    expect(report.created).toBe(1);
  });

  test("a validator that THROWS refuses transiently — a throw is not a verdict of invalid", async () => {
    // ⚠️ TWO properties, and the second is the one that was wrong. A throw must be
    // CAUGHT (the shipped gate dynamically imports a module and reads settings, so
    // a module-init failure or a briefly-unavailable internal DB throws here) — and
    // it must land on the TRANSIENT arm, because `snapshot-rejected` says
    // "re-running will not change this" and tells the admin to un-enroll a pair
    // that is fine.
    const h = harness({
      pairs: [
        { entity: "Throws", dimension: "status", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        Throws: entityYaml({ table: "throws", primaryKey: "id", dimensions: ["id", "status"] }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Small: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      {
        ...h.deps,
        // SYNCHRONOUS, and deliberately not an `async` function: a sync throw
        // happens before the promise exists, so `.catch(…)` never sees it and the
        // throw escaped the entire run as a 500. An `async` double cannot falsify
        // that.
        validateSnapshotSql: (request) => {
          if (request.entity === "Throws") throw new Error("module init failed");
          return Promise.resolve({ valid: true } as SnapshotSqlVerdict);
        },
      },
    );

    expect(refusalKeys(report.refusals)).toEqual(["Throws.status:snapshot-failed"]);
    expect(report.refusals[0]?.reason).not.toBe("snapshot-rejected");
    expect(report.refusals[0]?.message).not.toContain("Re-running will not change");
    // The positive control: one entity throwing costs one entity.
    expect(report.created).toBe(1);
  });

  test("a validator that REJECTS is caught on the same arm", async () => {
    const h = harness({
      pairs: [{ entity: "Rejects", dimension: "status", naming: false }],
      entities: {
        Rejects: entityYaml({ table: "rejects", primaryKey: "id", dimensions: ["id", "status"] }),
      },
    });
    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      { ...h.deps, validateSnapshotSql: async () => Promise.reject(new Error("settings unavailable")) },
    );
    expect(refusalKeys(report.refusals)).toEqual(["Rejects.status:snapshot-failed"]);
  });

  test("an entity-lookup failure keeps the driver's text OFF the wire", async () => {
    // The `snapshot-failed` arm states this policy explicitly; this arm did the
    // opposite and interpolated the caught error, so a pg failure would put an
    // internal host or role into a refusal an operator reads.
    const h = harness({
      pairs: [{ entity: "Ambiguous", dimension: "status", naming: false }],
      entities: {},
      lookupThrows: ["Ambiguous"],
    });
    const report = await run(h);
    expect(refusalKeys(report.refusals)).toEqual(["Ambiguous.status:entity-unreadable"]);
    // The harness throws `"Ambiguous" resolves in 2 connection groups` — the shape a
    // driver message would take. None of it may appear.
    expect(report.refusals[0]?.message).not.toContain("resolves in 2");
    // …and it must still be actionable.
    expect(report.refusals[0]?.message).toContain("server log");
  });

  test("stamps the snapshot episode by REFERENCE — locator, never body", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    await run(h);

    const [binds] = h.store.paramsFor(WAREHOUSE_EPISODE_INSERT_SQL);
    expect(binds?.[0]).toBe(WORKSPACE);
    expect(binds?.[1]).toBe("warehouse");
    expect(binds?.[2]).toBe(`warehouse:Accounts@${SNAPSHOT_AT.toISOString()}`);
    expect(binds?.[3]).toBe(WAREHOUSE_PRODUCER_PRINCIPAL);
    // The locator IS the query that was run. `body` is not a bind at all — the
    // statement writes NULL — which is the by-reference half of the split.
    expect(String(binds?.[4])).toContain("FROM accounts");
    expect(binds?.[6]).toEqual(["org"]);
  });

  test("proposes `warehouse_structural` cardinality, pending, one per enrolled predicate", async () => {
    const h = harness({
      pairs: [
        { entity: "Accounts", dimension: "tier", naming: false },
        { entity: "Accounts", dimension: "status", naming: false },
      ],
      entities: {
        Accounts: entityYaml({
          table: "accounts",
          primaryKey: "id",
          dimensions: ["id", "tier", "status"],
        }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold", "active")] },
    });

    const report = await run(h);

    const writes = h.store.cardinalityWrites();
    expect(writes).toHaveLength(2);
    // ⚠️ The KEY is asserted, and asserted DISTINCTLY per write. Checking only the
    // three constant binds let "propose for `dimensions[0]` twice" pass.
    expect(writes.map((b) => b[1])).toEqual([identityKey("tier"), identityKey("status")]);
    for (const binds of writes) {
      expect(binds[2]).toBe("single");
      expect(binds[3]).toBe("warehouse_structural");
      expect(binds[4]).toBe(WAREHOUSE_PRODUCER);
      // The statement itself is the `pending` half — a producer may not write
      // `approved`, and `proposePredicateCardinality` is what enforces it.
      expect(h.store.calls.find((c) => c.params === binds)?.sql).toContain("'pending'");
    }
    expect(report.entities[0]?.cardinalityProposed.toSorted()).toEqual(["status", "tier"]);
  });

  test("the workspace's predicate vocabulary decides the cardinality key", async () => {
    // Without this, `predicateAlias: vocabulary.predicate` → an identity lookup
    // survives — the silent no-op wearing a successful proposal's face that
    // `proposePredicateCardinalityForSurface`'s own docstring names.
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
      vocabulary: {
        ...identityVocabulary,
        predicate: (norm) => (norm === "tier" ? "tier band" : norm),
      },
    });

    await run(h);

    expect(h.store.cardinalityWrites().map((b) => b[1])).toEqual([identityKey("tier band")]);
    expect(h.store.cardinalityWrites().map((b) => b[1])).not.toEqual([identityKey("tier")]);
  });

  test("refuses an over-cap entity rather than emitting a truncated reading of it", async () => {
    const h = harness({
      rowCap: 2,
      pairs: [
        // TWO dimensions, so a refusal loop that only covered the first goes red.
        { entity: "Big", dimension: "status", naming: false },
        { entity: "Big", dimension: "region", naming: false },
        { entity: "AtCap", dimension: "plan", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        Big: entityYaml({ table: "big", primaryKey: "id", dimensions: ["id", "status", "region"] }),
        // Distinct dimension names per entity: `tier` on both would be AMBIGUOUS and
        // the fail-closed rule would refuse them, which is the rule working and not
        // the cap being tested.
        AtCap: entityYaml({ table: "at_cap", primaryKey: "id", dimensions: ["id", "plan"] }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: {
        // Three rows against a cap of two — the `cap + 1` the query asked for.
        Big: [1, 2, 3].map((n) => snapshotRow(`row-${n}`, "active", "eu")),
        // EXACTLY at the cap, and it must EMIT. Without this row `>` → `>=`
        // survives, and that tightening refuses every table of exactly `cap` rows —
        // the case the `cap + 1` design exists to admit.
        AtCap: [1, 2].map((n) => snapshotRow(`at-${n}`, "gold")),
        Small: [snapshotRow("Acme Corp", "gold")],
      },
    });

    const report = await run(h);

    expect(refusalKeys(report.refusals)).toEqual([
      "Big.region:row-cap-exceeded",
      "Big.status:row-cap-exceeded",
    ]);
    // NOT truncated: nothing at all from `Big`. The two controls carry DIFFERENT
    // counts (2 and 1) so they cannot be swapped for each other.
    expect(report.entities.map((e) => `${e.entity}:${e.created}`).toSorted()).toEqual([
      "AtCap:2",
      "Small:1",
    ]);
    expect(report.created).toBe(3);
  });

  test("a failed snapshot refuses ALL that entity's pairs and leaves the rest of the run alone", async () => {
    const h = harness({
      pairs: [
        { entity: "Broken", dimension: "status", naming: false },
        { entity: "Broken", dimension: "region", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        Broken: entityYaml({
          table: "broken",
          primaryKey: "id",
          dimensions: ["id", "status", "region"],
        }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      snapshot: async (request) => {
        if (request.entity === "Broken") throw new Error("connection refused");
        return [snapshotRow("Acme Corp", "gold")];
      },
    });

    const report = await run(h);

    expect(refusalKeys(report.refusals)).toEqual([
      "Broken.region:snapshot-failed",
      "Broken.status:snapshot-failed",
    ]);
    expect(report.created).toBe(1);
    // The refusal says what did NOT happen, because an operator's first question
    // about a failed producer is whether it retired anything — and unlike
    // `snapshot-rejected`, retrying this one is genuinely worth it.
    expect(report.refusals[0]?.message).toContain("Nothing was invalidated");
    // ⚠️ It says the next run TRIES, and warns that a repeat means the cause is
    // permanent. The gate checks SELECT-only / single-statement / whitelist and NOT
    // that the table exists, so a dropped table throws here on every run forever —
    // "the next run retries the pair" was true and useless.
    expect(report.refusals[0]?.message).toContain("next run tries again");
    expect(report.refusals[0]?.message).toContain("cause is permanent");
  });

  test("an entity lookup that THROWS costs that entity, not the run", async () => {
    // `getAdminEntity` throws `AmbiguousEntityError` for a name in two connection
    // groups — an ordinary multi-group workspace. The lookups run inside a
    // `Promise.all`, so an uncaught throw took down the whole run and returned a
    // 500 in place of the report whose job is explaining why a pair produced
    // nothing.
    const h = harness({
      pairs: [
        { entity: "Ambiguous", dimension: "status", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      lookupThrows: ["Ambiguous"],
      rows: { Small: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await run(h);

    expect(refusalKeys(report.refusals)).toEqual(["Ambiguous.status:entity-unreadable"]);
    expect(report.refusals[0]?.message).toContain("connection group");
    expect(report.created).toBe(1);
  });

  test("a published entity with no `table:` is unreadable, not unpublished", async () => {
    const h = harness({
      pairs: [
        { entity: "NoTable", dimension: "status", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        NoTable: { dimensions: [{ name: "status", sql: "status" }] },
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Small: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await run(h);

    expect(refusalKeys(report.refusals)).toEqual(["NoTable.status:entity-unreadable"]);
    expect(report.refusals[0]?.message).toContain("no `table:`");
    expect(report.created).toBe(1);
  });

  test("an entity that produces no candidates writes no episode and is still REPORTED", async () => {
    // Two distinct silences that must not merge: an entity nothing can be said
    // about still appears in `entities`, and no snapshot episode is written for it
    // (an episode with nothing hanging off it is what the transaction exists to
    // prevent).
    //
    // ⚠️ This is ALSO the path the canonical enrollment mistake takes — an enrolled
    // `jsonb` column yields zero candidates for every row, so it flows through THIS
    // outcome literal and not the one the counters are otherwise tested on. Every
    // number below is DIFFERENT (10 rows, 4 unidentified, 2 colliding, 3
    // unsurfaceable, 1 bad key), so no two fields can be swapped and none can be
    // hardcoded to zero.
    //
    // ⚠️ This comment has now been WRONG TWICE, which is why the numbers are spelled
    // out above rather than trusted. The first cut used `rows: 2` beside
    // `unidentifiedRows: 2`; the second separated those and left `unidentifiedRows`
    // and `unsurfaceableKeyRows` both at 1 — the two counters that ARE the split
    // this fixture exists to pin, so a swap between exactly them survived. Count the
    // values before believing the sentence.
    const h = harness({
      pairs: [{ entity: "Empty", dimension: "status", naming: false }],
      entities: {
        Empty: entityYaml({ table: "empty", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: {
        Empty: [
          snapshotRow(null, { j: 1 }),
          snapshotRow(null, { j: 7 }),
          snapshotRow(null, { j: 8 }),
          snapshotRow(null, { j: 9 }),
          snapshotRow({ bad: "key" }, "active"),
          snapshotRow("dup", { j: 2 }),
          snapshotRow("dup", { j: 3 }),
          snapshotRow(" dup ", { j: 4 }),
          snapshotRow("a", { j: 5 }),
          snapshotRow("b", { j: 6 }),
        ],
      },
    });

    const report = await run(h);

    expect(h.store.paramsFor(WAREHOUSE_EPISODE_INSERT_SQL)).toEqual([]);
    expect(h.store.transactions).toBe(0);
    expect(report.entities).toEqual([
      {
        entity: "Empty",
        rows: 10,
        candidates: 0,
        created: 0,
        corroborated: 0,
        blocked: 0,
        comparable: 0,
        unidentifiedRows: 4,
        collidingSubjectRows: 2,
        unsurfaceableCells: 3,
        unsurfaceableKeyRows: 1,
        cardinalityProposed: [],
        // No episode, no transaction — so nothing was STORED, whatever this
        // snapshot would have implied. `Empty` has no naming dimension either,
        // so `unnamedRows` stays 0: "nobody named a surface" is reported by the
        // plan, not by this counter.
        entitiesStored: 0,
        unnamedRows: 0,
      },
    ]);
  });

  test("the run-level outcome carries each counter from the claims it came from", async () => {
    // Asymmetric values (1 unidentified, 2 colliding, 3 unsurfaceable) so a swap
    // between any two of the three fields goes red.
    const h = harness({
      pairs: [{ entity: "Messy", dimension: "status", naming: false }],
      entities: {
        Messy: entityYaml({ table: "messy", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: {
        Messy: [
          snapshotRow(null, "active"),
          snapshotRow("dup", "active"),
          snapshotRow("dup", "churned"),
          snapshotRow(" dup ", "churned"),
          snapshotRow("a", { j: 1 }),
          snapshotRow("b", [1]),
          snapshotRow("c", { j: 2 }),
        ],
      },
    });

    const report = await run(h);
    const outcome = report.entities[0];

    expect(outcome?.unidentifiedRows).toBe(1);
    expect(outcome?.collidingSubjectRows).toBe(2);
    expect(outcome?.unsurfaceableCells).toBe(3);
    expect(outcome?.rows).toBe(7);
  });

  test("a re-run at the same instant reports the entity rather than dropping it", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });
    h.store.episodeConflict = true;

    const report = await run(h);

    expect(h.store.paramsFor(WAREHOUSE_EPISODE_INSERT_SQL)).toHaveLength(1);
    expect(h.store.paramsFor(INSERT_FACT_SQL)).toHaveLength(0);
    expect(report.created).toBe(0);
    // ⚠️ An entity that vanishes from BOTH lists reads as "never enrolled". A run
    // where every entity conflicted would otherwise be byte-identical to an empty
    // reach, which is the report's whole reason for carrying two lists.
    expect(refusalKeys(report.refusals)).toEqual(["Accounts.tier:snapshot-already-recorded"]);
    expect(report.entities).toEqual([]);
  });

  test("an empty reach opens no transaction and reads no entity", async () => {
    const h = harness({ pairs: [], entities: {} });
    const report = await run(h);
    expect(report.enrolled).toBe(0);
    expect(report.entities).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(h.store.transactions).toBe(0);
  });

  test("a failed reach read PROPAGATES — it must not read as an empty reach", async () => {
    // The two are byte-identical downstream: both emit nothing and leave every
    // test green. ADR-0039 names that as the milestone's central invisibility, so
    // the read is not allowed to degrade to `[]`.
    const h = harness({ pairs: [], entities: {} });
    await expect(
      runWarehouseProducer(
        { workspaceId: WORKSPACE, triggeredBy: "user-1" },
        {
          ...h.deps,
          loadReach: async () => {
            throw new Error("internal DB is down");
          },
        },
      ),
    ).rejects.toThrow("internal DB is down");
  });

  test("a transaction failure REFUSES that entity rather than 500ing the run", async () => {
    // ⚠️ This REVERSES the producer's first stated decision, deliberately. A
    // propagated failure reaches `runEffect` as `500 "Failed to run…"` — while
    // earlier entities have COMMITTED. The admin reads "failed", presses Run again,
    // `now()` yields a fresh instant so `ON CONFLICT` dedupes nothing, and every
    // committed entity files a second full round of drafts into the queue this
    // producer exists to keep reviewable.
    const h = harness({
      pairs: [
        { entity: "Broken", dimension: "status", naming: false },
        { entity: "Small", dimension: "tier", naming: false },
      ],
      entities: {
        Broken: entityYaml({ table: "broken", primaryKey: "id", dimensions: ["id", "status"] }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: {
        Broken: [snapshotRow("Acme Corp", "active")],
        Small: [snapshotRow("Globex", "gold")],
      },
    });
    let calls = 0;
    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      {
        ...h.deps,
        withTransaction: async (fn) => {
          if (++calls === 1) throw new Error("40001 serialization failure");
          return h.store.runner(fn);
        },
      },
    );

    expect(refusalKeys(report.refusals)).toEqual(["Broken.status:snapshot-failed"]);
    // The refusal warns against the blind retry, which is the whole point.
    expect(report.refusals[0]?.message).toContain("drain the review queue");
    // The positive control: the run CONTINUED and the second entity committed.
    expect(report.created).toBe(1);
    expect(report.entities.map((e) => e.entity)).toEqual(["Small"]);
  });

  test("a defect in this module's OWN contract still propagates", async () => {
    // The counterpart of the test above, and the reason the per-entity catch
    // re-throws one class: a `RETURNING` clause the reader cannot parse is a defect,
    // and turning it into a per-entity refusal would make every entity of every run
    // refuse quietly forever on a producer that merely looks unlucky.
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });
    h.store.episodeReturnsGarbage = true;
    await expect(run(h)).rejects.toThrow("RETURNING clause and this reader disagree");
  });
});

// ---------------------------------------------------------------------------
// The entity store (#5043, ADR-0037 §5)
// ---------------------------------------------------------------------------

describe("the entity store", () => {
  const ACCOUNTS = {
    table: "accounts",
    dimensions: [
      { name: "id", sql: "account_id", primary_key: true },
      { name: "name", sql: "display_name" },
      { name: "tier", sql: "plan_tier" },
    ],
  };

  /** The reach with `name` marked as the entity's canonical surface. */
  const namedPairs = [
    { entity: "Accounts", dimension: "name", naming: true },
    { entity: "Accounts", dimension: "tier", naming: false },
  ] as const;

  test("materializes an entry per row and proposes its edge at both positions", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [snapshotRow("42", "Acme Corp", "gold"), snapshotRow("43", "Beta LLC", "silver")],
      },
    });

    const report = await run(h);

    // ⚠️ THE POSITIVE CONTROL for this whole slice, and ADR-0039 is why it has
    // to be here: an empty store and a working one are indistinguishable from
    // inside the code, so every other assertion below could pass against a
    // producer that stored nothing.
    expect(report.entities[0]?.entitiesStored).toBe(2);
    expect(report.entities[0]?.unnamedRows).toBe(0);

    const [params] = h.store.entityStoreWrites();
    expect(params?.[1]).toBe("Accounts");
    // The ids are the SAME digests the facts carry on `subject_cmp` — derived
    // here rather than copied out of the run, so a producer that minted store
    // ids by a different route goes red.
    expect(params?.[3]).toEqual([
      warehouseRowId(WORKSPACE, "Accounts", "42"),
      warehouseRowId(WORKSPACE, "Accounts", "43"),
    ]);
    expect(params?.[4]).toEqual(["42", "43"]);
    expect(params?.[6]).toEqual(["Acme Corp", "Beta LLC"]);
    expect(params?.[7]).toEqual(["acme corp", "beta llc"]);

    // Two entries × two positions.
    expect(h.edgeBatches).toHaveLength(1);
    expect(h.edgeBatches[0]?.map((e) => `${e.position}:${e.fromNorm}->${e.toNorm}`)).toEqual([
      "subject:42->acme corp",
      "object:42->acme corp",
      "subject:43->beta llc",
      "object:43->beta llc",
    ]);
    expect(h.edgeBatches[0]?.every((e) => e.proposedBy === ENTITY_EDGE_PRODUCER)).toBe(true);
  });

  test("stores NOTHING and proposes NOTHING when no dimension names the entity", async () => {
    const h = harness({
      // Same rows, same entity, `naming: false` everywhere. The ONLY difference
      // from the test above.
      pairs: [
        { entity: "Accounts", dimension: "name", naming: false },
        { entity: "Accounts", dimension: "tier", naming: false },
      ],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [snapshotRow("42", "Acme Corp", "gold"), snapshotRow("43", "Beta LLC", "silver")],
      },
    });

    const report = await run(h);

    expect(report.entities[0]?.entitiesStored).toBe(0);
    // 0, not 2. "Nobody named a surface" is reported by `entitiesStored`; this
    // counter is for rows whose named column was EMPTY, and conflating them
    // would send an operator looking at their data for a decision they never made.
    expect(report.entities[0]?.unnamedRows).toBe(0);
    expect(h.store.entityStoreWrites()).toEqual([]);
    // `null`, not zeroed counters — nothing to propose is not the same as
    // proposing and having everything refused.
    expect(report.entityEdges).toBeNull();
    expect(h.edgeBatches).toEqual([]);
    // The CONTROL: the claims still landed, so this is a store that abstained
    // rather than a producer that did nothing.
    expect(report.entities[0]?.created).toBeGreaterThan(0);
  });

  test("DELETEs the entity's entries even with nothing to write — un-naming clears the store", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier", naming: false }],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "gold")] },
    });

    await run(h);

    // Without the unconditional DELETE, every entry written before a human
    // un-named the dimension keeps resolving under a name nobody named any more.
    expect(h.store.entityStoreDeletes()).toEqual([[WORKSPACE, "Accounts"]]);
    expect(h.store.entityStoreWrites()).toEqual([]);
  });

  test("counts a row whose name cell is empty, and stores the rows beside it", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [
          snapshotRow("42", "Acme Corp", "gold"),
          snapshotRow("43", null, "silver"),
          // A name that TRIMS to something and NORMS to nothing.
          snapshotRow("44", "---", "bronze"),
        ],
      },
    });

    const report = await run(h);

    // Distinct numbers: `{1, 2}` cannot be satisfied by an implementation that
    // put every row in one bucket.
    expect(report.entities[0]?.entitiesStored).toBe(1);
    expect(report.entities[0]?.unnamedRows).toBe(2);
  });

  test("a row the claim builder DROPPED never becomes an entry", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [
          snapshotRow("42", "Acme Corp", "gold"),
          // Same primary key — dropped as a colliding subject.
          snapshotRow("42", "Acme Holdings", "silver"),
          // No primary key at all.
          snapshotRow(null, "Ghost Inc", "bronze"),
        ],
      },
    });

    const report = await run(h);

    expect(report.entities[0]?.collidingSubjectRows).toBe(1);
    expect(report.entities[0]?.unidentifiedRows).toBe(1);
    // ONE entry, and its canonical surface is the FIRST row's. A second pass
    // over `rows` — rather than building entries inside the claim loop — would
    // store both and resolve `42` to whichever it wrote last.
    expect(report.entities[0]?.entitiesStored).toBe(1);
    const [params] = h.store.entityStoreWrites();
    expect(params?.[6]).toEqual(["Acme Corp"]);
  });

  test("refuses the edge when two rows share a name, and still stores both", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [
          snapshotRow("42", "Acme", "gold"),
          snapshotRow("43", "acme", "silver"),
          snapshotRow("44", "Gamma", "bronze"),
        ],
      },
    });

    const report = await run(h);

    // BOTH ambiguous rows are stored — they are true snapshots, and dropping one
    // would lie about coverage. It is the READER and the edge producer that
    // abstain.
    expect(report.entities[0]?.entitiesStored).toBe(3);
    expect(h.edgeBatches[0]?.map((e) => `${e.fromNorm}->${e.toNorm}`)).toEqual([
      "44->gamma",
      "44->gamma",
    ]);
  });

  test("reports the vocabulary seam's counters — `rejected` is the re-run signal", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "Acme Corp", "gold")] },
      // A human removed this edge. #4507's permanent rejection memory refuses
      // the re-proposal, and the counter is the ONLY way the run can say so.
      edgeCounters: { ...EMPTY_EDGE_COUNTERS, rejected: 2 },
    });

    const report = await run(h);

    expect(report.entityEdges).toEqual({ ...EMPTY_EDGE_COUNTERS, rejected: 2 });
  });

  test("an edge-pass failure does NOT fail the run — the facts are already committed", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "Acme Corp", "gold")] },
      entityStore: async () => {
        throw new Error("vocabulary lock timeout");
      },
    });

    // A throw here reaches `runEffect` as `500 "Failed to run"`, and the admin's
    // retry files a second full round of drafts into the queue this producer's
    // whole design exists to keep reviewable.
    const report = await run(h);

    expect(report.created).toBeGreaterThan(0);
    expect(report.entities[0]?.entitiesStored).toBe(1);
    expect(report.entityEdges).toBeNull();
  });

  test("the edge pass reads the PERSISTED store, not just this run's entries", async () => {
    // `contacts` was snapshotted on an earlier run and holds the same name. An
    // edge pass scoped to this run would never see it and would merge the two.
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "Acme", "gold")] },
      entityStore: async () => [
        {
          entityId: "wh_this" as WarehouseRowId,
          entity: "Accounts",
          keySurface: "42",
          keyNorm: "42",
          canonicalSurface: "Acme",
          canonicalNorm: "acme",
        },
        {
          entityId: "wh_prior" as WarehouseRowId,
          entity: "Contacts",
          keySurface: "9",
          keyNorm: "9",
          canonicalSurface: "acme",
          canonicalNorm: "acme",
        },
      ] satisfies readonly EntityStoreEntry[],
    });

    const report = await run(h);

    // No batch is handed to the vocabulary seam at all — an empty one would take
    // the workspace lock to say nothing.
    expect(h.edgeBatches).toEqual([]);
    expect(report.entityEdges).toBeNull();
    // ⚠️ The control that separates this from the no-naming-dimension case
    // above, where `entityEdges` is also null: the store DID write an entry.
    // Both facts together are what say "the edge was refused on ambiguity"
    // rather than "nothing was named".
    expect(report.entities[0]?.entitiesStored).toBe(1);
  });
});
