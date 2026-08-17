/**
 * **Two overlapping producer runs produce ONE snapshot's worth of facts** —
 * #5228's acceptance criterion, against real Postgres.
 *
 * ## Why a mock cannot settle this
 *
 * The claim is not "the lock function returns `acquired: false`" — the unit
 * suite pins that against an injected client. The claim is that a real
 * `pg_try_advisory_lock` taken on one pooled session is SEEN by a second
 * session, and that the producer running under it lands one instant's rows
 * rather than two. Every part of that is a property of the database.
 *
 * ## The positive control is the point of the file
 *
 * `both runs write when the lock is removed` runs the identical overlap with the
 * lock taken out, and asserts the damage: two episodes, two snapshot instants,
 * and a second reading of values nothing changed. Without it, the guarded test
 * is green against a producer that could not have written twice anyway — a
 * second run that silently did nothing would satisfy "one snapshot's worth"
 * perfectly, and the lock would be measuring itself.
 *
 * It is also the direct evidence for the sentence the module headers keep
 * repeating: `ON CONFLICT (workspace_id, source, source_id) DO NOTHING` on
 * `brain_episodes` does NOT dedupe two overlapping runs, because the source id
 * carries the snapshot instant and two runs take two.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_5228_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { withWarehouseRunLock } from "@atlas/api/lib/brain/warehouse-run-lock";
import {
  DIMENSION_ALIAS_PREFIX,
  SUBJECT_ALIAS,
  runWarehouseProducer,
  type ValidatedSnapshotRequest,
  type WarehouseProducerDeps,
  type WarehouseProducerReport,
} from "@atlas/api/lib/brain/warehouse-producer";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const ENTITY = "Accounts";
const SUBJECT = "Acme Corp";

const ACCOUNTS_YAML: Record<string, unknown> = {
  table: "accounts",
  dimensions: [
    { name: "name", sql: "account_name", primary_key: true },
    { name: "status", sql: "lifecycle_status" },
  ],
};

describeIfPg("warehouse run lock (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaName = `brain_5228_${suffix}`;
  /**
   * ⚠️ Suffixed, unlike the sibling `-pg` suites' constant workspace ids.
   *
   * An advisory lock's key is per DATABASE, not per schema — the schema-scoped
   * pool isolates the TABLES and does nothing about the lock space. Two of these
   * files running concurrently against one scratch database on a fixed workspace
   * id would serialize against each other and report a decline as a pass, which
   * is the failure that looks most like a success.
   */
  const workspace = `ws-brain-5228-${suffix}`;

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
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM brain_enrollment");
    await pool.query("DELETE FROM brain_predicate_cardinality");
  });

  async function enroll(dimension: string): Promise<void> {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note)
       VALUES ($1, $2, $3, 'user-1', NULL)`,
      [workspace, ENTITY, dimension],
    );
  }

  /**
   * A run whose only fictions are the semantic layer and the warehouse query —
   * `warehouse-producer-pg.test.ts`'s `deps`, plus a barrier.
   *
   * `gate` is awaited INSIDE `runSnapshot`, which is what makes the overlap real
   * rather than staged: the first run is genuinely mid-flight, holding whatever
   * it holds, when the second one arrives.
   *
   * ⚠️ **`resolveConnectionIds` is injected for the same reason `loadEntity` is: the
   * entity exists ONLY to these stubs.** The shipped resolver reads the workspace's
   * authoritative published catalog (`semantic_entities`), which this suite never
   * seeds, so with a live internal DB it correctly refuses {@link ENTITY} as
   * `connection-unresolved` (#5284) — and then `runSnapshot` is never reached, the
   * barrier's `onStart` never fires, and the overlap tests time out rather than
   * failing on the lock. Left un-injected, this file would be asserting lock
   * behaviour about a run that refuses before it takes anything.
   */
  function deps(
    snapshotAt: Date,
    status: string,
    gate?: Promise<void>,
    onStart?: () => void,
  ): WarehouseProducerDeps {
    return {
      loadEntity: async () => ACCOUNTS_YAML,
      // The flat default scope, matching the entity YAML above — no group, no hint.
      resolveConnectionIds: async () => ({ placed: new Map(), unplaceable: [] }),
      validateSnapshotSql: async (request) => ({
        valid: true,
        request: request as ValidatedSnapshotRequest,
      }),
      runSnapshot: async () => {
        // Signalled BEFORE awaiting the gate, so a waiter knows run A is
        // genuinely inside the snapshot — and therefore holding its lock.
        onStart?.();
        if (gate) await gate;
        return [{ [SUBJECT_ALIAS]: SUBJECT, [`${DIMENSION_ALIAS_PREFIX}0`]: status }];
      },
      now: () => snapshotAt,
    };
  }

  const produce = (
    snapshotAt: Date,
    status: string,
    gate?: Promise<void>,
    onStart?: () => void,
  ) =>
    runWarehouseProducer(
      { workspaceId: workspace, triggeredBy: "user-1" },
      deps(snapshotAt, status, gate, onStart),
    );

  /**
   * A barrier pair: `started` resolves when run A is inside `runSnapshot`,
   * `open` releases it.
   *
   * ⚠️ **This replaced a 50 ms `setTimeout`, and the sleep was not merely
   * slow — it flaked in the direction that HIDES a defect.** In the overlap test
   * a late run A fails loudly (visible). In the two-workspace scoping test it
   * does the opposite: under a global-lock mutation, if B goes first it
   * completes and releases before A arrives, so both acquire and the test passes
   * while the lock is fleet-wide. A test whose flake is green on the mutation it
   * exists to catch is worse than no test.
   */
  function barrier(): { started: Promise<void>; onStart: () => void; open: () => void; gate: Promise<void> } {
    let onStart!: () => void;
    let open!: () => void;
    const started = new Promise<void>((resolve) => {
      onStart = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { started, onStart, open, gate };
  }

  async function episodeSourceIds(): Promise<string[]> {
    const { rows } = await pool.query<{ source_id: string }>(
      `SELECT source_id FROM brain_episodes
        WHERE workspace_id = $1 AND source = 'warehouse' ORDER BY source_id`,
      [workspace],
    );
    return rows.map((r) => r.source_id);
  }

  async function factObjects(): Promise<string[]> {
    const { rows } = await pool.query<{ object: string }>(
      `SELECT object FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, object`,
      [workspace],
    );
    return rows.map((r) => r.object);
  }

  it(
    "declines the second of two overlapping runs — one snapshot's worth of facts lands",
    async () => {
      await enroll("status");
      const { started, onStart, open, gate } = barrier();

      // Run A is inside `runSnapshot`, holding the lock, when B arrives.
      const first = withWarehouseRunLock(workspace, () =>
        produce(new Date("2026-08-16T10:00:00.000Z"), "active", gate, onStart),
      );
      // Deterministic: A has ENTERED the snapshot, so it holds the lock.
      await started;

      let secondRan = false;
      const second = await withWarehouseRunLock(workspace, () => {
        secondRan = true;
        // A DIFFERENT instant and a DIFFERENT value: if this ever ran, the
        // assertions below could not mistake its output for A's.
        return produce(new Date("2026-08-16T10:00:00.500Z"), "churned");
      });

      open();
      const firstOutcome = await first;

      expect(second).toEqual({ acquired: false });
      expect(secondRan).toBe(false);
      expect(firstOutcome.acquired).toBe(true);
      const report = (firstOutcome as { acquired: true; value: WarehouseProducerReport }).value;
      expect(report.created).toBe(1);

      // ONE snapshot instant, ONE fact, and it is A's value.
      expect(await episodeSourceIds()).toEqual([
        `warehouse:${ENTITY}@2026-08-16T10:00:00.000Z`,
      ]);
      expect(await factObjects()).toEqual(["active"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "RELEASES the lock — a second, sequential run acquires and writes",
    async () => {
      // ⚠️ **Nothing in the tree could see a wrong unlock key.** The unit suite
      // asserts the statement's bound params and that it contains
      // `pg_advisory_unlock`; both survive `pg_advisory_unlock($1, 0)`. And in
      // `-pg`, a wrong-key unlock returns `false`, which poisons and DESTROYS the
      // socket — so the server drops the session lock anyway and every overlap
      // assertion still holds. The lock would silently depend on connection
      // destruction, with a `log.error` and a torn-down pooled connection on
      // every single run. Only a sequential SECOND acquisition can tell.
      await enroll("status");

      const first = await withWarehouseRunLock(workspace, () =>
        produce(new Date("2026-08-16T13:00:00.000Z"), "active"),
      );
      const second = await withWarehouseRunLock(workspace, () =>
        produce(new Date("2026-08-16T13:05:00.000Z"), "churned"),
      );

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(true);
      // Two genuine readings at two instants — the re-emission ADR-0037 §4
      // describes, which can only happen if the first lock was actually let go.
      expect(await episodeSourceIds()).toEqual([
        `warehouse:${ENTITY}@2026-08-16T13:00:00.000Z`,
        `warehouse:${ENTITY}@2026-08-16T13:05:00.000Z`,
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is WORKSPACE-scoped — two workspaces overlapping both acquire and both write",
    async () => {
      // ⚠️ **Nothing else in this file can tell a workspace-scoped lock from a
      // GLOBAL one.** Every other test uses a single workspace id, so
      // `hashtext($2) * 0` — valid SQL, still binds `$2`, still matches every
      // text assertion in the unit suite — passes all of them while making the
      // lock fleet-wide. An operator pressing Run in workspace B during
      // workspace A's cadence run would then get "a run is already in progress
      // for this workspace" about a workspace that has no run.
      const other = `${workspace}-second`;
      await enroll("status");
      await pool.query(
        `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note)
         VALUES ($1, $2, 'status', 'user-1', NULL)`,
        [other, ENTITY],
      );

      const { started, onStart, open, gate } = barrier();

      const first = withWarehouseRunLock(workspace, () =>
        produce(new Date("2026-08-16T12:00:00.000Z"), "active", gate, onStart),
      );
      // ⚠️ Deterministic, and here it is load-bearing rather than tidy: with a
      // sleep, a late run A lets B complete and release FIRST, so under a
      // global-lock mutation both still acquire and this test passes while the
      // lock is fleet-wide — a flake that is green on the defect it exists to
      // catch.
      await started;

      // A DIFFERENT workspace, while the first still holds its lock.
      const second = await withWarehouseRunLock(other, () =>
        runWarehouseProducer(
          { workspaceId: other, triggeredBy: "user-1" },
          deps(new Date("2026-08-16T12:00:00.500Z"), "churned"),
        ),
      );

      open();
      const firstOutcome = await first;

      // BOTH acquired. A global lock declines the second.
      expect(firstOutcome.acquired).toBe(true);
      expect(second.acquired).toBe(true);

      // And each workspace's facts are its own.
      expect(await factObjects()).toEqual(["active"]);
      const { rows } = await pool.query<{ object: string }>(
        `SELECT object FROM brain_facts WHERE workspace_id = $1`,
        [other],
      );
      expect(rows.map((r) => r.object)).toEqual(["churned"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "POSITIVE CONTROL: without the lock the same overlap writes BOTH readings",
    async () => {
      await enroll("status");
      const { started, onStart, open, gate } = barrier();

      // Identical overlap, no lock. This is the state the codebase was in before
      // #5228, and the assertions below are the damage the lock removes.
      const first = produce(new Date("2026-08-16T11:00:00.000Z"), "active", gate, onStart);
      await started;
      const second = await produce(new Date("2026-08-16T11:00:00.500Z"), "churned");
      open();
      await first;

      // TWO episodes. `ON CONFLICT (workspace_id, source, source_id) DO NOTHING`
      // saw two different source ids, because the source id carries the instant.
      expect(await episodeSourceIds()).toEqual([
        `warehouse:${ENTITY}@2026-08-16T11:00:00.000Z`,
        `warehouse:${ENTITY}@2026-08-16T11:00:00.500Z`,
      ]);
      // And the second reading landed as its own draft — one human decision
      // turned into two.
      expect(second.created).toBe(1);
      expect(await factObjects()).toContain("churned");
      expect((await factObjects()).length).toBeGreaterThan(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
