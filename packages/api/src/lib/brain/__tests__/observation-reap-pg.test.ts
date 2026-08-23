/**
 * Reaping observations of rows the entity filter excludes (#5344, ADR-0042),
 * against a real Postgres.
 *
 * Every claim here is one only a live schema can settle. The statement is a
 * five-CTE DELETE over three tables whose whole job is to touch one population
 * and no other; a double dispatching on its bytes proves it was ISSUED, which is
 * the one thing that was never in doubt.
 *
 * ## What each block proves
 *
 * **Block A — end to end, through the shipped producer.** #5344's acceptance
 * criterion in one test: an entity whose filter starts excluding a row, its
 * observation and the tension edges it minted gone, and a live reviewed claim in
 * the same slot untouched. Driven through `runWarehouseProducer` rather than by
 * calling the reaper, because the thing under test is the rule's interaction
 * with emission — the success records, the corroboration edges and the reap all
 * come from the same runs.
 *
 * It also carries the falsifier for the implementation this ticket most easily
 * gets: `brain_facts.extracted_at` looks like the fact's answer to
 * `brain_entity.snapshot_at` and is not. A row that never changes is
 * CORROBORATED on every later run, and corroboration deliberately writes nothing
 * to the fact — so its `extracted_at` stays pinned at the first sighting for as
 * long as the row lives. `Acme Corp` below is read successfully by all five runs
 * and its observation must survive every one of them; keyed on `extracted_at`
 * the whole comparison surface goes on run three.
 *
 * **Block B — the fences.** Three of the four ways this statement could delete a
 * belief, driven one at a time: a human claim a warehouse episode once
 * corroborated, a published row, another entity's corpus. Plus the arms the
 * reach rule inherits — an outage, a short history — asserted here as well as on
 * the store's reaper because "same rule" is a claim about THIS statement.
 *
 * **Block C — the entity parse.** The SQL regex is a third spelling of
 * `warehouse:<entity>@<iso>`. It is driven against `parseWarehouseEpisodeEntity`
 * over one corpus, including the names that break the two cheaper matchers
 * (`LIKE` and a non-greedy split).
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import {
  OBSERVATION_REAP_SQL,
  reapUnreachedObservations,
} from "@atlas/api/lib/brain/observation-reap";
import {
  recordEntityRunSuccess,
  WAREHOUSE_REAP_AFTER_SUCCESSFUL_RUNS,
} from "@atlas/api/lib/brain/warehouse-run-record";
import {
  DIMENSION_ALIAS_PREFIX,
  SUBJECT_ALIAS,
  parseWarehouseEpisodeEntity,
  runWarehouseProducer,
  warehouseEpisodeSourceId,
  type ValidatedSnapshotRequest,
  type WarehouseProducerDeps,
} from "@atlas/api/lib/brain/warehouse-producer";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-5344";
const ENTITY = "Accounts";
/** The row that stays in the filtered snapshot for every run. */
const LIVE = "Acme Corp";
/** The row that leaves it. */
const CHURNED = "Churned Inc";

const ACCOUNTS_YAML: Record<string, unknown> = {
  table: "reap_accounts",
  dimensions: [
    { name: "name", sql: "account_name", primary_key: true },
    { name: "status", sql: "lifecycle_status" },
  ],
};

describeIfPg("observation reaping (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5344_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    // The producer, the reconcile stage and the enrollment read all go through
    // the module-level pool, so it has to BE this schema-scoped one.
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
    // UNSCOPED, on `entity-store-reach-pg.test.ts`'s reason: a scoped cleanup
    // leaves another workspace's rows behind when an assertion fails, and the
    // first failure then cascades into every test after it.
    await pool.query(`DELETE FROM brain_edges`);
    await pool.query(`DELETE FROM brain_facts`);
    await pool.query(`DELETE FROM brain_episodes`);
    await pool.query(`DELETE FROM brain_enrollment`);
    await pool.query(`DELETE FROM brain_warehouse_entity_success`);
    await pool.query(`DELETE FROM brain_predicate_cardinality`);
  });

  // -- helpers ---------------------------------------------------------------

  /** The pool as a `ReconcileExecutor` — auto-committing. */
  const exec: ReconcileExecutor = { query: (sql, params) => pool.query(sql, params) };

  /** Run `fn` in one real transaction, so a rollback can be asserted. */
  async function inTransaction<T>(fn: (tx: ReconcileExecutor) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn({ query: (sql, params) => client.query(sql, params) });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        console.debug("observation-reap fixture: ROLLBACK failed", rollbackErr);
      });
      throw err;
    } finally {
      client.release();
    }
  }

  const reap = (entity = ENTITY, workspaceId = WORKSPACE) =>
    reapUnreachedObservations(exec, { workspaceId, entity });

  async function storedFacts(workspaceId = WORKSPACE): Promise<
    { id: string; subject: string; object: string; status: string; extracted_at: Date | null }[]
  > {
    const { rows } = await pool.query(
      `SELECT id::text AS id, subject, object, status, extracted_at
         FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, object`,
      [workspaceId],
    );
    return rows;
  }

  async function edgesOfType(type: string): Promise<{ from_fact_id: string | null; to_fact_id: string | null }[]> {
    const { rows } = await pool.query(
      `SELECT from_fact_id::text AS from_fact_id, to_fact_id::text AS to_fact_id
         FROM brain_edges WHERE workspace_id = $1 AND edge_type = $2`,
      [WORKSPACE, type],
    );
    return rows;
  }

  // ==========================================================================
  // Block A — end to end, through the shipped producer
  // ==========================================================================

  function deps(snapshotAt: Date, rows: readonly Record<string, unknown>[]): WarehouseProducerDeps {
    return {
      loadEntity: async () => ({ ...ACCOUNTS_YAML, filter: "deleted_at IS NULL" }),
      resolveConnectionIds: async () => ({ placed: new Map(), unplaceable: [] }),
      // The gate is workspace-whitelist-scoped and this schema has no whitelist —
      // `warehouse-producer-pg.test.ts`'s reason, verbatim. It brands the request
      // it was HANDED, so the run loop's anti-replay identity check still holds.
      validateSnapshotSql: async (request) => ({
        valid: true,
        request: request as ValidatedSnapshotRequest,
      }),
      runSnapshot: async () => rows,
      now: () => snapshotAt,
    };
  }

  const row = (subject: string, status: string) => ({
    [SUBJECT_ALIAS]: subject,
    [`${DIMENSION_ALIAS_PREFIX}0`]: status,
  });

  const run = (at: string, rows: readonly Record<string, unknown>[]) =>
    runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      deps(new Date(at), rows),
    );

  async function enroll(dimension: string, entity = ENTITY): Promise<void> {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note)
       VALUES ($1, $2, $3, 'user-1', NULL)`,
      [WORKSPACE, entity, dimension],
    );
  }

  /**
   * A REVIEWED human claim in the slot the churned row's observation occupies.
   *
   * Published, chat-sourced, and deliberately carrying a different object, so
   * the producer's own tension scan wires it to the observation exactly as it
   * would in production. It is the control the acceptance criterion names: the
   * reap must take the observation and the edge and leave this row alone.
   */
  async function seedReviewedClaim(subject: string, predicate: string, object: string): Promise<string> {
    const { rows: eps } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, occurred_at, visible_to)
       VALUES ($1, 'slack', 'slack:C1/1', 'someone said so', $2::timestamptz, $3::text[])
       RETURNING id`,
      [WORKSPACE, "2026-08-14T09:00:00.000Z", ["org"]],
    );
    const episodeId = eps[0]!.id;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status,
          visible_to, subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'published', $7::text[], $8, $9, $10)
       RETURNING id`,
      [
        WORKSPACE,
        subject,
        predicate,
        object,
        episodeId,
        JSON.stringify({ source: "slack", actor: "user-2" }),
        ["org"],
        slotKey(subject, identityAlias),
        slotKey(predicate, identityAlias),
        slotKey(object, identityAlias),
      ],
    );
    const factId = rows[0]!.id;
    // Its own evidence pointer, as `reconcile.ts` writes one — so the assertion
    // that the reap left this claim's graph alone has something to be about.
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
       VALUES ($1, 'provenance', $2, $3)`,
      [WORKSPACE, factId, episodeId],
    );
    return factId;
  }

  it(
    "the acceptance criterion — an excluded row's observation and its tension edges go, and the reviewed claim in the same slot does not",
    async () => {
      await enroll("status");
      const reviewed = await seedReviewedClaim(CHURNED, "status", "renewed");

      // Run 1: both rows in the filtered snapshot.
      await run("2026-08-14T10:00:00.000Z", [row(LIVE, "active"), row(CHURNED, "active")]);
      // Run 2: the churned row's value changes, which is what mints the
      // observation↔observation tension edge alongside the one against the
      // reviewed claim. Two edges hang off this entity's churned observations
      // now, and both must go with them.
      await run("2026-08-14T11:00:00.000Z", [row(LIVE, "active"), row(CHURNED, "churned")]);

      const before = await storedFacts();
      expect(
        before.map((f) => `${f.subject}/${f.object}`).toSorted(),
        "the fixture did not reach the state the reap is supposed to act on",
      ).toEqual(["Acme Corp/active", "Churned Inc/active", "Churned Inc/churned", "Churned Inc/renewed"]);
      expect(await edgesOfType("in-tension-with")).not.toEqual([]);
      const tensionBefore = (await edgesOfType("in-tension-with")).length;

      // The filter starts excluding `Churned Inc` — the row is soft-deleted, so
      // the snapshot simply stops carrying it. Three more successful runs.
      await run("2026-08-14T12:00:00.000Z", [row(LIVE, "active")]);
      await run("2026-08-14T13:00:00.000Z", [row(LIVE, "active")]);
      const afterTwo = await storedFacts();
      expect(
        afterTwo.map((f) => `${f.subject}/${f.object}`).toSorted(),
        "reaped the live-valued observation after only two runs without the row — the boundary is at N, and N is 3",
      ).toEqual(["Acme Corp/active", "Churned Inc/churned", "Churned Inc/renewed"]);

      // ⚠️ `Churned Inc/active` IS already gone here, and that is the same rule
      // rather than an exception to it. Run two read the row and found a
      // different value, so that observation earned no evidence from 11:00
      // onwards and ages out one run ahead of its successor — which is what the
      // rule says and what ADR-0042 wants: repeated runs are supposed to leave a
      // comparison surface, not an accumulating timeline of open windows the
      // design has already declined to grow. Stated because a reader arriving
      // from the ticket expects the two churned rows to go together.
      //
      // It also exercises the OTHER direction of the edge clause, here and
      // nowhere else in this file: run two wired `Churned Inc/churned` → the
      // now-reaped `Churned Inc/active`, so that edge hung off a reaped
      // observation by its `to_fact_id`. One edge is left at this point — the
      // surviving observation's tension against the reviewed claim — which is
      // what says the statement took the dangling one and not the type.
      const midpoint = await edgesOfType("in-tension-with");
      expect(
        midpoint,
        "an edge POINTING AT a reaped observation survived it — the clause matches only from_fact_id",
      ).toHaveLength(1);
      expect(midpoint[0]?.to_fact_id).toBe(reviewed);

      const report = await run("2026-08-14T14:00:00.000Z", [row(LIVE, "active")]);
      expect(report.refusals).toEqual([]);

      const after = await storedFacts();
      // Both observations of the churned row are gone…
      expect(after.filter((f) => f.subject === CHURNED && f.status === "draft")).toEqual([]);
      // …and the reviewed claim in the same slot is untouched.
      expect(after.map((f) => f.id)).toContain(reviewed);
      expect(after.find((f) => f.id === reviewed)?.status).toBe("published");

      // ⚠️ **THE `extracted_at` FALSIFIER.** `Acme Corp` was minted by run one
      // and merely CORROBORATED by runs two through five, which write nothing to
      // the fact — so its `extracted_at` is 10:00 and every success in the window
      // postdates it. A reaper keyed on the fact's own timestamp takes it here,
      // and takes the entire comparison surface of every entity with it.
      const live = after.filter((f) => f.subject === LIVE);
      expect(
        live,
        "the observation of a row that is still in the snapshot was reaped — the rule is keyed on the fact's own timestamp rather than on its evidence",
      ).toHaveLength(1);
      expect(live[0]?.extracted_at?.toISOString()).toBe("2026-08-14T10:00:00.000Z");

      // Every tension edge the reaped observations carried is gone. The one
      // left at the midpoint above named the reviewed claim as its counterpart,
      // and leaving it behind is the reader-facing failure #5344 is named for: a
      // person told their live belief is contested, by a reading of a row nobody
      // counts, which they cannot open.
      expect(tensionBefore).toBeGreaterThan(0);
      expect(
        await edgesOfType("in-tension-with"),
        "a tension edge outlived the observation it named — a live belief is now marked contested by a row nobody can open",
      ).toEqual([]);
      // The reviewed claim's own evidence pointer survives, because nothing
      // reaped it: the cascade is scoped to the deleted facts, not to the type.
      const provenance = await edgesOfType("provenance");
      expect(provenance.map((e) => e.from_fact_id)).toContain(reviewed);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the result counts every edge it removed, and the tension subset separately",
    async () => {
      // The return value is the audit trail for an irreversible DELETE — the run
      // report carries none of it on the wire, and the log line built from it is
      // where an operator finds out what a run took. Driven directly so the
      // numbers are readable rather than inferred from what is left.
      await enroll("status");
      const reviewed = await seedReviewedClaim(CHURNED, "status", "renewed");
      await run("2026-08-14T10:00:00.000Z", [row(LIVE, "active"), row(CHURNED, "churned")]);
      await run("2026-08-14T11:00:00.000Z", [row(LIVE, "active")]);
      await run("2026-08-14T12:00:00.000Z", [row(LIVE, "active")]);

      // Stopped one run short deliberately: a fourth producer run would perform
      // this reap itself and leave the direct call nothing to report.
      const observation = (await storedFacts()).find((f) => f.subject === CHURNED && f.status === "draft");
      expect(observation, "the fixture minted no observation to reap").toBeDefined();
      expect((await reap()).factIds, "the window licensed a reap a run early").toEqual([]);
      await successes(ENTITY, [13]);

      const result = await reap();
      expect(result.factIds).toEqual([observation!.id]);
      // One tension edge (against the reviewed claim) and one provenance edge
      // (its own evidence pointer) hung off it. Counted apart because only the
      // first is the failure this ticket is named for.
      expect(result.tensionEdgesRemoved).toBe(1);
      expect(result.edgesRemoved).toBe(2);
      // The reviewed claim and its own evidence pointer are untouched.
      expect((await storedFacts()).map((f) => f.id)).toContain(reviewed);
      expect((await edgesOfType("provenance")).map((e) => e.from_fact_id)).toContain(reviewed);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ==========================================================================
  // Block B — the fences
  // ==========================================================================

  /** A warehouse snapshot episode for `entity`, the way the producer writes one. */
  async function seedWarehouseEpisode(entity: string, at: string, workspaceId = WORKSPACE): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, locator, occurred_at, visible_to)
       VALUES ($1, 'warehouse', $2, 'SELECT 1', $3::timestamptz, $4::text[])
       RETURNING id`,
      [workspaceId, warehouseEpisodeSourceId(entity, new Date(at)), at, ["org"]],
    );
    return rows[0]!.id;
  }

  /**
   * One observation, minted the way `reconcile.ts` mints one: a warehouse
   * episode, a fact whose `provenance.source` is `warehouse`, and the evidence
   * edge between them.
   */
  async function seedObservation(params: {
    entity: string;
    subject: string;
    object: string;
    at: string;
    workspaceId?: string;
    status?: string;
    source?: string;
  }): Promise<string> {
    const workspaceId = params.workspaceId ?? WORKSPACE;
    const episodeId = await seedWarehouseEpisode(params.entity, params.at, workspaceId);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status,
          extracted_at, visible_to, subject_key, predicate_key, object_key)
       VALUES ($1, $2, 'status', $3, $4, $5::jsonb, $6, $7::timestamptz, $8::text[], $9, $10, $11)
       RETURNING id`,
      [
        workspaceId,
        params.subject,
        params.object,
        episodeId,
        JSON.stringify({ source: params.source ?? "warehouse", producer: "warehouse-producer" }),
        params.status ?? "draft",
        params.at,
        ["org"],
        slotKey(params.subject, identityAlias),
        slotKey("status", identityAlias),
        slotKey(params.object, identityAlias),
      ],
    );
    const factId = rows[0]!.id;
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
       VALUES ($1, 'provenance', $2, $3)`,
      [workspaceId, factId, episodeId],
    );
    return factId;
  }

  /** Record `count` successes for `entity`, strictly after `from`. */
  async function successes(entity: string, hours: readonly number[]): Promise<void> {
    for (const hour of hours) {
      await recordEntityRunSuccess(exec, {
        workspaceId: WORKSPACE,
        entity,
        snapshotAt: new Date(`2026-08-14T${String(hour).padStart(2, "0")}:00:00.000Z`),
      });
    }
  }

  it("N is 3, pinned as a literal", () => {
    // Pinned as a LITERAL, and every run count below is a literal too —
    // `entity-store-reach-pg.test.ts`'s argument, which is that a boundary
    // derived from the constant moves with it and measures nothing.
    expect(WAREHOUSE_REAP_AFTER_SUCCESSFUL_RUNS).toBe(3);
  });

  it(
    "TWO stranded runs reap nothing, THREE reap it — the boundary the constant claims",
    async () => {
      await seedObservation({ entity: ENTITY, subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      await successes(ENTITY, [10, 11, 12]);
      expect(
        (await reap()).factIds,
        "reaped after two stranded runs — with N = 3 the oldest of the last three successes is still the run that MINTED this observation",
      ).toEqual([]);

      await successes(ENTITY, [13]);
      expect((await reap()).factIds).toHaveLength(1);
      expect(await storedFacts()).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a fenced predicate survives a reap that would otherwise take it (#5388)",
    async () => {
      // The stand-down, end to end against real Postgres. This observation is
      // stranded by every measure the rule uses — five successful runs since it
      // was minted — so the ONLY thing standing between it and the DELETE is the
      // `$4` fence. `seedObservation` mints under the `status` predicate, which
      // is the dimension #5388's worked example takes out.
      const stranded = await seedObservation({
        entity: ENTITY,
        subject: CHURNED,
        object: "active",
        at: "2026-08-14T10:00:00.000Z",
      });
      await successes(ENTITY, [10, 11, 12, 13, 14]);

      expect(
        (
          await reapUnreachedObservations(exec, {
            workspaceId: WORKSPACE,
            entity: ENTITY,
            exceptPredicates: ["status"],
          })
        ).factIds,
        "a run that could not read a single `status` cell deleted the `status` readings anyway",
      ).toEqual([]);
      expect((await storedFacts()).map((f) => f.id)).toEqual([stranded]);

      // The positive control, on the SAME row: fence a different predicate and
      // the reap takes it. Without this the assertion above would stay green
      // against a statement that reaps nothing at all.
      expect(
        (
          await reapUnreachedObservations(exec, {
            workspaceId: WORKSPACE,
            entity: ENTITY,
            exceptPredicates: ["tier"],
          })
        ).factIds,
      ).toEqual([stranded]);
      expect(await storedFacts()).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a human belief a warehouse episode once corroborated is NOT an observation, and is never reaped",
    async () => {
      // The live shape this fence exists for. Corroboration attaches the incoming
      // warehouse episode as EVIDENCE for whatever live claim already occupies
      // the slot — including a published human one — so "has a warehouse
      // provenance edge" identifies nothing. The row's OWN provenance does.
      const belief = await seedObservation({
        entity: ENTITY,
        subject: CHURNED,
        object: "renewed",
        at: "2026-08-14T10:00:00.000Z",
        source: "slack",
      });
      await successes(ENTITY, [10, 11, 12, 13, 14]);

      expect(
        (await reap()).factIds,
        "a fact whose own provenance says a person said it was deleted as an observation",
      ).toEqual([]);
      expect((await storedFacts()).map((f) => f.id)).toEqual([belief]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a PUBLISHED warehouse row is left alone — a machine does not delete what a person blessed",
    async () => {
      // ADR-0042 makes every observation structurally `draft` and #5342 makes the
      // publish gate refuse one, so this is a fence for the rows that predate the
      // gate. Those get `retract`, a verb a person uses; the whole argument for
      // reaping is that nobody approved the row, and it stops applying here.
      const published = await seedObservation({
        entity: ENTITY,
        subject: CHURNED,
        object: "active",
        at: "2026-08-14T10:00:00.000Z",
        status: "published",
      });
      await successes(ENTITY, [10, 11, 12, 13, 14]);

      expect((await reap()).factIds).toEqual([]);
      expect((await storedFacts()).map((f) => f.id)).toEqual([published]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a chat episode agreeing with an observation does not hold it alive",
    async () => {
      // ⚠️ Since #5332 the STAGE no longer mints this edge — an extractor claim
      // agreeing with an observation gets its own draft instead. The edge is
      // seeded by hand here on purpose, and that is the point of the test
      // rather than a shortcut: ADR-0042's decision was to LEAVE the pre-fix
      // edges in place, so this shape is exactly the residue that decision left
      // on the corpus, and it has to stay reapable. A Slack message agreeing
      // with a reading does not put the row back in the warehouse.
      //
      // Rewriting this to drive the edge through `reconcileFacts` would make it
      // vacuous — the stage would mint two rows and the observation would carry
      // no chat evidence to test.
      const observation = await seedObservation({
        entity: ENTITY,
        subject: CHURNED,
        object: "active",
        at: "2026-08-14T10:00:00.000Z",
      });
      const { rows: eps } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes (workspace_id, source, source_id, body, occurred_at, visible_to)
         VALUES ($1, 'slack', 'slack:C1/9', 'still active', $2::timestamptz, $3::text[]) RETURNING id`,
        [WORKSPACE, "2026-08-14T13:30:00.000Z", ["org"]],
      );
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
         VALUES ($1, 'provenance', $2, $3)`,
        [WORKSPACE, observation, eps[0]!.id],
      );
      await successes(ENTITY, [10, 11, 12, 13]);

      expect((await reap()).factIds).toEqual([observation]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is per entity — one entity's successful runs never reap another's observations",
    async () => {
      const mine = await seedObservation({ entity: ENTITY, subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      const theirs = await seedObservation({ entity: "Contacts", subject: "Alice", object: "active", at: "2026-08-14T10:00:00.000Z" });
      // `Accounts` is well past N. `Contacts` has no history of its own, and a
      // rule that counted runs workspace-wide would take both.
      await successes(ENTITY, [10, 11, 12, 13, 14]);

      expect((await reap()).factIds).toEqual([mine]);
      expect((await storedFacts()).map((f) => f.id)).toEqual([theirs]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is workspace-scoped — another workspace's identically-named entity is untouched",
    async () => {
      await seedObservation({ entity: ENTITY, subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      const other = await seedObservation({
        entity: ENTITY,
        subject: CHURNED,
        object: "active",
        at: "2026-08-14T10:00:00.000Z",
        workspaceId: "ws-other",
      });
      await successes(ENTITY, [10, 11, 12, 13, 14]);

      await reap();
      expect(
        (await storedFacts("ws-other")).map((f) => f.id),
        "one workspace's reap deleted another workspace's observations for the same entity name",
      ).toEqual([other]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a transient outage reaps NOTHING, however many times it fails",
    async () => {
      // Driven as real failed transactions rather than by not calling the reaper,
      // which would assert the test's own script. A failed run records no
      // success, so the window never advances.
      const observation = await seedObservation({ entity: ENTITY, subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      await successes(ENTITY, [10]);

      for (let i = 0; i < 5; i++) {
        await expect(
          inTransaction(async (tx) => {
            await recordEntityRunSuccess(tx, {
              workspaceId: WORKSPACE,
              entity: ENTITY,
              snapshotAt: new Date(`2026-08-15T${String(10 + i).padStart(2, "0")}:00:00.000Z`),
            });
            throw new Error("snapshot-failed");
          }),
        ).rejects.toThrow("snapshot-failed");
        expect((await reap()).factIds).toEqual([]);
      }
      expect(
        (await storedFacts()).map((f) => f.id),
        "an outage emptied the comparison surface — this is the data loss the reach rule exists to prevent",
      ).toEqual([observation]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "fewer than N recorded successes reap nothing, even when the observation predates every one of them",
    async () => {
      // The arm `gate.n >= $3` exists for, and the state is real: a
      // freshly-migrated region holds facts whose successes never happened HERE,
      // because `bundle-scope.ts` deliberately does not export the success table.
      const observation = await seedObservation({ entity: ENTITY, subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      await successes(ENTITY, [20, 21]);

      expect(
        (await reap()).factIds,
        "reaped on two successes with N = 3 — absence of evidence licensed a delete",
      ).toEqual([]);
      expect((await storedFacts()).map((f) => f.id)).toEqual([observation]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a rolled-back transaction un-reaps — the delete cannot outlive the run that licensed it",
    async () => {
      const observation = await seedObservation({ entity: ENTITY, subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      await successes(ENTITY, [10, 11, 12, 13]);

      await expect(
        inTransaction(async (tx) => {
          const result = await reapUnreachedObservations(tx, { workspaceId: WORKSPACE, entity: ENTITY });
          expect(result.factIds).toEqual([observation]);
          throw new Error("cardinality-proposal-failed");
        }),
      ).rejects.toThrow("cardinality-proposal-failed");

      expect((await storedFacts()).map((f) => f.id)).toEqual([observation]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ==========================================================================
  // Block C — the entity parse
  // ==========================================================================

  /**
   * The names that break the two matchers this statement could have used.
   *
   * `billing_account` breaks `LIKE 'warehouse:' || $2 || '@%'` — `_` is a
   * metacharacter, so it would also match `billingXaccount`. `org@eu` breaks
   * both `LIKE` (a prefix match takes it for `org`) and a first-`@` split.
   */
  const ENTITY_NAMES = ["Accounts", "billing_account", "billingXaccount", "org", "org@eu", "a%b"];

  it(
    "the SQL parse of an episode source id agrees with the TypeScript one, name for name",
    async () => {
      for (const name of ENTITY_NAMES) {
        const sourceId = warehouseEpisodeSourceId(name, new Date("2026-08-14T10:00:00.000Z"));
        const { rows } = await pool.query<{ parsed: string | null }>(
          `SELECT substring($1::text from '^warehouse:(.*)@[^@]*$') AS parsed`,
          [sourceId],
        );
        expect(
          rows[0]?.parsed,
          `the SQL regex and parseWarehouseEpisodeEntity disagree about "${name}"`,
        ).toBe(parseWarehouseEpisodeEntity(sourceId));
        expect(rows[0]?.parsed).toBe(name);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "reaping one entity never takes an entity whose name merely starts with it",
    async () => {
      const org = await seedObservation({ entity: "org", subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      const orgEu = await seedObservation({ entity: "org@eu", subject: CHURNED, object: "active", at: "2026-08-14T10:00:00.000Z" });
      const underscore = await seedObservation({ entity: "billing_account", subject: "Beta", object: "active", at: "2026-08-14T10:00:00.000Z" });
      const wildcard = await seedObservation({ entity: "billingXaccount", subject: "Beta", object: "active", at: "2026-08-14T10:00:00.000Z" });
      await successes("org", [10, 11, 12, 13]);
      await successes("billing_account", [10, 11, 12, 13]);

      const reaped = [...(await reap("org")).factIds, ...(await reap("billing_account")).factIds];
      expect(reaped.toSorted()).toEqual([org, underscore].toSorted());
      expect(
        (await storedFacts()).map((f) => f.id).toSorted(),
        "a reap crossed into an entity whose name merely shares a prefix — the parse is a pattern match rather than an equality",
      ).toEqual([orgEu, wildcard].toSorted());
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the statement is the one the producer issues — dispatched on its exact bytes",
    async () => {
      // `reconcile.ts`' convention: the statement is exported so this suite runs
      // the SHIPPED text against the live schema rather than a paraphrase that
      // stays green against an edited one.
      // `$4` is the stand-down fence (#5388). An EMPTY array is the ordinary
      // case and is what the producer sends when nothing stood down.
      const { rows } = await pool.query(OBSERVATION_REAP_SQL, [WORKSPACE, ENTITY, 3, []]);
      expect(rows).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
