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
 *   4. **Do the queue mechanics hold?** A completed pass stamps `extracted_at`
 *      and a FAILED pass does not — the difference between "retried next cycle"
 *      and "silently dropped". (What the drain's index does for the query is a
 *      planner question no test here asks.)
 *   5. **Does the stage refuse BEFORE the row reaches a table whose CHECKs
 *      would happily accept it?** `['everyone']` is precisely the grant the
 *      0180 CHECK does not catch, which is why the stage blocks upstream — so
 *      the blocked cases assert both that it refused AND that nothing reached
 *      the table.
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
  BATCH_SIZE,
  _resetBrainExtractionFailures,
  runBrainExtractionCycle,
  type FactExtractor,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";

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
    await pool.query("DELETE FROM admin_action_log");
    // The quarantine ledger is module-level and survives between tests; a
    // process restart is what clears it in production, and this is the test's
    // equivalent. Without it, a later test inherits an earlier one's failures.
    _resetBrainExtractionFailures();
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
    // The stored `occurred_at` is the SAME value the returned ref carries — a
    // `now()` here would make the ref a near-miss of the row it describes, and
    // any assertion about provenance `occurredAt` silently wrong.
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'slack', $2, $3, $4, $5, $6::timestamptz, $7::text[], $8::timestamptz)
       RETURNING id`,
      [WORKSPACE, sourceId, sourceActor, body, locator, occurredAt.toISOString(), visibleTo, extractedAt],
    );
    return {
      id: rows[0]!.id,
      workspaceId: WORKSPACE,
      source: "slack",
      sourceId,
      sourceActor,
      occurredAt,
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

  /** Poll for the fire-and-forget audit row. See the audit test for why. */
  async function waitForAuditRows(
    actionType: string,
  ): Promise<{ status: string; actor_id: string | null }[]> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const { rows } = await pool.query<{ status: string; actor_id: string | null }>(
        `SELECT status, actor_id FROM admin_action_log WHERE action_type = $1`,
        [actionType],
      );
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [];
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
      vocabulary: identityVocabulary,
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
    // did not finish. The failure is induced on the SECOND candidate, so what is
    // proven is that the FIRST candidate's already-succeeded write is undone.
    //
    // The inducer used to be a cardinality `chk_brain_facts_predicate_cardinality`
    // refuses. That stopped working when #5027 took `predicate_cardinality` out
    // of `INSERT_FACT_SQL`'s column list — the value no longer reaches Postgres,
    // so the batch simply succeeded and this test passed while asserting
    // nothing. A NUL byte is the replacement: `22021 invalid byte sequence for
    // encoding "UTF8"` is refused by the SERVER, on that row's INSERT, which is
    // the same shape of failure at the same point.
    //
    // Deliberately NOT a column this repo owns. The old inducer was coupled to a
    // constraint that was about to be dropped, and picking another one would put
    // this test back on the same clock; encoding is not going anywhere.
    const episode = await insertEpisode();
    const first = candidate();
    await expect(
      reconcileFacts({
        vocabulary: identityVocabulary,
        episode,
        candidates: [
          first,
          candidate({ object: `Fri${String.fromCharCode(0)}days` }),
          candidate({ object: "Mondays" }),
        ],
        producer: "extraction:v1",
        extractedAt: new Date(),
      }),
      // Anchored: an unanchored `toThrow()` would also pass if the FIRST
      // candidate started failing for an unrelated reason, in which case
      // nothing was ever written and the rollback claim is untested.
    ).rejects.toThrow(/invalid byte sequence/);

    expect(await facts()).toHaveLength(0);
    expect(await edges()).toHaveLength(0);

    // Control: that same first candidate on its own DOES land, so the empty
    // table above is a rollback and not a candidate that never worked.
    await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [first],
      producer: "extraction:v1",
      extractedAt: new Date(),
    });
    expect(await facts()).toHaveLength(1);
  });

  it("blocks an episode whose grant no reader can match, and writes nothing", async () => {
    // `['everyone']` satisfies `chk_brain_episodes_grant_nonempty` — it is a
    // legally storable episode — and grants nobody. Blocking here is what keeps
    // #4769's promotion refusal from becoming a permanent trap.
    const episode = await insertEpisode({ visibleTo: ["everyone"] });
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
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
      vocabulary: identityVocabulary,
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

    await reconcileFacts({ vocabulary: identityVocabulary, episode: first, candidates: [candidate()], producer: "p", extractedAt: new Date() });
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: second,
      candidates: [candidate()],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(report.corroborated).toBe(1);
    expect(await facts()).toHaveLength(1);
    const provenanceEdges = (await edges()).filter((e) => e.edge_type === "provenance");
    // Explicit comparator: these are uuid strings, and `toSorted()` with no
    // argument sorts by UTF-16 code unit, which `require-array-sort-compare`
    // refuses precisely because that is a different order than a reader assumes.
    const byId = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");
    expect(provenanceEdges.map((e) => e.to_episode_id).toSorted(byId)).toEqual(
      [first.id, second.id].toSorted(byId),
    );
  });

  // ── claim identity (#5020, ADR-0037 §1) ─────────────────────────────────
  //
  // The write side and the two lookups that now read it. Only a live schema
  // settles these: the unit suite's fake records what the stage BOUND, which
  // cannot tell a correct bind from one the column list drops on the floor —
  // an INSERT naming ten columns and passing thirteen params errors, but one
  // whose keys land in the wrong columns does not.

  /** The stored identity of every fact, in insertion order. */
  async function slots(): Promise<
    { subject_key: string | null; predicate_key: string | null; object_key: string | null }[]
  > {
    const { rows } = await pool.query(
      `SELECT subject_key, predicate_key, object_key FROM brain_facts ORDER BY ingested_at, id`,
    );
    return rows;
  }

  it("materializes all three keys on a new fact, off the RESOLVED surfaces", async () => {
    const episode = await insertEpisode({ sourceId: "C01:key-1" });
    await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [candidate({ subject: "Deploy_Window", predicate: "Ships  On" })],
      producer: "p",
      extractedAt: new Date(),
      // The key must describe the row that was STORED, so it is derived after
      // resolution — not from the candidate's raw surface.
      resolveEntity: (surface) =>
        surface === "Deploy_Window" ? { canonical: "The Deploy Box" } : { canonical: surface },
    });

    expect(await slots()).toEqual([
      { subject_key: "the deploy box", predicate_key: "ships on", object_key: "thursdays" },
    ]);
    // The retained surface is the resolver's canonical form, untouched by the
    // fold — identity moved, the record of the claim did not.
    expect((await facts())[0]).toMatchObject({ subject: "The Deploy Box" });
  });

  // The three collide/don't-collide cases that used to sit here — a phrasing
  // variant corroborating, `is priced at` NOT unifying with `priced at`, and a
  // phrasing-hidden rival earning a tension edge — moved to
  // `identity-consumers-pg.test.ts` (#5021). They are now asserted over ONE
  // corpus read by all three consumers, alongside the supersession join, which
  // is what stops the three drifting into disagreeing about what collides. A
  // second set of pairs making the same claims here is the drift shape itself.
  //
  // What stays below is what that corpus cannot express: a row whose key is
  // NULL, and a rival whose OBJECT key is NULL. Both need a surface that norms
  // away, which is a property of one claim rather than a relation between two.
  //
  // The other two-claim cases elsewhere in this file (`corroborates a
  // re-observed claim`, `records an advisory in-tension-with edge`, the
  // published/retracted/cross-tenant ones) are NOT duplicates of the corpus and
  // were deliberately kept: each varies a STAGE property — status, grant,
  // tombstone, tenant — over one fixed claim, rather than varying the claim.
  // Identity is the corpus's axis; those are this file's.

  it("keys a surface that norms away as NULL, and NULL corroborates nothing", async () => {
    // `-` and `___` survive the MALFORMED_CLAIM guard (`trim` strips whitespace,
    // not `_` or `-`), so they are storable claims with no slot. They must NOT
    // share one: a stored `''` — or a NULL-safe join arm — would file every
    // placeholder in the corpus under one key, and at `single` cardinality
    // publishing either would stamp `valid_to` on the other.
    //
    // What the column read below pins is that `slotKey` returned `null` rather
    // than `""` — NOT that no `DEFAULT ''` exists, since `INSERT_FACT_SQL` now
    // binds `object_key` explicitly and an explicit NULL always beats a default.
    // `identity-pg.test.ts` introspects the column for the default itself.
    const first = await insertEpisode({ sourceId: "C01:key-6" });
    const second = await insertEpisode({ sourceId: "C01:key-7" });

    await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: first,
      candidates: [candidate({ object: "-" })],
      producer: "p",
      extractedAt: new Date(),
    });
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: second,
      candidates: [candidate({ object: "___" })],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(report.corroborated).toBe(0);
    const stored = await facts();
    expect(stored).toHaveLength(2);
    // The degenerate SURFACES survive to the column verbatim — a reviewer has
    // to be able to see what the producer emitted in order to repair it.
    expect(stored.map((f) => f.object)).toEqual(["-", "___"]);
    for (const slot of await slots()) {
      expect(slot.object_key).toBeNull();
      expect(slot.subject_key).toBe("deploy window");
    }
  });

  it("a rival with NO object identity is not a rival — the object arm's falsifier", async () => {
    // This is what makes `object_key <> $4` load-bearing rather than
    // decorative, and it took a review to find: a live row in the same slot
    // whose object is `-` has `object_key IS NULL`, so the corroboration
    // lookup does not return it either (`object_key = $4` is unknown) and it
    // survives to the rival scan. There the two spellings genuinely diverge —
    // `object <> $4` is TRUE, `object_key <> $4` is unknown.
    //
    // Wiring the edge would be the worse outcome: a permanent advisory
    // `in-tension-with` from a real claim to a placeholder that asserts
    // nothing, shown to a reviewer as a contradiction to arbitrate.
    const first = await insertEpisode({ sourceId: "C01:key-10" });
    const second = await insertEpisode({ sourceId: "C01:key-11" });

    await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: first,
      candidates: [candidate({ object: "-", predicateCardinality: "single" })],
      producer: "p",
      extractedAt: new Date(),
    });
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: second,
      candidates: [candidate({ object: "Thursdays", predicateCardinality: "single" })],
      producer: "p",
      extractedAt: new Date(),
    });

    // Two facts — the degenerate one could not corroborate — and NO edge.
    expect(report.outcomes[0]).toMatchObject({ kind: "created", tensionEdges: 0 });
    expect(await facts()).toHaveLength(2);
    expect((await edges()).filter((e) => e.edge_type === "in-tension-with")).toHaveLength(0);
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
      vocabulary: identityVocabulary,
      episode: first,
      candidates: [candidate({ ...single, object: "Grace" })],
      producer: "p",
      extractedAt: new Date(),
    });
    await reconcileFacts({
      vocabulary: identityVocabulary,
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
    const seen: { modelId: string; body: string; episodeId: string }[] = [];
    const result = await cycleWith((input) => {
      seen.push({ modelId: input.modelId, body: input.body, episodeId: input.episode.id });
      return Promise.resolve([candidate()]);
    });

    expect(result).toMatchObject({ status: "success", inspected: 1, extracted: 1, factsCreated: 1 });
    expect(await extractedAtOf(episode.id)).not.toBeNull();
    expect(await facts()).toHaveLength(1);
    // The resolved model reaches the extractor — the piece every other fiber
    // test injects past, and the reason `detail.model` in provenance is
    // trustworthy at all.
    expect(seen).toEqual([
      { modelId: "fake-model", body: "the deploy window is Thursdays", episodeId: episode.id },
    ]);
    // The event time round-trips into provenance rather than being re-derived.
    expect((await facts())[0]!.provenance).toMatchObject({
      occurredAt: "2026-06-21T09:00:00.000Z",
    });
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

    expect(result).toMatchObject({ inspected: 1, extracted: 0 });
    expect(result.skipped.no_body).toBe(1);
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

    expect(result).toMatchObject({ inspected: 1, extracted: 0 });
    expect(result.skipped.model_unavailable).toBe(1);
    expect(await extractedAtOf(episode.id)).toBeNull();
    expect(await facts()).toHaveLength(0);
  });

  it("refuses an unsafe episode BEFORE calling a model, and stamps it", async () => {
    // Two claims in one. Blocking is a DECISION, not a failure: retrying it
    // forever would re-log the same refusal every cycle and hold a queue slot,
    // so it is stamped (the evidence itself is never deleted). And the refusal
    // is pre-flighted, so an episode from which no safe fact can be drawn costs
    // ZERO model calls rather than one per pass — `extractorCalls` is the
    // assertion, since a post-hoc block would look identical in the database.
    const episode = await insertEpisode({ visibleTo: ["everyone"] });
    let extractorCalls = 0;
    const result = await cycleWith(() => {
      extractorCalls++;
      return Promise.resolve([candidate()]);
    });

    expect(extractorCalls).toBe(0);
    expect(result).toMatchObject({ blockedEpisodes: 1, extracted: 0, factsCreated: 0 });
    expect(await extractedAtOf(episode.id)).not.toBeNull();
    expect(await facts()).toHaveLength(0);
  });

  it("stops calling a model for an episode that fails every attempt", async () => {
    // The spend bound. Retry-forever is right for a 429 and wrong for a body
    // that deterministically trips a content filter — and nothing in the
    // failure itself distinguishes them, so the ledger counts consecutive
    // failures instead of guessing. Deliberately NOT a stamp: three failures in
    // one process is not proof of "unextractable forever", and stamping on that
    // guess is the silent drop the whole ordering avoids.
    const poison = await insertEpisode({ body: "explode" });
    let calls = 0;
    const exploding: FactExtractor = () => {
      calls++;
      return Promise.reject(new Error("model refused"));
    };

    // FOUR ticks, not three: the first all-failed tick is forgiven as a possible
    // outage (one free pass per episode, see the refund cap), so the three
    // strikes that reach the threshold start on tick 2.
    for (let i = 0; i < 4; i++) await cycleWith(exploding);
    expect(calls).toBe(4);

    const quarantined = await cycleWith(exploding);
    // `inspected: 0`, not 1: a backing-off episode is now excluded by the DRAIN
    // rather than selected and then skipped, so it no longer consumes a slot in
    // the batch. That is the point of the exclusion — see the poisoned-head test
    // below. It is still COUNTED as quarantined, sourced from the ledger.
    expect(quarantined).toMatchObject({ inspected: 0, failed: 0 });
    expect(quarantined.skipped.quarantined).toBe(1);
    // No fifth model call…
    expect(calls).toBe(4);
    // …and still queued, so a restart (or a fix) picks it back up.
    expect(await extractedAtOf(poison.id)).toBeNull();
  });

  it("still quarantines when the WHOLE batch is poisoned", async () => {
    // The regression the single-episode test above structurally cannot catch.
    // A failing episode is never stamped, so it stays at the head of the drain —
    // and once the healthy episodes ahead of it have gone, "every episode this
    // tick failed" is just what a poisoned queue looks like, on every tick. An
    // uncapped outage refund therefore un-charges the strikes it just charged
    // and quarantine becomes unreachable: measured over a simulated day, two
    // poisoned episodes went from 25 model calls total to 576 and climbing.
    await insertEpisode({ sourceId: "C01:poison-a", body: "explode" });
    await insertEpisode({ sourceId: "C01:poison-b", body: "explode" });
    let calls = 0;
    const exploding: FactExtractor = () => {
      calls++;
      return Promise.reject(new Error("model refused"));
    };

    // Tick 1 charges a strike each and refunds both (a genuine outage looks
    // exactly like this, and costs nothing). Ticks 2-4 charge again; the
    // per-episode cap means those strikes STAY.
    for (let i = 0; i < 4; i++) await cycleWith(exploding);
    const quiet = await cycleWith(exploding);

    expect(quiet.skipped.quarantined).toBe(2);
    const callsBefore = calls;
    await cycleWith(exploding);
    // …and no further model calls while the backoff holds.
    expect(calls).toBe(callsBefore);
  });

  it("⭐ a poisoned HEAD of the queue does not block the healthy episodes behind it", async () => {
    // Quarantine bounds what a poisoned episode COSTS. It did not bound what one
    // BLOCKS, and those are different properties. A failing episode is never
    // stamped, so it stays at the head of `ORDER BY ingested_at` forever — and
    // the skip used to happen AFTER the row had already consumed one of the
    // batch's slots. Past `BATCH_SIZE` poisoned episodes at the head (one
    // workspace's content filter, one 404ing model) every tick selected the same
    // full batch, skipped all of it for free, and drained NOTHING — for every
    // other workspace and source in the deployment. Cheap, silent, and total.
    //
    // Uses a batch-sized poison block so the test fails for the RIGHT reason: a
    // smaller block would leave room in the LIMIT and pass without the fix.
    //
    // MUTATION THIS CATCHES: dropping the `id <> ALL($2::uuid[])` exclusion.
    //
    // BATCH is IMPORTED, never copied: a local `const BATCH = 25` silently
    // decouples from `extract.ts` the day the real one is raised, and the test
    // then passes vacuously — the poison block no longer fills the LIMIT, so
    // the healthy row is reachable without the exclusion doing anything.
    const BATCH = BATCH_SIZE;
    for (let i = 0; i < BATCH; i++) {
      await insertEpisode({ sourceId: `C01:poison-${i}`, body: "explode" });
    }
    const selective: FactExtractor = (input) => {
      if (input.body === "explode") return Promise.reject(new Error("model refused"));
      return Promise.resolve([candidate()]);
    };

    // Drive the poison block into quarantine (tick 1 is refunded as an outage).
    for (let i = 0; i < 4; i++) await cycleWith(selective);
    const stalled = await cycleWith(selective);
    expect(stalled.skipped.quarantined).toBe(BATCH);
    expect(stalled.extracted).toBe(0);

    // NOW a healthy episode arrives BEHIND all of them. Before the exclusion it
    // was unreachable: the 25 quarantined rows filled the LIMIT on every tick.
    const healthy = await insertEpisode({ sourceId: "C01:healthy", body: "the deploy window is Thursdays" });
    const drained = await cycleWith(selective);

    expect(drained.extracted).toBe(1);
    expect(await extractedAtOf(healthy.id)).not.toBeNull();
    // …and the quarantined block is still REPORTED, not silently dropped from
    // the counters just because it left the SELECT.
    expect(drained.skipped.quarantined).toBe(BATCH);
  });

  it("forgives one strike each when a whole tick fails, so an outage costs nothing", async () => {
    // The other half of the same rule. Two episodes, one bad tick, then a good
    // one: neither may carry a strike out of the outage.
    await insertEpisode({ sourceId: "C01:outage-a" });
    await insertEpisode({ sourceId: "C01:outage-b" });
    let failNext = true;
    const flaky: FactExtractor = () =>
      failNext ? Promise.reject(new Error("provider 503")) : Promise.resolve([candidate()]);

    const outage = await cycleWith(flaky);
    expect(outage).toMatchObject({ failed: 2, outageRefunded: 2 });

    failNext = false;
    const recovered = await cycleWith(flaky);
    expect(recovered).toMatchObject({ extracted: 2, failed: 0 });
    expect(recovered.skipped.quarantined).toBe(0);
  });

  it("stamps an episode whose extraction found nothing to claim", async () => {
    // The modal case in production: most chat contains no durable fact. If an
    // empty-candidate short-circuit ever landed before the stamp, the drain
    // would head-of-line block on small talk forever.
    const episode = await insertEpisode({ body: "morning all" });
    const result = await cycleWith(() => Promise.resolve([]));

    expect(result).toMatchObject({ extracted: 1, factsCreated: 0, blockedEpisodes: 0 });
    expect(await extractedAtOf(episode.id)).not.toBeNull();
  });

  it("emits a cycle audit row on every terminal path", async () => {
    // The row's ABSENCE over a window is the "the fiber stopped" signal, so it
    // has to be emitted even when there was nothing to do — and the system
    // actor has to pass `assertSystemActor`, which validates at RUNTIME and
    // silently drops the row when it does not.
    await cycleWith(oneFact);
    // `logAdminAction` is fire-and-forget by contract, so the row lands just
    // after the cycle resolves. Polling here is not only how the assertion
    // works — it is also what keeps the suite's `DROP SCHEMA … CASCADE` from
    // racing an in-flight INSERT and logging a spurious failure.
    const rows = await waitForAuditRows("brain.extraction_cycle");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("success");
    // The system actor is validated at RUNTIME by `assertSystemActor`, which
    // drops the row (with a warn) when it does not match — so a malformed
    // actor would destroy the "absence means the fiber stopped" invariant
    // while every other test stayed green.
    expect(rows[0]!.actor_id).toBe("system:brain-extraction");
  });

  it("leaves the episode queued when the reconcile transaction itself fails", async () => {
    // The stamp is the LAST thing that happens, and this is what that ordering
    // buys: a database fault during reconcile must leave the queue marker
    // untouched so the claim is re-derived, rather than stamping past evidence
    // whose facts never committed.
    const episode = await insertEpisode();
    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: oneFact,
        resolveModel: async () => FAKE_MODEL,
        reconcile: () => Promise.reject(new Error("deadlock detected")),
      }),
    );

    expect(result).toMatchObject({ inspected: 1, extracted: 0, failed: 1 });
    expect(await extractedAtOf(episode.id)).toBeNull();
    expect(await facts()).toHaveLength(0);
  });

  it("corroborates a PUBLISHED fact rather than minting a fresh draft duplicate", async () => {
    // The corroboration lookup is deliberately not filtered by review state.
    // Adding `AND status = 'draft'` to it would leave every test above green
    // while every re-observation of an already-reviewed claim queued a new
    // draft for a human to re-approve — the review queue would fill with work
    // somebody already did.
    const first = await insertEpisode({ sourceId: "C01:pub-1" });
    const second = await insertEpisode({ sourceId: "C01:pub-2" });
    await reconcileFacts({ vocabulary: identityVocabulary, episode: first, candidates: [candidate()], producer: "p", extractedAt: new Date() });
    await pool.query(`UPDATE brain_facts SET status = 'published'`);

    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: second,
      candidates: [candidate()],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(report.corroborated).toBe(1);
    const stored = await facts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("published");
    expect((await edges()).filter((e) => e.edge_type === "provenance")).toHaveLength(2);
  });

  it("corroborates ACROSS grants and leaves the fact's own grant alone", async () => {
    // The premise #4823's publish-time widening rests on, proved at the stage
    // that produces it: the same claim in a private channel and then a public
    // one must land as ONE fact with TWO provenance edges, and reconcile must
    // not touch the grant — widening at an unattended ingest pass is exactly
    // what ADR-0036 §T5 forbids. If `CORROBORATION_LOOKUP_SQL` ever gained a
    // grant filter, the second episode would mint a duplicate instead, the
    // wider edge would never exist, and the publish-side widening would have
    // nothing to find — while every test in `promotion-pg.test.ts` stayed green
    // on its hand-seeded edges.
    const priv = await insertEpisode({
      sourceId: "C0BK:cross-1",
      visibleTo: ["audience:chat-channel:slack:C0BK"],
    });
    const pub = await insertEpisode({ sourceId: "C0BB:cross-2", visibleTo: ["org"] });
    await reconcileFacts({ vocabulary: identityVocabulary, episode: priv, candidates: [candidate()], producer: "p", extractedAt: new Date() });

    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: pub,
      candidates: [candidate()],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(report.corroborated).toBe(1);
    const stored = await facts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.visible_to).toEqual(["audience:chat-channel:slack:C0BK"]);
    const provenance = (await edges()).filter((e) => e.edge_type === "provenance");
    expect(provenance).toHaveLength(2);
    // Sorted with an explicit comparator: uuids are strings, but a bare
    // `.sort()` stringifies through `toString()` and the type-aware lint gate
    // refuses it (`require-array-sort-compare`).
    const byString = (a: string, b: string) => a.localeCompare(b);
    expect(
      provenance.map((e) => e.to_episode_id ?? "").sort(byString),
    ).toEqual([priv.id, pub.id].sort(byString));
  });

  it("does not let a RETRACTED fact absorb a re-observation", async () => {
    // `invalidated_at IS NULL` in the lookup. A tombstoned claim corroborating
    // a fresh observation would resurrect a belief by side-effect — and, worse,
    // silently: the new evidence would attach to a fact no reader can see.
    const first = await insertEpisode({ sourceId: "C01:ret-1" });
    const second = await insertEpisode({ sourceId: "C01:ret-2" });
    await reconcileFacts({ vocabulary: identityVocabulary, episode: first, candidates: [candidate()], producer: "p", extractedAt: new Date() });
    await pool.query(`UPDATE brain_facts SET invalidated_at = now()`);

    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: second,
      candidates: [candidate()],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(report.created).toBe(1);
    expect(await facts()).toHaveLength(2);
  });

  it("keeps corroboration inside the tenant, in the SQL and not just the caller", async () => {
    // Three predicates ride on this: the corroboration lookup, the tension
    // lookup, and the stamp. Dropping `workspace_id =` from the first turns a
    // dedupe into a cross-tenant read — tenant B's re-observation attaches a
    // provenance edge to tenant A's fact, and A's fact then cites evidence A
    // cannot see. The unit suite can only prove the PARAMETER is passed
    // (`reconcile.test.ts`, "the lookup's first bind is the episode's
    // workspace") — since #5021 its fake answers the lookup from a scripted
    // premise and implements no filter at all. That the SQL TEXT still names
    // the column is this test's.
    const mine = await insertEpisode({ sourceId: "C01:tenant-a" });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ('ws-other-tenant', 'slack', 'C01:tenant-b', 'U999', 'same claim', now(), ARRAY['org'])
       RETURNING id`,
    );
    const theirs: ReconcileEpisodeRef = {
      id: rows[0]!.id,
      workspaceId: "ws-other-tenant",
      source: "slack",
      sourceId: "C01:tenant-b",
      sourceActor: "U999",
      occurredAt: new Date("2026-06-21T09:00:00.000Z"),
      visibleTo: ["org"],
    };

    await reconcileFacts({ vocabulary: identityVocabulary, episode: mine, candidates: [candidate()], producer: "p", extractedAt: new Date() });
    const other = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: theirs,
      candidates: [candidate()],
      producer: "p",
      extractedAt: new Date(),
    });

    expect(other.created).toBe(1);
    const stored = await facts();
    expect(stored).toHaveLength(2);
    // Each fact cites only its OWN tenant's evidence.
    const all = await edges();
    for (const fact of stored) {
      const evidence = all.filter((e) => e.from_fact_id === fact.id);
      expect(evidence).toHaveLength(1);
    }

    await pool.query(`DELETE FROM brain_facts WHERE workspace_id = 'ws-other-tenant'`);
    await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = 'ws-other-tenant'`);
  });

  it("counts CONSECUTIVE failures, so a success between them clears the ledger", async () => {
    // Without the `delete` on the success path this counts TOTAL failures, and
    // an episode that 429s twice, succeeds, then 429s once more would be
    // quarantined — exactly the transient-vs-deterministic conflation the
    // ledger exists to avoid.
    const episode = await insertEpisode();
    let calls = 0;
    const flaky: FactExtractor = () => {
      calls++;
      return calls === 3
        ? Promise.resolve([candidate()])
        : Promise.reject(new Error("transient"));
    };

    await cycleWith(flaky); // fail 1
    await cycleWith(flaky); // fail 2
    await cycleWith(flaky); // success — clears the ledger AND stamps
    expect(await extractedAtOf(episode.id)).not.toBeNull();

    // Re-queue and fail twice more; a TOTAL counter would quarantine on the
    // second of these, a consecutive one keeps calling the model.
    await pool.query(`UPDATE brain_episodes SET extracted_at = NULL WHERE id = $1`, [episode.id]);
    const failAgain: FactExtractor = () => {
      calls++;
      return Promise.reject(new Error("transient"));
    };
    await cycleWith(failAgain);
    const second = await cycleWith(failAgain);

    expect(second.skipped.quarantined).toBe(0);
    expect(second.failed).toBe(1);
  });

  it("two reconciles racing on one claim produce ONE fact", async () => {
    // What the per-workspace advisory lock is FOR. The unit suite proves the
    // statement is issued; only a real transaction proves it serializes a
    // read-then-insert that would otherwise interleave into two rows.
    const a = await insertEpisode({ sourceId: "C01:race-a" });
    const b = await insertEpisode({ sourceId: "C01:race-b" });

    await Promise.all([
      reconcileFacts({ vocabulary: identityVocabulary, episode: a, candidates: [candidate()], producer: "p", extractedAt: new Date() }),
      reconcileFacts({ vocabulary: identityVocabulary, episode: b, candidates: [candidate()], producer: "p", extractedAt: new Date() }),
    ]);

    expect(await facts()).toHaveLength(1);
    expect((await edges()).filter((e) => e.edge_type === "provenance")).toHaveLength(2);
  });

  it("an empty queue is a clean success", async () => {
    const result = await cycleWith(oneFact);
    expect(result).toMatchObject({ status: "success", inspected: 0, extracted: 0 });
  });
});
