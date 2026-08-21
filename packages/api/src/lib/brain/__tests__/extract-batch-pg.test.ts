/**
 * The batch ledger and the in-flight exclusion, against a live schema (#5352,
 * migration 0207).
 *
 * `extract-batch.test.ts` covers the control flow with injected seams and is the
 * better test for the phase logic. What CANNOT be tested there is everything
 * this ticket actually put in Postgres, and all of it fails in the silent
 * direction:
 *
 *   1. **The drain's in-flight exclusion is a correlated subquery.** A fake
 *      `internalQuery` resolves whatever it is handed, so a `NOT EXISTS` with
 *      the wrong join arm — or a `::uuid` mismatch on the pointer — passes the
 *      unit suite and then either excludes NOTHING (every in-flight episode
 *      re-submitted, every tick, at full price) or excludes EVERYTHING.
 *   2. **The exclusion keys on the batch's STATUS.** The whole reason for it is
 *      that a settled batch's unstamped episodes must return to the queue with
 *      no sweep. Only a real row can be settled and then re-drained.
 *   3. **Three CHECK constraints and a composite FK.** Each of them refuses a
 *      state the code is arranged never to produce, which is exactly why nothing
 *      in the unit suite reaches them.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool, internalQuery } from "@atlas/api/lib/db/internal";
import { BATCH_SIZE, DRAIN_EPISODES_SQL, type EpisodeRow } from "@atlas/api/lib/brain/extract";
import {
  abandonBatch,
  loadInFlightBatches,
  recordBatchSubmission,
  settleBatchCollected,
  BATCH_EPISODES_SQL,
} from "@atlas/api/lib/brain/extract-batch";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-5352";
const OTHER_WORKSPACE = "ws-brain-5352-other";

describeIfPg("brain extraction batch ledger (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5352_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    // Episodes first — they reference the ledger under a composite FK.
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM brain_extraction_batch");
  });

  // -- helpers ---------------------------------------------------------------

  async function insertEpisode(sourceId: string, workspaceId = WORKSPACE): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'the deploy window is Thursdays', now(), ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId],
    );
    return rows[0]!.id;
  }

  /** The drain, run exactly as the cycle runs it (no quarantine exclusions). */
  async function drain(): Promise<readonly EpisodeRow[]> {
    return internalQuery<EpisodeRow>(DRAIN_EPISODES_SQL, [BATCH_SIZE, []]);
  }

  const EXPIRES = new Date(Date.now() + 60 * 60 * 1000);

  async function submit(episodeIds: readonly string[], providerBatchId = "msgbatch_1"): Promise<string> {
    return recordBatchSubmission({
      workspaceId: WORKSPACE,
      providerBatchId,
      modelId: "claude-haiku-4-5",
      expiresAt: EXPIRES,
      episodeIds,
    });
  }

  // -- the exclusion ---------------------------------------------------------

  it(
    "⭐ an episode out with an in-flight batch is not re-drained",
    async () => {
      // #5352's AC verbatim. Without this the next tick re-drafts — and re-pays
      // for — everything the last tick submitted, which is the whole cost the
      // ticket exists to remove, doubled.
      const a = await insertEpisode("s-1");
      const b = await insertEpisode("s-2");
      expect((await drain()).map((r) => r.id).sort()).toEqual([a, b].sort());

      await submit([a]);

      const remaining = await drain();
      expect(remaining.map((r) => r.id)).toEqual([b]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⭐ settling the batch puts its UNSTAMPED episodes straight back on the queue",
    async () => {
      // THE reason the predicate reads `status` rather than testing the pointer
      // for NULL. A collect pass settles the batch BEFORE its episodes are
      // stamped, so there is a window where an episode is unstamped and pointed
      // at a settled batch — and a crash there, or a results set that omitted
      // the episode, must not strand it. Under the pointer-null predicate this
      // row is excluded from the drain forever with nothing left to unwind it.
      const a = await insertEpisode("s-1");
      const batchId = await submit([a]);
      expect(await drain()).toHaveLength(0);

      await settleBatchCollected(batchId);

      const back = await drain();
      expect(back.map((r) => r.id)).toEqual([a]);
      // And the POINTER is still set — it is the record of which batch produced
      // the episode, and clearing it is not what re-queues.
      const { rows } = await pool.query<{ extraction_batch_id: string | null }>(
        `SELECT extraction_batch_id FROM brain_episodes WHERE id = $1`,
        [a],
      );
      expect(rows[0]!.extraction_batch_id).toBe(batchId);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a STAMPED episode of a settled batch stays off the queue",
    async () => {
      // The control for the test above: `extracted_at` is still what takes an
      // episode off the queue for good. Without this, "settling re-queues"
      // could be satisfied by a predicate that re-queues everything.
      const a = await insertEpisode("s-1");
      const batchId = await submit([a]);
      await pool.query(`UPDATE brain_episodes SET extracted_at = now() WHERE id = $1`, [a]);
      await settleBatchCollected(batchId);
      expect(await drain()).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "abandoning clears the pointers and charges the episodes nothing",
    async () => {
      const a = await insertEpisode("s-1");
      const b = await insertEpisode("s-2");
      const batchId = await submit([a, b]);
      expect(await drain()).toHaveLength(0);

      const requeued = await abandonBatch({ batchId, reason: "the batch expired" });
      expect(requeued).toBe(2);

      expect((await drain()).map((r) => r.id).sort()).toEqual([a, b].sort());
      const { rows } = await pool.query<{ status: string; abandon_reason: string | null }>(
        `SELECT status, abandon_reason FROM brain_extraction_batch WHERE id = $1`,
        [batchId],
      );
      expect(rows[0]!.status).toBe("abandoned");
      expect(rows[0]!.abandon_reason).toBe("the batch expired");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the submission does not steal an episode another batch already claimed",
    async () => {
      // `AND extraction_batch_id IS NULL` on the UPDATE. Without it the later
      // writer silently re-points the episode, orphaning the first batch's
      // result line for it — the episode is collected once, stamped, and the
      // other batch's line is dropped as unmatched.
      const a = await insertEpisode("s-1");
      const first = await submit([a], "msgbatch_first");
      const second = await submit([a], "msgbatch_second");

      const stillFirst = await internalQuery<EpisodeRow>(BATCH_EPISODES_SQL, [first]);
      const stolen = await internalQuery<EpisodeRow>(BATCH_EPISODES_SQL, [second]);
      expect(stillFirst.map((r) => r.id)).toEqual([a]);
      expect(stolen).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the collect scan returns in-flight batches oldest-first and skips settled ones",
    async () => {
      const a = await insertEpisode("s-1");
      const b = await insertEpisode("s-2");
      const older = await submit([a], "msgbatch_older");
      await pool.query(
        `UPDATE brain_extraction_batch SET submitted_at = now() - interval '1 hour' WHERE id = $1`,
        [older],
      );
      const newer = await submit([b], "msgbatch_newer");

      expect((await loadInFlightBatches(10)).map((r) => r.id)).toEqual([older, newer]);

      await settleBatchCollected(older);
      expect((await loadInFlightBatches(10)).map((r) => r.id)).toEqual([newer]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -- what the schema refuses ----------------------------------------------

  describe("the migration's constraints", () => {
    async function insertBatch(overrides: Record<string, string | null>): Promise<void> {
      const row = {
        workspace_id: WORKSPACE,
        provider: "anthropic",
        provider_batch_id: "msgbatch_x",
        model_id: "claude-haiku-4-5",
        request_count: "1",
        status: "in_flight",
        expires_at: EXPIRES.toISOString(),
        settled_at: null as string | null,
        abandon_reason: null as string | null,
        ...overrides,
      };
      const keys = Object.keys(row);
      await pool.query(
        `INSERT INTO brain_extraction_batch (${keys.join(", ")})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
        keys.map((k) => (row as Record<string, string | null>)[k]),
      );
    }

    it("refuses a status outside the closed set", async () => {
      // `settled_at` is set alongside, deliberately: an unknown status with a
      // NULL `settled_at` trips the settled CHECK first (only `in_flight` may
      // be unsettled), so the row would be refused for the wrong reason and
      // this assertion would pass without the status CHECK existing at all.
      await expect(
        insertBatch({ status: "pending", settled_at: new Date().toISOString() }),
      ).rejects.toThrow(/ck_brain_extraction_batch_status/);
    });

    it("⭐ refuses a row that is settled by one field and in-flight by the other", async () => {
      // Silent in BOTH directions, which is why it is a constraint rather than
      // a convention: a settled row still matching the collect scan re-reads a
      // vendor batch forever, and an in-flight row carrying `settled_at` is a
      // batch nothing collects while its episodes stay excluded from the drain.
      await expect(
        insertBatch({ status: "in_flight", settled_at: new Date().toISOString() }),
      ).rejects.toThrow(/ck_brain_extraction_batch_settled/);
      await expect(insertBatch({ status: "collected", settled_at: null })).rejects.toThrow(
        /ck_brain_extraction_batch_settled/,
      );
    });

    it("refuses an abandon_reason on a batch that was not abandoned", async () => {
      // Otherwise a COLLECTED batch could carry vendor error text an operator
      // would read as a failure.
      await expect(
        insertBatch({
          status: "collected",
          settled_at: new Date().toISOString(),
          abandon_reason: "something went wrong",
        }),
      ).rejects.toThrow(/ck_brain_extraction_batch_reason_only_when_abandoned/);
    });

    it("⭐ refuses an episode pointed at another workspace's batch", async () => {
      // The composite FK, and the reason it is composite: with a plain
      // `REFERENCES brain_extraction_batch(id)` this is representable, and what
      // it represents is one tenant's episodes being collected — and reconciled
      // — through another tenant's batch and another tenant's key.
      const mine = await insertEpisode("s-1");
      const batchId = await submit([mine]);
      const theirs = await insertEpisode("s-other", OTHER_WORKSPACE);
      await expect(
        pool.query(`UPDATE brain_episodes SET extraction_batch_id = $1 WHERE id = $2`, [
          batchId,
          theirs,
        ]),
      ).rejects.toThrow(/fk_brain_episodes_extraction_batch/);
    });

    it("refuses two rows for the same vendor batch id in one workspace", async () => {
      await insertBatch({});
      await expect(insertBatch({})).rejects.toThrow(/uq_brain_extraction_batch_provider_id/);
      // ...and permits the same id in a DIFFERENT workspace, because a BYO
      // workspace and the platform key see different id spaces.
      await insertBatch({ workspace_id: OTHER_WORKSPACE });
    });
  });
});
