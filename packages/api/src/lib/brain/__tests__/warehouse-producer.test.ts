/**
 * The tier-1 warehouse producer's decisions (#5042, ADR-0037 §4, ADR-0039).
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **Generated — see `packages/api/scripts/mutations/warehouse-producer.md`.** The
 * mutation list is `packages/api/scripts/mutations/warehouse-producer.mutations.ts`,
 * and the table measures each mutation against this suite and four others —
 * `-logging`, `-bypass`, `-mint` and `-pg` — which are its other columns:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/warehouse-producer.mutations.ts
 *
 * The `-pg` column needs `TEST_DATABASE_URL`; without it the runner aborts on a
 * deflated baseline rather than publishing that column as zeros.
 *
 * Those numbers used to live in commit messages, hand-measured during #5042's
 * review, where nothing re-ran them (#5229). Read the columns against each other:
 * this one is the widest, and several rows die ONLY here.
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
  ENTITY_STORE_LIVE_IDS_SQL,
  ENTITY_STORE_RENAME_RECONCILE_SQL,
  ENTITY_STORE_REAP_SQL,
  ENTITY_EDGE_PRODUCER,
  type EntityStoreEntry,
  type StoredEntity,
} from "@atlas/api/lib/brain/entity-store";
import { ENTITY_RUN_SUCCESS_INSERT_SQL } from "@atlas/api/lib/brain/warehouse-run-record";
import { ENTITY_COMPARABLE_RETIRE_SQL } from "@atlas/api/lib/brain/entity-comparable-retire";
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
  mapEntitiesToConnectionIds,
  mergeWarehouseClaims,
  parseWarehouseEntity,
  planWarehouseEmission,
  runWarehouseProducer,
  warehouseEntityResolver,
  warehouseRowId,
  warehouseSurface,
  type WarehouseDimension,
  type WarehouseEntity,
  type WarehouseEntityLookup,
  type WarehouseEntityPlan,
  type WarehouseClaims,
  type WarehouseProducerDeps,
  type SnapshotSqlValidator,
  type SnapshotSqlVerdict,
  type ValidatedSnapshotRequest,
  type WarehouseConnectionId,
  type WarehouseConnectionPlacement,
  type WarehousePlacementTarget,
  type WarehouseRowId,
  type WarehouseSnapshotRequest,
  type WarehouseSnapshotRunner,
} from "@atlas/api/lib/brain/warehouse-producer";

const WORKSPACE = "ws-5042";
const SNAPSHOT_AT = new Date("2026-08-14T10:00:00.000Z");

/**
 * A {@link WarehouseConnectionPlacement} from the placed pairs alone.
 *
 * The cast is the point of the brand rather than a hole in it: a test is allowed to
 * assert "this string IS a connection id", and production has exactly one such cast,
 * where `loadVisibleGroups` answers. What the brand refuses is the SILENT swap — a
 * connection GROUP id flowing into the value position because both are `string`.
 */
const placement = (
  placed: Readonly<Record<string, string | readonly string[]>>,
  unplaceable: WarehouseConnectionPlacement["unplaceable"] = [],
): WarehouseConnectionPlacement => ({
  placed: new Map(
    // A bare string is the ONE-member group, which is what nearly every case here
    // means; a list is a group whose members the run must all read (#5326).
    Object.entries(placed).map(([name, id]) => [
      name,
      (typeof id === "string" ? [id] : id) as readonly WarehouseConnectionId[],
    ]),
  ),
  unplaceable,
});

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
  const dims = [first, ...rest] as [WarehouseDimension, ...WarehouseDimension[]];
  // The INDEX, resolved by name against the very array the plan returns — so a
  // fixture cannot hand `buildWarehouseClaims` a position that is not in it.
  const namingIndex = naming === undefined ? -1 : dims.findIndex((d) => d.name === naming);
  if (naming !== undefined && namingIndex === -1) {
    throw new Error(`fixture "${entity.name}" cannot name "${naming}" — it is not a planned dimension`);
  }
  return {
    entity,
    primaryKey,
    dimensions: dims,
    namingDimensionIndex: namingIndex === -1 ? null : namingIndex,
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
      { entity: "Accounts", group: null, dimension: "status", naming: false },
      { entity: "Accounts", group: null, dimension: "tier", naming: false },
      { entity: "Contracts", group: null, dimension: "status", naming: false },
      { entity: "Contracts", group: null, dimension: "region", naming: false },
      { entity: "Contracts", group: null, dimension: "owner", naming: false },
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
      { entity: "Accounts", group: null, dimension: "status", naming: false },
      // Enrolled, but the entity left the published semantic layer. The producer
      // is not producing from it, so `status` is not ambiguous.
      { entity: "Contracts", group: null, dimension: "status", naming: false },
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
        { entity: "Accounts", group: null, dimension: "status", naming: false },
        { entity: "Contracts", group: null, dimension: "Status", naming: false },
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
      makeProducerReach([{ entity: "Accounts", group: null, dimension: "tier", naming: false }]),
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
    const claimsFrom = (entity: WarehouseEntity, connectionGroup: string | null) =>
      buildWarehouseClaims({
        workspaceId: WORKSPACE,
        plan: planFor(entity, ["price"]),
        rows: [row],
        snapshotAt: SNAPSHOT_AT,
        connectionGroup,
        connectionId: null,
      }).candidates;

    const [fromAnalytics] = claimsFrom(analytics, "analytics");
    const [fromBilling] = claimsFrom(billing, "billing");

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
        { entity: "Plans", group: null, dimension: "price", naming: false },
        { entity: "Products", group: null, dimension: "price", naming: false },
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
        { entity: "NoKey", group: null, dimension: "status", naming: false },
        { entity: "Composite", group: null, dimension: "status", naming: false },
        { entity: "Orders", group: null, dimension: "total_revenue", naming: false },
        { entity: "Orders", group: null, dimension: "typo", naming: false },
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
        { entity: "Broken", group: null, dimension: "status", naming: false },
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
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
   *
   * ⚠️ **This block REDS if you run it in the same `bun test` invocation as
   * `warehouse-producer-mint.test.ts`, and that is the tripwire working.** That
   * suite `mock.module`s `lib/tools/sql`, whose blast radius is the process, so the
   * real gate is not what answers here. The isolated runner spawns per file, so CI
   * and `bun run test` are unaffected; a hand-run of both files together is not, and
   * the red is telling you this block measured a stub. Run them separately.
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
      // ⚠️ And a POSITIVE tripwire, which the negative one cannot supply: this is
      // the SHIPPED gate's own wording. A negative assertion is satisfied by any
      // stub that happens not to say that phrase, and `mock.module` is process-wide
      // — so co-locating a suite that stubs `lib/tools/sql` in one `bun test`
      // invocation made this whole block pass against the stub's message instead.
      expect(reason(result)).toMatch(/allowed list|catalog\.yml/);
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
    return buildWarehouseClaims({
      workspaceId: WORKSPACE,
      plan,
      rows,
      snapshotAt: SNAPSHOT_AT,
      // The member read is a separate axis from the group (#5326) and has its own
      // case below; these fixtures are about the group, so they read the flat scope.
      connectionId: null,
      // The RESOLVED group (#5314), which is what `detail.connectionGroup`
      // records. The fixture's YAML hint says `analytics` too, deliberately: the
      // dedicated test below is the one that drives them APART.
      connectionGroup: "analytics",
    });
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

  /**
   * #5314 — the recorded group is the RESOLVED one, and the YAML hint cannot
   * substitute for it.
   *
   * ⚠️ **The fixture's hint is `null`, which is the PRODUCTION shape rather than
   * a corner.** {@link WarehouseEntity.connection} records that a DB-backed
   * semantic layer stores the scope in the row's `connection_group_id` and
   * leaves the YAML `connection:` field empty for every entity — so the old
   * `detail.connectionGroup: plan.entity.connection` wrote `null` on every SaaS
   * fact, including ones that came from a real group. Measured on prod `us`
   * (#5197's row-count read): two facts from an enrollment whose
   * `connection_group_id` was non-empty recorded `"connectionGroup": null`.
   *
   * The pair of assertions is what makes this falsifiable rather than
   * decorative: reverting the write to the hint fails the first, and reading
   * BOTH (a `??` between them) fails the second.
   */
  test("records the RESOLVED connection group, not the YAML `connection:` hint", () => {
    const dbBacked = parsed("Accounts", {
      // No `connection:` at all — the shape every entity on a DB-backed
      // semantic layer has.
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "status"],
    });
    expect(dbBacked.connection, "the fixture must carry no hint, or this proves nothing").toBeNull();

    const { candidates } = buildWarehouseClaims({
      workspaceId: WORKSPACE,
      plan: planFor(dbBacked, ["status"]),
      rows: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" }],
      snapshotAt: SNAPSHOT_AT,
      connectionGroup: "grp-42",
      connectionId: null,
    });
    expect(candidates[0]?.detail?.connectionGroup).toBe("grp-42");

    // …and where the two DISAGREE the resolved group wins. An author's
    // `connection:` hint overrides which datasource is READ
    // (`runWarehouseProducer`'s `resolvedConnection`); it is not the group the
    // claim came FROM, and provenance records the second.
    const hinted = parsed("Accounts", {
      table: "accounts",
      connection: "analytics",
      primaryKey: "id",
      dimensions: ["id", "status"],
    });
    const { candidates: fromHinted } = buildWarehouseClaims({
      workspaceId: WORKSPACE,
      plan: planFor(hinted, ["status"]),
      rows: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" }],
      snapshotAt: SNAPSHOT_AT,
      connectionGroup: "grp-42",
      connectionId: null,
    });
    expect(fromHinted[0]?.detail?.connectionGroup).toBe("grp-42");
  });

  test("the flat scope stays `null` — no second translator for `''`", () => {
    // `brain_enrollment`'s `fromStoredGroup` is the ONE place `''` becomes
    // `null`, and the producer must not grow a second one: a value that means
    // the flat scope in two spellings is how the two ends stop agreeing.
    const { candidates } = buildWarehouseClaims({
      workspaceId: WORKSPACE,
      plan,
      rows: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" }],
      snapshotAt: SNAPSHOT_AT,
      connectionGroup: null,
      connectionId: null,
    });
    expect(candidates[0]?.detail?.connectionGroup).toBeNull();
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

  /** The per-entity success records this run wrote (#5317). */
  runSuccesses(): readonly (readonly unknown[])[] {
    return this.calls
      .filter((c) => c.sql === ENTITY_RUN_SUCCESS_INSERT_SQL)
      .map((c) => c.params);
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
    if (sql === ENTITY_RUN_SUCCESS_INSERT_SQL) return { rows: [] };
    // The three statements #5319/#5320/#5321 added to the minting transaction.
    // Each answers "nothing", which is the state a fresh store is in: no live
    // ids to retire, no divergent name to reconcile, nothing old enough to reap.
    // Dispatched on the EXACT bytes for this harness's whole reason — a
    // paraphrase would stay green against an edited statement.
    if (sql === ENTITY_STORE_LIVE_IDS_SQL) return { rows: [] };
    if (sql === ENTITY_STORE_RENAME_RECONCILE_SQL) return { rows: [] };
    if (sql === ENTITY_STORE_REAP_SQL) return { rows: [] };
    if (sql === ENTITY_COMPARABLE_RETIRE_SQL) return { rows: [] };
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
  /**
   * Make the vocabulary seam THROW after it has been handed a batch (#5277).
   *
   * ⚠️ The batch is recorded in `edgeBatches` BEFORE the throw, deliberately: that
   * is what the real `proposeAliasEdges` does — it commits per proposal, so a
   * mid-batch failure leaves approved edges behind. A seam that threw without
   * recording would model "nothing was submitted", which is the OTHER failure and
   * the one this option exists to be distinguishable from.
   */
  edgeProposeThrows?: string;
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
      // ⚠️ A CAST, and it has to be. The passing verdict carries a branded
      // `ValidatedSnapshotRequest`, so no object literal can assert that the
      // product's SQL gate said yes — which is the whole point, since an unbranded
      // `{valid: true}` made the seam the same convention-enforced hole it
      // replaced. The real gate is workspace-whitelist-scoped and this suite has no
      // whitelist, so the bypass is deliberate, named here, and greppable.
      //
      // ⚠️ It brands THE REQUEST IT WAS HANDED, by reference. Minting a fresh object
      // here would satisfy the type and be refused by the run loop's identity check
      // (#5230) — which is the anti-replay guard, and it does not exempt harnesses.
          : { valid: true, request: request as ValidatedSnapshotRequest };
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
        if (options.edgeProposeThrows !== undefined) throw new Error(options.edgeProposeThrows);
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

/**
 * The placement rule, driven directly (#5284).
 *
 * ⚠️ **These exist because the I/O half CANNOT be driven here at all, and that made
 * the rule dead code no mutation could kill.** `test-setup.ts` strips `DATABASE_URL`
 * and points `ATLAS_SEMANTIC_ROOT` at an empty directory, so `listAdminEntities`
 * takes its disk branch over an empty root and answers `[]`. Every run test in this
 * file therefore exercised the shipped resolver returning an empty placement — they
 * passed *because it did nothing*, and `defaultResolveConnectionIds → return {placed:
 * new Map(), unplaceable: []}` survived the entire tree.
 */
describe("mapEntitiesToConnectionIds (#5284)", () => {
  const visible = new Map<string, readonly WarehouseConnectionId[]>([
    ["g-eu", ["eu-prod" as WarehouseConnectionId]],
    ["g-us", ["us-prod" as WarehouseConnectionId]],
    // A group of THREE, for the cases about how many members a placement carries
    // (#5326). The rosters above stay single-member so every other case here goes
    // on being about the rule it was written for.
    [
      "g-prod",
      ["apac-prod", "eu-prod", "us-prod"] as unknown as readonly WarehouseConnectionId[],
    ],
  ]);

  /** The placed map as plain string lists — the brand is a producer-side guarantee,
   * not something an assertion should have to restate. */
  const placedOf = (out: WarehouseConnectionPlacement) =>
    Object.fromEntries<readonly string[]>(out.placed);

  test("a group-scoped entity resolves to its group's PRIMARY member", () => {
    const out = mapEntitiesToConnectionIds(
      [
        { name: "Accounts", connectionId: "g-eu" },
        { name: "Orders", connectionId: "g-us" },
      ],
      [{ entity: "Accounts", group: null }, { entity: "Orders", group: null }],
      visible,
      true,
    );

    expect(placedOf(out)).toEqual({ Accounts: ["eu-prod"], Orders: ["us-prod"] });
    expect(out.unplaceable).toEqual([]);
  });

  test("an entity nobody enrolled is not placed", () => {
    const out = mapEntitiesToConnectionIds(
      [
        { name: "Accounts", connectionId: "g-eu" },
        { name: "Secrets", connectionId: "g-us" },
      ],
      [{ entity: "Accounts", group: null }],
      visible,
      true,
    );

    expect([...out.placed.keys()]).toEqual(["Accounts"]);
    expect(out.unplaceable).toEqual([]);
  });

  test("a FLAT entity is left unplaced rather than resolved to the literal \"default\"", () => {
    const out = mapEntitiesToConnectionIds(
      [{ name: "Accounts", connectionId: null }],
      [{ entity: "Accounts", group: null }],
      visible,
      true,
    );

    // ⚠️ The arm the review caught: `resolveGroupPrimaryConnectionId` answers
    // `"default"` for a null group, and that string is NOT interchangeable with the
    // `undefined` this workspace produced before the seam existed — `validateSQL`
    // sends it to `getDBType("default")`, which throws `ConnectionNotRegisteredError`
    // until something has touched the default pool, where `undefined` takes
    // `detectDBType()`. Placing it would refuse every flat workspace to fix grouped ones.
    expect(out.placed.size).toBe(0);
    expect(out.placed.get("Accounts")).toBeUndefined();
    expect(out.unplaceable).toEqual([]);
  });

  test("a name published under TWO groups is unplaceable, not silently defaulted", () => {
    const out = mapEntitiesToConnectionIds(
      [
        { name: "Accounts", connectionId: "g-eu" },
        // The `__global__` shadow case: the catalog read is `org_id = $1 OR org_id =
        // '__global__'`, while the run loop's `getEntity` is `org_id = $1` alone. So
        // this name looks ambiguous HERE and resolves cleanly THERE — and the old
        // code's justification for omitting it ("the loader is about to refuse it
        // anyway") is false for exactly this population.
        { name: "Accounts", connectionId: null },
        { name: "Orders", connectionId: "g-us" },
      ],
      [{ entity: "Accounts", group: null }, { entity: "Orders", group: null }],
      visible,
      true,
    );

    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "ambiguous-group" }]);
    // The positive control, at a different size: the sibling in the same call still
    // resolves, so this is not "the whole placement collapsed".
    expect(placedOf(out)).toEqual({ Orders: ["us-prod"] });
  });

  test("two rows of the SAME group are overlay state, not ambiguity", () => {
    const out = mapEntitiesToConnectionIds(
      [
        { name: "Accounts", connectionId: "g-eu" },
        { name: "Accounts", connectionId: "g-eu" },
      ],
      [{ entity: "Accounts", group: null }],
      visible,
      true,
    );

    // Ambiguity is "multiple GROUPS", not "multiple rows" — `getEntity`'s own
    // definition. Counting rows (which the first cut did) refuses an entity for
    // being ordinary: one group holding a published and a draft row is normal.
    expect(out.unplaceable).toEqual([]);
    expect(placedOf(out)).toEqual({ Accounts: ["eu-prod"] });
  });

  test("a group missing from the visible set is unplaceable", () => {
    const out = mapEntitiesToConnectionIds(
      [
        { name: "Accounts", connectionId: "g-hidden" },
        { name: "Orders", connectionId: "g-us" },
      ],
      [{ entity: "Accounts", group: null }, { entity: "Orders", group: null }],
      visible,
      true,
    );

    // Previously this degraded to submitting the GROUP ID as a connection id, which
    // surfaced as `Connection "g-hidden" is not registered` under the TRANSIENT
    // "the next run tries again" wording — for a condition that repeats every run.
    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "group-not-visible" }]);
    expect(placedOf(out)).toEqual({ Orders: ["us-prod"] });
  });

  test("an enrolled name absent from a GROUP-SCOPED catalog is unplaceable", () => {
    const out = mapEntitiesToConnectionIds(
      [{ name: "Orders", connectionId: "g-us" }],
      [{ entity: "Accounts", group: null }, { entity: "Orders", group: null }],
      visible,
      true,
    );

    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "absent-from-catalog" }]);
    expect(placedOf(out)).toEqual({ Orders: ["us-prod"] });
  });

  test("an enrolled name absent from a NON-authoritative catalog is left to the default", () => {
    const out = mapEntitiesToConnectionIds(
      [{ name: "Orders", connectionId: null }],
      [{ entity: "Accounts", group: null }, { entity: "Orders", group: null }],
      visible,
      false,
    );

    // The disk fallback — pure-YAML self-hosted, or no workspace in scope — where
    // connection groups are not the scoping mechanism and the deployment default is
    // right, exactly as before #5284. This is also the shape this whole suite runs
    // under, which is why the flag is a passed-in FACT and not an inference.
    expect(out.unplaceable).toEqual([]);
    expect(out.placed.size).toBe(0);
  });

  test("an entity whose group was hidden is refused even when the clause DELETED its row", () => {
    // ⚠️ **The asymmetry that the first cut of this fix got wrong, and it reproduced
    // the exact defect the fix exists to end.** That cut inferred "is this catalog
    // group-scoped" from `summaries.some((s) => s.connectionId !== null)` — but the
    // visibility clause in `listEntityRows` is what REMOVES a group-scoped row from
    // the catalog when its datasource is unpublished. So a workspace whose only group
    // just went invisible keeps its `__global__` demo rows (group `null`), the
    // inference read FALSE, and the enrolled entity was defaulted to the demo
    // database with nothing refused.
    //
    // Same condition, two shapes, and they must agree:
    //   row SURVIVES the clause  → `group-not-visible`  (the test above)
    //   row DELETED by the clause → `absent-from-catalog` (this one)
    const out = mapEntitiesToConnectionIds(
      // Only the ungrouped `__global__` demo rows are left. Nothing here is
      // group-scoped, which is precisely what made the old inference say "flat".
      [{ name: "DemoAccounts", connectionId: null }],
      [{ entity: "Accounts", group: null }],
      visible,
      true,
    );

    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "absent-from-catalog" }]);
    expect(out.placed.size).toBe(0);
  });

  test("an EMPTY catalog places nothing and refuses nothing", () => {
    const out = mapEntitiesToConnectionIds([], [{ entity: "Accounts", group: null }], visible, false);

    expect(out.placed.size).toBe(0);
    expect(out.unplaceable).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // #5286 — the enrollment's OWN group, where one exists
  // ---------------------------------------------------------------------------

  test("a DECLARED group places a name the catalog holds under three of them", () => {
    // ⚠️ **This is staging's exact shape, and before #5286 it was unplaceable.**
    // `test_orders` is published under three connection groups, so the inference
    // below refused it `ambiguous-group` on every run — including runs whose
    // enrollment named one of the three, because the enrollment could not carry
    // a group to name it with.
    const catalog = [
      { name: "test_orders", connectionId: "g-clickhouse" },
      { name: "test_orders", connectionId: "g-mysql" },
      { name: "test_orders", connectionId: "g-eu" },
    ];
    const out = mapEntitiesToConnectionIds(
      catalog,
      [{ entity: "test_orders", group: "g-eu" }],
      visible,
      true,
    );

    expect(placedOf(out)).toEqual({ test_orders: ["eu-prod"] });
    expect(out.unplaceable).toEqual([]);
  });

  test("the SAME catalog still refuses the same name when the enrollment names no group", () => {
    // ⚠️ The control that makes the test above mean something. Identical catalog,
    // identical visible groups — only the enrollment's own group differs. Without
    // this, "declared groups place" is equally satisfied by an implementation
    // that stopped refusing ambiguity altogether, which would put a snapshot on
    // whichever database sorted first.
    //
    // It is also the pre-0205 path, which a backfilled row still takes: the
    // inference is kept for rows written before the column existed, and
    // `ambiguous-group` remains the honest answer for the ones 0205's own
    // backfill could not resolve.
    const catalog = [
      { name: "test_orders", connectionId: "g-clickhouse" },
      { name: "test_orders", connectionId: "g-mysql" },
      { name: "test_orders", connectionId: "g-eu" },
    ];
    const out = mapEntitiesToConnectionIds(
      catalog,
      [{ entity: "test_orders", group: null }],
      visible,
      true,
    );

    expect(out.placed.size).toBe(0);
    expect(out.unplaceable).toEqual([{ entity: "test_orders", cause: "ambiguous-group" }]);
  });

  test("a declared group that is NOT visible is refused, never defaulted", () => {
    const out = mapEntitiesToConnectionIds(
      [{ name: "Accounts", connectionId: "g-gone" }],
      [{ entity: "Accounts", group: "g-gone" }],
      visible,
      true,
    );

    expect(out.placed.size).toBe(0);
    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "group-not-visible" }]);
  });

  test("a declared group the catalog no longer publishes the name under is refused", () => {
    // An enrollment outliving its entity's group is ordinary — nothing
    // un-enrolls on a semantic-layer sync, by 0199's design. Placing it on the
    // group's primary anyway would point a snapshot at a database that no longer
    // answers for that name, and the refusal it earned would be a whitelist
    // rejection blaming the SQL.
    const out = mapEntitiesToConnectionIds(
      [{ name: "Accounts", connectionId: "g-us" }],
      [{ entity: "Accounts", group: "g-eu" }],
      visible,
      true,
    );

    expect(out.placed.size).toBe(0);
    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "absent-from-catalog" }]);
  });

  test("a NON-authoritative (disk) catalog does not refuse a declared group it lacks", () => {
    // `catalogIsAuthoritative` is the same fact the `absent-from-catalog` arm
    // above turns on, and it must gate this arm too: on the disk-fallback branch
    // a name missing from the catalog establishes nothing, so refusing it would
    // break pure-YAML self-hosted deploys that group their entities in
    // directories.
    const out = mapEntitiesToConnectionIds(
      [],
      [{ entity: "Accounts", group: "g-eu" }],
      visible,
      false,
    );

    expect(placedOf(out)).toEqual({ Accounts: ["eu-prod"] });
    expect(out.unplaceable).toEqual([]);
  });

  test("a multi-member group places EVERY member, in the roster's order (#5326)", () => {
    // The placement is where "which datasource" is answered, and answering it with
    // one member of three is what made the store describe a quarter of the company.
    // The order is the roster's, which `loadVisibleGroups` already sorts — stable
    // across runs, so one run's snapshots are comparable to the last one's.
    const out = mapEntitiesToConnectionIds(
      [{ name: "organization", connectionId: "g-prod" }],
      [{ entity: "organization", group: "g-prod" }],
      visible,
      true,
    );

    expect(placedOf(out)).toEqual({ organization: ["apac-prod", "eu-prod", "us-prod"] });
    expect(out.unplaceable).toEqual([]);
  });

  test("a group whose roster is EMPTY is unplaceable, not placed with nothing to read (#5326)", () => {
    // ⚠️ Unreachable through `loadVisibleGroups` today — it builds `members` from
    // `groupToMembers.get(id) ?? [id]` and cannot answer `[]`. Pinned because of what
    // it costs the day that changes: an empty list placed here loops zero times in the
    // run, merges to zero claims, and reports as a SUCCESSFUL read of an empty table.
    // That is byte-identical to "this entity has no rows", which is the silence the
    // two-state placement type exists to remove.
    const out = mapEntitiesToConnectionIds(
      [{ name: "Accounts", connectionId: "g-empty" }],
      [{ entity: "Accounts", group: "g-empty" }],
      new Map([["g-empty", [] as readonly WarehouseConnectionId[]]]),
      true,
    );

    expect(out.placed.size).toBe(0);
    expect(out.unplaceable).toEqual([{ entity: "Accounts", cause: "group-not-visible" }]);
  });
});

describe("mergeWarehouseClaims (#5326)", () => {
  /** One member's claims, with only the fields a case actually asserts on. */
  const memberClaims = (
    connection: string,
    subjects: Readonly<Record<string, string>>,
    extra: Partial<WarehouseClaims> = {},
  ) => ({
    connection,
    claims: {
      candidates: Object.keys(subjects).map((subject) => ({
        subject,
        predicate: "tier",
        object: "gold",
        validFrom: SNAPSHOT_AT,
      })),
      subjectIds: new Map(
        Object.entries(subjects).map(([surface, id]) => [surface, id as WarehouseRowId]),
      ),
      entityEntries: [],
      unnamedRows: 0,
      unidentifiedRows: 0,
      collidingSubjectRows: 0,
      unsurfaceableCells: 0,
      unsurfaceableKeyRows: 0,
      unsurfaceableByDimension: new Map<string, number>(),
      ...extra,
    } as WarehouseClaims,
  });

  test("disjoint members merge into the union, and every counter is summed", () => {
    const out = mergeWarehouseClaims([
      memberClaims("eu-prod", { "org-eu-1": "wh_eu1" }, {
        unnamedRows: 1,
        unidentifiedRows: 2,
        collidingSubjectRows: 3,
        unsurfaceableCells: 4,
        unsurfaceableKeyRows: 5,
        unsurfaceableByDimension: new Map([["tier", 4]]),
      }),
      memberClaims("us-prod", { "org-us-1": "wh_us1", "org-us-2": "wh_us2" }, {
        unnamedRows: 10,
        unidentifiedRows: 20,
        collidingSubjectRows: 30,
        unsurfaceableCells: 40,
        unsurfaceableKeyRows: 50,
        unsurfaceableByDimension: new Map([
          ["tier", 40],
          ["plan", 7],
        ]),
      }),
    ]);

    expect(out.kind).toBe("merged");
    if (out.kind !== "merged") return;
    expect(out.claims.candidates).toHaveLength(3);
    expect([...out.claims.subjectIds.keys()].sort()).toEqual(["org-eu-1", "org-us-1", "org-us-2"]);
    // Summed, not taken from the last member — a merge that overwrote would report
    // the second member's numbers as the union's and look entirely plausible.
    expect(out.claims.unnamedRows).toBe(11);
    expect(out.claims.unidentifiedRows).toBe(22);
    // ⚠️ The WITHIN-member drops still count, and they are a different fact from a
    // cross-member collision: this entity's declared key repeats inside a member.
    expect(out.claims.collidingSubjectRows).toBe(33);
    expect(out.claims.unsurfaceableCells).toBe(44);
    expect(out.claims.unsurfaceableKeyRows).toBe(55);
    // Per DIMENSION, summed across members — the operator's action is to un-enroll
    // ONE pair, so the number has to stay attached to the dimension it came from.
    expect(Object.fromEntries(out.claims.unsurfaceableByDimension)).toEqual({ tier: 44, plan: 7 });
  });

  test("a subject in TWO members refuses, naming both — and every member is examined first", () => {
    const out = mergeWarehouseClaims([
      memberClaims("apac-prod", { "1": "wh_apac1" }),
      memberClaims("eu-prod", { "2": "wh_eu2" }),
      memberClaims("us-prod", { "1": "wh_us1", "2": "wh_us2" }),
    ]);

    expect(out.kind).toBe("subject-collision");
    if (out.kind !== "subject-collision") return;
    // TWO distinct surfaces collide, and all three members hold one of them. Settling
    // at the first pair would name two members and count one — and would decide which
    // member "wins", which is first-writer-wins across shards under another name.
    expect(out.collidingSubjects).toBe(2);
    expect(out.members).toEqual(["apac-prod", "eu-prod", "us-prod"]);
  });

  test("one member merges to itself — the single-datasource case is the same path", () => {
    // No branch beside the loop for `members.length === 1`: a second path for the
    // ordinary case is a second thing to keep true, and it is the one every other
    // test in this file exercises.
    const only = memberClaims("default", { "Acme Corp": "wh_acme" });
    const out = mergeWarehouseClaims([only]);

    expect(out.kind).toBe("merged");
    if (out.kind !== "merged") return;
    expect(out.claims.candidates).toEqual(only.claims.candidates);
    expect([...out.claims.subjectIds]).toEqual([...only.claims.subjectIds]);
  });
});

describe("runWarehouseProducer", () => {
  test("reads only enrolled dimensions, and emits only for enrolled pairs", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
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

  test("snapshots run against the entity's CONNECTION GROUP, not the default connection", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: {
        // NO YAML `connection:` — which is every entity on a DB-backed semantic
        // layer, where the scope lives in the row's `connection_group_id` and
        // never in the document.
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    // ⚠️ The stub RECORDS its arguments instead of ignoring them. Every stub here
    // used to be `async () => new Map([...])`, so nothing asserted what the producer
    // actually passed — and two mutations were green against the whole tree because
    // of it: `resolveConnectionIds(workspaceId, [])`, which places nothing and puts
    // every entity back on the default datasource (#5284 verbatim), and
    // `resolveConnectionIds("", reach.entities)`, which sends `listAdminEntities` an
    // empty org and falls to its DISK-ROOT branch — a SaaS workspace resolving its
    // connection groups from whatever YAML is on the box.
    const calls: { ws: string; names: readonly WarehousePlacementTarget[] }[] = [];
    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async (ws, names) => {
          calls.push({ ws, names });
          return placement({ Accounts: "us-prod" });
        },
      },
    );

    // ⚠️ The TARGETS, not bare names (#5286): the seam is handed each entity's
    // enrolled group, which is what lets a multi-group workspace resolve at all.
    expect(calls).toEqual([{ ws: WORKSPACE, names: [{ entity: "Accounts", group: null }] }]);

    // Before #5284 this was `undefined`: the run read the YAML hint, found null,
    // and sent every snapshot to the deployment's `default` datasource. On a SaaS
    // deploy that is a DIFFERENT database, so the entity refused with `relation
    // "accounts" does not exist` while its pair sat in the list looking enrolled.
    expect(h.snapshots[0]?.connectionId).toBe("us-prod");
    // The GATE has to be told the same connection. Its table whitelist is
    // per-connection, so validating against one datasource and reading another
    // would clear a table the target does not have — the two ids agreeing is the
    // property, not either one alone.
    expect(h.validations[0]?.connectionId).toBe("us-prod");
    expect(report.created).toBe(1);
  });

  test("a group-scoped enrollment's emitted provenance records its group (#5314)", async () => {
    const h = harness({
      // Enrolled UNDER A GROUP — the multi-group SaaS shape #5286 made storable.
      pairs: [{ entity: "Accounts", group: "grp-42", dimension: "tier", naming: false }],
      entities: {
        // …and, as on every DB-backed semantic layer, the document names no
        // connection at all. This is the exact pair of conditions that produced
        // `"connectionGroup": null` on prod `us`.
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      { ...h.deps, resolveConnectionIds: async () => placement({ Accounts: "us-prod" }) },
    );
    expect(report.created).toBe(1);

    // Read off the INSERT the run actually issued rather than off
    // `buildWarehouseClaims`' return value: the unit test above pins the builder,
    // and what this one adds is that the resolved group survives the whole run
    // loop into the row. `$8` is `INSERT_FACT_SQL`'s `provenance`.
    const [factParams] = h.store.paramsFor(INSERT_FACT_SQL);
    const provenance: unknown = JSON.parse(String(factParams?.[7]));
    expect(provenance).toMatchObject({ connectionGroup: "grp-42", entity: "Accounts" });
  });

  /**
   * #5326 — a multi-member group is SNAPSHOT PER MEMBER, not once against the
   * alphabetically-first one.
   *
   * ⚠️ **Driven at the RUN, not at `mapEntitiesToConnectionIds`, and the first
   * cut of this test got that wrong.** The pure placement function stores
   * whatever the resolver hands it, so a test that passed it an array and read
   * the array back was green against the unfixed code — an assertion that could
   * not fail. The behaviour that is actually broken is *how many datasources a
   * run reads*, and only the run loop can be wrong about that. (The placement
   * type now says `readonly WarehouseConnectionId[]`, so that first cut would no
   * longer even compile; the case stays here because the type is not what makes
   * the run read them.)
   *
   * Measured on prod: `g_prod` = `apac-prod` / `eu-prod` / `us-prod` holding
   * 1 / 1 / 2 orgs. The run read `apac-prod` alone — "a" sorts first — and filed
   * 1 of 4 orgs as the workspace's, unqualified, because the keys carry the
   * entity name and no member.
   */
  test("every member of a multi-member group is snapshot, not just one (#5326)", async () => {
    const h = harness({
      pairs: [{ entity: "organization", group: "g-prod", dimension: "plan_tier", naming: false }],
      entities: {
        organization: entityYaml({
          table: "organization",
          primaryKey: "id",
          dimensions: ["id", "plan_tier"],
        }),
      },
      // Each member answers with its OWN row — shards, not replicas. Keyed by the
      // connection the runner was asked for, so a run that reads one member
      // cannot accidentally collect the others' rows.
      snapshot: async (request) =>
        request.connectionId === "us-prod"
          ? [snapshotRow("org-us-1", "pro"), snapshotRow("org-us-2", "free")]
          : request.connectionId === "eu-prod"
            ? [snapshotRow("org-eu-1", "trial")]
            : [snapshotRow("org-apac-1", "trial")],
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () =>
          placement({ organization: ["us-prod", "apac-prod", "eu-prod"] }),
      },
    );

    // THE assertion: one snapshot per member, against all three connections.
    expect(
      // `?? "default"` is the flat scope's spelling in a request, and it keeps this a
      // sort of STRINGS — `(string | undefined)[]).sort()` is a type-aware lint error
      // here, and it is right to be: an implicit sort of `undefined` is not ordering.
      [...new Set(h.snapshots.map((r) => r.connectionId ?? "default"))].sort(),
      "the run read one datasource of a three-member group — that describes a fraction of the rows and files them as the whole (#5326)",
    ).toEqual(["apac-prod", "eu-prod", "us-prod"]);
    // …and every member's rows reached the claims, so the union is described
    // rather than one shard standing in for it.
    expect(report.created).toBe(4);
  });

  /**
   * #5326's other half — the union is only sound while the members' keys are
   * disjoint, and this is what happens when they are not.
   *
   * Two shards keyed by per-shard sequential integers is the realistic shape: both
   * hold a row `1`, and every key the producer writes carries the entity name and
   * NOT the member (`brain_entity.entity_id` hashes `(workspace, entity, primary
   * key)`). Merging them files two customers as one subject — a false `same` at the
   * publish gate, the direction with no inverse — so the entity is refused whole.
   */
  test("a subject held by TWO members refuses the entity rather than merging them (#5326)", async () => {
    const h = harness({
      pairs: [{ entity: "organization", group: "g-prod", dimension: "plan_tier", naming: false }],
      entities: {
        organization: entityYaml({
          table: "organization",
          primaryKey: "id",
          dimensions: ["id", "plan_tier"],
        }),
      },
      // ⚠️ `1` in BOTH shards, and different rows: `pro` here, `free` there. Sharing
      // one row id across shards is exactly what a per-shard sequence produces.
      snapshot: async (request) =>
        request.connectionId === "us-prod"
          ? [snapshotRow("1", "pro"), snapshotRow("2", "free")]
          : [snapshotRow("1", "trial")],
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () => placement({ organization: ["eu-prod", "us-prod"] }),
      },
    );

    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]?.reason).toBe("subject-collides-across-members");
    // ⚠️ It NAMES the members. A refusal saying only "two of your datasources
    // overlap" is the difference between a gap and a bug report — #5326's own
    // acceptance criterion, and the reason the merge returns them rather than a
    // boolean.
    expect(report.refusals[0]?.message).toContain('"eu-prod"');
    expect(report.refusals[0]?.message).toContain('"us-prod"');
    // …and never the colliding KEY. It is a primary key read out of a customer's
    // warehouse — an email, an account name — and this module keeps row values off
    // the wire. The count is what the operator acts on.
    expect(report.refusals[0]?.message).toContain("1 of");

    // NOTHING was written. The non-colliding row (`2`, in `us-prod` alone) is not
    // emitted either: it would be an arbitrary subset of two populations, which at
    // rest reads exactly like a complete reading of one.
    expect(h.store.paramsFor(INSERT_FACT_SQL)).toHaveLength(0);
    expect(report.entities).toEqual([]);
    // Both members WERE read — the collision is settled over the whole set, not at
    // the first pair, so which member "wins" is never decided.
    expect(h.snapshots).toHaveLength(2);
  });

  test("the same key in ONE member is still a counted drop, not a refusal (#5326)", async () => {
    // The scope boundary the merge draws. Within one member a repeated key is a
    // data-quality note about a declared key that is not unique — the surviving
    // rows still describe that table — and folding it into the cross-member
    // refusal would tell an operator their shards overlap when they do not.
    const h = harness({
      pairs: [{ entity: "organization", group: "g-prod", dimension: "plan_tier", naming: false }],
      entities: {
        organization: entityYaml({
          table: "organization",
          primaryKey: "id",
          dimensions: ["id", "plan_tier"],
        }),
      },
      snapshot: async (request) =>
        request.connectionId === "us-prod"
          ? [snapshotRow("1", "pro"), snapshotRow("1", "free")]
          : [snapshotRow("2", "trial")],
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () => placement({ organization: ["eu-prod", "us-prod"] }),
      },
    );

    expect(report.refusals).toEqual([]);
    expect(report.entities[0]?.collidingSubjectRows).toBe(1);
    // The union's two surviving subjects, and the union's three rows.
    expect(report.entities[0]?.rows).toBe(3);
    expect(report.created).toBe(2);
  });

  test("provenance records WHICH member a claim was read from (#5326)", async () => {
    // Before this, `connectionGroup` recorded `g_prod` and nothing recorded the
    // member — so a human auditing a fact could not tell an `apac-prod` row from a
    // `us-prod` one, which is the question the measurement behind #5326 had to
    // answer by hand, against the databases, because the record could not.
    const h = harness({
      pairs: [{ entity: "organization", group: "g-prod", dimension: "plan_tier", naming: false }],
      entities: {
        organization: entityYaml({
          table: "organization",
          primaryKey: "id",
          dimensions: ["id", "plan_tier"],
        }),
      },
      snapshot: async (request) =>
        request.connectionId === "us-prod" ? [snapshotRow("org-us-1", "pro")] : [],
    });

    await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () => placement({ organization: ["eu-prod", "us-prod"] }),
      },
    );

    const [factParams] = h.store.paramsFor(INSERT_FACT_SQL);
    const provenance: unknown = JSON.parse(String(factParams?.[7]));
    // The MEMBER beside the group — the group alone cannot answer "which database".
    expect(provenance).toMatchObject({ connection: "us-prod", entity: "organization" });
  });

  test("the row cap is about the UNION, not one member at a time (#5326)", async () => {
    // ⚠️ Two members of 3 rows each against a cap of 4. Per member both pass; the
    // union does not. `WAREHOUSE_ROW_CAP`'s reason is that every row becomes a draft
    // a person has to review, and a review queue does not get twice as long because
    // the rows arrived from two datasources.
    const h = harness({
      pairs: [{ entity: "organization", group: "g-prod", dimension: "plan_tier", naming: false }],
      entities: {
        organization: entityYaml({
          table: "organization",
          primaryKey: "id",
          dimensions: ["id", "plan_tier"],
        }),
      },
      rowCap: 4,
      snapshot: async (request) =>
        request.connectionId === "us-prod"
          ? [snapshotRow("us-1", "pro"), snapshotRow("us-2", "pro"), snapshotRow("us-3", "pro")]
          : [snapshotRow("eu-1", "trial"), snapshotRow("eu-2", "trial"), snapshotRow("eu-3", "trial")],
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () => placement({ organization: ["eu-prod", "us-prod"] }),
      },
    );

    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]?.reason).toBe("row-cap-exceeded");
    // It names the group's size and the member it was reading when the union
    // crossed the cap, so the operator knows this is not one oversized table.
    expect(report.refusals[0]?.message).toContain("2 datasources");
    expect(h.store.paramsFor(INSERT_FACT_SQL)).toHaveLength(0);
  });

  test("a YAML `connection:` hint stays ONE read, even for a multi-member group (#5326)", async () => {
    // An author naming a datasource outright is more specific than the row's group,
    // and #5326 does not widen a deliberate single-datasource answer into a fan-out
    // nobody asked for. The hint wins whole: one request, against `authored`.
    const h = harness({
      pairs: [{ entity: "Accounts", group: "g-prod", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({
          table: "accounts",
          connection: "authored",
          primaryKey: "id",
          dimensions: ["id", "tier"],
        }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () =>
          placement({ Accounts: ["eu-prod", "us-prod", "apac-prod"] }),
      },
    );

    expect(h.snapshots.map((r) => r.connectionId)).toEqual(["authored"]);
  });

  test("the connection is resolved ONCE per run, not once per entity", async () => {
    const h = harness({
      pairs: [
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
        { entity: "Orders", group: null, dimension: "status", naming: false },
      ],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
        Orders: entityYaml({ table: "orders", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: {
        Accounts: [snapshotRow("Acme Corp", "gold")],
        Orders: [snapshotRow("Order 1", "shipped")],
      },
    });

    let resolveCalls = 0;
    await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async (_ws, names) => {
          resolveCalls += 1;
          return placement(Object.fromEntries(names.map((n) => [n, "us-prod"])));
        },
      },
    );

    // The claim the call site's comment makes ("ONE resolution per run, not one per
    // entity"). Moving the call inside the per-entity loop killed nothing while the
    // stubs were idempotent — two entities is the smallest fixture that can tell.
    expect(resolveCalls).toBe(1);
    expect(h.snapshots).toHaveLength(2);
  });

  test("a YAML `connection:` hint still overrides the resolved group", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({
          table: "accounts",
          connection: "authored",
          primaryKey: "id",
          dimensions: ["id", "tier"],
        }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      { ...h.deps, resolveConnectionIds: async () => placement({ Accounts: "us-prod" }) },
    );

    // An author naming a datasource outright is more specific than the row's
    // group, so the hint wins. Asserted because the fix inverted nothing: the
    // group is the FALLBACK the hint never had.
    expect(h.snapshots[0]?.connectionId).toBe("authored");
  });

  test("a YAML `connection: default` hint is the flat scope, not a connection named \"default\"", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: {
        // ⚠️ `connection: default` is this repo's OWN spelling of the flat root — the
        // implied group name in `whitelist.ts`, and a documented entity YAML value.
        Accounts: entityYaml({
          table: "accounts",
          connection: "default",
          primaryKey: "id",
          dimensions: ["id", "tier"],
        }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await run(h);

    // ⚠️ The two spellings are NOT interchangeable downstream, and the runner and the
    // gate disagree about them: `defaultRunSnapshot` collapses `undefined` and
    // `"default"` to one pool, while `validateSQL` sends the literal to
    // `getDBType("default")`, which throws until something has touched the default
    // pool. Passed through, this entity took a PERMANENT `snapshot-rejected` blaming
    // the whitelist — on the flat self-hosted workspace the arm exists to protect.
    expect(h.validations[0]?.connectionId).toBeUndefined();
    expect(h.snapshots[0]?.connectionId).toBeUndefined();
    // Positive controls: it ran, and it produced.
    expect(h.snapshots).toHaveLength(1);
    expect(report.created).toBe(1);
    expect(report.refusals).toEqual([]);
  });

  test("an UNPLACED entity reads the default connection; an UNPLACEABLE one reads nothing", async () => {
    const h = harness({
      pairs: [
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
        { entity: "Orders", group: null, dimension: "status", naming: false },
      ],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
        Orders: entityYaml({ table: "orders", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: {
        Accounts: [snapshotRow("Acme Corp", "gold")],
        Orders: [snapshotRow("Order 1", "shipped")],
      },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        // The two states a bare `ReadonlyMap` could not tell apart, in ONE run and
        // with DIFFERENT outcomes: `Accounts` is simply ungrouped (a flat workspace,
        // where the deployment default is right), `Orders` is a name Atlas could not
        // place at all (where the default is the #5284 bug).
        resolveConnectionIds: async () =>
          placement({}, [{ entity: "Orders", cause: "ambiguous-group" }]),
      },
    );

    // The unplaced one ran, against the default connection — `undefined`, never the
    // literal `"default"`, which takes a different branch in the SQL gate.
    expect(h.snapshots.map((s) => s.entity)).toEqual(["Accounts"]);
    expect(h.snapshots[0]?.connectionId).toBeUndefined();

    // ⚠️ THE POSITIVE CONTROL. `toBeUndefined()` alone was satisfied by
    // `h.snapshots.length === 0` — this file's own documented hazard #1, a producer
    // that emitted nothing at all passing a test about what it emitted. The two
    // sides are deliberately different sizes (1 snapshot, 1 refusal, 1 created).
    expect(report.created).toBe(1);

    // The unplaceable one never reached the datasource, and is REFUSED rather than
    // dropped — every enrolled pair stays accounted for in the report.
    expect(h.validations.map((v) => v.entity)).toEqual(["Accounts"]);
    expect(report.refusals).toEqual([
      {
        entity: "Orders",
        dimension: "status",
        reason: "connection-unresolved",
        message: expect.stringContaining("more than one database answers"),
      },
    ]);
  });

  test("each unplaceable cause names its OWN remedy", async () => {
    // One shared "check your connection groups" would be the generic message
    // CLAUDE.md forbids, on a refusal whose own text says re-running will not help.
    // The three causes are three different jobs, so the messages must differ.
    const causes = ["ambiguous-group", "group-not-visible", "absent-from-catalog"] as const;
    const messages: string[] = [];

    for (const cause of causes) {
      const h = harness({
        pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
        entities: {
          Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
        },
        rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
      });
      const report = await runWarehouseProducer(
        { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
        {
          ...h.deps,
          resolveConnectionIds: async () => placement({}, [{ entity: "Accounts", cause }]),
        },
      );
      expect(h.snapshots).toHaveLength(0);
      messages.push(report.refusals[0]?.message ?? "");
    }

    expect(new Set(messages).size).toBe(causes.length);
    // ⚠️ The ACTIONABLE half of the ambiguous-group remedy, and it changed with
    // #5286: re-enrolling through the picker now records which entity was meant,
    // which the old "rename one of them" advice could not offer because there was
    // nothing to record it in. Renaming still works and the sentence still says
    // so; the assertion is on the remedy an admin reaches for first.
    expect(messages[0]).toContain("enroll it again");
    expect(messages[1]).toContain("Check the datasource is published");
    expect(messages[2]).toContain("Republish the entity");
    // ⚠️ The `group-not-visible` remedy must admit the DEGRADED case as well as the
    // unpublished one: `loadVisibleGroups` never throws — it answers `[]` when the
    // whitelist read fails — so this arm also fires for a datasource that IS
    // published, and a remedy naming only "unpublished" would be false there.
    expect(messages[1]).toContain("could not read the workspace's whitelist");
  });

  test("a failed connection resolution ABANDONS the run rather than defaulting it", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    // The third member of the propagating set, alongside the reach and the
    // vocabulary. Degrading to an empty placement here is indistinguishable from "no
    // entity is group-scoped" — #5284 applied to the whole workspace at once — so a
    // resolver that cannot answer must take the run down, not guess.
    await expect(
      runWarehouseProducer(
        { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
        {
          ...h.deps,
          resolveConnectionIds: async () => {
            throw new Error("internal DB down");
          },
        },
      ),
    ).rejects.toThrow("internal DB down");

    // Nothing was read and nothing was stamped on the way down.
    expect(h.snapshots).toHaveLength(0);
    expect(h.validations).toHaveLength(0);
  });

  test("validates the built statement BEFORE the snapshot seam is reached", async () => {
    const h = harness({
      pairs: [
        { entity: "Blocked", group: null, dimension: "status", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
        { entity: "Throws", group: null, dimension: "status", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
          return Promise.resolve({
            valid: true,
            request: request as ValidatedSnapshotRequest,
          });
        },
      },
    );

    expect(refusalKeys(report.refusals)).toEqual(["Throws.status:snapshot-failed"]);
    expect(report.refusals[0]?.reason).not.toBe("snapshot-rejected");
    expect(report.refusals[0]?.message).not.toContain("Re-running will not change");
    // The positive control: one entity throwing costs one entity.
    expect(report.created).toBe(1);
  });

  test("a REPLAYED verdict cannot authorize a different statement (#5230)", async () => {
    // ⚠️ THE SHAPE #5230 EXISTS FOR, and nothing in it is forged. The validator
    // mints ONE genuine passing token — for the first request it is handed — and
    // hands the same token back for every entity after that:
    //
    //   cached ??= await validate(FIRST_REQUEST)
    //
    // Under a verdict that only said "something passed", every later entity reached
    // the datasource on a token about a statement it has nothing to do with. The
    // verdict now carries the request it passed, and the run loop compares it by
    // IDENTITY against what it submitted.
    const h = harness({
      pairs: [
        { entity: "First", group: null, dimension: "status", naming: false },
        { entity: "Second", group: null, dimension: "tier", naming: false },
      ],
      entities: {
        First: entityYaml({ table: "first", primaryKey: "id", dimensions: ["id", "status"] }),
        Second: entityYaml({ table: "second", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      // ⚠️ DIFFERENT row counts, so the two entities cannot be told apart by
      // accident: an assertion that both ran and one that only the first did would
      // otherwise read the same on `created`.
      rows: {
        First: [snapshotRow("Acme Corp", "gold")],
        Second: [snapshotRow("Beta Ltd", "silver"), snapshotRow("Gamma Inc", "bronze")],
      },
    });

    let cached: SnapshotSqlVerdict | undefined;
    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-replay" },
      {
        ...h.deps,
        validateSnapshotSql: async (request) => {
          h.validations.push(request);
          return (cached ??= { valid: true, request: request as ValidatedSnapshotRequest });
        },
      },
    );

    // The gate was consulted for both — the replay is at the VERDICT, not the call.
    expect(h.validations.map((v) => v.entity).toSorted()).toEqual(["First", "Second"]);

    // Exactly one entity reached the runner: the one the cached token is actually
    // about. Asserted relationally rather than by name, because which entity the
    // planner emits first is not this test's subject.
    expect(h.snapshots).toHaveLength(1);
    const ran = h.snapshots[0]?.entity;
    // ⚠️ WHICH one ran, not merely that one did. `not.toBe(ran)` alone is satisfied
    // by an INVERTED check (`===` instead of `!==`), which runs the wrong entity on
    // the cached token and refuses the right one — the mutation this test is the
    // subject of, and the one it could not see. The cached token is about the first
    // request the gate was handed, so that entity is the one that may run.
    expect(ran).toBe(h.validations[0]?.entity);
    // …and the row counts differ (1 vs 2), so `created` says which entity's rows
    // were read rather than only that reading happened.
    expect(report.created).toBe(1);
    expect(refusalKeys(report.refusals)).toHaveLength(1);
    const refused = report.refusals[0];
    expect(refused?.entity).not.toBe(ran);
    // TRANSIENT, not `snapshot-rejected`: the statement was never judged, so a
    // message saying "re-running will not change this" would describe a check that
    // did not happen.
    expect(refused?.reason).toBe("snapshot-failed");
    expect(refused?.message).not.toContain("Re-running will not change");
    expect(refused?.message).toContain("could not confirm");
    // The operator's only handle: the report carries no request id, so the refusal
    // has to name it inline or the instruction to quote it is unfollowable.
    expect(refused?.message).toContain("req-replay");
  });

  test("a verdict carrying a RECONSTRUCTED request is refused too (#5230)", async () => {
    // Identity, not field equality. A validator that returns a token for an object
    // with the same fields is indistinguishable at the field level from one
    // returning a token for a statement it rewrote — the gate's answer is about the
    // object it was given, so a copy is refused. Without this the check could be
    // weakened to a deep compare and the test above would stay green, since a
    // CACHED token differs in fields as well as in identity.
    const h = harness({
      pairs: [{ entity: "Copied", group: null, dimension: "status", naming: false }],
      entities: {
        Copied: entityYaml({ table: "copied", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: { Copied: [snapshotRow("Acme Corp", "active")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      {
        ...h.deps,
        validateSnapshotSql: async (request) => ({
          valid: true,
          request: { ...request } as ValidatedSnapshotRequest,
        }),
      },
    );

    expect(h.snapshots).toEqual([]);
    expect(refusalKeys(report.refusals)).toEqual(["Copied.status:snapshot-failed"]);
    // ⚠️ The MESSAGE, because `snapshot-failed` is shared by four arms — the gate
    // throwing, the snapshot read throwing, a rolled-back transaction, and this one
    // — and only the message tells them apart. (The gate REJECTING is
    // `snapshot-rejected`, a different reason.) Without it this test passes on a run
    // that refused for an entirely different reason.
    expect(report.refusals[0]?.message).toContain("could not confirm");
    expect(report.created).toBe(0);
  });

  test("a validator that MUTATES the request after validating is refused (#5230)", async () => {
    // ⚠️ The residual the identity check reads as if it had closed. `readonly` is
    // erased at runtime, so a validator can validate, rewrite `sql`, and hand back
    // the SAME reference — identity passes and the datasource reads a statement the
    // gate never saw. The request is frozen, so the write throws instead, onto the
    // gate-threw arm. `Object.assign` rather than `request.sql = …`: the latter is a
    // compile error against the `readonly` field, and a test that cannot be written
    // is not evidence about runtime.
    const h = harness({
      pairs: [{ entity: "Mutated", group: null, dimension: "status", naming: false }],
      entities: {
        Mutated: entityYaml({ table: "mutated", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: { Mutated: [snapshotRow("Acme Corp", "active")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      {
        ...h.deps,
        validateSnapshotSql: async (request) => {
          Object.assign(request, { sql: "SELECT * FROM salaries" });
          return { valid: true, request: request as ValidatedSnapshotRequest };
        },
      },
    );

    expect(h.snapshots).toEqual([]);
    expect(refusalKeys(report.refusals)).toEqual(["Mutated.status:snapshot-failed"]);
    // The TRANSIENT arm, and specifically the gate-threw one rather than the
    // mismatch one — the write throws before a verdict exists.
    expect(report.refusals[0]?.message).toContain("could not check the query");
    expect(report.created).toBe(0);
  });

  test("a verdict whose `request` ANSWERS DIFFERENTLY on each read is refused (#5230)", async () => {
    // ⚠️ Identity across TWO PROPERTY ACCESSES is not identity. `validation` comes
    // from the seam the check defends against, so `validation.request` is an
    // expression the implementer controls: a getter answers the guard with the
    // honest request and the runner with another object. Freezing the request closes
    // mutation and leaves this open; only capturing the value once closes it.
    //
    // Worse than the mutation hole it sits beside: the substituted object carries its
    // own `workspaceId`/`connectionId`, and `defaultRunSnapshot` selects the
    // connection pool from those — a cross-tenant read, not merely a gate bypass.
    const h = harness({
      pairs: [{ entity: "Aliased", group: null, dimension: "status", naming: false }],
      entities: {
        Aliased: entityYaml({ table: "aliased", primaryKey: "id", dimensions: ["id", "status"] }),
      },
      rows: { Aliased: [snapshotRow("Acme Corp", "active")] },
    });

    let reads = 0;
    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      {
        ...h.deps,
        validateSnapshotSql: async (request) => {
          const other = { ...request, sql: "SELECT * FROM salaries" };
          return {
            valid: true,
            get request() {
              // First read: the honest object, so the guard passes. Every read after:
              // a different statement.
              return (reads++ === 0 ? request : other) as ValidatedSnapshotRequest;
            },
          };
        },
      },
    );

    // ⚠️ EXACTLY ONE read. Two would mean the guard's value and the runner's
    // argument came from separate property accesses — the defect, even on a read
    // that happens to return the same thing.
    expect(reads).toBe(1);
    // …and the statement that reached the runner is the one the gate approved, not
    // the getter's second answer. This is the assertion that goes red without the
    // capture: the run still succeeds, silently, on the wrong statement.
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.sql).not.toContain("salaries");
    expect(h.snapshots[0]?.sql).toContain("aliased");
    // A refusal here would be a DIFFERENT, weaker outcome — the honest request did
    // pass the gate, so the entity is expected to produce.
    expect(report.refusals).toEqual([]);
    expect(report.created).toBe(1);
  });

  test("the runner's parameter refuses an unvalidated request — ordering is a TYPE (#5230)", () => {
    // ⚠️ A COMPILE-TIME assertion, and `bun run type` is where it fails. `@ts-expect-error`
    // is an error when the line it guards has NO error, so widening
    // `WarehouseSnapshotRunner` back to a bare request — or dropping the brand —
    // reds the type gate rather than quietly restoring the hole this issue closed.
    // Statement order was the only thing sequencing validate-then-run before #5230.
    const runner: WarehouseSnapshotRunner = async () => [];
    const bare: WarehouseSnapshotRequest = {
      workspaceId: WORKSPACE,
      entity: "Unvalidated",
      connectionId: undefined,
      sql: "SELECT 1",
    };
    // @ts-expect-error a bare request has not passed the SQL gate, and the runner says so
    const call = () => runner(bare);
    // ⚠️ Keep the guarded line MINIMAL. `@ts-expect-error` suppresses *any* error on
    // its line, so a line that grows can start satisfying the directive for a reason
    // that has nothing to do with the brand.
    expect(typeof call).toBe("function");

    // The BRAND, not only the parameter — three more one-line claims, each measured
    // against `bun run type` rather than reasoned about. Without these, deleting the
    // brand from the verdict's passing arm would leave only the runner's parameter
    // pinned, and the replay half of #5230 would go quiet.
    // @ts-expect-error the passing verdict cannot be written as a literal carrying a bare request
    const literal: SnapshotSqlVerdict = { valid: true, request: bare };
    // @ts-expect-error a validator cannot return a token for a request the gate has not branded
    const mint: SnapshotSqlValidator = async (r) => ({ valid: true, request: r });
    // @ts-expect-error the runner cannot be narrowed to a function taking a bare request
    const widened: (r: WarehouseSnapshotRequest) => Promise<readonly Record<string, unknown>[]> =
      runner;
    // ⚠️ This asserts NOTHING about the brand, and saying so is the point. The three
    // values are referenced so the unused-vars rule is satisfied; the CLAIM is each
    // `@ts-expect-error` directive above, and `bun run type` is where it fails. An
    // `every(v => v !== null)` here read like an assertion and had no reachable red.
    expect([literal, mint, widened]).toHaveLength(3);
  });

  test("a validator that REJECTS is caught on the same arm", async () => {
    const h = harness({
      pairs: [{ entity: "Rejects", group: null, dimension: "status", naming: false }],
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
      pairs: [{ entity: "Ambiguous", group: null, dimension: "status", naming: false }],
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
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
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
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
        { entity: "Accounts", group: null, dimension: "status", naming: false },
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
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
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
        { entity: "Big", group: null, dimension: "status", naming: false },
        { entity: "Big", group: null, dimension: "region", naming: false },
        { entity: "AtCap", group: null, dimension: "plan", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
    // ⚠️ The PER-MEMBER arm's own wording, and asserting it is what keeps that arm
    // falsifiable now that a union check sits beside it (#5326). The union of ONE
    // member is the same number, so deleting `rowCount > rowCap` still refuses this
    // entity with the same REASON — the message is the only thing that can tell the
    // two arms apart, and a row-cap test that reads only the reason went green
    // against a producer whose per-member cap had been removed.
    expect(report.refusals[0]?.message).toContain('"big" holds more than 2 rows');
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
        { entity: "Broken", group: null, dimension: "status", naming: false },
        { entity: "Broken", group: null, dimension: "region", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
        { entity: "Ambiguous", group: null, dimension: "status", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
        { entity: "NoTable", group: null, dimension: "status", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
      pairs: [{ entity: "Empty", group: null, dimension: "status", naming: false }],
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
    // ⚠️ ONE transaction, and it holds exactly ONE statement — the success record
    // (#5317). This assertion used to be `transactions).toBe(0)`, and relaxing it
    // to `1` alone would have given up what it was protecting: that a
    // zero-candidate entity does no RECONCILE work. So it is spelled as the
    // statement set instead, which is strictly stronger than the count was — an
    // episode, a fact or a store write appearing here now fails, and the count
    // alone could not have said which.
    //
    // The record itself belongs here: a read that returned rows and produced no
    // claims SUCCEEDED, and it is the arm #5233's reaper depends on — see
    // migration 0206's header, and `warehouse-run-record-pg.test.ts`.
    expect(h.store.transactions).toBe(1);
    // The reap rides the same transaction as the record it reads (#5321), so
    // the zero-candidate arm is two statements now and the ORDER is the claim:
    // the success this run just wrote has to be inside the window the reap
    // reads, or the rule lags a full cycle behind itself.
    expect(h.store.calls.map((c) => c.sql)).toEqual([
      ENTITY_RUN_SUCCESS_INSERT_SQL,
      ENTITY_STORE_REAP_SQL,
    ]);
    expect(h.store.runSuccesses()).toEqual([[WORKSPACE, "Empty", SNAPSHOT_AT.toISOString()]]);
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
      pairs: [{ entity: "Messy", group: null, dimension: "status", naming: false }],
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
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
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
        { entity: "Broken", group: null, dimension: "status", naming: false },
        { entity: "Small", group: null, dimension: "tier", naming: false },
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
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
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

describe("planWarehouseEmission — the naming dimension (#5043)", () => {
  const withName = (entity: string, dimension: string) =>
    ({ entity, group: null, dimension, naming: true }) as const;

  test("resolves the naming dimension to a position in the plan's OWN dimension list", () => {
    const accounts = parsed("Accounts", {
      table: "accounts",
      primaryKey: "id",
      dimensions: ["id", "name", "tier"],
    });
    const plan = planWarehouseEmission(
      makeProducerReach([
        withName("Accounts", "name"),
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
      ]),
      found(accounts),
    );
    const emitted = plan.emit[0];
    // An INDEX, and it must point at `name` within `dimensions` — not at the
    // entity's full YAML dimension list, which also contains `id`. Resolving
    // against `entity.dimensions` (the defect this block's comment argues
    // against) yields a different position and reads the wrong column.
    expect(emitted?.namingDimensionIndex).not.toBeNull();
    expect(emitted?.dimensions[emitted.namingDimensionIndex ?? -1]?.name).toBe("name");
  });

  test("a naming dimension the plan REFUSED lands null AND is reported, never silent", () => {
    // ⚠️ The data-destroying case. `name` is enrolled on two entities, so the
    // ambiguity rule refuses it on BOTH — it leaves `dimensions`, the snapshot
    // never selects its column, and the producer's unconditional DELETE then
    // clears every entry the entity already had. Folded into the same `null` as
    // "nobody named this entity", that reported `entitiesStored: 0` while the
    // enrollment surface still showed the badge.
    const accounts = parsed("Accounts", { table: "accounts", primaryKey: "id", dimensions: ["id", "name", "tier"] });
    const contracts = parsed("Contracts", { table: "contracts", primaryKey: "id", dimensions: ["id", "name"] });
    const plan = planWarehouseEmission(
      makeProducerReach([
        withName("Accounts", "name"),
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
        withName("Contracts", "name"),
      ]),
      found(accounts, contracts),
    );

    const accountsPlan = plan.emit.find((e) => e.entity.name === "Accounts");
    // Still emitting — `tier` survived, so this is not "the entity dropped out".
    expect(accountsPlan?.dimensions.map((d) => d.name)).toEqual(["tier"]);
    expect(accountsPlan?.namingDimensionIndex).toBeNull();
    // …and the refusal reaches the caller, beside the `ambiguous-dimension` row
    // that caused it. A `null` with no refusal is the silent version.
    expect(refusalKeys(plan.refused)).toContain("Accounts.name:naming-dimension-refused");
    expect(refusalKeys(plan.refused)).toContain("Accounts.name:ambiguous-dimension");
  });

  test("an UNNAMED entity produces no refusal — the two nulls are different facts", () => {
    // The control that makes the assertion above mean something. Without it, a
    // planner that emitted `naming-dimension-refused` unconditionally would pass.
    const accounts = parsed("Accounts", { table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] });
    const plan = planWarehouseEmission(
      makeProducerReach([{ entity: "Accounts", group: null, dimension: "tier", naming: false }]),
      found(accounts),
    );
    expect(plan.emit[0]?.namingDimensionIndex).toBeNull();
    expect(plan.refused).toEqual([]);
  });
});

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
    { entity: "Accounts", group: null, dimension: "name", naming: true },
    { entity: "Accounts", group: null, dimension: "tier", naming: false },
  ] as const;

  test("materializes an entry per row and proposes its edge at both positions", async () => {
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        // ⚠️ Key surfaces that NORM DIFFERENTLY from themselves (`ACC-42` →
        // `acc 42`). Every earlier fixture used numeric keys, where
        // `key_surface` and `key_norm` are equal by construction — so swapping
        // those two columns in the INSERT passed every suite in the arc.
        Accounts: [snapshotRow("ACC-42", "Acme Corp", "gold"), snapshotRow("ACC-43", "Beta LLC", "silver")],
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
      warehouseRowId(WORKSPACE, "Accounts", "ACC-42"),
      warehouseRowId(WORKSPACE, "Accounts", "ACC-43"),
    ]);
    expect(params?.[4]).toEqual(["ACC-42", "ACC-43"]);
    // ⚠️ ASSERTED, and distinct from the surfaces above. This slot had no
    // assertion at all, and could not have distinguished anything if it had:
    // under numeric keys `key_surface` and `key_norm` hold the same bytes.
    expect(params?.[5]).toEqual(["acc 42", "acc 43"]);
    expect(params?.[6]).toEqual(["Acme Corp", "Beta LLC"]);
    expect(params?.[7]).toEqual(["acme corp", "beta llc"]);

    // Two entries × two positions.
    expect(h.edgeBatches).toHaveLength(1);
    expect(h.edgeBatches[0]?.map((e) => `${e.position}:${e.fromNorm}->${e.toNorm}`)).toEqual([
      "subject:acc 42->acme corp",
      "object:acc 42->acme corp",
      "subject:acc 43->beta llc",
      "object:acc 43->beta llc",
    ]);
    expect(h.edgeBatches[0]?.every((e) => e.proposedBy === ENTITY_EDGE_PRODUCER)).toBe(true);
  });

  test("stores NOTHING and proposes NOTHING when no dimension names the entity", async () => {
    const h = harness({
      // Same rows, same entity, `naming: false` everywhere. The ONLY difference
      // from the test above.
      pairs: [
        { entity: "Accounts", group: null, dimension: "name", naming: false },
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
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
    // `nothing-to-propose`, not zeroed counters — nothing to propose is not the
    // same as proposing and having everything refused. `entries: 0` is the store
    // the pass actually read, which is what says WHY there was nothing.
    expect(report.entityEdges).toEqual({
      kind: "nothing-to-propose",
      entries: 0,
      ambiguous: 0,
      selfEdges: 0,
      unmintedIds: 0,
    });
    expect(h.edgeBatches).toEqual([]);
    // The CONTROL: the claims still landed, so this is a store that abstained
    // rather than a producer that did nothing.
    expect(report.entities[0]?.created).toBeGreaterThan(0);
  });

  // ── the per-entity success record (#5317) ────────────────────────────────

  test("records the entity's success on the SAME transaction, stamped with the snapshot instant", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "gold")] },
    });

    await run(h);

    // ⚠️ Read off the EXACT exported statement, not a substring match: the
    // fake executor throws on an unrecognized one, so a statement edited
    // anywhere would fail loudly here rather than quietly stop matching.
    // `snapshotAt` and not a wall clock — the reach rule compares this value to
    // `brain_entity.snapshot_at`, which the same transaction writes.
    expect(h.store.runSuccesses()).toEqual([[WORKSPACE, "Accounts", SNAPSHOT_AT.toISOString()]]);
  });

  test("a REFUSED entity records no success — the arm the reaper's safety rests on", async () => {
    // The rule #5317 rejected is "reap on any completed run that omitted the
    // entity", because it deletes a live entity's whole store on a transient
    // outage. This is the assertion that keeps the replacement honest: an entity
    // the producer could not read leaves no evidence that it succeeded, so a
    // reaper reading this table has nothing to act on.
    const h = harness({
      pairs: [
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
        { entity: "Missing", group: null, dimension: "tier", naming: false },
      ],
      // Not in the published semantic layer — refused before any transaction opens.
      entities: { Accounts: ACCOUNTS, Missing: null },
      rows: { Accounts: [snapshotRow("42", "gold")] },
    });

    const report = await run(h);

    expect(report.refusals.some((r) => r.entity === "Missing")).toBe(true);
    // The CONTROL rides in the same assertion: the entity that DID succeed is
    // present, so this is a record that discriminates rather than one that is
    // simply never written.
    expect(h.store.runSuccesses()).toEqual([[WORKSPACE, "Accounts", SNAPSHOT_AT.toISOString()]]);
  });

  test("DELETEs the entity's entries even with nothing to write — un-naming clears the store", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
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

    expect(report.entityEdges).toEqual({
      kind: "proposed",
      entries: 1,
      ambiguous: 0,
      selfEdges: 0,
      unmintedIds: 0,
      counters: { ...EMPTY_EDGE_COUNTERS, rejected: 2 },
    });
  });

  test("a wholly natural-key store is `nothing-to-propose` with entries > 0 and NOTHING wrong", async () => {
    // ⚠️ The arm's own stated raison d'être, which nothing exercised: every other
    // `nothing-to-propose` assertion in this file is `(0,0)` — an empty store — or
    // `(2,2)` — everything ambiguous. The third point in the space is a store that
    // is FULL, HEALTHY and has nothing to do, and it is the one the docstring uses
    // as its example ("a run that wrote 500 natural-key entries lands HERE").
    //
    // The name cell IS the key, so `keyNorm === canonicalNorm` and every entry is a
    // benign self-edge.
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [snapshotRow("Acme", "Acme", "gold"), snapshotRow("Beta", "Beta", "silver")],
      },
    });

    const report = await run(h);

    // ⚠️ `selfEdges: 2` is what separates this from an unminted-id store, and
    // before the round-1 fix it was invisible: `{entries: 2, ambiguous: 0}` was
    // byte-identical for this healthy store and for two rows whose ids no producer
    // could have minted, which resolve NOTHING.
    expect(report.entityEdges).toEqual({
      kind: "nothing-to-propose",
      entries: 2,
      ambiguous: 0,
      selfEdges: 2,
      unmintedIds: 0,
    });
    // The control: nothing was handed to the vocabulary seam, because an empty
    // batch would take the workspace lock to say nothing.
    expect(h.edgeBatches).toEqual([]);
    // ...and the store really was written, so this is "nothing to do" rather than
    // "nothing was named".
    expect(report.entities[0]?.entitiesStored).toBe(2);
  });

  test("an UNMINTED-id store is distinguishable from a healthy natural-key one", async () => {
    // ⚠️ The pair the round-1 panel found missing, and the reason `unmintedIds` is
    // on the report at all — two reviewers converged on it independently. A store
    // of ids no producer could have minted (a hand-edited or downgraded bundle)
    // resolves NOTHING, ever, and its remedy is a re-import rather than a warehouse
    // edit. Under the first cut of this union it reported `{entries: 2,
    // ambiguous: 0}` — byte-identical to the healthy store in the test above.
    //
    // That is #5277's own charter failing one counter over: the union exists
    // because a lock timeout read as "nobody has named anything" to the admin whose
    // next action was to go name something.
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("ACC-42", "gold")] },
      entityStore: async () => [
        {
          // Not `wh_` + 64 hex digits, so `isWarehouseRowId` refuses it.
          entityId: "wh_handedited" as WarehouseRowId,
          entity: "Accounts",
          keySurface: "ACC-42",
          keyNorm: "acc 42",
          canonicalSurface: "Acme",
          canonicalNorm: "acme",
        },
        {
          entityId: "wh_downgraded" as WarehouseRowId,
          entity: "Contacts",
          keySurface: "C-9",
          keyNorm: "c 9",
          canonicalSurface: "Beta",
          canonicalNorm: "beta",
        },
      ] satisfies readonly EntityStoreEntry[],
    });

    const report = await run(h);

    // ⚠️ The SAME `kind` and the SAME `entries`/`ambiguous`/`selfEdges` as the
    // healthy store above — `unmintedIds` is the ONLY field that differs, which is
    // exactly why its absence was invisible rather than merely incomplete.
    expect(report.entityEdges).toEqual({
      kind: "nothing-to-propose",
      entries: 2,
      ambiguous: 0,
      selfEdges: 0,
      unmintedIds: 2,
    });
    expect(h.edgeBatches).toEqual([]);
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
    // ⚠️ **THE ARM THAT MAKES THE FAILURE READABLE.** Under #5043's three fields
    // a failing run and a healthy idle run were byte-identical apart from one
    // sibling string — a vocabulary lock timeout told the admin "nobody has named
    // anything", whose next action is to go name something. The discriminant is
    // now the report's own vocabulary rather than a `null` a reader has to decode.
    //
    // ⚠️ **`reached: {phase: "store-read"}` carries NO COUNT AT ALL**, and that is
    // stronger than the `entries: null` the first cut used. Reporting `0` would
    // claim an empty, unambiguous store to an operator whose store may hold every
    // row it ever did — ADR-0039's invisible failure as a confident number — but a
    // nullable field beside a non-nullable `proposalsAttempted` also SPELLS
    // combinations that are not runs. Absent-where-unknown says the same thing and
    // makes the impossible ones unrepresentable.
    //
    // The paired test below is the same failure at a LATER phase, and the pair is
    // the whole point of the arm.
    //
    // `toEqual`, not `toMatchObject`: a field added to this arm must be a visible
    // edit rather than silently admitted.
    expect(report.entityEdges).toEqual({
      kind: "failed",
      reached: { phase: "store-read" },
      message: expect.any(String),
    });
    expect(h.edgeBatches).toEqual([]);
    // ⚠️ **The failure is REPORTED but the driver's text is NOT.** Both throw
    // sources are internal-DB-backed, so `err.message` here is a `pg` string —
    // `FATAL: password authentication failed for user "atlas"`, a host, a role.
    // The first cut of this field put it straight in a 200 body, which is the
    // one thing this file already refuses for `snapshot-failed`.
    const failed = report.entityEdges;
    expect(failed.kind).toBe("failed");
    if (failed.kind !== "failed") throw new Error("unreachable: asserted above");
    expect(failed.message).not.toContain("vocabulary lock timeout");
    // …and it carries the handle that makes the real reason findable, which is
    // what stops the redaction from being a dead end.
    expect(failed.message).toContain("req-1");
    // ⚠️ It must NOT claim the clean case either. `proposeAliasEdges` commits
    // PER PROPOSAL, so a mid-batch throw leaves approved edges behind — and an
    // auto-approved entity edge re-keys the corpus. "No vocabulary edge was
    // raised this run" was false in exactly that case.
    expect(failed.message).not.toContain("no vocabulary edge was raised");

    // ⚠️ **THE MODULE'S REGISTER, capital and all.** Sibling refusals in
    // `warehouse-producer.ts` say "This is an Atlas fault", the logging suite asserts
    // that exact string on them, and a case-sensitive grep is what an operator runs
    // over a pile of support tickets. The first cut of this clause wrote "this is an
    // Atlas fault rather than a transient one" — which that grep misses, on the arm
    // most likely to be grepped for — under a comment claiming it matched them.
    //
    // No count here on purpose: the phrase is split across string concatenations at
    // several of those sites, so any hand-written tally of them is wrong in a way
    // `grep -c` will not tell you. This diff produced four such miscounts.
    expect(failed.message).toContain("This is an Atlas fault");
    // ...and the permanence TEST names a comparison the reader can make. It used to
    // say "if it fails again identically", which is unfalsifiable by construction:
    // this sentence is byte-identical for every failure, so two bodies always look
    // the same. It now points at `reached`, the half that genuinely varies, and
    // excludes the contention case — this pass takes the workspace lock up to
    // `2 × entries` times, so two presses during a concurrent run repeat identically
    // and are NOT a defect.
    expect(failed.message).toContain("stops at the same point");
    expect(failed.message).toContain("otherwise idle workspace");
  });

  test("a store seam that RESOLVES the wrong shape lands on `failed`, not on a schema degrade", async () => {
    // ⚠️ Built because the guard it covers was measured UNFALSIFIABLE: removing
    // `if (!Array.isArray(store)) throw` left all 186 tests green, which by this
    // repo's rule makes it decoration rather than a guard.
    //
    // A seam that THROWS is caught. The one shape that escapes is a seam that
    // RESOLVES something that is not an array — a partial mock, a stubbed module, a
    // future loader returning `{rows: [...]}`. Without the guard `store.length` is
    // `undefined`, which flows into the report as an `undefined` count, fails
    // `BrainWarehouseRunReportSchema`, and hands the operator "the report could not
    // be serialized" — a true statement about the wrong subsystem, on a run whose
    // actual fault is one seam over.
    //
    // The cast is the point of the test: the seam is TYPED, so only a caller that
    // lies about the type can produce this, which is exactly what a partial mock is.
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "Acme Corp", "gold")] },
      entityStore: (async () => ({ rows: [] })) as unknown as () => Promise<
        readonly EntityStoreEntry[]
      >,
    });

    const report = await run(h);

    // The run still succeeds and the facts are still committed…
    expect(report.created).toBeGreaterThan(0);
    // …and the failure is attributed to the pass that actually failed, at the phase
    // that actually failed — nothing was read, so no count is reported.
    expect(report.entityEdges).toEqual({
      kind: "failed",
      reached: { phase: "store-read" },
      message: expect.any(String),
    });
    expect(h.edgeBatches).toEqual([]);
  });

  test("the PLANNING phase: the store was read, then planning threw (#5277)", async () => {
    // ⚠️ The one arm round 1 covered on the wire but not at the producer. Deleting
    // the `reached = {phase: "planning", …}` assignment outright left every suite
    // green, because no fixture threw in the window between the store read and the
    // batch submission — every failure fixture threw in `loadStore` (→ `store-read`)
    // or in `proposeAliasEdges` (→ `proposing`).
    //
    // A hostile getter is what reaches it: the array passes `Array.isArray`, so
    // `entries` is established, and `entityEdgeProposals` throws while reading the
    // entry. That is a code defect rather than an operational failure, which is
    // exactly why the arm must be reportable — `entries` is known and nothing was
    // submitted, and a shape that could not say so would have to fold it into a
    // neighbour and lie about one of the two.
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("ACC-42", "gold")] },
      entityStore: async () =>
        [
          {
            get entityId(): WarehouseRowId {
              throw new Error("hostile getter");
            },
            entity: "Accounts",
            keySurface: "ACC-42",
            keyNorm: "acc 42",
            canonicalSurface: "Acme",
            canonicalNorm: "acme",
          },
        ] as unknown as readonly EntityStoreEntry[],
    });

    const report = await run(h);

    // `entries: 1` — established BEFORE the throw, and the number that separates this
    // from `store-read`, where no count exists at all.
    expect(report.entityEdges).toEqual({
      kind: "failed",
      reached: { phase: "planning", entries: 1 },
      message: expect.any(String),
    });
    // Nothing was handed to the vocabulary seam, so nothing can have been committed.
    expect(h.edgeBatches).toEqual([]);
  });

  test("PARTIAL PROGRESS: a throw AFTER the batch was submitted is a different wire value (#5277)", async () => {
    // ⚠️ The state #5043's shape could not represent, and the reason the union
    // exists. `proposeAliasEdges` COMMITS PER PROPOSAL and an auto-approved entity
    // edge RE-KEYS THE CORPUS, so "threw before proposing anything" and "threw
    // after committing 900 edges" are materially different runs — different
    // remedies, different blast radius — and both used to be `entityEdges: null`
    // plus the same sentence. The prose said so; the type could not.
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [
          snapshotRow("42", "Acme Corp", "gold"),
          snapshotRow("43", "Beta LLC", "silver"),
          // ⚠️ A THIRD row whose name cell is empty, and it is here for one reason:
          // with two rows, `proposalsAttempted` (2 positions × 2 entries = 4) was
          // EQUAL to `report.created` (2 rows × 2 dimensions = 4), under a comment
          // claiming the number "can be confused with nothing else on this report".
          // That claim was false and structurally so — the panel caught it. An
          // unnamed row makes a fact without making an entry, which separates them.
          snapshotRow("44", null, "bronze"),
          // ⚠️ A FOURTH row that IS stored but earns NO edge — its name cell is its
          // key, so it is a benign self-edge. Without it the census was three
          // interchangeable zeros and `proposalsAttempted` was exactly `2 × entries`
          // in every fixture that carried it, so `proposalsAttempted = entries * 2`
          // passed the whole suite. A refused entry is what makes the two differ.
          snapshotRow("Gamma", "Gamma", "platinum"),
        ],
      },
      edgeProposeThrows: "deadlock detected on brain_vocabulary_edge",
    });

    const report = await run(h);

    // ⚠️ The three numbers ASSERTED here are each distinct from
    // `proposalsAttempted: 4`, so a field copied into another cannot pass.
    //
    // ⚠️ **NOT "every number on this report" — `rows` is 4 as well**, because it
    // counts the snapshot rows the seam returned and there are four of them. That
    // universal was the FOURTH wrong version of this one claim (4, then 5, then 7,
    // then "every"), in a comment that boasted about having measured the previous
    // three. The numbers that discriminate are asserted; the sentence no longer
    // quantifies over ones that are not.
    expect(report.created).toBe(7);
    expect(report.entities[0]?.entitiesStored).toBe(3);
    expect(report.entities[0]?.unnamedRows).toBe(1);
    // Two positions × the two entries that EARN an edge — `Gamma` is stored and
    // refused, so this is no longer `2 × entries`.
    expect(h.edgeBatches[0]).toHaveLength(4);
    expect(report.entityEdges).toEqual({
      kind: "failed",
      reached: {
        // ⚠️ The LATER phase, and the whole pair: same `kind` as the read failure
        // above, different knowledge. The census is present here because the read
        // and the planning both succeeded; on that one it is absent entirely.
        //
        // ⚠️ `selfEdges: 1` is what makes `proposalsAttempted` independent of
        // `entries`: 3 entries, 1 refused, 2 earners, 4 proposals. With an all-zero
        // census the two were locked together and `proposalsAttempted = entries * 2`
        // passed every test in the repo.
        phase: "proposing",
        entries: 3,
        ambiguous: 0,
        selfEdges: 1,
        unmintedIds: 0,
        proposalsAttempted: 4,
      },
      message: expect.any(String),
    });
    // ⚠️ The SENTENCE is identical to the read-failure case above. That is the
    // rule (#5043): a fixed sentence plus the correlation handle, never the
    // driver's message — so what varies between the two failures is the STRUCTURED
    // half, which a machine can read without parsing prose.
    const failed = report.entityEdges;
    if (failed.kind !== "failed") throw new Error("unreachable: asserted above");
    expect(failed.message).not.toContain("deadlock detected");
    expect(failed.message).toContain("req-1");

    // ⚠️ "FIXED" asserted directly rather than inferred from two `not.toContain`s:
    // the same bytes come back from a completely different failure with a
    // completely different driver message. A `message` that interpolated anything
    // about the cause would differ here, which is how `err.message` would come
    // back in through the door #5043 closed.
    const readFailure = await run(
      harness({
        pairs: [...namedPairs],
        entities: { Accounts: ACCOUNTS },
        rows: { Accounts: [snapshotRow("42", "Acme Corp", "gold")] },
        entityStore: async () => {
          throw new Error('FATAL: password authentication failed for user "atlas"');
        },
      }),
    );
    const readFailed = readFailure.entityEdges;
    if (readFailed.kind !== "failed") throw new Error("unreachable: the store read threw");
    expect(readFailed.message).toBe(failed.message);
  });

  test("a run with NOTHING to do is distinguishable from a run that FAILED", async () => {
    // The paired arm, and the reason this pair exists: two tests in this file
    // asserted identical state under a comment claiming they distinguished
    // these cases. They did not — the panel found it by reading the tests.
    const h = harness({
      // No naming dimension, so nothing is stored and the store stays empty —
      // the genuine "nothing to do" run.
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("ACC-42", "gold")] },
    });

    const report = await run(h);

    // ⚠️ A DIFFERENT `kind` from the failing run above, where the old shape gave
    // both the same `entityEdges: null` and leaned on a sibling string to separate
    // them. The discriminant is now the first thing a reader sees.
    expect(report.entityEdges).toEqual({
      kind: "nothing-to-propose",
      entries: 0,
      ambiguous: 0,
      selfEdges: 0,
      unmintedIds: 0,
    });
  });

  test("the edge pass runs even when EVERY enrolled pair was refused", async () => {
    // ⚠️ Removing the `entitiesStored > 0` gate was only half the fix: the pass
    // still sat below the `plan.emit.length === 0` early return, so a run where
    // every pair was refused — expired warehouse credentials, an entity
    // un-published — skipped it while `brain_entity` still held every row.
    // Un-enrolling deletes no entry and no reaper exists yet, so that is exactly
    // the run an operator is staring at when they ask why the store stopped
    // working, and it reported the then-flat `entityEdgesAmbiguous: 0` over a
    // store that may be entirely ambiguous.
    const h = harness({
      pairs: [{ entity: "Ghost", group: null, dimension: "tier", naming: false }],
      // Not in the published semantic layer → every pair refused → `emit` empty.
      entities: { Ghost: null },
      entityStore: async () => [
        {
          entityId: warehouseRowId(WORKSPACE, "Accounts", "ACC-42"),
          entity: "Accounts",
          keySurface: "ACC-42",
          keyNorm: "acc 42",
          canonicalSurface: "Acme",
          canonicalNorm: "acme",
        },
        {
          entityId: warehouseRowId(WORKSPACE, "Contacts", "C-9"),
          entity: "Contacts",
          keySurface: "C-9",
          keyNorm: "c 9",
          canonicalSurface: "acme",
          canonicalNorm: "acme",
        },
      ] satisfies readonly StoredEntity[],
    });

    const report = await run(h);

    // Nothing emitted — the reach really was empty of producible pairs…
    expect(report.entities).toEqual([]);
    expect(report.refusals.length).toBeGreaterThan(0);
    // …and the edge pass ran anyway, over the PERSISTED store, and found the
    // collision. `ambiguous: 0` here would be the report saying "no name
    // collisions" about a store where neither entity resolves.
    expect(report.entityEdges).toEqual({
      kind: "nothing-to-propose",
      entries: 2,
      ambiguous: 2,
      selfEdges: 0,
      unmintedIds: 0,
    });
  });

  test("the edge pass runs even when THIS run stored nothing — the re-run case", async () => {
    // It was gated on `entitiesStored > 0`, which skipped the pass entirely on
    // a run where every entity was already snapshotted — i.e. exactly the
    // RE-RUN on which `rejected` (the counter that says a human's removal
    // stuck) is the number an operator reads.
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("ACC-42", "gold")] },
      // The persisted store is NOT empty, though this run wrote nothing.
      entityStore: async () => [
        {
          entityId: warehouseRowId(WORKSPACE, "Accounts", "ACC-42"),
          entity: "Accounts",
          keySurface: "ACC-42",
          keyNorm: "acc 42",
          canonicalSurface: "Acme Corp",
          canonicalNorm: "acme corp",
        },
      ] satisfies readonly EntityStoreEntry[],
      edgeCounters: { ...EMPTY_EDGE_COUNTERS, rejected: 2 },
    });

    const report = await run(h);

    expect(report.entities[0]?.entitiesStored).toBe(0);
    // The pass ran anyway, and its counters reached the report.
    expect(h.edgeBatches).toHaveLength(1);
    expect(report.entityEdges).toEqual({
      kind: "proposed",
      entries: 1,
      ambiguous: 0,
      selfEdges: 0,
      unmintedIds: 0,
      counters: { ...EMPTY_EDGE_COUNTERS, rejected: 2 },
    });
  });

  test("ambiguous entries are COUNTED on the report, not just skipped", async () => {
    // Two rows sharing a name is ordinary warehouse data with a PERMANENT
    // consequence — neither resolves by name, ever. It was visible only in a
    // `debug` line production does not emit, under a docstring claiming the
    // caller counted it.
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: {
        Accounts: [
          snapshotRow("ACC-42", "Acme", "gold"),
          snapshotRow("ACC-43", "acme", "silver"),
          // ⚠️ A THIRD spelling of the same name, added because the previous
          // fixture claimed "three distinct numbers" and had only two:
          // `ambiguous` and the proposal count were BOTH 2, so the mutation
          // `ambiguous = batch.proposals.length` passed this test. Now the four
          // numbers are 4 / 3 / 0 / 1 and no two can be swapped unnoticed.
          snapshotRow("ACC-44", "ACME", "platinum"),
          snapshotRow("ACC-45", "Gamma", "bronze"),
        ],
      },
    });

    const report = await run(h);

    // Four DISTINCT numbers — entries 4, ambiguous 3, selfEdges 0, proposals 2 —
    // so an implementation that put every row in one bucket, or copied one counter
    // into another, cannot satisfy this.
    expect(report.entityEdges).toEqual({
      kind: "proposed",
      entries: 4,
      ambiguous: 3,
      selfEdges: 0,
      unmintedIds: 0,
      counters: EMPTY_EDGE_COUNTERS,
    });
    // The control: the last row is NOT ambiguous and its edge was proposed, so
    // this is a count of the refused rather than of everything.
    expect(h.edgeBatches[0]).toHaveLength(2);
  });

  test("the edge pass reads the PERSISTED store, not just this run's entries", async () => {
    // `contacts` was snapshotted on an earlier run and holds the same name. An
    // edge pass scoped to this run would never see it and would merge the two.
    const h = harness({
      pairs: [...namedPairs],
      entities: { Accounts: ACCOUNTS },
      rows: { Accounts: [snapshotRow("42", "Acme", "gold")] },
      // ⚠️ REAL minted ids, not `"wh_this"`/`"wh_prior"`. Those fail
      // `isWarehouseRowId`, so both entries were counted as `unmintedIds` and
      // skipped BEFORE the ambiguity test ever ran — the pass returned no batch
      // for the wrong reason entirely, and both of this test's original
      // assertions (`entityEdges === null`, `entitiesStored === 1`) held either
      // way. Caught by the `ambiguous`/`unmintedIds` assertion below, which is the
      // first one in this test that could tell the two mechanisms apart — and
      // `unmintedIds: 0` is now what pins that the ids ARE minted, so a revert to
      // the old fixture reds here rather than passing for the wrong reason.
      entityStore: async () => [
        {
          entityId: warehouseRowId(WORKSPACE, "Accounts", "42"),
          entity: "Accounts",
          keySurface: "42",
          keyNorm: "42",
          canonicalSurface: "Acme",
          canonicalNorm: "acme",
        },
        {
          entityId: warehouseRowId(WORKSPACE, "Contacts", "9"),
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
    // ⚠️ The same `kind` as the no-naming-dimension case above, and the numbers
    // are what separate them now: there the store was empty (`entries: 0,
    // ambiguous: 0`), here it holds two entries that collide. Under the old shape
    // both were a bare `null` and the separation lived in a second assertion about
    // a different field.
    expect(report.entityEdges).toEqual({
      kind: "nothing-to-propose",
      entries: 2,
      ambiguous: 2,
      selfEdges: 0,
      unmintedIds: 0,
    });
    // The control: the store DID write an entry, so this is "the edge was refused
    // on ambiguity" rather than "nothing was named".
    expect(report.entities[0]?.entitiesStored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #5286 — the enrollment's connection group, end to end
// ---------------------------------------------------------------------------

describe("an enrollment's connection group (#5286)", () => {
  /**
   * A placement that answers for whatever it is asked, so these tests are about
   * the GROUP travelling rather than about the resolver's own rules — those have
   * their own suite above, driven against hand-built catalogs.
   */
  const placeEverything = (connection: string) => async (
    _ws: string,
    targets: readonly WarehousePlacementTarget[],
  ): Promise<WarehouseConnectionPlacement> => ({
    placed: new Map(targets.map((t) => [t.entity, [connection as WarehouseConnectionId]])),
    unplaceable: [],
  });

  test("the entity lookup is scoped to the group the pair was enrolled under", async () => {
    // ⚠️ **The half of #5286 that no placement test can show.** Even correctly
    // placed, the run has to READ the entity's YAML — and `getAdminEntity`
    // refuses a stem-only lookup spanning two groups (`AmbiguousEntityError`).
    // Without the group on this call the run caught that throw and refused the
    // pair `entity-unreadable` on every run, which is what staging did.
    const lookups: { entity: string; group: string | null }[] = [];
    const h = harness({
      pairs: [{ entity: "Accounts", group: "g-eu", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: placeEverything("eu-prod"),
        loadEntity: async (_ws, entity, group) => {
          lookups.push({ entity, group });
          return h.deps.loadEntity ? h.deps.loadEntity(_ws, entity, group) : null;
        },
      },
    );

    expect(lookups).toEqual([{ entity: "Accounts", group: "g-eu" }]);
    // POSITIVE CONTROL: the pair actually produced. The assertion above is
    // equally satisfied by a run that scoped the lookup correctly and then
    // refused everything downstream.
    expect(report.refusals).toEqual([]);
    expect(report.entities[0]?.rows).toBe(1);
  });

  test("a name enrolled under TWO groups refuses BOTH pairs, and reads neither", async () => {
    // ⚠️ The state 0205 makes reachable and the producer will not produce from.
    // Two published `Accounts` are two entities over two databases — but
    // `brain_entity.entity_id` hashes `(workspace, entity, primary key)`, the
    // fact subject carries the entity NAME, and the coverage evidence join
    // recovers it from `warehouse:<entity>@<instant>`. None of those carries a
    // group, so producing both would file two subjects as one: a false `same` at
    // the publish gate, which has no inverse.
    const h = harness({
      pairs: [
        { entity: "Accounts", group: "g-eu", dimension: "tier", naming: false },
        { entity: "Accounts", group: "g-us", dimension: "tier", naming: false },
      ],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      { ...h.deps, resolveConnectionIds: placeEverything("eu-prod") },
    );

    expect(report.refusals).toHaveLength(2);
    expect(report.refusals.every((r) => r.reason === "enrolled-in-two-groups")).toBe(true);
    // The refusal NAMES the collision, which is the one thing that makes it
    // fixable by the person who caused it — `ambiguous-dimension`'s rule.
    expect(report.refusals[0]?.message).toContain("g-eu");
    expect(report.refusals[0]?.message).toContain("g-us");

    // ⚠️ It read NOTHING. Refusing in the report while still snapshotting would
    // put rows from one of the two databases into the workspace's episode table
    // under a name that means both.
    expect(h.snapshots).toEqual([]);
    expect(report.created).toBe(0);
    expect(report.entities).toEqual([]);
  });

  test("the SAME name enrolled under ONE group produces — the refusal is not about the name", async () => {
    // The control that makes the test above a statement about the COLLISION
    // rather than about multi-group workspaces in general. This is also the
    // acceptance criterion #5286 was filed on: a staging workspace can enroll a
    // pair that produces.
    const h = harness({
      pairs: [{ entity: "Accounts", group: "g-eu", dimension: "tier", naming: false }],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: { Accounts: [snapshotRow("Acme Corp", "gold")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      { ...h.deps, resolveConnectionIds: placeEverything("eu-prod") },
    );

    expect(report.refusals).toEqual([]);
    expect(report.created).toBeGreaterThan(0);
    expect(h.snapshots[0]?.connectionId).toBe("eu-prod");
  });

  test("an UNPLACEABLE entity is refused for its placement cause, not for being unreadable", async () => {
    // ⚠️ **The commonest shape after 0205, and it used to report the wrong
    // thing.** A pre-#5286 enrollment carries no group; the migration's backfill
    // deliberately leaves it flat when its name is published under two groups,
    // because it cannot know which was meant. Placement refuses that
    // `ambiguous-group` — but the LOOKUP, scoped to the flat scope, finds
    // nothing and answered `not-published` first, so the pair was refused
    // *"Publish the entity, or un-enroll the pair"* for an entity published
    // twice. Advice an admin can follow forever with nothing changing.
    const h = harness({
      pairs: [{ entity: "Accounts", group: null, dimension: "tier", naming: false }],
      // Nothing published under the flat scope — the read the lookup would make.
      entities: {},
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () => ({
          placed: new Map(),
          unplaceable: [{ entity: "Accounts", cause: "ambiguous-group" as const }],
        }),
      },
    );

    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]?.reason).toBe("connection-unresolved");
    // The remedy is the placement's, and it is the one that can be acted on.
    expect(report.refusals[0]?.message).toContain("more than one database answers");
    // ...and NOT the sentence the lookup would have produced.
    expect(report.refusals[0]?.message).not.toContain("Publish the entity");
    expect(h.snapshots).toEqual([]);
  });

  test("an unplaceable entity is not even LOOKED UP — the read is skipped", async () => {
    // The other half of the same move. A read whose answer cannot change the
    // outcome is work against the internal DB for an entity nothing is built
    // from, and its only possible effect is to replace an honest refusal with a
    // worse one.
    const lookups: string[] = [];
    const h = harness({
      pairs: [
        { entity: "Accounts", group: null, dimension: "tier", naming: false },
        { entity: "Contracts", group: "g-eu", dimension: "region", naming: false },
      ],
      entities: {
        Contracts: entityYaml({
          table: "contracts",
          primaryKey: "id",
          dimensions: ["id", "region"],
        }),
      },
      rows: { Contracts: [snapshotRow("Contract 7", "emea")] },
    });

    await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      {
        ...h.deps,
        resolveConnectionIds: async () => ({
          placed: new Map([["Contracts", ["eu-prod" as WarehouseConnectionId]]]),
          unplaceable: [{ entity: "Accounts", cause: "group-not-visible" as const }],
        }),
        loadEntity: async (_ws, entity, group) => {
          lookups.push(entity);
          return h.deps.loadEntity ? h.deps.loadEntity(_ws, entity, group) : null;
        },
      },
    );

    // The placeable one was read; the unplaceable one was not. A positive
    // control on the same call, so "nothing was read" cannot pass it.
    expect(lookups).toEqual(["Contracts"]);
  });

  test("one colliding name does not take down the unrelated entities beside it", async () => {
    // The run loop's standing contract — a refusal is per entity, never per run —
    // applied to the arm this change added. A collision that emptied
    // `placementTargets` for everything, or that threw, would refuse a workspace
    // over one bad enrollment.
    const h = harness({
      pairs: [
        { entity: "Accounts", group: "g-eu", dimension: "tier", naming: false },
        { entity: "Accounts", group: "g-us", dimension: "tier", naming: false },
        { entity: "Contracts", group: "g-eu", dimension: "region", naming: false },
      ],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }),
        Contracts: entityYaml({
          table: "contracts",
          primaryKey: "id",
          dimensions: ["id", "region"],
        }),
      },
      rows: { Contracts: [snapshotRow("Contract 7", "emea")] },
    });

    const report = await runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
      { ...h.deps, resolveConnectionIds: placeEverything("eu-prod") },
    );

    expect(report.refusals.map((r) => r.entity)).toEqual(["Accounts", "Accounts"]);
    expect(h.snapshots.map((snap) => snap.entity)).toEqual(["Contracts"]);
    expect(report.entities.map((e) => e.entity)).toEqual(["Contracts"]);
  });
});
