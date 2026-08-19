/**
 * The three things a store write does beyond replacing its own rows (#5319,
 * #5320, #5321), against a real Postgres.
 *
 * All three are DELETEs or blanked columns with no inverse, and all three turn
 * on SQL a double cannot assert: that a row a statement did not mention is gone,
 * that a row it did mention survived, and that a window function over a success
 * history picked the boundary the constant claims. `entity-store-pg.test.ts`
 * covers the store's own contract; this file covers what it does to its
 * neighbours.
 *
 * ## What each block proves
 *
 * **#5320 — the rename reconciliation.** The falsifier comes FIRST and
 * reproduces the poisoning: two live sets under two `(workspace_id, entity)`
 * keys, the same canonical norms, different ids, and `resolvableIds` resolving
 * nothing. Then the same scenario through the fixed path. Beside them, the
 * control that keeps the fix from being a homonym purge — two entities that are
 * BOTH enrolled and both legitimately name a row `Acme Corp` must survive
 * untouched, because that is ordinary data the store deliberately abstains on.
 *
 * **#5319 — comparable retirement.** That an ordinary re-run retires nothing is
 * the load-bearing one: the cheapest wrong implementation blanks every object
 * comparable in the workspace on every run, and it would pass every assertion
 * about the hazard while destroying the corpus.
 *
 * **#5321 — the reaper.** The constant is load-bearing rather than decorative,
 * so N-1 and N are both measured. A failed run reaping nothing is asserted by
 * driving a real failure rather than by not calling the reaper.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { lexicalNorm, identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import {
  buildEntityEntry,
  entityEdgeProposals,
  loadEntityStore,
  reapUnreachedEntityEntries,
  resolvableIds,
  writeEntityEntries,
  ENTITY_STORE_REAP_AFTER_SUCCESSFUL_RUNS,
  type EntityStoreEntry,
} from "@atlas/api/lib/brain/entity-store";
import { recordEntityRunSuccess } from "@atlas/api/lib/brain/warehouse-run-record";
import { comparableValue } from "@atlas/api/lib/brain/object-cmp";
import { warehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-entity-reach";
/** The name the entity is published under before a rename, and after. */
const OLD_NAME = "accounts";
const NEW_NAME = "customers";
const CANONICAL = "Acme Corp";
const PRIMARY_KEY = "1";

describeIfPg("entity store reach, reconciliation and retirement (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_reach_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    // `loadEntityStore` reads the module-level pool, so it has to BE this
    // schema-scoped one for the reads below to see what the writes wrote.
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
    // UNSCOPED, on `entity-store-pg.test.ts`'s reason: a scoped cleanup leaves a
    // second workspace's rows behind when an assertion fails, and the first
    // failure then cascades into every test after it.
    await pool.query(`DELETE FROM brain_entity`);
    await pool.query(`DELETE FROM brain_warehouse_entity_success`);
    await pool.query(`DELETE FROM brain_facts`);
    await pool.query(`DELETE FROM brain_episodes`);
  });

  // -- helpers ---------------------------------------------------------------

  /** The pool as a `ReconcileExecutor` — auto-committing, for the arms that want that. */
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
        // Must not mask the original error, and must not vanish either — the
        // connection goes back to the pool either way.
        console.debug("entity-store-reach fixture: ROLLBACK failed", rollbackErr);
      });
      throw err;
    } finally {
      client.release();
    }
  }

  function entry(params: {
    entity: string;
    keySurface?: string;
    canonicalSurface?: string;
    /** Override the id — for the imported-from-another-region shape. */
    entityId?: string;
  }): EntityStoreEntry {
    const keySurface = params.keySurface ?? PRIMARY_KEY;
    const canonicalSurface = params.canonicalSurface ?? CANONICAL;
    const built = buildEntityEntry({
      entityId: (params.entityId ??
        warehouseRowId(WORKSPACE, params.entity, keySurface)) as ReturnType<typeof warehouseRowId>,
      entity: params.entity,
      keySurface,
      canonicalSurface,
    });
    expect(built, "the fixture entry was refused — the test would prove nothing").not.toBeNull();
    return built as EntityStoreEntry;
  }

  async function storeRows(): Promise<{ entity: string; entity_id: string }[]> {
    const { rows } = await pool.query(
      `SELECT entity, entity_id FROM brain_entity WHERE workspace_id = $1 ORDER BY entity, entity_id`,
      [WORKSPACE],
    );
    return rows;
  }

  /** One episode, so a fact has something to hang off. */
  async function seedEpisode(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', 'reach', 'evidence', $2::text[]) RETURNING id`,
      [WORKSPACE, ["org"]],
    );
    return rows[0]!.id;
  }

  /** A fact whose object comparable names `entityId`. Returns its id. */
  async function seedFact(episodeId: string, entityId: string, object = CANONICAL): Promise<string> {
    const predicate = "works_at";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status,
          visible_to, subject_key, predicate_key, object_key, object_cmp)
       VALUES ($1, 'alice', $2, $3, $4, $5::jsonb, 'draft', $6::text[], $7, $8, $9, $10)
       RETURNING id`,
      [
        WORKSPACE,
        predicate,
        object,
        episodeId,
        JSON.stringify({ actor: "test" }),
        ["org"],
        slotKey("alice", identityAlias),
        slotKey(predicate, identityAlias),
        slotKey(object, identityAlias),
        comparableValue({ surface: object, entityId }),
      ],
    );
    return rows[0]!.id;
  }

  async function objectCmpOf(factId: string): Promise<string | null> {
    const { rows } = await pool.query<{ object_cmp: string | null }>(
      `SELECT object_cmp FROM brain_facts WHERE id = $1`,
      [factId],
    );
    return rows[0]?.object_cmp ?? null;
  }

  /** Record a success for one entity at an instant, the way the producer does. */
  async function recordSuccess(entity: string, at: string): Promise<void> {
    await recordEntityRunSuccess(exec, { workspaceId: WORKSPACE, entity, snapshotAt: new Date(at) });
  }

  // =========================================================================
  // #5320 — the rename reconciliation
  // =========================================================================

  it(
    "FALSIFIER — two live sets under two names poison every shared norm, and the store resolves NOTHING",
    async () => {
      // Reproduced FIRST, per #5233's AC-3, and reproduced the only way it can
      // be: by writing the second set while the first name is still in reach, so
      // the reconciliation declines to fire. That is not a contrivance — it is
      // precisely the state a region import leaves behind, where BOTH names are
      // legitimate at the moment the rows land.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME, NEW_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: NEW_NAME,
        entries: [entry({ entity: NEW_NAME })],
        entityNamesInReach: [OLD_NAME, NEW_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      // Two live sets, one canonical norm, two ids.
      expect(await storeRows()).toHaveLength(2);
      const stored = await loadEntityStore(WORKSPACE);
      expect(
        resolvableIds(stored).get(lexicalNorm(CANONICAL)),
        "the poisoning did not reproduce — every assertion about the remedy below would then be vacuous",
      ).toBeUndefined();

      // ⚠️ AC: the condition is REPORTED while it exists, rather than being
      // visible only as absence. This is the number an operator sees.
      expect(entityEdgeProposals(stored).ambiguous).toBeGreaterThan(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "…and once the old name leaves reach, the write reconciles it away and the store resolves again",
    async () => {
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });

      // THE RENAME: the semantic layer now publishes the entity as `customers`,
      // so `accounts` is no longer a name the producer reaches.
      const outcome = await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: NEW_NAME,
        entries: [entry({ entity: NEW_NAME })],
        entityNamesInReach: [NEW_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      expect(outcome.orphansDeleted).toBe(1);
      const rows = await storeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity).toBe(NEW_NAME);

      // The point of the whole exercise: the store answers again.
      const resolved: string | undefined = resolvableIds(await loadEntityStore(WORKSPACE)).get(
        lexicalNorm(CANONICAL),
      );
      expect(resolved).toBe(warehouseRowId(WORKSPACE, NEW_NAME, PRIMARY_KEY));
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "CONTROL — a genuine homonym between two ENROLLED entities is left alone",
    async () => {
      // Two different entities that both legitimately name a row `Acme Corp` —
      // an account and a contact company, say. This is ordinary data, not
      // corruption: the store abstains for the norm and reports it. A
      // reconciliation that deleted one of them would be picking a winner, which
      // is the thing `resolvableIds` spends its whole docstring refusing to do.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "contacts",
        entries: [entry({ entity: "contacts" })],
        entityNamesInReach: ["contacts", OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      const outcome = await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: ["contacts", OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      expect(
        outcome.orphansDeleted,
        "the reconciliation deleted a live, enrolled entity's entries — it has become a homonym purge",
      ).toBe(0);
      expect(await storeRows()).toHaveLength(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an out-of-reach entry that collides with NOTHING is left for the reaper, not reconciled away",
    async () => {
      // The two remedies have to stay separable: #5320 is a key mismatch and
      // #5321 is staleness on an age rule. An out-of-reach entry sharing no norm
      // is stale and recoverable, and deleting it here would be reaping with no
      // age gate at all — the trade #5233's AC-1 exists to refuse.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "legacy",
        entries: [entry({ entity: "legacy", keySurface: "9", canonicalSurface: "Unrelated Ltd" })],
        entityNamesInReach: ["legacy"],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      const outcome = await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      expect(outcome.orphansDeleted).toBe(0);
      expect(await storeRows()).toHaveLength(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the reconciliation is not a one-time cleanup — a second divergent set is cleared the same way",
    async () => {
      const write = (entity: string, reach: string[], at: string) =>
        writeEntityEntries(exec, {
          workspaceId: WORKSPACE,
          entity,
          entries: [entry({ entity })],
          entityNamesInReach: reach,
          snapshotAt: new Date(at),
        });

      await write(OLD_NAME, [OLD_NAME], "2026-08-18T10:00:00Z");
      expect((await write(NEW_NAME, [NEW_NAME], "2026-08-18T11:00:00Z")).orphansDeleted).toBe(1);

      // A LATER divergent set — a second import, or a second rename — lands and
      // is cleared by the same rule on the next run. The property is "the
      // poisoning cannot persist", not "it was cleaned up once".
      await write("crm_accounts", ["crm_accounts", NEW_NAME], "2026-08-18T12:00:00Z");
      expect(await storeRows()).toHaveLength(2);
      expect((await write(NEW_NAME, [NEW_NAME], "2026-08-18T13:00:00Z")).orphansDeleted).toBe(1);
      expect(await storeRows()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // #5319 — comparable retirement
  // =========================================================================

  it(
    "an ordinary re-run retires NOTHING — the id survived, so its comparables are still current",
    async () => {
      // ⚠️ THE LOAD-BEARING CONTROL of this block. The cheapest wrong
      // implementation of retirement blanks every object comparable it can
      // reach on every run; it would satisfy every assertion about the hazard
      // while quietly deleting the corpus's evidence of difference. Nothing else
      // here would catch it.
      const ep = await seedEpisode();
      const id = warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY);
      const fact = await seedFact(ep, id);

      const write = (at: string) =>
        writeEntityEntries(exec, {
          workspaceId: WORKSPACE,
          entity: OLD_NAME,
          entries: [entry({ entity: OLD_NAME })],
          entityNamesInReach: [OLD_NAME],
          snapshotAt: new Date(at),
        });
      await write("2026-08-18T10:00:00Z");
      const second = await write("2026-08-18T11:00:00Z");

      expect(second.comparablesRetired).toBe(0);
      expect(await objectCmpOf(fact)).toBe(`entity:${id}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a re-mint retires the OLD id's comparables and leaves every other fact alone",
    async () => {
      const ep = await seedEpisode();
      const foreignId = warehouseRowId("ws-some-other-region", OLD_NAME, PRIMARY_KEY);
      const bridgeFact = await seedFact(ep, foreignId);
      // A fact about a DIFFERENT entity, which nothing in this run re-mints.
      const untouchedId = warehouseRowId(WORKSPACE, "contacts", "7");
      const untouchedFact = await seedFact(ep, untouchedId, "Alice");

      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME, entityId: foreignId })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      const outcome = await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      expect(outcome.comparablesRetired).toBe(1);
      // NULL is the abstain — see `entity-comparable-retire.ts` for why that is
      // the retirement rather than some marker value.
      expect(await objectCmpOf(bridgeFact)).toBeNull();
      expect(
        await objectCmpOf(untouchedFact),
        "an unrelated entity's comparable was retired — the retirement is not scoped to the ids this run replaced",
      ).toBe(`entity:${untouchedId}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a warehouse row that DISAPPEARS retires NOTHING — absence is not staleness",
    async () => {
      // ⚠️ **This test asserted the OPPOSITE in a first cut, and the inversion is
      // the finding.** Retirement was gated on "this id is no longer in the
      // store", on the argument that such an id could never be produced again.
      // That argument is false: `warehouseRowId` digests
      // `(workspace, entity, primary key)` and NOT the name, so an id that
      // leaves the store comes back IDENTICAL the moment the row is described
      // again. See the next two tests for the reversible admin actions that made
      // it a corpus-wide irreversible write.
      const ep = await seedEpisode();
      const goneId = warehouseRowId(WORKSPACE, OLD_NAME, "2");
      const goneFact = await seedFact(ep, goneId, "Beta LLC");

      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [
          entry({ entity: OLD_NAME }),
          entry({ entity: OLD_NAME, keySurface: "2", canonicalSurface: "Beta LLC" }),
        ],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      // The second warehouse row is deleted upstream: the next snapshot simply
      // does not contain it. Nothing re-mints its key, so nothing is stale.
      const outcome = await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      expect(outcome.retiredIds).toEqual([]);
      expect(
        await objectCmpOf(goneFact),
        "a deleted row's comparables were retired — absence was treated as staleness, and the id can come back identical",
      ).toBe(`entity:${goneId}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "blanking a row's NAME retires nothing — the id is unchanged by the name, so re-typing it restores everything",
    async () => {
      // The reversible admin action that the wider rule made irreversible. A
      // nullable display-name column is ordinary data; the producer counts such a
      // row in `unnamedRows` and `buildEntityEntry` refuses it, so its entry
      // vanishes while its id stays exactly what it was.
      const ep = await seedEpisode();
      const id = warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY);
      const fact = await seedFact(ep, id);

      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      // Name blanked upstream: no entry for the row this run.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });
      expect(await objectCmpOf(fact)).toBe(`entity:${id}`);

      // …and re-typing it restores the store with the SAME id, which is the
      // whole reason retiring on absence was wrong.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T12:00:00Z"),
      });
      const rows = await storeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity_id).toBe(id);
      expect(await objectCmpOf(fact)).toBe(`entity:${id}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "un-naming the DIMENSION clears the store but does not blank the entity's corpus",
    async () => {
      // The worst shape of the same defect: `entityEntries` is empty, so under
      // the wider rule EVERY id for the entity dropped at once and every fact
      // about any of its rows was blanked in one transaction — for an action
      // whose operator-facing text promises only that the store entries are
      // cleared.
      const ep = await seedEpisode();
      const first = warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY);
      const second = warehouseRowId(WORKSPACE, OLD_NAME, "2");
      const factA = await seedFact(ep, first);
      const factB = await seedFact(ep, second, "Beta LLC");

      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [
          entry({ entity: OLD_NAME }),
          entry({ entity: OLD_NAME, keySurface: "2", canonicalSurface: "Beta LLC" }),
        ],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      const outcome = await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      // The store IS cleared — that half is the documented behaviour.
      expect(await storeRows()).toEqual([]);
      // The corpus is not touched.
      expect(outcome.comparablesRetired).toBe(0);
      expect(await objectCmpOf(factA)).toBe(`entity:${first}`);
      expect(await objectCmpOf(factB)).toBe(`entity:${second}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "`subject_cmp` is deliberately NOT retired — at that position a difference is the guard, not the hazard",
    async () => {
      const ep = await seedEpisode();
      const foreignId = warehouseRowId("ws-some-other-region", OLD_NAME, PRIMARY_KEY);
      await pool.query(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance, status,
            visible_to, subject_key, predicate_key, object_key, subject_cmp)
         VALUES ($1, 'Acme Corp', 'has_tier', 'gold', $2, $3::jsonb, 'draft', $4::text[], $5, $6, $7, $8)`,
        [
          WORKSPACE,
          ep,
          JSON.stringify({ actor: "test" }),
          ["org"],
          slotKey(CANONICAL, identityAlias),
          slotKey("has_tier", identityAlias),
          slotKey("gold", identityAlias),
          `entity:${foreignId}`,
        ],
      );

      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME, entityId: foreignId })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T11:00:00Z"),
      });

      const { rows } = await pool.query<{ subject_cmp: string | null }>(
        `SELECT subject_cmp FROM brain_facts WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(
        rows[0]?.subject_cmp,
        "`subject_cmp` was retired. At the SUBJECT position a proven difference SUPPRESSES rather than drives, so nulling it does not retire a hazard — it deletes the guard that keeps two distinct entities sharing a subject_key from merging at the publish gate",
      ).toBe(`entity:${foreignId}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a rollback leaves BOTH the mint and the retirement undone",
    async () => {
      const ep = await seedEpisode();
      const foreignId = warehouseRowId("ws-some-other-region", OLD_NAME, PRIMARY_KEY);
      const fact = await seedFact(ep, foreignId);
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME, entityId: foreignId })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });

      const boom = new Error("the entity's transaction failed after the store write");
      await expect(
        inTransaction(async (tx) => {
          await writeEntityEntries(tx, {
            workspaceId: WORKSPACE,
            entity: OLD_NAME,
            entries: [entry({ entity: OLD_NAME })],
            entityNamesInReach: [OLD_NAME],
            snapshotAt: new Date("2026-08-18T11:00:00Z"),
          });
          throw boom;
        }),
      ).rejects.toThrow(boom.message);

      // The mint is undone…
      const rows = await storeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity_id).toBe(foreignId);
      // …and so is the retirement. The pair is what matters: a retirement that
      // outlived a rolled-back mint would have the corpus abstaining on evidence
      // that is still current, which is worse than either state alone.
      expect(await objectCmpOf(fact)).toBe(`entity:${foreignId}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a partially-refused run retires only for the entity it actually re-minted",
    async () => {
      // Two entities. One re-mints and commits; the other's transaction fails,
      // the way a refused entity's does. The producer runs one transaction per
      // entity, so the failure must leave the second entity's comparables
      // exactly as they were.
      const ep = await seedEpisode();
      const staleAccounts = warehouseRowId("ws-old-region", OLD_NAME, PRIMARY_KEY);
      const staleContacts = warehouseRowId("ws-old-region", "contacts", "7");
      const accountsFact = await seedFact(ep, staleAccounts);
      const contactsFact = await seedFact(ep, staleContacts, "Alice");

      for (const [entity, id, key, surface] of [
        [OLD_NAME, staleAccounts, PRIMARY_KEY, CANONICAL],
        ["contacts", staleContacts, "7", "Alice"],
      ] as const) {
        await writeEntityEntries(exec, {
          workspaceId: WORKSPACE,
          entity,
          entries: [entry({ entity, entityId: id, keySurface: key, canonicalSurface: surface })],
          entityNamesInReach: [OLD_NAME, "contacts"],
          snapshotAt: new Date("2026-08-18T10:00:00Z"),
        });
      }

      // Entity one: re-mints and commits.
      await inTransaction((tx) =>
        writeEntityEntries(tx, {
          workspaceId: WORKSPACE,
          entity: OLD_NAME,
          entries: [entry({ entity: OLD_NAME })],
          entityNamesInReach: [OLD_NAME, "contacts"],
          snapshotAt: new Date("2026-08-18T11:00:00Z"),
        }),
      );
      // Entity two: refused mid-transaction.
      await expect(
        inTransaction(async (tx) => {
          await writeEntityEntries(tx, {
            workspaceId: WORKSPACE,
            entity: "contacts",
            entries: [entry({ entity: "contacts", keySurface: "7", canonicalSurface: "Alice" })],
            entityNamesInReach: [OLD_NAME, "contacts"],
            snapshotAt: new Date("2026-08-18T11:00:00Z"),
          });
          throw new Error("row-cap-exceeded");
        }),
      ).rejects.toThrow("row-cap-exceeded");

      expect(await objectCmpOf(accountsFact)).toBeNull();
      expect(
        await objectCmpOf(contactsFact),
        "a refused entity's comparables were retired anyway — the retirement is not riding that entity's own transaction",
      ).toBe(`entity:${staleContacts}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // #5321 — the reaper
  // =========================================================================

  /**
   * Write one entry at `10:00`, then drive `strandedRuns` further successful
   * runs that produce NO entries — the zero-candidate arm, which is the
   * reaper's whole target population (a truncated table, a primary key that
   * stopped being surfaceable).
   *
   * The run that WROTE the entry records a success at the entry's own instant,
   * exactly as the producer's reconcile transaction does. That is why the
   * counting below starts where it does: `strandedRuns` is how many runs have
   * succeeded and written nothing SINCE the entry, which is the quantity the
   * reach rule is about.
   */
  async function stranded(entity: string, strandedRuns: number): Promise<void> {
    await writeEntityEntries(exec, {
      workspaceId: WORKSPACE,
      entity,
      entries: [entry({ entity })],
      entityNamesInReach: [entity],
      snapshotAt: new Date("2026-08-18T10:00:00Z"),
    });
    await recordSuccess(entity, "2026-08-18T10:00:00Z");
    for (let i = 1; i <= strandedRuns; i++) {
      await recordSuccess(entity, `2026-08-18T${String(10 + i).padStart(2, "0")}:00:00Z`);
    }
  }

  const reap = (entity: string) =>
    reapUnreachedEntityEntries(exec, { workspaceId: WORKSPACE, entity });

  it("N is 3, pinned as a literal", () => {
    // ⚠️ **Pinned as a LITERAL, and every assertion below counts runs in
    // literals too.** An earlier version of this block derived its boundary from
    // the constant (`n - 1`, `n`), which reads as a boundary test and is not
    // one: it moves with the constant, so changing 3 to 2 kept the whole suite
    // green. Measured — that mutation survived. #5321 asks for a constant that
    // is load-bearing rather than decorative, and the only way to get that is
    // for the numbers here NOT to be a function of it.
    expect(ENTITY_STORE_REAP_AFTER_SUCCESSFUL_RUNS).toBe(3);
  });

  it(
    "TWO stranded runs reap nothing — the boundary at N-1",
    async () => {
      await stranded(OLD_NAME, 2);
      expect(
        await reap(OLD_NAME),
        "reaped after only two stranded runs. With N = 3 the oldest of the last three successes is still the run that WROTE this entry, so nothing predates the window",
      ).toEqual([]);
      expect(await storeRows()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "THREE stranded runs do reap it — the boundary at N",
    async () => {
      await stranded(OLD_NAME, 3);
      expect(await reap(OLD_NAME)).toEqual([warehouseRowId(WORKSPACE, OLD_NAME, PRIMARY_KEY)]);
      expect(await storeRows()).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "fewer than N recorded successes reap nothing, even when the entry predates every one of them",
    async () => {
      // ⚠️ This is the arm the `gate.n >= $3` clause exists for, and nothing
      // else reaches it — measured: with that clause weakened to `>= 0` the rest
      // of this block stayed green, because everywhere else the run that wrote
      // the entry is itself inside the window and holds the boundary.
      //
      // The state is real rather than contrived. `bundle-scope.ts` exports
      // `brain_entity` and deliberately does NOT export
      // `brain_warehouse_entity_success`: after a region migration the
      // destination holds entries whose successes never happened HERE. Its first
      // two runs then record successes that postdate every entry in the store,
      // and reaping on them would delete a bridge the destination cannot
      // regenerate — a deletion licensed by a reading that never took place.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      await pool.query(`DELETE FROM brain_warehouse_entity_success`);
      // Two successes, both strictly AFTER the entry. Two is less than three.
      await recordSuccess(OLD_NAME, "2026-08-19T10:00:00Z");
      await recordSuccess(OLD_NAME, "2026-08-19T11:00:00Z");

      expect(
        await reap(OLD_NAME),
        "reaped on two successes with N = 3 — absence of evidence licensed a delete",
      ).toEqual([]);
      expect(await storeRows()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a transient datasource outage reaps NOTHING, however many times it fails",
    async () => {
      // The failure this rule exists to survive. A failed run records no
      // success, so the window never advances — and the entries stay however
      // long the outage lasts. Driven as real failed transactions rather than by
      // simply not calling the reaper, which would assert the test's own script.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      await recordSuccess(OLD_NAME, "2026-08-18T10:00:00Z");

      for (let i = 0; i < 5; i++) {
        await expect(
          inTransaction(async (tx) => {
            await recordEntityRunSuccess(tx, {
              workspaceId: WORKSPACE,
              entity: OLD_NAME,
              snapshotAt: new Date(`2026-08-19T${String(10 + i).padStart(2, "0")}:00:00Z`),
            });
            throw new Error("snapshot-failed");
          }),
        ).rejects.toThrow("snapshot-failed");
        expect(await reap(OLD_NAME)).toEqual([]);
      }
      expect(
        await storeRows(),
        "a datasource outage reaped live entries — this is the data loss the reach rule exists to prevent",
      ).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "reaps nothing when the producer has never successfully run for the entity",
    async () => {
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });
      // No success rows at all — a freshly-migrated region, whose success
      // history deliberately does not travel on the bundle.
      expect(await reap(OLD_NAME)).toEqual([]);
      expect(await storeRows()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is per entity — one entity's successful runs never reap another's entries",
    async () => {
      // `accounts` is stranded and well past N. `contacts` has one entry and no
      // history of its own. A rule that counted runs workspace-wide would take
      // both.
      await stranded(OLD_NAME, 4);
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "contacts",
        entries: [entry({ entity: "contacts", keySurface: "7", canonicalSurface: "Alice" })],
        entityNamesInReach: [OLD_NAME, "contacts"],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });

      await reap(OLD_NAME);
      const rows = await storeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity).toBe("contacts");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is workspace-scoped — another workspace's identically-named entity is untouched",
    async () => {
      await stranded(OLD_NAME, 4);
      await writeEntityEntries(exec, {
        workspaceId: "ws-other",
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-18T10:00:00Z"),
      });

      await reap(OLD_NAME);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_entity WHERE workspace_id = 'ws-other'`,
      );
      expect(
        rows[0]!.n,
        "one workspace's reap deleted another workspace's entries for the same entity name",
      ).toBe("1");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "reaps only entries older than the window — a fresh entry beside a stale one survives",
    async () => {
      // The rule is about the ENTRY's age, not the entity's. An entity whose
      // last run wrote entries has nothing to reap even with a long history,
      // which is what makes the reconcile arm a no-op by construction.
      await stranded(OLD_NAME, 4);
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: OLD_NAME,
        entries: [entry({ entity: OLD_NAME })],
        entityNamesInReach: [OLD_NAME],
        snapshotAt: new Date("2026-08-20T10:00:00Z"),
      });
      await recordSuccess(OLD_NAME, "2026-08-20T10:00:00Z");

      expect(await reap(OLD_NAME)).toEqual([]);
      expect(await storeRows()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
