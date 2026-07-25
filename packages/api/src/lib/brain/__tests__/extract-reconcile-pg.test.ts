/**
 * Real-Postgres coverage for the extraction fiber + reconcile stage (#4771,
 * ADR-0036 §Ingestion & connectors).
 *
 * The unit suites pin the DECISIONS (which failure blocks, which flags) against
 * an in-memory executor. Everything below is a claim only a live schema can
 * settle, and every one of them would pass vacuously against a mock:
 *
 *   1. **Does a reconciled fact actually land `draft`?** The insert omits
 *      `status` entirely, because migration 0180's default IS the review gate
 *      applying itself (#4769). A mock cannot tell that apart from a writer
 *      that forgot the column — only the stored row can.
 *   2. **Is the episode's batch genuinely atomic?** "One transaction, no
 *      half-formed rows" is a property of BEGIN/ROLLBACK, not of the
 *      TypeScript around it. A failure part-way through a multi-candidate
 *      episode must leave NOTHING behind — including the facts that had
 *      already succeeded.
 *   3. **Does re-running extraction over an already-extracted window no-op?**
 *      Acceptance criterion 5, and the thing that makes work-then-stamp safe.
 *      It rests on the corroboration lookup + the edge's `NOT EXISTS` guard
 *      running against real rows.
 *   4. **Do the queue mechanics hold?** The drain reads
 *      `idx_brain_episodes_extraction_queue`'s predicate, a completed pass
 *      stamps `extracted_at`, and a FAILED pass does not — the difference
 *      between "retried next cycle" and "silently dropped".
 *   5. **Do the CHECKs the block-stage stands in front of actually fire?** The
 *      blocked cases assert both that the stage refused AND that nothing
 *      reached the table.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import {
  reconcileFacts,
  type FactCandidate,
  type ReconcileEpisodeRef,
} from "@atlas/api/lib/brain/reconcile";
import {
  runBrainExtractionCycle,
  type FactExtractor,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-4771";

/** A model handle the fiber only ever passes through to the injected extractor. */
const FAKE_MODEL = {
  model: "fake-model" as unknown as ResolvedExtractionModel["model"],
  modelId: "fake-model",
} satisfies ResolvedExtractionModel;

describeIfPg("brain extraction + reconcile (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_4771_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `runPeriodicDbCycle` guards on `hasInternalDB()`, which reads
    // `DATABASE_URL` rather than the pool — so without this the cycle takes its
    // "nothing to do, no database" path and every fiber assertion below would
    // pass vacuously against an empty result. Set inside the hook (never at
    // module top level, per the test-discipline rule) and restored after.
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    // `search_path` baked into the connection string, not SET from an unawaited
    // `pool.on("connect")` handler — the pattern the sibling brain -pg suites
    // established.
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
    // The stage and the fiber both write through the module-level pool, so it
    // has to BE this schema-scoped one for the test to exercise the real SQL.
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
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  async function insertEpisode(
    overrides: {
      sourceId?: string;
      sourceActor?: string | null;
      body?: string | null;
      locator?: string | null;
      visibleTo?: readonly (string | null)[];
      extractedAt?: string | null;
    } = {},
  ): Promise<ReconcileEpisodeRef> {
    const {
      sourceId = `C01:${Date.now()}.${Math.floor(Math.random() * 1e6)}`,
      sourceActor = "U123",
      body = "the deploy window is Thursdays",
      locator = null,
      visibleTo = ["org"],
      extractedAt = null,
    } = overrides;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'slack', $2, $3, $4, $5, now(), $6::text[], $7::timestamptz)
       RETURNING id`,
      [WORKSPACE, sourceId, sourceActor, body, locator, visibleTo, extractedAt],
    );
    return {
      id: rows[0]!.id,
      workspaceId: WORKSPACE,
      source: "slack",
      sourceId,
      sourceActor,
      occurredAt: new Date("2026-06-21T09:00:00.000Z"),
      visibleTo,
    };
  }

  function candidate(overrides: Partial<FactCandidate> = {}): FactCandidate {
    return { subject: "deploy window", predicate: "is", object: "Thursdays", ...overrides };
  }

  async function facts(): Promise<
    { id: string; subject: string; object: string; status: string; provenance: Record<string, unknown>; visible_to: string[] }[]
  > {
    const { rows } = await pool.query(
      `SELECT id, subject, object, status, provenance, visible_to FROM brain_facts ORDER BY ingested_at, id`,
    );
    return rows;
  }

  async function edges(): Promise<{ edge_type: string; from_fact_id: string | null; to_episode_id: string | null; to_fact_id: string | null }[]> {
    const { rows } = await pool.query(
      `SELECT edge_type, from_fact_id, to_episode_id, to_fact_id FROM brain_edges ORDER BY created_at, id`,
    );
    return rows;
  }

  async function extractedAtOf(episodeId: string): Promise<Date | null> {
    const { rows } = await pool.query<{ extracted_at: Date | null }>(
      `SELECT extracted_at FROM brain_episodes WHERE id = $1`,
      [episodeId],
    );
    return rows[0]?.extracted_at ?? null;
  }

  // ── the stage ───────────────────────────────────────────────────────────

  it("lands a fully-formed candidate as a DRAFT it never asked for", async () => {
    const episode = await insertEpisode();
    const report = await reconcileFacts({
      episode,
      candidates: [candidate()],
      producer: "extraction:v1",
      extractedAt: new Date(),
    });

    expect(report.created).toBe(1);
    const stored = await facts();
    expect(stored).toHaveLength(1);
    // The whole point of omitting the column: the review gate applies itself.
    expect(stored[0]!.status).toBe("draft");
    expect(stored[0]!.visible_to).toEqual(["org"]);
    expect(stored[0]!.provenance).toMatchObject({
      source: "slack",
      episodeId: episode.id,
      actor: "slack:U123",
      producer: "extraction:v1",
    });
    // The evidence pointer exists in the SAME breath as the claim.
    expect(await edges()).toEqual([
      {
        edge_type: "provenance",
        from_fact_id: stored[0]!.id,
        to_episode_id: episode.id,
        to_fact_id: null,
      },
    ]);
  });

  it("rolls the WHOLE episode back when one candidate's write fails", async () => {
    // The invariant is "no half-formed rows", which means half-formed BATCHES
    // too: a reviewer must never inherit two of three claims from a pass that
    // did not finish. Forced by a subject long enough to be fine and an object
    // that violates nothing — so instead we break the write itself by aiming
    // the second candidate at a cardinality the CHECK refuses.
    const episode = await insertEpisode();
    await expect(
      reconcileFacts({
        episode,
        candidates: [
          candidate(),
          // `chk_brain_facts_predicate_cardinality` refuses this.
          candidate({
            object: "Fridays",
            predicateCardinality: "sometimes" as FactCandidate["predicateCardinality"],
          }),
          candidate({ object: "Mondays" }),
        ],
        producer: "extraction:v1",
        extractedAt: new Date(),
      }),
    ).rejects.toThrow();

    expect(await facts()).toHaveLength(0);
    expect(await edges()).toHaveLength(0);
  });

  it("blocks an episode whose grant no reader can match, and writes nothing", async () => {
    // `['everyone']` satisfies `chk_brain_episodes_grant_nonempty` — it is a
    // legally storable episode — and grants nobody. Blocking here is what keeps
    // #4769's promotion refusal from becoming a permanent trap.
    const episode = await insertEpisode({ visibleTo: ["everyone"] });
    const report = await reconcileFacts({
      episode,
      candidates: [candidate()],
      producer: "extraction:v1",
      extractedAt: new Date(),
    });

    expect(report.blocked.NO_GRANT).toBe(1);
    expect(await facts()).toHaveLength(0);
  });

  it("stores a provisional flag that survives the jsonb round-trip", async () => {
    const episode = await insertEpisode();
    await reconcileFacts({
      episode,
      candidates: [candidate()],
      producer: "extraction:v1",
      extractedAt: new Date(),
      resolveEntity: (surface, { role }) => (role === "object" ? null : { canonical: surface }),
    });

    const stored = await facts();
    expect(stored[0]!.provenance).toMatchObject({ provisional: true, unresolved: ["object"] });
    // Still a draft, still reviewable — flagged, not dropped.
    expect(stored[0]!.status).toBe("draft");
  });

  it("corroborates a re-observed claim instead of duplicating it", async () => {
    const first = await insertEpisode({ sourceId: "C01:1" });
    const second = await insertEpisode({ sourceId: "C01:2" });

    await reconcileFacts({ episode: first, candidates: [candidate()], producer: "p", extractedAt: new Date() });
    const report = await reconcileFacts({
      episode: second,
      candidates: [candidate()],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(report.corroborated).toBe(1);
    expect(await facts()).toHaveLength(1);
    const provenanceEdges = (await edges()).filter((e) => e.edge_type === "provenance");
    expect(provenanceEdges.map((e) => e.to_episode_id).toSorted()).toEqual(
      [first.id, second.id].toSorted(),
    );
  });

  it("records an advisory in-tension-with edge without invalidating anything", async () => {
    const first = await insertEpisode({ sourceId: "C01:3" });
    const second = await insertEpisode({ sourceId: "C01:4" });
    const single: Partial<FactCandidate> = {
      subject: "Ada",
      predicate: "reports to",
      predicateCardinality: "single",
    };

    await reconcileFacts({
      episode: first,
      candidates: [candidate({ ...single, object: "Grace" })],
      producer: "p",
      extractedAt: new Date(),
    });
    await reconcileFacts({
      episode: second,
      candidates: [candidate({ ...single, object: "Alan" })],
      producer: "p",
      extractedAt: new Date(),
    });

    const stored = await facts();
    expect(stored).toHaveLength(2);
    const tension = (await edges()).filter((e) => e.edge_type === "in-tension-with");
    expect(tension).toHaveLength(1);
    // Supersession is not deletion, and this stage does not supersede at all.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_facts WHERE invalidated_at IS NOT NULL`,
    );
    expect(rows[0]!.n).toBe("0");
  });

  // ── the fiber ───────────────────────────────────────────────────────────

  function cycleWith(extract: FactExtractor) {
    return Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        resolveModel: async () => FAKE_MODEL,
      }),
    );
  }

  const oneFact: FactExtractor = () => Promise.resolve([candidate()]);

  it("drains the queue, stages drafts, and stamps the episode", async () => {
    const episode = await insertEpisode();
    const result = await cycleWith(oneFact);

    expect(result).toMatchObject({ status: "success", inspected: 1, extracted: 1, factsCreated: 1 });
    expect(await extractedAtOf(episode.id)).not.toBeNull();
    expect(await facts()).toHaveLength(1);
  });

  it("re-running over an already-extracted window is a no-op", async () => {
    // Acceptance criterion 5, both halves: the stamped episode leaves the
    // drain's partial index, and even a forced re-run corroborates rather than
    // duplicating — which is what makes the crash window between the reconcile
    // commit and the stamp affordable.
    const episode = await insertEpisode();
    await cycleWith(oneFact);
    const second = await cycleWith(oneFact);

    expect(second).toMatchObject({ inspected: 0, extracted: 0, factsCreated: 0 });
    expect(await facts()).toHaveLength(1);

    // Force the episode back onto the queue, as a crash before the stamp would.
    await pool.query(`UPDATE brain_episodes SET extracted_at = NULL WHERE id = $1`, [episode.id]);
    const replay = await cycleWith(oneFact);

    expect(replay).toMatchObject({ inspected: 1, extracted: 1, factsCreated: 0, factsCorroborated: 1 });
    expect(await facts()).toHaveLength(1);
    expect((await edges()).filter((e) => e.edge_type === "provenance")).toHaveLength(1);
  });

  it("leaves a failed episode on the queue and keeps draining the rest", async () => {
    const poison = await insertEpisode({ sourceId: "C01:poison", body: "explode" });
    const healthy = await insertEpisode({ sourceId: "C01:healthy" });

    const result = await cycleWith((input) =>
      input.body === "explode"
        ? Promise.reject(new Error("model refused"))
        : Promise.resolve([candidate()]),
    );

    expect(result).toMatchObject({ inspected: 2, extracted: 1, failed: 1, status: "success" });
    // Not stamped ⇒ retried next cycle. A stamp here would be a silent drop.
    expect(await extractedAtOf(poison.id)).toBeNull();
    expect(await extractedAtOf(healthy.id)).not.toBeNull();
  });

  it("stamps a by-reference episode it can never extract, so it cannot block the queue head", async () => {
    const byRef = await insertEpisode({ body: null, locator: "warehouse://snapshot/1" });
    const result = await cycleWith(oneFact);

    expect(result).toMatchObject({ inspected: 1, extracted: 0, skippedNoBody: 1 });
    expect(await extractedAtOf(byRef.id)).not.toBeNull();
    expect(await facts()).toHaveLength(0);
  });

  it("leaves episodes queued when the workspace's model cannot be resolved", async () => {
    // A rotated-and-broken BYO key must not fall back to the platform model
    // (that would bill Atlas for a workspace that chose its own provider) and
    // must not stamp — re-entering the key is the whole repair.
    const episode = await insertEpisode();
    const result = await Effect.runPromise(
      runBrainExtractionCycle({ extract: oneFact, resolveModel: async () => null }),
    );

    expect(result).toMatchObject({ inspected: 1, extracted: 0, skippedModelUnavailable: 1 });
    expect(await extractedAtOf(episode.id)).toBeNull();
    expect(await facts()).toHaveLength(0);
  });

  it("stamps an episode whose candidates were all blocked", async () => {
    // Blocking is a DECISION, not a failure: retrying it forever would re-log
    // the same refusal every cycle and burn a queue slot. The episode itself is
    // never deleted, so the evidence survives for a later, smarter pass.
    const episode = await insertEpisode({ visibleTo: ["everyone"] });
    const result = await cycleWith(oneFact);

    expect(result).toMatchObject({ extracted: 1, factsCreated: 0, factsBlocked: 1 });
    expect(await extractedAtOf(episode.id)).not.toBeNull();
    expect(await facts()).toHaveLength(0);
  });

  it("an empty queue is a clean success", async () => {
    const result = await cycleWith(oneFact);
    expect(result).toMatchObject({ status: "success", inspected: 0, extracted: 0 });
  });
});
