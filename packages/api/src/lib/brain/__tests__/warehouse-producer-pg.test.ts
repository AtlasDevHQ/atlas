/**
 * Real-Postgres coverage for the tier-1 warehouse producer (#5042, ADR-0037 §4,
 * ADR-0039).
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **Generated — see `packages/api/scripts/mutations/warehouse-producer.md`**, where
 * this file is the `pg` column (#5229). It is non-zero on exactly two rows, and both
 * are the `name`/`sql` decision — the emitted predicate, and the surface a
 * cardinality proposal is keyed by. Both are reachable only because the fixture
 * below gives every dimension a `sql:` that differs from its `name:`; with them
 * equal, as the profiler defaults them, neither row can fail. Its zeros are honest
 * and the spec's preamble says which of three reasons applies to each.
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/warehouse-producer.mutations.ts
 *
 * The unit suite pins what the producer DECIDES — which pairs it refuses, what a
 * candidate carries — against injected seams. Everything below is a claim only a
 * live schema can settle, and every one of them passes vacuously against a mock:
 *
 *   1. **Does a warehouse fact actually land `draft`?** The insert omits `status`
 *      entirely, because migration 0180's default IS the review gate applying
 *      itself. ADR-0039's whole argument rests on that being true for THIS
 *      producer, and only a stored row can tell it apart from a writer that
 *      forgot the column.
 *   2. **Does `subject_cmp` actually get populated?** It is the column ADR-0037
 *      §5 says only a warehouse-backed subject can supply, and it was
 *      permanently NULL until this producer existed. A test that asserts the
 *      resolver was CALLED does not answer it.
 *   3. **Acceptance criterion 5 — is re-emission tension-only?** A re-run over a
 *      changed value must mint an `in-tension-with` edge and must NOT stamp
 *      `valid_to` on the snapshot it replaces. Both halves need real rows: the
 *      tension scan is a SQL predicate over the live corpus, and "nothing was
 *      stamped" is a claim about a column.
 *   4. **Does an unchanged re-run corroborate instead of duplicating?** The
 *      POSITIVE CONTROL for (3). Without it, a producer whose identity path was
 *      broken — every run keying into its own fresh slot — would satisfy "no
 *      `valid_to` was stamped" perfectly while never colliding with anything.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/brain_5042_scratch
 *
 * ⚠️ 5432, not 5433. `db:up` starts the ROOT `docker-compose.yml`, which publishes
 * 5432; 5433/5434/5435 belong to the multi-env compose. This line said 5433 until
 * #5229, which is the port that makes the suite self-skip and then aborts the
 * mutation runner on a deflated baseline — the one failure the runbook exists to
 * prevent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityKey } from "@atlas/api/lib/brain/identity";
import {
  DIMENSION_ALIAS_PREFIX,
  SUBJECT_ALIAS,
  WAREHOUSE_PRODUCER,
  runWarehouseProducer,
  warehouseRowId,
  type ValidatedSnapshotRequest,
  type WarehouseProducerDeps,
} from "@atlas/api/lib/brain/warehouse-producer";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-5042";
const ENTITY = "Accounts";
const SUBJECT = "Acme Corp";

/**
 * The published entity the producer reads. One key, two enrollable dimensions.
 *
 * ⚠️ Every `sql:` differs from its `name:`, deliberately. With them equal —
 * the profiler's own default — `predicate: dim.name` and `predicate: dim.sql` are
 * the same string, and emitting a COLUMN EXPRESSION as a predicate is exactly the
 * "can never lexically match anything an LLM emits" failure the bare name exists to
 * prevent. The unit suite makes the same choice for the same reason.
 */
const ACCOUNTS_YAML: Record<string, unknown> = {
  table: "accounts",
  dimensions: [
    { name: "name", sql: "account_name", primary_key: true },
    { name: "status", sql: "lifecycle_status" },
    { name: "tier", sql: "plan_tier" },
  ],
};

describeIfPg("warehouse producer (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5042_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Set inside the hook, never at module top level (test-discipline rule), and
    // restored after: `getInternalDB` and its callers read `DATABASE_URL`.
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // The producer, the reconcile stage and the enrollment read all write through
    // the module-level pool, so it has to BE this schema-scoped one for the test
    // to exercise the real SQL.
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  afterEach(async () => {
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM brain_enrollment");
    await pool.query("DELETE FROM brain_predicate_cardinality");
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Enroll a pair through the TABLE rather than through `enrollPair`.
   *
   * Deliberate: this suite's subject is the producer, and going through the
   * writer would make every assertion below depend on the enrollment seam's own
   * behaviour. `enrollment-pg.test.ts` owns that.
   */
  async function enroll(dimension: string): Promise<void> {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note)
       VALUES ($1, $2, $3, 'user-1', NULL)`,
      [WORKSPACE, ENTITY, dimension],
    );
  }

  /**
   * A run whose only fiction is the warehouse itself.
   *
   * The reach read, the vocabulary load, the transaction, the reconcile stage and
   * the cardinality proposal are all the SHIPPED ones against the live schema —
   * only the semantic-layer read and the datasource query are injected, because
   * neither has a schema this test could stand up.
   *
   * ⚠️ **`resolveConnectionIds` is injected too, and it has to be — the entity this
   * file runs on exists ONLY to the injected loader.** The shipped resolver reads
   * `semantic_entities`, which this suite never seeds, so with a live internal DB it
   * correctly reports {@link ENTITY} as absent from the workspace's authoritative
   * catalog and refuses every pair `connection-unresolved` (#5284). That refusal is
   * right about the fixture and wrong about the intent: the fixture's premise is that
   * the entity IS published, asserted by injecting `loadEntity`. Injecting both keeps
   * the two halves of that premise from disagreeing.
   */
  function deps(snapshotAt: Date, rows: readonly Record<string, unknown>[]): WarehouseProducerDeps {
    return {
      loadEntity: async () => ACCOUNTS_YAML,
      // The flat default scope — no `connection:` hint, no group — which is what this
      // suite's snapshots ran against before the seam existed.
      resolveConnectionIds: async () => ({ placed: new Map(), unplaceable: [] }),
      // The SQL gate is workspace-whitelist-scoped and this schema has no
      // whitelist, so it is stubbed here and driven for real in the unit suite
      // (`what it builds is never rejected for its FORM`).
      // The cast is required: the passing verdict carries a branded
      // `ValidatedSnapshotRequest`, so an object literal cannot assert the gate
      // passed, which makes every bypass in the tree greppable.
      //
      // It brands the request it was HANDED — a freshly built one would be refused
      // by the run loop's anti-replay identity check (#5230).
      validateSnapshotSql: async (request) => ({
        valid: true,
        request: request as ValidatedSnapshotRequest,
      }),
      runSnapshot: async () => rows,
      now: () => snapshotAt,
    };
  }

  const row = (status: string, tier?: string) => ({
    [SUBJECT_ALIAS]: SUBJECT,
    [`${DIMENSION_ALIAS_PREFIX}0`]: status,
    ...(tier === undefined ? {} : { [`${DIMENSION_ALIAS_PREFIX}1`]: tier }),
  });

  const run = (snapshotAt: Date, rows: readonly Record<string, unknown>[]) =>
    runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      deps(snapshotAt, rows),
    );

  async function facts(): Promise<
    {
      id: string;
      subject: string;
      predicate: string;
      object: string;
      status: string;
      subject_cmp: string | null;
      valid_to: Date | null;
      provenance: Record<string, unknown>;
    }[]
  > {
    const { rows } = await pool.query(
      `SELECT id::text AS id, subject, predicate, object, status, subject_cmp, valid_to, provenance
         FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, object`,
      [WORKSPACE],
    );
    return rows;
  }

  async function tensionEdges(): Promise<{ from_fact_id: string; to_fact_id: string }[]> {
    const { rows } = await pool.query(
      `SELECT from_fact_id::text AS from_fact_id, to_fact_id::text AS to_fact_id
         FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [WORKSPACE],
    );
    return rows;
  }

  // ── the emission ──────────────────────────────────────────────────────────

  it(
    "lands a DRAFT carrying the bare predicate, a warehouse episode and a non-null subject_cmp",
    async () => {
      await enroll("status");
      const report = await run(new Date("2026-08-14T10:00:00.000Z"), [row("active")]);

      expect(report.created).toBe(1);
      const [fact] = await facts();
      expect(fact?.subject).toBe(SUBJECT);
      // THE BARE NAME — not `accounts.status`, not the COLUMN `lifecycle_status`.
      expect(fact?.predicate).toBe("status");
      expect(fact?.predicate).not.toBe("lifecycle_status");
      expect(fact?.object).toBe("active");
      // The review gate applying itself. Asserted against the STORED row, because
      // the insert never names the column.
      expect(fact?.status).toBe("draft");
      expect(fact?.valid_to).toBeNull();
      // The column that was permanently NULL before this producer existed.
      expect(fact?.subject_cmp).toBe(`entity:${warehouseRowId(WORKSPACE, ENTITY, SUBJECT)}`);
      // ⚠️ `comparable` counts a non-null `object_cmp` and is legitimately 0 here —
      // `active` is an unparseable string. Asserted BESIDE the non-null
      // `subject_cmp` above, at a different value, so the two can never be read as
      // one number again: an earlier docstring claimed this field counted
      // `subject_cmp`, which would have made a working producer look idle.
      expect(report.entities[0]?.comparable).toBe(0);
      expect(fact?.subject_cmp).not.toBeNull();
      expect(fact?.provenance.producer).toBe(WAREHOUSE_PRODUCER);
      // Qualification rides here and NOWHERE ELSE.
      expect(fact?.provenance.entity).toBe(ENTITY);
      expect(fact?.provenance.table).toBe("accounts");

      const { rows: episodes } = await pool.query(
        `SELECT source, body, locator, extracted_at FROM brain_episodes WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(episodes).toHaveLength(1);
      expect(episodes[0].source).toBe("warehouse");
      // Evidence BY REFERENCE, and already off the extraction queue — leaving
      // `extracted_at` null would hand a snapshot to the LLM fiber to be
      // re-derived as a second, guessed claim.
      expect(episodes[0].body).toBeNull();
      expect(String(episodes[0].locator)).toContain("FROM accounts");
      expect(episodes[0].extracted_at).not.toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "proposes warehouse_structural cardinality as PENDING, never approved",
    async () => {
      await enroll("status");
      await run(new Date("2026-08-14T10:00:00.000Z"), [row("active")]);

      const { rows } = await pool.query(
        `SELECT predicate_key, cardinality, status, source_class, proposed_by
           FROM brain_predicate_cardinality WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].predicate_key).toBe(identityKey("status"));
      expect(rows[0].cardinality).toBe("single");
      // `pending`, not `approved`. A `single` entry is retroactively destructive,
      // so no producer decides one — the human at the vocabulary gate does.
      expect(rows[0].status).toBe("pending");
      expect(rows[0].source_class).toBe("warehouse_structural");
      expect(rows[0].proposed_by).toBe(WAREHOUSE_PRODUCER);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── acceptance criterion 5 ────────────────────────────────────────────────

  it(
    "re-emission over a CHANGED value is tension-only — an edge, and no valid_to stamp",
    async () => {
      await enroll("status");
      await run(new Date("2026-08-14T10:00:00.000Z"), [row("active")]);
      const report = await run(new Date("2026-08-14T11:00:00.000Z"), [row("churned")]);

      expect(report.created).toBe(1);
      const stored = await facts();
      expect(stored.map((f) => f.object).toSorted()).toEqual(["active", "churned"]);

      // The advisory edge — one, between the two.
      const edges = await tensionEdges();
      expect(edges).toHaveLength(1);
      expect(new Set([edges[0]!.from_fact_id, edges[0]!.to_fact_id])).toEqual(
        new Set(stored.map((f) => f.id)),
      );

      // ⚠️ THE OTHER HALF, and it is the half a "did the edge appear?" test cannot
      // see. A machine invalidating a fact is forbidden (#4759 §2), and #5033's
      // tier guard is symmetric — so warehouse↔warehouse supersession is held back
      // exactly as cross-tier is. NEITHER row may be stamped or tombstoned.
      expect(stored.every((f) => f.valid_to === null)).toBe(true);
      const { rows: invalidated } = await pool.query(
        `SELECT count(*)::int AS n FROM brain_facts
          WHERE workspace_id = $1 AND invalidated_at IS NOT NULL`,
        [WORKSPACE],
      );
      expect(invalidated[0].n).toBe(0);
      // Both still live, both still draft — the queue a person drains.
      expect(stored.every((f) => f.status === "draft")).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an UNCHANGED re-run corroborates rather than duplicating — the control for the edge above",
    async () => {
      // Without this, a producer whose identity path was broken (every run keying
      // into a fresh slot) would satisfy "no valid_to was stamped" while never
      // colliding with anything at all.
      await enroll("status");
      await run(new Date("2026-08-14T10:00:00.000Z"), [row("active")]);
      const report = await run(new Date("2026-08-14T11:00:00.000Z"), [row("active")]);

      expect(report.created).toBe(0);
      expect(report.corroborated).toBe(1);
      // ⚠️ `already-decided` is the ordinary refusal, and this is what pins it: an
      // unconditional push into `cardinalityProposed` survives every other
      // assertion in both suites.
      expect(report.entities[0]?.cardinalityProposed).toEqual([]);
      expect(await facts()).toHaveLength(1);
      expect(await tensionEdges()).toEqual([]);
      // The second snapshot IS recorded as evidence — corroboration is the claim
      // getting stronger, not the run being skipped.
      const { rows: provenanceEdges } = await pool.query(
        `SELECT count(*)::int AS n FROM brain_edges
          WHERE workspace_id = $1 AND edge_type = 'provenance'`,
        [WORKSPACE],
      );
      expect(provenanceEdges[0].n).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── the reach ─────────────────────────────────────────────────────────────

  it(
    "emits for the enrolled dimension and for no other, with the unenrolled one in the same snapshot",
    async () => {
      // The falsifier for "no code path emits for an unenrolled pair", stated
      // where it is hardest to fake: `tier` is present in the ROWS the run reads,
      // so a producer that emitted whatever the snapshot handed it would create
      // two facts here rather than one.
      await enroll("status");
      const report = await run(new Date("2026-08-14T10:00:00.000Z"), [row("active", "gold")]);

      expect(report.created).toBe(1);
      const stored = await facts();
      expect(stored.map((f) => f.predicate)).toEqual(["status"]);
      expect(stored.map((f) => f.object)).toEqual(["active"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an empty reach writes nothing at all — not an episode, not a cardinality row",
    async () => {
      const report = await run(new Date("2026-08-14T10:00:00.000Z"), [row("active")]);
      expect(report.enrolled).toBe(0);
      expect(await facts()).toEqual([]);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM brain_episodes WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(rows[0].n).toBe(0);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
