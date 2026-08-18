/**
 * #5316 — does a SEMANTIC-LAYER RENAME re-mint entity ids and orphan the store?
 *
 * PR 5315 confirmed the supersession hazard at the join and framed its trigger
 * as the region-migration bridge window. #5316 says the trigger looks far more
 * ordinary than that, and asks for the cheaper hypothesis to be falsified rather
 * than asserted:
 *
 *   `warehouseRowId` digests `(workspace, entity, primary key)`, and the entity
 *   component is `semantic_entities.name`. So renaming an entity should re-mint
 *   every id under it with no region migration involved — and because
 *   `writeEntityEntries` DELETEs by `(workspace_id, entity)`, the OLD name's
 *   entries are never targeted by any future run and should orphan permanently.
 *
 * Both halves are measured here against a live schema, through the SHIPPED
 * producer. A rename is modelled the way the product produces one: the
 * enrollment's `entity` moves, the semantic layer answers under the new name,
 * and the producer runs again over the same warehouse rows.
 *
 * ## The verdict — measured, with one prediction REFUTED
 *
 * One variable moves: the entity's name. Same workspace, same warehouse row
 * (`1`), same canonical surface (`Acme Corp`), no region migration.
 *
 * | prediction | verdict | what was measured |
 * |---|---|---|
 * | ids re-mint on a rename | **CONFIRMED** | `wh_3b9386f1…` → `wh_700d4644…` |
 * | the old name's entries orphan | **CONFIRMED** | both rows live; nothing can DELETE the `Accounts` one |
 * | `resolvableIds` poisons the shared norms | **CONFIRMED, and worse** | the map is EMPTY — `acme corp` *and* `1` both poisoned |
 * | …and the pair SUPERSEDES | **REFUTED** | `superseded: []`, `supersessionHeldBack: 0`, every `valid_to` null |
 *
 * The control — the same two runs with NO rename — holds the id fixed and keeps
 * the store answering, which is what makes the name the only moving part.
 *
 * ⚠️ **The refuted row is the one that changes downstream scope, so it is stated
 * sharply.** #5316 framed the rename as reaching PR 5315's `valid_to` stamp. It
 * does not, and it cannot: the id lands in `subject_cmp`, and at the SUBJECT
 * position a proven difference is a SUPPRESSOR in `supersessionCollisionJoin`
 * (`(…subject differs…) IS NOT TRUE`, pinned byte-for-byte in
 * `collision-sql-pinned.test.ts`) rather than a driver. PR 5315's stamp came
 * through `object_cmp`, which an EXTRACTED fact reaches by resolving its object
 * through the entity store — and after a rename the store resolves nothing at
 * all, so that path abstains instead of stamping.
 *
 * So one root cause, two costs, and the rename produces the quieter one: not a
 * fact retired by its own twin, but an entity the store has gone permanently
 * blind to, while claims about one warehouse row split across two comparables
 * and stop corroborating. Recoverable, invisible, and unbounded in time — no
 * error, no refusal, no count. That is the poisoning #5233's parent describes,
 * reached without leaving the region, and the reaper is what clears it.
 *
 * ## Why this file rather than an extension of PR 5315's harness
 *
 * #5316 names `bridge-window-object-cmp-pg.test.ts` as the harness to extend,
 * and that file is still unmerged on PR 5315's branch. Extending it in place
 * would stack this PR behind that one for no gain: the two share no fixture —
 * 5315 seeds `brain_facts` by hand to isolate the JOIN, and the question here is
 * what the PRODUCER writes, which has to go through `runWarehouseProducer` and
 * `brain_entity`. Same subject, disjoint machinery. When 5315 lands, the two sit
 * beside each other as the join-side and producer-side halves of #5233.
 *
 * ## What ships skipped, and why
 *
 * The three falsifiers assert what a REMEDY must deliver. They fail today, and
 * they are deliberately NOT inverted into characterization tests that pass —
 * that would pin the hazard as correct, the shape this tree refuses elsewhere.
 * The controls beside them are active and green, and they are what make the
 * skipped rows evidence rather than an opinion: without them a producer whose
 * store path was simply broken would satisfy every falsifier trivially.
 *
 * Un-skip when #5233's remedy lands.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { lexicalNorm } from "@atlas/api/lib/brain/identity";
import { loadEntityStore, resolvableIds } from "@atlas/api/lib/brain/entity-store";
import {
  DIMENSION_ALIAS_PREFIX,
  SUBJECT_ALIAS,
  runWarehouseProducer,
  warehouseRowId,
  type ValidatedSnapshotRequest,
  type WarehouseProducerDeps,
} from "@atlas/api/lib/brain/warehouse-producer";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-5316";
/** The name the entity is published under before the rename. */
const OLD_NAME = "Accounts";
/** …and after. One rename, nothing else moves. */
const NEW_NAME = "Customers";

/** The warehouse row every assertion below is about. It never changes. */
const PRIMARY_KEY = "1";
const CANONICAL = "Acme Corp";

/**
 * A SURROGATE-KEYED entity with a human-named naming dimension — the shape the
 * entity store exists for.
 *
 * `account_id` is the primary key and says nothing a person would say; `name`
 * carries the surface an extractor emits. With a natural key (the name AS the
 * primary key) the store's entries are `acme corp -> acme corp` and the
 * poisoning question below cannot even be posed, because the key norm and the
 * canonical norm are one string.
 *
 * Dimensions arrive in the order `loadProducerReach` sorts them (`ORDER BY
 * entity, connection_group_id, dimension`), so `name` is `d0` and `status` is
 * `d1`. Asserted rather than assumed — the first control below reads the stored
 * canonical surface, which is wrong if that order ever flips.
 */
const ACCOUNTS_YAML: Record<string, unknown> = {
  table: "accounts",
  dimensions: [
    { name: "account_id", sql: "id", primary_key: true },
    { name: "name", sql: "account_name" },
    { name: "status", sql: "lifecycle_status" },
  ],
};

describeIfPg("#5316 semantic-layer rename (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5316_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    // The producer, the reconcile stage, the enrollment read and the entity
    // store all write through the module-level pool, so it has to BE this
    // schema-scoped one for the test to exercise the real SQL.
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
    await pool.query("DELETE FROM brain_entity");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM brain_enrollment");
    await pool.query("DELETE FROM brain_predicate_cardinality");
    await pool.query("DELETE FROM brain_vocabulary_proposal");
  });

  // -- helpers ---------------------------------------------------------------

  /**
   * Enroll through the TABLE rather than through `enrollPair`, on
   * `warehouse-producer-pg.test.ts`'s reason: this suite's subject is what the
   * producer MINTS, and going through the writer would make every assertion
   * depend on the enrollment seam's own behaviour.
   */
  async function enroll(entity: string, dimension: string, naming = false): Promise<void> {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note, naming)
       VALUES ($1, $2, $3, 'user-1', NULL, $4)`,
      [WORKSPACE, entity, dimension, naming],
    );
  }

  /**
   * THE RENAME, as the product performs it.
   *
   * A semantic-layer rename moves `semantic_entities.name`, and every brain-side
   * consumer of that name follows: the enrollment rows that name the entity, and
   * the entity the producer's injected loader answers for. `brain_entity.entity`
   * is NOT touched — that is the whole question, and touching it here would be
   * writing the remedy into the fixture.
   */
  async function rename(from: string, to: string): Promise<void> {
    const { rowCount } = await pool.query(
      `UPDATE brain_enrollment SET entity = $3 WHERE workspace_id = $1 AND entity = $2`,
      [WORKSPACE, from, to],
    );
    expect(rowCount, "the rename moved no enrollment rows — the fixture is not set up").toBeGreaterThan(0);
  }

  function deps(
    entityName: string,
    snapshotAt: Date,
    rows: readonly Record<string, unknown>[],
  ): WarehouseProducerDeps {
    return {
      // The semantic layer answers under whatever name it is currently published
      // as. This is the one seam a rename moves.
      loadEntity: async () => ({ ...ACCOUNTS_YAML, name: entityName }),
      resolveConnectionIds: async () => ({ placed: new Map(), unplaceable: [] }),
      // Stubbed for `warehouse-producer-pg.test.ts`'s reason: the SQL gate is
      // workspace-whitelist-scoped and this schema has no whitelist. The cast is
      // required — the passing verdict carries a branded request, so every
      // bypass in the tree stays greppable.
      validateSnapshotSql: async (request) => ({
        valid: true,
        request: request as ValidatedSnapshotRequest,
      }),
      runSnapshot: async () => rows,
      now: () => snapshotAt,
    };
  }

  /** One warehouse row: surrogate key, a name, a status. */
  const row = (status: string) => ({
    [SUBJECT_ALIAS]: PRIMARY_KEY,
    [`${DIMENSION_ALIAS_PREFIX}0`]: CANONICAL,
    [`${DIMENSION_ALIAS_PREFIX}1`]: status,
  });

  const run = (entityName: string, snapshotAt: Date, status = "active") =>
    runWarehouseProducer(
      { workspaceId: WORKSPACE, triggeredBy: "user-1" },
      deps(entityName, snapshotAt, [row(status)]),
    );

  async function storeRows(): Promise<
    { entity_id: string; entity: string; key_norm: string; canonical_norm: string }[]
  > {
    const { rows } = await pool.query(
      `SELECT entity_id, entity, key_norm, canonical_norm FROM brain_entity
        WHERE workspace_id = $1 ORDER BY entity, entity_id`,
      [WORKSPACE],
    );
    return rows;
  }

  async function subjectCmps(): Promise<(string | null)[]> {
    const { rows } = await pool.query<{ subject_cmp: string | null }>(
      `SELECT subject_cmp FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, id`,
      [WORKSPACE],
    );
    return rows.map((r) => r.subject_cmp);
  }

  // -- the derivation, pinned ------------------------------------------------

  it("the entity NAME is a component of the id — the derivation the hypothesis rests on", () => {
    // Active, and not the hazard: this pins the DERIVATION, which is correct and
    // deliberate (`warehouseRowId`'s docstring argues for the triple). What
    // #5316 asks is whether a rename can move that component behind the store's
    // back, which is what the falsifiers below measure. Stated here so a reader
    // does not have to take the premise on trust, and so a future id scheme that
    // dropped the entity component fails LOUDLY beside them rather than making
    // three skipped tests quietly meaningless.
    expect(warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY)).not.toBe(
      warehouseRowId(WORKSPACE, NEW_NAME, PRIMARY_KEY),
    );
    // …and nothing else about the row moved.
    expect(warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY)).toBe(
      warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY),
    );
  });

  // -- the control -----------------------------------------------------------

  it(
    "CONTROL — with NO rename, a second run re-mints the SAME id and replaces its own entries",
    async () => {
      // THE control that makes every measurement below a finding rather than a
      // coincidence. Without it a producer whose store path was broken — every
      // run writing a fresh id, or writing nothing — would satisfy all three
      // falsifiers perfectly while proving nothing about renames.
      await enroll(OLD_NAME, "name", true);
      await enroll(OLD_NAME, "status");

      await run(OLD_NAME, new Date("2026-08-18T10:00:00.000Z"));
      const first = await storeRows();
      expect(first).toHaveLength(1);
      expect(first[0]!.entity).toBe(OLD_NAME);
      // The naming dimension really was read — if `d0`/`d1` ever swap, this is
      // what says so rather than the assertions further down going quiet.
      expect(first[0]!.canonical_norm).toBe(lexicalNorm(CANONICAL));
      expect(first[0]!.key_norm).toBe(lexicalNorm(PRIMARY_KEY));
      expect(first[0]!.entity_id).toBe(warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY));

      await run(OLD_NAME, new Date("2026-08-18T11:00:00.000Z"), "churned");
      const second = await storeRows();
      // ONE row, not two: same id, replaced in place by the DELETE-then-INSERT.
      expect(second).toHaveLength(1);
      expect(second[0]!.entity_id).toBe(first[0]!.entity_id);

      // And the store still answers — the positive control for the poisoning
      // measurement below, which is otherwise satisfied by a store that resolves
      // nothing under any conditions at all.
      // Read as a plain string: `resolvableIds` answers in the branded
      // `WarehouseRowId`, and the stored column is `text`. Comparing them is the
      // point — the brand exists to guard the WRITE path, not to stop a test
      // asking whether the value that came back is the one that went in.
      const resolvable = resolvableIds(await loadEntityStore(WORKSPACE));
      const answer: string | undefined = resolvable.get(lexicalNorm(CANONICAL));
      expect(answer).toBe(first[0]!.entity_id);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- prediction 1: re-mint -------------------------------------------------

  // SKIPPED, and deliberately not inverted. Asserts what a remedy must deliver.
  it.skip(
    "a rename alone must not re-mint the ids of warehouse rows that did not change",
    async () => {
      await enroll(OLD_NAME, "name", true);
      await enroll(OLD_NAME, "status");
      await run(OLD_NAME, new Date("2026-08-18T10:00:00.000Z"));
      const before = await storeRows();

      await rename(OLD_NAME, NEW_NAME);
      await run(NEW_NAME, new Date("2026-08-18T11:00:00.000Z"));

      const after = (await storeRows()).filter((r) => r.entity === NEW_NAME);
      expect(after).toHaveLength(1);
      expect(
        after[0]!.entity_id,
        "the same warehouse row got a new id because the ENTITY was renamed — no region migration involved, and every fact carrying the old id now names a row nothing will mint again",
      ).toBe(before[0]!.entity_id);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // SKIPPED for the same reason. The consequence of prediction 1 at the column
  // that carries it: `subject_cmp` is where the id reaches `brain_facts`.
  //
  // ⚠️ It asserts ONE comparable per warehouse row, NOT the absence of a stamp —
  // see the header's refuted row. A `valid_to` assertion here would be green
  // today and green under the remedy, and would read as evidence about renames
  // while measuring the tier guard.
  it.skip(
    "…so two facts about ONE warehouse row either side of a rename carry the same comparable",
    async () => {
      await enroll(OLD_NAME, "name", true);
      await enroll(OLD_NAME, "status");
      await run(OLD_NAME, new Date("2026-08-18T10:00:00.000Z"));
      await rename(OLD_NAME, NEW_NAME);
      // A CHANGED value, so the second run emits a fresh claim rather than
      // corroborating — the two facts have to coexist for the comparables to be
      // comparable at all.
      await run(NEW_NAME, new Date("2026-08-18T11:00:00.000Z"), "churned");

      const cmps = await subjectCmps();
      expect(cmps.length).toBeGreaterThanOrEqual(2);
      expect(
        new Set(cmps).size,
        "one warehouse row is wearing two subject comparables across a rename, so the publish gate can no longer tell that the two claims are about the same row",
      ).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- prediction 2: orphan --------------------------------------------------

  // SKIPPED for the same reason.
  it.skip(
    "a rename must not leave the old name's entries behind with no path to deletion",
    async () => {
      await enroll(OLD_NAME, "name", true);
      await enroll(OLD_NAME, "status");
      await run(OLD_NAME, new Date("2026-08-18T10:00:00.000Z"));

      await rename(OLD_NAME, NEW_NAME);
      await run(NEW_NAME, new Date("2026-08-18T11:00:00.000Z"));

      const stale = (await storeRows()).filter((r) => r.entity === OLD_NAME);
      expect(
        stale,
        "the old name's entries survived the rename. `writeEntityEntries` DELETEs by (workspace_id, entity), and no future run will ever pass the old name again — nothing in the product can reach these rows",
      ).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- prediction 3: the poisoning -------------------------------------------

  // SKIPPED for the same reason. This is the arm #5316 asks about last and the
  // one that costs the most: if both sets go live under the SAME canonical norm
  // with DIFFERENT ids, `resolvableIds` marks the norm ambiguous and the store
  // stops answering for that entity — permanently, and with no error anywhere.
  it.skip(
    "…and the shared norms must still resolve after a rename",
    async () => {
      await enroll(OLD_NAME, "name", true);
      await enroll(OLD_NAME, "status");
      await run(OLD_NAME, new Date("2026-08-18T10:00:00.000Z"));
      await rename(OLD_NAME, NEW_NAME);
      await run(NEW_NAME, new Date("2026-08-18T11:00:00.000Z"));

      const stored = await loadEntityStore(WORKSPACE);
      const canonical = lexicalNorm(CANONICAL);
      expect(
        resolvableIds(stored).get(canonical),
        "the canonical norm resolves to nothing after a rename: both the old and the new entries are live, they carry the same norms and different ids, and `resolvableIds` poisons a norm two ids claim. Every later extraction naming this entity now abstains — silently, and for as long as the orphaned rows remain",
      ).toBe(warehouseRowId(WORKSPACE, NEW_NAME, PRIMARY_KEY));
    },
    PG_TEST_TIMEOUT_MS,
  );
});
