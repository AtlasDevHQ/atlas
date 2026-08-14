/**
 * The tier-1 warehouse producer's decisions (#5042, ADR-0037 §4, ADR-0039).
 *
 * Everything here is a claim about what the producer WILL AND WILL NOT EMIT,
 * driven against injected seams — no database, no datasource, no semantic layer
 * on disk. The storage-level half (a fact landing `draft`, a re-emission minting
 * a tension edge and stamping no `valid_to`) is `warehouse-producer-pg.test.ts`;
 * neither file can stand in for the other.
 *
 * ## ⚠️ The one shape every test here has to avoid
 *
 * *"No bad row appeared"* is satisfied by a producer that emitted **nothing at
 * all**, which is the failure ADR-0039 predicts is invisible: *"a producer nobody
 * enrolls anything into leaves M4 exactly as dead as it is today, with every test
 * green."* So every refusal test carries a POSITIVE CONTROL on the same run — an
 * unambiguous sibling that still emits — and the two sides are given DIFFERENT
 * SIZES, so a fix that swapped them (or collapsed both to zero) cannot pass on an
 * accidental equality.
 */

import { describe, expect, test } from "bun:test";
import { makeProducerReach } from "@atlas/api/lib/brain/enrollment";
import { identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
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
  parseWarehouseEntity,
  planWarehouseEmission,
  runWarehouseProducer,
  warehouseEntityResolver,
  warehouseRowId,
  warehouseSurface,
  type WarehouseEntity,
  type WarehouseEntityPlan,
  type WarehouseProducerDeps,
  type WarehouseSnapshotRequest,
} from "@atlas/api/lib/brain/warehouse-producer";

const WORKSPACE = "ws-5042";
const SNAPSHOT_AT = new Date("2026-08-14T10:00:00.000Z");

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * An entity YAML in the ARRAY shape the profiler emits.
 *
 * Built from a spec rather than hand-written per test so every fixture agrees
 * with `parseWarehouseEntity` by CONSTRUCTION on the shape and by nothing else on
 * the content — the fields under test (which dimension is the key, which names
 * exist) still vary per test, which is what keeps the fixture falsifiable.
 */
function entityYaml(spec: {
  table: string;
  connection?: string;
  primaryKey?: string | readonly string[];
  dimensions: readonly string[];
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
    dimensions: spec.dimensions.map((name) => ({
      name,
      sql: name,
      ...(keys.has(name) ? { primary_key: true } : {}),
    })),
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

function planFor(entity: WarehouseEntity, dimensions: readonly string[]): WarehouseEntityPlan {
  const pick = (name: string) => {
    const dim = entity.dimensions.find((d) => d.name === name);
    if (dim === undefined) throw new Error(`fixture "${entity.name}" has no dimension "${name}"`);
    return dim;
  };
  const primaryKey = entity.dimensions.find((d) => d.primaryKey);
  if (primaryKey === undefined) throw new Error(`fixture "${entity.name}" declares no primary key`);
  return { entity, primaryKey, dimensions: dimensions.map(pick) };
}

// ── the parse ───────────────────────────────────────────────────────────────

describe("parseWarehouseEntity", () => {
  test("reads the array shape and the name-keyed map shape identically", () => {
    const asArray = parseWarehouseEntity("Accounts", {
      table: "accounts",
      dimensions: [{ name: "id", sql: "id", primary_key: true }, { name: "status", sql: "status" }],
    });
    const asMap = parseWarehouseEntity("Accounts", {
      table: "accounts",
      dimensions: { id: { sql: "id", primary_key: true }, status: { sql: "status" } },
    });
    expect(asArray).toEqual(asMap);
    // Pinned positively as well as by equality: two nulls are also "identical",
    // and this file's whole hazard is a test that a producer emitting nothing
    // satisfies.
    expect(asArray?.dimensions.map((d) => d.name)).toEqual(["id", "status"]);
    expect(asArray?.dimensions.filter((d) => d.primaryKey).map((d) => d.name)).toEqual(["id"]);
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
      { entity: "Accounts", dimension: "status" },
      { entity: "Accounts", dimension: "tier" },
      { entity: "Contracts", dimension: "status" },
      { entity: "Contracts", dimension: "region" },
      { entity: "Contracts", dimension: "owner" },
    ]);

    const plan = planWarehouseEmission(
      reach,
      new Map([
        ["Accounts", accounts],
        ["Contracts", contracts],
      ]),
    );

    // The refusal: BOTH sides, never a winner.
    expect(
      plan.refused
        .filter((r) => r.reason === "ambiguous-dimension")
        .map((r) => `${r.entity}.${r.dimension}`)
        .toSorted(),
    ).toEqual(["Accounts.status", "Contracts.status"]);
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
      { entity: "Accounts", dimension: "status" },
      // Enrolled, but the entity left the published semantic layer. The producer
      // is not producing from it, so `status` is not ambiguous.
      { entity: "Contracts", dimension: "status" },
    ]);

    const plan = planWarehouseEmission(
      reach,
      new Map<string, WarehouseEntity | null>([
        ["Accounts", accounts],
        ["Contracts", null],
      ]),
    );

    expect(plan.emit.map((e) => `${e.entity.name}.${e.dimensions.map((d) => d.name).join(",")}`)).toEqual([
      "Accounts.status",
    ]);
    expect(plan.refused.map((r) => r.reason)).toEqual(["entity-not-published"]);
  });

  test("the comparison is case-sensitive, because a warehouse may hold both spellings", () => {
    const accounts = parsed("Accounts", { table: "accounts", primaryKey: "id", dimensions: ["id", "status"] });
    const contracts = parsed("Contracts", { table: "contracts", primaryKey: "id", dimensions: ["id", "Status"] });
    const plan = planWarehouseEmission(
      makeProducerReach([
        { entity: "Accounts", dimension: "status" },
        { entity: "Contracts", dimension: "Status" },
      ]),
      new Map([
        ["Accounts", accounts],
        ["Contracts", contracts],
      ]),
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
      makeProducerReach([{ entity: "Accounts", dimension: "tier" }]),
      new Map([["Accounts", accounts]]),
    );
    expect(plan.emit[0]?.dimensions.map((d) => d.name)).toEqual(["tier"]);
    expect(plan.refused).toEqual([]);
  });

  /**
   * Acceptance criterion 4, pinned rather than left as prose.
   *
   * Two connection groups each holding a `price` dimension produce ONE predicate
   * key, because the vocabulary and the keys are WORKSPACE-scoped and carry no
   * group. That conflation is pre-existing — it is a property of `slotKey`, not
   * something this producer introduces — and it is precisely why the ambiguity
   * rule above has to refuse rather than qualify: there is no group-qualified key
   * for it to fall back to.
   */
  test("cross-group conflation is a property of the KEY, which is why ambiguity refuses", () => {
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

    // The key each would emit under, computed the way the producer computes it.
    expect(slotKey("price", identityVocabulary.predicate)).toBe(slotKey("price", identityVocabulary.predicate));
    expect(slotKey("price", identityVocabulary.predicate)).not.toBeNull();

    const plan = planWarehouseEmission(
      makeProducerReach([
        { entity: "Plans", dimension: "price" },
        { entity: "Products", dimension: "price" },
      ]),
      new Map([
        ["Plans", analytics],
        ["Products", billing],
      ]),
    );
    expect(plan.emit).toEqual([]);
    expect(plan.refused.map((r) => r.reason)).toEqual([
      "ambiguous-dimension",
      "ambiguous-dimension",
    ]);
    // The groups DIFFER and the refusal still fires, which is the criterion: the
    // group is not part of the identity, so it cannot disambiguate.
    expect(analytics.connection).not.toBe(billing.connection);
  });

  test("each structural refusal reports its own reason", () => {
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
        { entity: "NoKey", dimension: "status" },
        { entity: "Composite", dimension: "status" },
        { entity: "Orders", dimension: "total_revenue" },
        { entity: "Orders", dimension: "typo" },
      ]),
      new Map([
        ["NoKey", noKey],
        ["Composite", composite],
        ["Orders", withMeasure],
      ]),
    );
    expect(plan.emit).toEqual([]);
    expect(plan.refused.map((r) => r.reason).toSorted()).toEqual([
      "composite-primary-key",
      "dimension-not-found",
      "measure-not-per-row",
      "no-primary-key",
    ]);
    // A measure is refused as a MEASURE and not as a typo — the two send an admin
    // to different places, and one of them is not their mistake.
    expect(plan.refused.find((r) => r.dimension === "total_revenue")?.message).toContain("aggregate");
  });
});

// ── the snapshot query ──────────────────────────────────────────────────────

describe("buildSnapshotSql", () => {
  const accounts = parsed("Accounts", {
    table: "public.accounts",
    primaryKey: "account_id",
    dimensions: ["account_id", "status", "tier"],
  });

  test("selects the primary key as the subject and each dimension positionally", () => {
    const sql = buildSnapshotSql(planFor(accounts, ["status", "tier"]), 5);
    expect(sql).toBe(
      `SELECT account_id AS ${SUBJECT_ALIAS}, status AS ${DIMENSION_ALIAS_PREFIX}0, ` +
        `tier AS ${DIMENSION_ALIAS_PREFIX}1 FROM public.accounts LIMIT 6`,
    );
  });

  test("asks for cap + 1 rows, which is what makes the cap detectable", () => {
    // At exactly `cap` a truncated read and a table of that size are the same
    // result set. The extra row is the evidence, so this asserts the arithmetic
    // rather than the presence of a LIMIT.
    expect(buildSnapshotSql(planFor(accounts, ["status"]), 1)).toContain("LIMIT 2");
    expect(buildSnapshotSql(planFor(accounts, ["status"]), 250)).toContain("LIMIT 251");
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

  test("emits the BARE dimension name and keeps qualification out of the predicate", () => {
    const { candidates } = claimsFor([
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active", [`${DIMENSION_ALIAS_PREFIX}1`]: "gold" },
    ]);
    expect(candidates.map((c) => c.predicate)).toEqual(["status", "tier"]);
    // The qualification exists — it just does not touch the predicate.
    expect(candidates[0]?.detail).toMatchObject({
      entity: "Accounts",
      table: "accounts",
      connectionGroup: "analytics",
      primaryKeyDimension: "id",
      primaryKey: "Acme Corp",
    });
    expect(candidates.every((c) => !c.predicate.includes("."))).toBe(true);
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

  test("a NULL cell asserts nothing and produces no candidate", () => {
    const { candidates } = claimsFor([
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: null, [`${DIMENSION_ALIAS_PREFIX}1`]: "gold" },
    ]);
    // One candidate, not two, and not a `"null"` string object.
    expect(candidates.map((c) => `${c.predicate}=${c.object}`)).toEqual(["tier=gold"]);
  });

  test("a row with no usable primary key is counted, not emitted and not thrown on", () => {
    const { candidates, unidentifiedRows, collidingSubjectRows } = claimsFor([
      { [SUBJECT_ALIAS]: null, [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      { [SUBJECT_ALIAS]: { json: true }, [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(unidentifiedRows).toBe(2);
    // The counters are given different values on purpose: folded into one number,
    // an unusable key and a colliding key are indistinguishable, and only the
    // second explains a row a person expected to see.
    expect(collidingSubjectRows).toBe(0);
  });

  test("two rows whose keys trim to one surface do not share an identity", () => {
    // `42` and ` 42 ` are DIFFERENT rows. The id is derived from the RAW key and
    // the subject from the TRIMMED one, so the two disagree here — which is what
    // makes the collision detectable at all. Deriving both from the trimmed
    // surface would give the rows one identity silently.
    const { candidates, subjectIds, unidentifiedRows, collidingSubjectRows } = claimsFor([
      { [SUBJECT_ALIAS]: "42", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      { [SUBJECT_ALIAS]: " 42 ", [`${DIMENSION_ALIAS_PREFIX}0`]: "churned" },
    ]);
    expect(candidates.map((c) => c.object)).toEqual(["active"]);
    expect(subjectIds.get("42")).toBe(warehouseRowId(WORKSPACE, "Accounts", "42"));
    expect(collidingSubjectRows).toBe(1);
    expect(unidentifiedRows).toBe(0);
  });

  test("the subject id is what reaches the resolver, and only for surfaces it knows", () => {
    const { subjectIds } = claimsFor([
      { [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
    ]);
    const resolver = warehouseEntityResolver(subjectIds);
    const answer = resolver(new Set(["Acme Corp", "active", "Globex"]), { workspaceId: WORKSPACE });
    const resolved = answer instanceof Promise ? undefined : answer;
    expect(resolved?.get("Acme Corp")?.entityId).toBe(warehouseRowId(WORKSPACE, "Accounts", "Acme Corp"));
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
 * It dispatches on the EXPORTED SQL constants rather than on substrings of them,
 * so a statement that is edited stops matching instead of silently taking a
 * default arm — `reconcile.test.ts`'s rule, and the reason both modules export
 * their statements.
 */
class RunStore {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  transactions = 0;
  /** Set to make the episode insert report a conflict (the same instant, twice). */
  episodeConflict = false;
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

  cardinalityWrites(): readonly (readonly unknown[])[] {
    return this.calls
      .filter((c) => c.sql.includes("brain_predicate_cardinality"))
      .map((c) => c.params);
  }

  private async query(sql: string, params: unknown[]): Promise<{ rows: readonly unknown[] }> {
    this.calls.push({ sql, params });
    if (sql === WAREHOUSE_EPISODE_INSERT_SQL) {
      return { rows: this.episodeConflict ? [] : [{ id: `ep-${++this.seq}` }] };
    }
    if (sql === INSERT_FACT_SQL) return { rows: [{ id: `fact-${++this.seq}` }] };
    if (sql === RECONCILE_LOCK_SQL) return { rows: [] };
    if (sql === CORROBORATION_LOOKUP_SQL) return { rows: [] };
    if (sql === TENSION_CANDIDATES_SQL) return { rows: [] };
    if (sql === INSERT_PROVENANCE_EDGE_SQL) return { rows: [] };
    if (sql.includes("brain_predicate_cardinality")) return { rows: [{ inserted: 1 }] };
    throw new Error(`RunStore: unexpected statement\n${sql}`);
  }
}

interface RunHarness {
  readonly store: RunStore;
  readonly snapshots: WarehouseSnapshotRequest[];
  readonly deps: WarehouseProducerDeps;
}

function harness(options: {
  pairs: readonly { entity: string; dimension: string }[];
  entities: Record<string, Record<string, unknown> | null>;
  rows?: Record<string, readonly Record<string, unknown>[]>;
  snapshot?: (request: WarehouseSnapshotRequest) => Promise<readonly Record<string, unknown>[]>;
  rowCap?: number;
}): RunHarness {
  const store = new RunStore();
  const snapshots: WarehouseSnapshotRequest[] = [];
  return {
    store,
    snapshots,
    deps: {
      loadReach: async () => makeProducerReach(options.pairs),
      loadEntity: async (_workspaceId, entity) => options.entities[entity] ?? null,
      runSnapshot: async (request) => {
        snapshots.push(request);
        if (options.snapshot) return options.snapshot(request);
        return options.rows?.[request.entity] ?? [];
      },
      loadVocabulary: async () => identityVocabulary,
      withTransaction: store.runner,
      now: () => SNAPSHOT_AT,
      ...(options.rowCap === undefined ? {} : { rowCap: options.rowCap }),
    },
  };
}

const run = (h: RunHarness) =>
  runWarehouseProducer({ workspaceId: WORKSPACE, triggeredBy: "user-1" }, h.deps);

describe("runWarehouseProducer", () => {
  test("reads only enrolled dimensions, and emits only for enrolled pairs", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier" }],
      entities: {
        Accounts: entityYaml({
          table: "accounts",
          primaryKey: "id",
          // `status` and `arr` exist and are NOT enrolled. A sweep would read them.
          dimensions: ["id", "status", "tier", "arr"],
        }),
      },
      rows: {
        Accounts: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "gold" }],
      },
    });

    const report = await run(h);

    // The query itself names the enrolled dimension and nothing else — the
    // strongest available form of "no code path emits for an unenrolled pair",
    // because an unenrolled column never leaves the warehouse.
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.sql).toContain("tier AS");
    expect(h.snapshots[0]?.sql).not.toContain("status");
    expect(h.snapshots[0]?.sql).not.toContain("arr");
    // …and the positive control: it did emit.
    expect(report.created).toBe(1);
    expect(h.store.paramsFor(INSERT_FACT_SQL)).toHaveLength(1);
  });

  test("stamps the snapshot episode by REFERENCE — locator, never body", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier" }],
      entities: { Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }) },
      rows: { Accounts: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "gold" }] },
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
        { entity: "Accounts", dimension: "tier" },
        { entity: "Accounts", dimension: "status" },
      ],
      entities: {
        Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier", "status"] }),
      },
      rows: {
        Accounts: [
          {
            [SUBJECT_ALIAS]: "Acme Corp",
            [`${DIMENSION_ALIAS_PREFIX}0`]: "gold",
            [`${DIMENSION_ALIAS_PREFIX}1`]: "active",
          },
        ],
      },
    });

    const report = await run(h);

    const writes = h.store.cardinalityWrites();
    expect(writes).toHaveLength(2);
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

  test("refuses an over-cap entity rather than emitting a truncated reading of it", async () => {
    const h = harness({
      rowCap: 2,
      pairs: [
        { entity: "Big", dimension: "status" },
        { entity: "Small", dimension: "tier" },
      ],
      entities: {
        Big: entityYaml({ table: "big", primaryKey: "id", dimensions: ["id", "status"] }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      rows: {
        // Three rows against a cap of two — the `cap + 1` the query asked for.
        Big: [1, 2, 3].map((n) => ({
          [SUBJECT_ALIAS]: `row-${n}`,
          [`${DIMENSION_ALIAS_PREFIX}0`]: "active",
        })),
        Small: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "gold" }],
      },
    });

    const report = await run(h);

    expect(report.refusals.map((r) => `${r.entity}:${r.reason}`)).toEqual(["Big:row-cap-exceeded"]);
    // NOT truncated: nothing at all from `Big`, and the positive control shows the
    // run continued rather than aborting.
    expect(report.entities.map((e) => e.entity)).toEqual(["Small"]);
    expect(report.created).toBe(1);
  });

  test("a failed snapshot refuses that entity's pairs and leaves the rest of the run alone", async () => {
    const h = harness({
      pairs: [
        { entity: "Broken", dimension: "status" },
        { entity: "Small", dimension: "tier" },
      ],
      entities: {
        Broken: entityYaml({ table: "broken", primaryKey: "id", dimensions: ["id", "status"] }),
        Small: entityYaml({ table: "small", primaryKey: "id", dimensions: ["id", "tier"] }),
      },
      snapshot: async (request) => {
        if (request.entity === "Broken") throw new Error("connection refused");
        return [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "gold" }];
      },
    });

    const report = await run(h);

    expect(report.refusals.map((r) => `${r.entity}:${r.reason}`)).toEqual(["Broken:snapshot-failed"]);
    expect(report.created).toBe(1);
    // The refusal says what did NOT happen, because an operator's first question
    // about a failed producer is whether it retired anything.
    expect(report.refusals[0]?.message).toContain("Nothing was invalidated");
  });

  test("a re-run at the same instant does not write a second episode's worth of facts", async () => {
    const h = harness({
      pairs: [{ entity: "Accounts", dimension: "tier" }],
      entities: { Accounts: entityYaml({ table: "accounts", primaryKey: "id", dimensions: ["id", "tier"] }) },
      rows: { Accounts: [{ [SUBJECT_ALIAS]: "Acme Corp", [`${DIMENSION_ALIAS_PREFIX}0`]: "gold" }] },
    });
    h.store.episodeConflict = true;

    const report = await run(h);

    expect(h.store.paramsFor(WAREHOUSE_EPISODE_INSERT_SQL)).toHaveLength(1);
    expect(h.store.paramsFor(INSERT_FACT_SQL)).toHaveLength(0);
    expect(report.created).toBe(0);
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
        { ...h.deps, loadReach: async () => { throw new Error("internal DB is down"); } },
      ),
    ).rejects.toThrow("internal DB is down");
  });
});
