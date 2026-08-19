/**
 * The per-entity success record, against a live schema (#5317, migration 0206).
 *
 * The record exists so #5233's entity-store reaper can ask *when did the
 * producer last succeed for THIS entity* — a question nothing could answer
 * before, at any grain. Its whole value is a negative: a row must never exist
 * for work that did not commit, because the reaper DELETES on the strength of
 * one.
 *
 * That claim is not testable against a mock. `recordEntityRunSuccess` takes a
 * `ReconcileExecutor`, and every fake executor in the tree resolves whatever it
 * is handed — so a writer that had been given a POOL instead of the entity's
 * transaction would satisfy the unit suite perfectly and then survive every
 * rollback in production, which is the one case the reaper is standing on.
 * Only a real transaction can tell the two apart.
 *
 * Four arms, and two of them needed a database:
 *
 *   1. **Success** — a committing run leaves exactly one row per entity,
 *      stamped with the run's SNAPSHOT INSTANT (the value the reach rule
 *      compares against `brain_entity.snapshot_at`), not with a wall clock.
 *   2. **Zero candidates** — a run that READ the datasource successfully and
 *      found nothing to claim is a success too, and this is the arm the record
 *      exists for. See below.
 *   3. **Refusal** — an entity whose datasource cannot be read is refused
 *      before any transaction opens, and advances nothing.
 *   4. **Rollback** — an entity whose transaction does its work and then rolls
 *      back leaves NO row, even though the INSERT was executed. This is the
 *      arm that would pass vacuously against the others alone.
 *
 * ## ⚠️ Why arm 2 is the one that matters
 *
 * The first draft recorded a success only inside the reconcile transaction, and
 * a review caught what that costs. Every case migration 0206 names as the reason
 * #5233 needs a reaper is a ZERO-CANDIDATE case — a truncated table, a primary
 * key that stopped being surfaceable — because those are exactly the runs that
 * never reach `writeEntityEntries` and therefore exactly the runs that strand
 * entries. Meanwhile any run that DOES commit replaces every entry at the same
 * `snapshot_at`, so nothing can predate it.
 *
 * So with arm 2 missing, the marker advanced only when there was nothing to reap
 * and never when there was, and the reach rule was unfireable on its own target
 * population. Measured before the fix: a zero-row snapshot reported
 * `candidates: 0`, `refusals: []` and wrote no record.
 *
 * No reader is exercised because this slice adds none, deliberately (#5317).
 * The assertions read the table directly, which is the honest way to test a
 * write with no consumer yet — and it is why the statement is exported.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";
import {
  DIMENSION_ALIAS_PREFIX,
  SUBJECT_ALIAS,
  runWarehouseProducer,
  type ValidatedSnapshotRequest,
  type WarehouseProducerDeps,
} from "@atlas/api/lib/brain/warehouse-producer";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-5317";
const ENTITY = "Accounts";
const SUBJECT = "Acme Corp";
const SNAPSHOT_AT = new Date("2026-08-18T10:00:00.000Z");

const ACCOUNTS_YAML: Record<string, unknown> = {
  table: "accounts",
  dimensions: [
    { name: "name", sql: "account_name", primary_key: true },
    { name: "status", sql: "lifecycle_status" },
  ],
};

describeIfPg("warehouse per-entity success record (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5317_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
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
    await pool.query("DELETE FROM brain_warehouse_entity_success");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM brain_enrollment");
    await pool.query("DELETE FROM brain_predicate_cardinality");
  });

  // -- helpers ---------------------------------------------------------------

  async function enroll(dimension: string): Promise<void> {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note)
       VALUES ($1, $2, $3, 'user-1', NULL)`,
      [WORKSPACE, ENTITY, dimension],
    );
  }

  /**
   * A transaction that does the real work against the real database and then
   * ROLLS BACK, exactly as `withBrainTransaction` does when the entity's work
   * throws — followed by the rejection the producer's own catch arm expects.
   *
   * The rollback is what makes the arm: every statement the producer issued,
   * the success INSERT included, really executed against Postgres. If the
   * writer had been handed a pool instead of the entity's `tx`, its row would
   * be sitting outside this transaction and would survive.
   */
  const rollingBackTransaction: ReconcileTransactionRunner = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
      await client.query("ROLLBACK");
      throw new Error("the entity's work failed after it was written");
    } finally {
      client.release();
    }
  };

  function deps(overrides: Partial<WarehouseProducerDeps> = {}): WarehouseProducerDeps {
    return {
      loadEntity: async () => ACCOUNTS_YAML,
      resolveConnectionIds: async () => ({ placed: new Map(), unplaceable: [] }),
      // Stubbed for `warehouse-producer-pg.test.ts`'s reason: the SQL gate is
      // workspace-whitelist-scoped and this schema has no whitelist. The cast is
      // required so every bypass in the tree stays greppable.
      validateSnapshotSql: async (request) => ({
        valid: true,
        request: request as ValidatedSnapshotRequest,
      }),
      runSnapshot: async () => [
        { [SUBJECT_ALIAS]: SUBJECT, [`${DIMENSION_ALIAS_PREFIX}0`]: "active" },
      ],
      now: () => SNAPSHOT_AT,
      ...overrides,
    };
  }

  const run = (overrides: Partial<WarehouseProducerDeps> = {}) =>
    runWarehouseProducer({ workspaceId: WORKSPACE, triggeredBy: "user-1" }, deps(overrides));

  async function successes(): Promise<{ entity: string; succeeded_at: Date }[]> {
    const { rows } = await pool.query(
      `SELECT entity, succeeded_at FROM brain_warehouse_entity_success
        WHERE workspace_id = $1 ORDER BY entity, succeeded_at`,
      [WORKSPACE],
    );
    return rows;
  }

  // -- 1: the success arm ----------------------------------------------------

  it(
    "a committing run records the entity, stamped with the SNAPSHOT INSTANT",
    async () => {
      await enroll("status");
      const report = await run();
      expect(report.created, "the run produced nothing, so the record below proves nothing").toBe(1);

      const rows = await successes();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity).toBe(ENTITY);
      // The run's snapshot instant, NOT the transaction's clock. The reach rule
      // compares this to `brain_entity.snapshot_at`, which the same transaction
      // wrote from the same value — a `now()` here would be later than the
      // snapshot by however long the reconcile took, and every entry would read
      // as older than its own run: the direction that reaps live entries.
      expect(rows[0]!.succeeded_at.toISOString()).toBe(SNAPSHOT_AT.toISOString());

      const { rows: entries } = await pool.query<{ snapshot_at: Date }>(
        `SELECT snapshot_at FROM brain_entity WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      // This fixture names no naming dimension, so there are no store entries —
      // and the record is written anyway. Asserted rather than left implicit:
      // the row describes THE RUN, not the store, and an implementation that
      // wrote it from inside the entry loop would be silently absent for every
      // entity nobody has named.
      expect(entries).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a second successful run appends rather than replacing — the history the rule needs",
    async () => {
      // The positive control for "last N successful runs" being answerable at
      // all. A single-timestamp record satisfies the arm above and answers only
      // N = 1, which is the thing #5317 refuses to decide here.
      await enroll("status");
      await run();
      await run({ now: () => new Date("2026-08-18T11:00:00.000Z") });

      const rows = await successes();
      expect(rows.map((r) => r.succeeded_at.toISOString())).toEqual([
        "2026-08-18T10:00:00.000Z",
        "2026-08-18T11:00:00.000Z",
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- 2: the zero-candidate arm ---------------------------------------------

  it(
    "a run that READ the datasource and found nothing still records a success",
    async () => {
      // THE arm the record exists for, and the one the first draft missed. A
      // truncated warehouse table reads clean and yields no claims — and it is
      // the state whose stale `brain_entity` entries the reaper is for. If this
      // run advances nothing, those entries are unreapable forever.
      await enroll("status");
      const report = await run({ runSnapshot: async () => [] });

      // The producer's own line between the two: read-but-empty is an OUTCOME,
      // not a refusal. Asserted so this test cannot quietly become a test about
      // the refusal arm if that classification ever moves.
      expect(report.refusals, "a zero-row read is not a refusal").toEqual([]);
      expect(report.entities.map((e) => [e.entity, e.candidates])).toEqual([[ENTITY, 0]]);

      const rows = await successes();
      expect(
        rows.map((r) => [r.entity, r.succeeded_at.toISOString()]),
        "a successful read that produced no claims recorded nothing, so #5233's reach rule can never fire on the population it exists for",
      ).toEqual([[ENTITY, SNAPSHOT_AT.toISOString()]]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "…and it writes ONLY the record — no episode, no facts",
    async () => {
      // The control for the arm above. Recording a success must not be a licence
      // to write a snapshot episode with nothing hanging off it, which is the
      // behaviour the zero-candidate branch exists to prevent in the first place.
      await enroll("status");
      await run({ runSnapshot: async () => [] });

      const { rows } = await pool.query<{ episodes: number; facts: number }>(
        `SELECT (SELECT count(*) FROM brain_episodes WHERE workspace_id = $1)::int AS episodes,
                (SELECT count(*) FROM brain_facts    WHERE workspace_id = $1)::int AS facts`,
        [WORKSPACE],
      );
      expect(rows[0]).toEqual({ episodes: 0, facts: 0 });
      expect(await successes()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- 3: the refusal arm ----------------------------------------------------

  it(
    "an UNREADABLE DATASOURCE advances nothing — the refusal arm",
    async () => {
      // The case #5317 names by hand: a refusal or an unreadable datasource is
      // precisely what must not advance the success marker, because the
      // alternative rule — reap on any run that omitted the entity — deletes a
      // live entity's whole store on a transient outage.
      await enroll("status");
      const report = await run({
        runSnapshot: async () => {
          throw new Error("connection refused");
        },
      });

      expect(
        report.refusals.length,
        "the entity was not refused, so this measures nothing about refusals",
      ).toBeGreaterThan(0);
      expect(await successes()).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- 4: the rollback arm ---------------------------------------------------

  it(
    "a ROLLED-BACK transaction leaves no record, though the INSERT ran",
    async () => {
      // THE arm the other two cannot reach. The producer's work — the episode,
      // the facts, the cardinality proposal and the success INSERT — all really
      // executed against Postgres inside a real transaction, which then rolled
      // back. A record written through anything other than that transaction
      // survives here and nowhere else.
      await enroll("status");
      const report = await run({ withTransaction: rollingBackTransaction });

      expect(
        report.refusals.some((r) => r.reason === "snapshot-failed"),
        "the transaction did not fail the way this arm needs it to",
      ).toBe(true);
      expect(
        await successes(),
        "a success record outlived the transaction that wrote it — the reaper would delete this entity's store entries on the strength of a run that never committed",
      ).toEqual([]);

      // And the control that makes the emptiness mean something: nothing else
      // committed either, so the run really did roll back rather than never
      // having run.
      const { rows: facts } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM brain_facts WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(facts[0]!.n).toBe(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "…and the SAME fixture with a committing transaction does record — the control",
    async () => {
      // Without this, the rollback arm is satisfied by a producer that never
      // writes the record at all, and by a fixture whose entity was never
      // reached.
      await enroll("status");
      await run();
      expect(await successes()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
