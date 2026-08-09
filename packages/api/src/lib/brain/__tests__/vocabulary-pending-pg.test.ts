/**
 * The **Pending** queue against a real schema (#5088).
 *
 * Four claims here can only be made against Postgres, and each of them is one
 * the surface would otherwise assert on the strength of prose:
 *
 *   1. **Direct authoring never renders as outstanding work.** ADR-0037 §6 makes
 *      authoring write THROUGH the proposal table — a `human`-sourced row decided
 *      `approved` in the SAME transaction — so the row exists. Only a real
 *      `authorAliasEdge` run produces that shape; a fixture would just be the
 *      filter restated.
 *   2. **An entity-position proposal is withheld from a reader who cannot see a
 *      fact on EACH side**, with a positive control and a one-sided control. The
 *      rule is re-derived from `brain_facts` through #5087's seam, so it is a
 *      claim about a join against real grants.
 *   3. **The evidence agrees with the producer's own gate.** The queue re-derives
 *      the agreeing-subject count because migration 0190 stores none, and
 *      `correctionEvidenceSql` is a declared second spelling of
 *      `CORRECTION_REPEAT_COUNT_SQL`'s predicate. Both are run here against ONE
 *      corpus and compared, which is what bounds the copy.
 *   4. **An undirected proposal stays undirected on the wire.** `directed` is a
 *      column, and the whole direction AC rests on `null` reaching the client.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import {
  ALIAS_PROPOSAL_REPEAT_THRESHOLD,
  ALIAS_PROPOSAL_SQL,
} from "@atlas/api/lib/brain/alias-proposal";
import { CORRECTION_REPEAT_COUNT_SQL } from "@atlas/api/lib/brain/cardinality";
import { HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";
import { authorAliasEdge, proposeAliasEdge } from "@atlas/api/lib/brain/vocabulary-decide";
import { loadPendingQueue } from "@atlas/api/lib/brain/vocabulary-pending";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-pending-5088";

describeIfPg("the Pending queue against a real schema (#5088)", () => {
  let pool: Pool;
  const schemaName = `brain_5088_pending_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let priorDatabaseUrl: string | undefined;

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
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_vocabulary_proposal");
    await pool.query("DELETE FROM brain_predicate_cardinality");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
  });

  // ── principals ──────────────────────────────────────────────────────────
  //
  // ⚠️ Every grant below is a NARROW `audience:` token, never `org`.
  // `ORG_PRINCIPAL` matches every member of the workspace, so a fixture granted
  // `['org']` makes the entity-position control vacuous — and the control is the
  // whole point of test 2.

  const owner = (): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-owner",
    role: "owner",
    audienceIds: ["eng", "sales"],
  });

  /** Sees `eng` only — the ONE-SIDED control. */
  const engOnly = (): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-eng",
    // ⚠️ `member`, not `admin`: an entitled admin takes `aclVisibilityClause`'s
    // `audit-override` arm (workspace containment only) and sees everything, so
    // an admin control proves nothing about the grant join.
    role: "member",
    audienceIds: ["eng"],
  });

  /** Sees nothing — the NEGATIVE control. */
  const stranger = (): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-stranger",
    role: "member",
    audienceIds: [],
  });

  let episodeSeq = 0;
  async function seedEpisode(visibleTo: readonly string[]): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const sourceId = `C01:5088pend.${episodeSeq++}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'evidence', $3::timestamptz, $4::text[])
       RETURNING id`,
      [WS, sourceId, occurredAt.toISOString(), visibleTo],
    );
    return {
      id: rows[0]!.id,
      workspaceId: WS,
      source: "slack",
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: [...visibleTo],
    };
  }

  async function land(
    claim: { subject: string; predicate: string; object: string },
    visibleTo: readonly string[] = ["audience:eng"],
  ): Promise<void> {
    const episode = await seedEpisode(visibleTo);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [{ ...claim, predicateCardinality: "multi" }],
      producer: "pending-5088",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    expect(
      report.outcomes[0],
      `"${claim.subject} ${claim.predicate} ${claim.object}" was refused, not landed`,
    ).not.toMatchObject({ kind: "blocked" });
  }

  // ── 1. direct authoring is not outstanding work ──────────────────────────

  it("⚠️ EXCLUDES a row proposed and decided in one transaction", async () => {
    // Direct authoring writes THROUGH the proposal table (ADR-0037 §6), so the
    // row is real and its `reviewed_at` is set in the same commit. If the queue
    // filtered on anything but `status`, a human's own completed authoring would
    // sit in the review queue forever, and every approver would see work that
    // was already done.
    await land({ subject: "widget", predicate: "is priced at", object: "10 USD" });
    await land({ subject: "widget", predicate: "priced at", object: "10 USD" });

    const authored = await authorAliasEdge(
      WS,
      { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
      owner(),
    );
    expect(authored.kind, JSON.stringify(authored)).toBe("authored");

    // The row EXISTS — the exclusion has to be doing work rather than describing
    // an empty table.
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM brain_vocabulary_proposal WHERE workspace_id = $1`,
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("approved");

    const queue = await loadPendingQueue(pool, owner());
    expect(queue.entries).toHaveLength(0);
    // ...and the workspace-wide total agrees, so the empty list is not merely a
    // scoping accident.
    const predicateCounts = queue.aliasCounts.find((c) => c.position === "predicate")!;
    expect(predicateCounts.total).toBe(0);
    expect(predicateCounts.withheld).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  it("POSITIVE CONTROL — an undecided proposal for the same pair IS listed", async () => {
    // Without this, a queue that returned nothing at all would satisfy the test
    // above.
    await land({ subject: "widget", predicate: "is priced at", object: "10 USD" });
    await land({ subject: "widget", predicate: "priced at", object: "10 USD" });
    const queued = await proposeAliasEdge(WS, {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
      directed: false,
      sourceClass: "seam",
      confidence: 0.67,
      proposedBy: "brain:alias-proposal",
    });
    expect(queued.kind).toBe("queued");

    const queue = await loadPendingQueue(pool, owner());
    expect(queue.entries).toHaveLength(1);
    const entry = queue.entries[0]!;
    expect(entry.kind).toBe("alias");
    if (entry.kind !== "alias") throw new Error("unreachable");
    // ⚠️ THE direction AC, at the wire boundary: an undirected proposal reaches
    // the client with NO direction, so a renderer has nothing to prefill from.
    // The seam's own refusal is the second statement of the same rule; this is
    // the one a UI can violate without the server ever seeing it.
    expect(entry.direction).toBeNull();
    expect(entry.pair).toEqual(["is priced at", "priced at"]);
  }, PG_TEST_TIMEOUT_MS);

  // ── 2. positional visibility, imported from #5087's seam ────────────────

  it("⚠️ withholds an ENTITY-position proposal from a reader who cannot see BOTH sides", async () => {
    // Two entity surfaces, each evidenced only inside its own audience.
    await land({ subject: "Project Atlas", predicate: "codename is", object: "x" }, [
      "audience:eng",
    ]);
    await land({ subject: "Nova", predicate: "codename is", object: "y" }, ["audience:sales"]);
    await proposeAliasEdge(WS, {
      position: "subject",
      fromNorm: "project atlas",
      toNorm: "nova",
      directed: false,
      sourceClass: "extractor",
      confidence: 0.5,
      proposedBy: "extractor",
    });

    // POSITIVE CONTROL — a reader on both sides sees it.
    const seen = await loadPendingQueue(pool, owner());
    expect(seen.entries.map((e) => e.kind)).toEqual(["alias"]);

    // ONE-SIDED — `eng` can read `Project Atlas` and not `Nova`. The rule is
    // *"a fact on EACH side"*, and this is the control that catches a join
    // written as `OR` or applied to one norm only, which is the half of the rule
    // #5087's seam says is most likely to be dropped in a copy.
    const oneSided = await loadPendingQueue(pool, engOnly());
    expect(oneSided.entries).toHaveLength(0);
    const oneSidedCounts = oneSided.aliasCounts.find((c) => c.position === "subject")!;
    expect(oneSidedCounts.total, "the SIZE of the vocabulary is not a secret").toBe(1);
    expect(oneSidedCounts.withheld, "a withheld count, never a silent omission").toBe(1);
    expect(oneSidedCounts.decision).toBe("reader-scoped");

    // NEGATIVE — no grants at all.
    const none = await loadPendingQueue(pool, stranger());
    expect(none.entries).toHaveLength(0);
    expect(none.aliasCounts.find((c) => c.position === "subject")!.withheld).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("a PREDICATE-position proposal is unscoped — a verb phrase discloses nothing", async () => {
    // The other arm of the same rule, and the one that keeps #5000's own entry
    // visible for the prod verification the arc closes on.
    await land({ subject: "widget", predicate: "is priced at", object: "10 USD" }, [
      "audience:eng",
    ]);
    await land({ subject: "widget", predicate: "priced at", object: "10 USD" }, ["audience:eng"]);
    await proposeAliasEdge(WS, {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
      directed: false,
      sourceClass: "seam",
      confidence: 0.67,
      proposedBy: "brain:alias-proposal",
    });

    const queue = await loadPendingQueue(pool, stranger());
    expect(queue.entries, "a reader with no grants still sees predicate proposals").toHaveLength(1);
    expect(queue.aliasCounts.find((c) => c.position === "predicate")!.withheld).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // ── 3. the evidence agrees with the producer's own gate ─────────────────

  it("⚠️ the re-derived agreeing-subject count equals ALIAS_PROPOSAL_SQL's own", async () => {
    // The queue re-derives this because 0190 stores no evidence columns. Running
    // the producer's OWN statement against the same corpus is what bounds the
    // re-derivation: if the two ever disagree, an approver reads a number that
    // is not the one the gate applied.
    for (const [subject, price] of [
      ["widget", "10 USD"],
      ["gadget", "20 USD"],
      ["doohickey", "30 USD"],
    ] as const) {
      await land({ subject, predicate: "is priced at", object: price });
      await land({ subject, predicate: "priced at", object: price });
    }
    await proposeAliasEdge(WS, {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
      directed: false,
      sourceClass: "seam",
      confidence: 0.75,
      proposedBy: "brain:alias-proposal",
    });

    const { rows } = await pool.query<{ from_norm: string; to_norm: string; subjects: number }>(
      ALIAS_PROPOSAL_SQL,
      [WS, ALIAS_PROPOSAL_REPEAT_THRESHOLD, 25],
    );
    const producer = rows.find(
      (r) => r.from_norm === "is priced at" && r.to_norm === "priced at",
    );
    expect(producer, "the fixture must reach the producer's own gate, or this is vacuous")
      .toBeDefined();
    expect(producer!.subjects).toBe(3);

    const queue = await loadPendingQueue(pool, owner());
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias") throw new Error("expected the alias entry");
    expect(entry.evidence.kind).toBe("structural");
    if (entry.evidence.kind !== "structural") throw new Error("unreachable");
    expect(entry.evidence.subjects).toBe(producer!.subjects);
    expect(entry.evidence.threshold).toBe(ALIAS_PROPOSAL_REPEAT_THRESHOLD);
    // *What* agreed, bounded and reader-scoped. A count alone gives magnitude
    // and not kind, which is the AC the sample exists for.
    expect(entry.evidence.examples.length).toBeGreaterThan(0);
    expect(entry.evidence.examples[0]!.object).toContain("USD");
    expect(entry.evidence.countsConsistent).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("⚠️ an ENTITY-position proposal reports its evidence as UNASKABLE, not as zero", async () => {
    // The structural producer holds two claims in one SUBJECT slot and compares
    // their predicates, so at an entity position the agreement question cannot be
    // asked. `subjects: 0` would report a warehouse-key proposal as unsupported
    // when its support is a primary key — the same "0 and cannot-be-non-zero are
    // opposite facts" the object-position radius exists for.
    await land({ subject: "Project Atlas", predicate: "codename is", object: "x" }, [
      "audience:eng",
    ]);
    await land({ subject: "Nova", predicate: "codename is", object: "y" }, ["audience:eng"]);
    await proposeAliasEdge(WS, {
      position: "subject",
      fromNorm: "project atlas",
      toNorm: "nova",
      directed: true,
      sourceClass: "warehouse_key",
      confidence: 1,
      proposedBy: "warehouse",
    });

    const queue = await loadPendingQueue(pool, owner());
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias") throw new Error("expected the alias entry");
    expect(entry.evidence.kind).toBe("not-applicable");
    if (entry.evidence.kind !== "not-applicable") throw new Error("unreachable");
    expect(entry.evidence.reason).toBe("entity-position");
    // ...and a DIRECTED proposal does carry its direction, so the picker can grey
    // the alternative rather than offering it.
    expect(entry.direction).toEqual({ fromNorm: "project atlas", toNorm: "nova" });
  }, PG_TEST_TIMEOUT_MS);

  it("⚠️ the correction evidence agrees with CORRECTION_REPEAT_COUNT_SQL", async () => {
    // `correctionEvidenceSql` is a DECLARED second spelling of that statement's
    // predicate — it cannot be spliced verbatim, because it has to correlate on
    // `c.predicate_key` and project three columns plus a sample. The copy is
    // bounded by running both against one corpus and comparing, which is what
    // stops it drifting into a number no gate reads.
    const seq: [string, string, string][] = [
      ["widget", "10", "20"],
      ["gadget", "30", "40"],
      ["doohickey", "50", "60"],
    ];
    for (const [subject, before, after] of seq) {
      await land({ subject, predicate: "headcount is", object: before }, ["audience:eng"]);
      await land({ subject, predicate: "headcount is", object: after }, ["audience:eng"]);
      // The correction's own shape: a `supersedes` edge whose replacement came
      // from a HUMAN episode. Written directly — `correction.ts`'s verb is its
      // own test, and this file's claim is about the two COUNTS agreeing.
      const { rows } = await pool.query<{ id: string; object: string }>(
        `SELECT id::text AS id, object FROM brain_facts
          WHERE workspace_id = $1 AND subject = $2 ORDER BY ingested_at`,
        [WS, subject],
      );
      expect(rows).toHaveLength(2);
      const episode = await seedEpisode(["audience:eng"]);
      await pool.query(
        `UPDATE brain_episodes SET source = $2 WHERE id = $1::uuid`,
        [episode.id, HUMAN_SOURCE],
      );
      await pool.query(
        `UPDATE brain_facts SET source_episode_id = $2::uuid WHERE id = $1::uuid`,
        [rows[1]!.id, episode.id],
      );
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
         VALUES ($1, 'supersedes', $2::uuid, $3::uuid)`,
        [WS, rows[1]!.id, rows[0]!.id],
      );
    }

    await pool.query(
      `INSERT INTO brain_predicate_cardinality
         (workspace_id, predicate_key, cardinality, status, source_class, proposed_by)
       VALUES ($1, 'headcount is', 'single', 'pending', 'correction_event',
               'brain:correction-event-cardinality')`,
      [WS],
    );

    const { rows: gate } = await pool.query<{ n: number }>(CORRECTION_REPEAT_COUNT_SQL, [
      WS,
      "headcount is",
      HUMAN_SOURCE,
    ]);
    expect(gate[0]!.n, "the fixture must reach the gate, or this is vacuous").toBe(3);

    const queue = await loadPendingQueue(pool, owner());
    const entry = queue.entries.find((e) => e.kind === "cardinality");
    expect(entry, "the cardinality proposal must be listed").toBeDefined();
    if (entry === undefined || entry.kind !== "cardinality") throw new Error("unreachable");
    expect(entry.evidence.subjects).toBe(gate[0]!.n);
    // ⚠️ The SECOND number, and the reason it exists: the gate counts distinct
    // SUBJECTS, so `events` is what makes "and links to them" possible. One
    // correction per subject here, so they coincide — which is exactly why the
    // assertion below has to name both rather than one standing in for the other.
    expect(entry.evidence.events).toBe(3);
    expect(entry.evidence.examples).toHaveLength(3);
    expect(entry.evidence.examples[0]!.fromObject).not.toBe(
      entry.evidence.examples[0]!.toObject,
    );
    expect(entry.predicateSurface).toBe("headcount is");
    expect(entry.decidable).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("ONE list — both kinds, interleaved by age rather than stacked by kind", async () => {
    // The AC's *shared: the list and the ordering*. Two lists rendered one after
    // the other would satisfy every other assertion in this file.
    await land({ subject: "widget", predicate: "is priced at", object: "10 USD" });
    await land({ subject: "widget", predicate: "priced at", object: "10 USD" });
    await pool.query(
      `INSERT INTO brain_predicate_cardinality
         (workspace_id, predicate_key, cardinality, status, source_class, proposed_by, proposed_at)
       VALUES ($1, 'is priced at', 'single', 'pending', 'correction_event', 'producer',
               now() - interval '1 day')`,
      [WS],
    );
    await proposeAliasEdge(WS, {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
      directed: false,
      sourceClass: "seam",
      confidence: 0.67,
      proposedBy: "brain:alias-proposal",
    });

    const queue = await loadPendingQueue(pool, owner());
    expect(queue.entries.map((e) => e.kind)).toEqual(["alias", "cardinality"]);

    // The SHARED filters narrow the one list rather than switching between two.
    const aliasesOnly = await loadPendingQueue(pool, owner(), { kind: "alias" });
    expect(aliasesOnly.entries.map((e) => e.kind)).toEqual(["alias"]);
    const cardinalityOnly = await loadPendingQueue(pool, owner(), { kind: "cardinality" });
    expect(cardinalityOnly.entries.map((e) => e.kind)).toEqual(["cardinality"]);
  }, PG_TEST_TIMEOUT_MS);
});
