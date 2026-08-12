/**
 * The admin-triggered tension sweep, against a real Postgres (#5029,
 * ADR-0037 §7, T7 target (d)).
 *
 * ## Why none of this can live in a double
 *
 * Every property below is a property of ONE statement — a correlated `EXISTS`
 * against `brain_predicate_cardinality`, a `LATERAL` whose `LIMIT` applies
 * per-fact, a row comparison that orders a slot, and a `NOT EXISTS` that has to
 * match an edge from either end. A fake executor asserting those would be
 * asserting its own script, which is #5000's trap and the thing this whole map
 * exists to remove. `tension-sweep.test.ts` owns the WIRING (which lock, in what
 * order, how the report is computed, what contention returns); this file owns
 * whether the rule is true.
 *
 * ## What each block would catch
 *
 *   - **the motivating case** — two facts that already exist gain an edge after
 *     a human curates, which is the thing "re-reconcile" structurally cannot do.
 *     Without it every other assertion here is satisfiable by a build that
 *     mints nothing at all.
 *   - **TODAY's cardinality (AC 4)** — the decision the resolution left open,
 *     asserted in three states (absent, `pending`, `approved`) and with the ROW
 *     column set to the OPPOSITE value, so a build that read the extractor's
 *     per-claim guess instead fails here rather than shipping.
 *   - **`TENSION_EDGE_CAP` (AC 2)** — the fan-out bound, with more rivals
 *     available than the cap admits, so removing the `LIMIT` changes the number.
 *   - **idempotency (AC 5), in BOTH directions** — a second run mints nothing,
 *     and an edge that already exists the OTHER way round suppresses the pair.
 *     The reverse case is not hypothetical: a region import carries its origin
 *     region's `ingested_at`, so a row created after an incumbent can be older
 *     on the clock, and `reconcile.ts` will have pointed it the opposite way.
 *   - **the run cap is applied AFTER the dedupe** — driven through the exported
 *     statement with a deliberately tiny cap, because that ordering is what
 *     makes a truncated sweep CONVERGE and a build with it the other way round
 *     passes every other test in this file while never sweeping the tail.
 *   - **additive** — no fact row is written at all. The sweep is an autonomous
 *     writer, and the licence it was granted is narrow.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 *
 * ⚠️ **Two things this file needs that per-schema isolation does NOT give it.**
 *
 * **Advisory locks are DATABASE-wide, not schema-wide.** The contention test
 * holds namespace 4771 on `hashtext('ws-5029-contended')` for a few seconds, and
 * a sibling suite sharing this scratch database would block on it if it used the
 * same workspace id. Every workspace name here is prefixed `ws-5029-`, which is
 * what keeps that true; do not drop the prefix.
 *
 * **`seedFact` USED TO write `brain_facts.predicate_cardinality`**, as the
 * AC-4 falsifier's opposite value — the point being that the sweep must ignore
 * it. [#5028](https://github.com/AtlasDevHQ/atlas/issues/5028) phase 2 dropped
 * the column (migration 0195), so that fixture is gone and the property it
 * guarded is now STRUCTURAL: the sweep cannot read a per-row guess that does
 * not exist. The AC-4 tests below keep their assertions — mint only on a
 * CURATED predicate — but they no longer discriminate between "reads the row"
 * and "reads the vocabulary", because only one of those is still expressible.
 * That is what a completed two-phase drop looks like: the guard graduates from
 * a test fixture into the schema.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import { comparableValue } from "@atlas/api/lib/brain/object-cmp";
import {
  declarePredicateCardinality,
  proposePredicateCardinality,
} from "@atlas/api/lib/brain/cardinality";
import {
  RECONCILE_LOCK_NAMESPACE,
  RECONCILE_LOCK_SQL,
  TENSION_EDGE_CAP,
} from "@atlas/api/lib/brain/reconcile";
import {
  TENSION_SWEEP_RUN_CAP,
  TENSION_SWEEP_SQL,
  contentionMessage,
  sweepTensionEdges,
} from "@atlas/api/lib/brain/tension-sweep";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("the admin-triggered tension sweep (#5029)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5029_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedEpisode(workspaceId: string, sourceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'evidence', now(), ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId],
    );
    return rows[0]!.id;
  }

  /**
   * A stored fact, inserted directly.
   *
   * There is no per-row cardinality knob any more: #5028 phase 2 dropped
   * `brain_facts.predicate_cardinality`, so the OPPOSITE-of-the-vocabulary
   * fixture the "today's cardinality" block used as its falsifier is no longer
   * expressible. Cardinality reaches the sweep only through `curate()` below.
   *
   * `ingestedAt` is explicit because the sweep's pair DIRECTION is a total
   * order on `(ingested_at, id)`, so a fixture that let every row default to
   * `now()` would be asserting against whatever order the inserts happened to
   * commit in.
   */
  async function seedFact(
    workspaceId: string,
    episodeId: string,
    claim: { subject: string; predicate: string; object: string },
    opts: {
      ingestedAt: string;
      status?: "draft" | "published";
      invalidated?: boolean;
      validTo?: string | null;
      /**
       * The resolver's verdict at the SUBJECT position — `entity:<id>`, or NULL
       * for the abstain every fact in this file carries unless it says
       * otherwise. Threaded because the `subject_cmp` suppression arm is
       * INERT against a fixture that leaves it NULL on both sides, and an
       * always-NULL column is exactly the accidental equality that makes an
       * assertion pass over machinery that was deleted.
       */
      subjectCmp?: string | null;
    },
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          visible_to, status, ingested_at, invalidated_at, valid_to,
          subject_key, predicate_key, object_key, object_cmp, subject_cmp)
       VALUES ($1, $2, $3, $4, $5, '{"source":"slack","actor":"test"}'::jsonb, ARRAY['org'],
               $6, $7::timestamptz, $8, $9::timestamptz, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        workspaceId,
        claim.subject,
        claim.predicate,
        claim.object,
        episodeId,
        opts.status ?? "published",
        opts.ingestedAt,
        opts.invalidated === true ? new Date().toISOString() : null,
        opts.validTo ?? null,
        slotKey(claim.subject, identityAlias),
        slotKey(claim.predicate, identityAlias),
        slotKey(claim.object, identityAlias),
        comparableValue({ surface: claim.object }),
        opts.subjectCmp ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /** Curate a canonical predicate through the shipped door, never a raw INSERT. */
  async function curate(
    workspaceId: string,
    predicate: string,
    cardinality: "single" | "multi",
  ): Promise<void> {
    const result = await declarePredicateCardinality(pool, workspaceId, {
      predicateKey: slotKey(predicate, identityAlias),
      cardinality,
      authoredBy: "curator-1",
    });
    expect(result.ok, `curating "${predicate}" failed — the assertions below are vacuous`).toBe(
      true,
    );
  }

  /** Every `in-tension-with` edge in a workspace, as unordered pairs. */
  async function edgePairs(workspaceId: string): Promise<{ from: string; to: string }[]> {
    const { rows } = await pool.query<{ from_fact_id: string; to_fact_id: string }>(
      `SELECT from_fact_id::text AS from_fact_id, to_fact_id::text AS to_fact_id
         FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'
        ORDER BY from_fact_id, to_fact_id`,
      [workspaceId],
    );
    return rows.map((r) => ({ from: r.from_fact_id, to: r.to_fact_id }));
  }

  async function outboundEdgeCount(workspaceId: string, factId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with' AND from_fact_id = $2`,
      [workspaceId, factId],
    );
    return Number(rows[0]!.n);
  }

  /** `sweepTensionEdges`, with the outcome narrowed to the arm every test wants. */
  async function sweep(workspaceId: string): Promise<{ minted: number; truncated: boolean }> {
    const outcome = await sweepTensionEdges(workspaceId);
    // Narrowed rather than `as`: an uncontended sweep is the premise of every
    // assertion below, and a contended one would otherwise report `minted: 0`
    // through a property read on the wrong arm.
    expect(outcome.kind, "the sweep reported lock contention — no assertion below is meaningful").toBe(
      "swept",
    );
    if (outcome.kind !== "swept") throw new Error("unreachable");
    return outcome.report;
  }

  const T0 = "2026-01-01T00:00:00Z";
  const T1 = "2026-01-02T00:00:00Z";
  const T2 = "2026-01-03T00:00:00Z";

  // -------------------------------------------------------------------------
  // The motivating case
  // -------------------------------------------------------------------------

  describe("it reaches rows the ingest path structurally cannot", () => {
    it(
      "mints an edge between two facts that already existed when the predicate was curated",
      async () => {
        // Exactly #5000's shape: two live claims in one slot, differing objects,
        // both written long before anybody decided the predicate holds one
        // value. Replaying `reconcileFacts` over either corroborates it against
        // ITSELF and returns before the tension pass, so nothing in the ingest
        // path can ever produce this edge. That is the whole reason this module
        // exists, and asserting it first is what stops the rest of this file
        // being satisfied by a build that mints nothing.
        const ws = "ws-5029-motivating";
        const ep = await seedEpisode(ws, "motivating");
        const older = await seedFact(
          ws,
          ep,
          { subject: "business tier", predicate: "priced at", object: "499 USD" },
          { ingestedAt: T0 },
        );
        const newer = await seedFact(
          ws,
          ep,
          { subject: "business tier", predicate: "priced at", object: "599 USD" },
          { ingestedAt: T1 },
        );

        expect(
          await edgePairs(ws),
          "the fixture already carries a tension edge — the sweep's effect below is not measurable",
        ).toEqual([]);

        await curate(ws, "priced at", "single");
        const report = await sweep(ws);

        expect(report.minted).toBe(1);
        expect(report.truncated).toBe(false);
        // The DIRECTION is asserted, not just the count: the newer claim points
        // at the incumbent, which is `reconcile.ts`' own rule replayed. A build
        // that generated the pair the other way round would still mint one edge
        // and would disagree with every edge the ingest path has ever written.
        expect(await edgePairs(ws)).toEqual([{ from: newer, to: older }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "writes nothing to any fact row — the licence is additive",
      async () => {
        // The sweep is the second autonomous writer of `brain_edges`, and what
        // makes that acceptable is that it cannot reach `brain_facts` at all.
        // A snapshot of every mutable column, before and after, is the only
        // assertion that survives someone "helpfully" stamping `updated_at` or
        // flipping a status to mark a row swept.
        const ws = "ws-5029-additive";
        const ep = await seedEpisode(ws, "additive");
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "led by", object: "alice" },
          { ingestedAt: T0 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "led by", object: "bob" },
          { ingestedAt: T1 },
        );
        await curate(ws, "led by", "single");

        // EVERY column, via `to_jsonb`, rather than the seven a hand-written list
        // remembered. The list version claimed "every mutable column" and omitted
        // `visible_to` — an ACL widening, which is the silent write that would
        // matter most here — along with both `_cmp` columns, all three keys,
        // `valid_from`, and `pre_widening_visible_to`. `- 'fts'` drops the
        // generated tsvector, whose `pg` text rendering is not stable enough to
        // diff.
        const snapshot = async () =>
          (
            await pool.query(
              `SELECT id::text AS id, to_jsonb(f) - 'fts' AS row
                 FROM brain_facts f WHERE workspace_id = $1 ORDER BY id`,
              [ws],
            )
          ).rows;
        const before = await snapshot();
        expect(await sweep(ws)).toEqual({ minted: 1, truncated: false });

        expect(
          await snapshot(),
          "the sweep changed a fact row — it is licensed to write `brain_edges` and nothing else",
        ).toEqual(before);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "pairs only rows in the SAME slot — two subjects and two predicates, interleaved",
      async () => {
        // ⚠️ THE SLOT JOIN, and until this fixture existed BOTH of its arms were
        // inert: deleting `b.subject_key = a.subject_key` or
        // `b.predicate_key = a.predicate_key` left all 19 tests green. Measured,
        // not suspected.
        //
        // Why the rest of this file cannot see it. Every other workspace here
        // holds exactly ONE predicate, so the predicate arm can never bite. And
        // the only other two-subject fixture (`ws-5029-per-fact`) gives its two
        // subjects DISJOINT time windows, so the direction arm
        // `(b.ingested_at, b.id) < (a.ingested_at, a.id)` hides the missing
        // subject arm by itself — the older subject's rows are never "older" than
        // the newer subject's in a way that changes either outbound count.
        //
        // So this fixture does the two things that break both hiding mechanisms:
        // two subjects AND two predicates, with the four rows' timestamps
        // INTERLEAVED across both axes, and it asserts the COMPLETE edge set
        // rather than per-fact outbound counts. Without the arms the sweep wires
        // `acme priced at` to `acme hq in` — an advisory contradiction between
        // two claims that are not about the same thing, surfaced to every
        // reviewer by `loadTensionClusters`.
        // ⚠️ THE GRID IS FULL, and a partial one does not work — measured. A
        // first cut gave `acme` the predicate `priced at` and `globex` the
        // predicate `hq in`, so dropping the SUBJECT arm changed nothing: the
        // predicate arm still excluded every cross pair on its own, and the
        // mutant survived. Each arm can only be falsified by pairs the OTHER arm
        // would admit, so both subjects must carry both predicates.
        //
        // 2 subjects × 2 predicates × 2 rows = 8 rows, interleaved so every
        // cross pair is direction-eligible and only the slot arms exclude it.
        const ws = "ws-5029-slot-join";
        const ep = await seedEpisode(ws, "slot-join");
        const id: Record<string, string> = {};
        let tick = 0;
        for (const object of ["first", "second"]) {
          for (const subject of ["acme", "globex"]) {
            for (const predicate of ["priced at", "hq in"]) {
              tick += 1;
              id[`${subject}|${predicate}|${object}`] = await seedFact(
                ws,
                ep,
                { subject, predicate, object: `${subject} ${predicate} ${object}` },
                { ingestedAt: `2026-05-01T00:00:${String(tick).padStart(2, "0")}Z` },
              );
            }
          }
        }
        // BOTH predicates curated, so neither arm is doing the excluding by
        // being uncurated — the slot join is the only thing left.
        await curate(ws, "priced at", "single");
        await curate(ws, "hq in", "single");

        // Exactly FOUR edges — one per (subject, predicate) slot. Of the 28
        // ordered pairs among 8 rows, 4 are same-slot and the other 24 cross a
        // subject, a predicate, or both. `4` is not the row count (8), not the
        // eligible-pair count (28), and not the count of either axis (2), so no
        // arithmetic coincidence produces it.
        const report = await sweep(ws);
        expect(
          report.minted,
          "the sweep did not mint exactly one edge per slot — with a full 2x2 subject x predicate grid, a count above 4 means the subject arm, the predicate arm, or both are gone, and unrelated claims are being wired as contradictions",
        ).toBe(4);

        // …and WHICH pairs, because a build that dropped one real edge and added
        // one cross-slot edge also totals 4.
        const pairs = await edgePairs(ws);
        expect(pairs.map((p) => `${p.from}->${p.to}`).sort()).toEqual(
          ["acme", "globex"]
            .flatMap((subject) =>
              ["priced at", "hq in"].map(
                (predicate) =>
                  `${id[`${subject}|${predicate}|second`]}->${id[`${subject}|${predicate}|first`]}`,
              ),
            )
            .sort(),
        );
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "stays inside the workspace it was asked about",
      async () => {
        // Two workspaces holding the IDENTICAL slot, both curated, one swept.
        // Identical rather than merely different, because a `workspace_id` arm
        // dropped from the candidate scan would still produce the right count
        // when the other tenant's claims happen not to collide.
        const swept = "ws-5029-scoped-a";
        const untouched = "ws-5029-scoped-b";
        for (const ws of [swept, untouched]) {
          const ep = await seedEpisode(ws, `scoped-${ws}`);
          await seedFact(
            ws,
            ep,
            { subject: "acme", predicate: "hq in", object: "berlin" },
            { ingestedAt: T0 },
          );
          await seedFact(
            ws,
            ep,
            { subject: "acme", predicate: "hq in", object: "lisbon" },
            { ingestedAt: T1 },
          );
          await curate(ws, "hq in", "single");
        }

        expect(await sweep(swept)).toEqual({ minted: 1, truncated: false });
        expect(await edgePairs(swept)).toHaveLength(1);
        expect(
          await edgePairs(untouched),
          "the sweep minted an edge in a workspace it was not asked about",
        ).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // AC 4 — TODAY's vocabulary cardinality, not the value at write time
  // -------------------------------------------------------------------------

  describe("it reads TODAY's approved cardinality (AC 4)", () => {
    /**
     * One slot, three vocabulary states, one fixture.
     *
     * ⚠️ Both rows USED to carry `predicate_cardinality = 'single'` — the
     * extractor's per-claim guess, deliberately opposite to the vocabulary in
     * the first two states, so that a build sweeping on the row column would
     * mint in all three and be caught. #5028 phase 2 dropped that column, so
     * the opposite value is no longer expressible and the name went with it.
     * These tests now assert the surviving half: minting follows the CURATED
     * predicate and nothing else.
     */
    async function slotWithUncuratedPredicate(ws: string) {
      const ep = await seedEpisode(ws, `today-${ws}`);
      await seedFact(
        ws,
        ep,
        { subject: "starter tier", predicate: "priced at", object: "19 USD" },
        { ingestedAt: T0 },
      );
      await seedFact(
        ws,
        ep,
        { subject: "starter tier", predicate: "priced at", object: "29 USD" },
        { ingestedAt: T1 },
      );
    }

    it(
      "mints nothing when the predicate is UNCURATED, however the extractor guessed",
      async () => {
        const ws = "ws-5029-today-absent";
        await slotWithUncuratedPredicate(ws);

        expect(
          await sweep(ws),
          "the sweep minted against an UNCURATED predicate. Since #5028 phase 2 there is no per-row cardinality left to read, so this can only mean the vocabulary lookup itself stopped gating.",
        ).toEqual({ minted: 0, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "mints nothing on a PENDING proposal — a proposal is not a decision",
      async () => {
        // The arm `cardinalitySingleSql`'s docstring calls "not optional
        // decoration": dropping `status = 'approved'` lets a repeat-gated
        // heuristic arm an autonomous writer with no human in the loop. It reads
        // as a tightening in a diff and has no symptom at rest.
        const ws = "ws-5029-today-pending";
        await slotWithUncuratedPredicate(ws);
        const proposed = await proposePredicateCardinality(pool, ws, {
          predicateKey: slotKey("priced at", identityAlias),
          cardinality: "single",
          sourceClass: "correction_event",
          proposedBy: "brain:correction-event-cardinality",
        });
        expect(proposed.ok, "the fixture's proposal was refused — the assertion is vacuous").toBe(
          true,
        );

        expect(
          await sweep(ws),
          "the sweep minted against a PENDING proposal — `status = 'approved'` is gone from the live read",
        ).toEqual({ minted: 0, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "…and mints once the same predicate is APPROVED — the positive control",
      async () => {
        // Without this, both prohibitions above are satisfied by a build that
        // never mints anything, which is the failure mode ADR-0037 §9 names.
        const ws = "ws-5029-today-approved";
        await slotWithUncuratedPredicate(ws);
        expect(await sweep(ws)).toEqual({ minted: 0, truncated: false });

        await curate(ws, "priced at", "single");

        expect(
          await sweep(ws),
          "the same corpus minted nothing after approval — the sweep is not reading the vocabulary at all",
        ).toEqual({ minted: 1, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "mints nothing when a human curated the predicate `multi`",
      async () => {
        // `multi` is the adjudicated record that values coexist — the un-curation
        // verb. An `EXISTS` that checked only for a ROW rather than for
        // `cardinality = 'single'` would pass every test above and mint here.
        const ws = "ws-5029-today-multi";
        await slotWithUncuratedPredicate(ws);
        await curate(ws, "priced at", "multi");

        expect(
          await sweep(ws),
          "the sweep minted against a predicate a human declared `multi` — the live read is matching on the row's existence rather than on its value",
        ).toEqual({ minted: 0, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // AC 2 — bounded by TENSION_EDGE_CAP
  // -------------------------------------------------------------------------

  describe("it is bounded by TENSION_EDGE_CAP (AC 2)", () => {
    it(
      "gives the newest claim exactly TENSION_EDGE_CAP edges when more rivals are available",
      async () => {
        // RIVALS is derived from the cap and is deliberately larger than it, so
        // the expected number (the cap) and the available number can never be
        // accidentally equal. Removing the `LIMIT` changes 10 into 12.
        const ws = "ws-5029-cap";
        const ep = await seedEpisode(ws, "cap");
        const RIVALS = TENSION_EDGE_CAP + 2;
        for (let i = 0; i < RIVALS; i++) {
          await seedFact(
            ws,
            ep,
            { subject: "acme", predicate: "reports to", object: `manager ${i}` },
            // Distinct, ascending, and all BEFORE the newest below.
            { ingestedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` },
          );
        }
        const newest = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "reports to", object: "manager last" },
          { ingestedAt: T2 },
        );
        await curate(ws, "reports to", "single");

        await sweep(ws);

        expect(
          await outboundEdgeCount(ws, newest),
          `the newest claim earned a fan-out other than TENSION_EDGE_CAP (${TENSION_EDGE_CAP}) with ${RIVALS} rivals available — the LATERAL's per-fact LIMIT is gone`,
        ).toBe(TENSION_EDGE_CAP);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "applies the cap PER FACT, not once across the run",
      async () => {
        // Two slots, each with more rivals than one fact may point at. A single
        // run-wide `LIMIT` (the obvious way to write this without a LATERAL)
        // would trim the second slot to nothing instead of trimming each slot's
        // fan-out — and the total would still look "bounded".
        //
        // The two slots are given DIFFERENT sizes so a build that swept one and
        // reported the other's number cannot pass: `left` has one rival, `right`
        // has TENSION_EDGE_CAP + 1.
        const ws = "ws-5029-per-fact";
        const ep = await seedEpisode(ws, "per-fact");
        await seedFact(
          ws,
          ep,
          { subject: "left", predicate: "owned by", object: "alice" },
          { ingestedAt: T0 },
        );
        const leftNewest = await seedFact(
          ws,
          ep,
          { subject: "left", predicate: "owned by", object: "bob" },
          { ingestedAt: T1 },
        );
        for (let i = 0; i <= TENSION_EDGE_CAP; i++) {
          await seedFact(
            ws,
            ep,
            { subject: "right", predicate: "owned by", object: `owner ${i}` },
            { ingestedAt: `2026-02-01T00:00:${String(i).padStart(2, "0")}Z` },
          );
        }
        const rightNewest = await seedFact(
          ws,
          ep,
          { subject: "right", predicate: "owned by", object: "owner last" },
          // AFTER the `2026-02-…` rivals above, not `T2` — the direction arm is a
          // total order on `(ingested_at, id)`, so a "newest" stamped earlier
          // than its own slot points at nothing and the assertion below reads 0
          // for a reason that has nothing to do with the cap.
          { ingestedAt: "2026-03-01T00:00:00Z" },
        );
        await curate(ws, "owned by", "single");

        await sweep(ws);

        expect(
          await outboundEdgeCount(ws, leftNewest),
          "the small slot lost its only edge — the cap is being applied across the run rather than per fact",
        ).toBe(1);
        expect(await outboundEdgeCount(ws, rightNewest)).toBe(TENSION_EDGE_CAP);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // AC 5 — running it twice does not duplicate
  // -------------------------------------------------------------------------

  describe("running it twice does not duplicate edges (AC 5)", () => {
    it(
      "a second run mints nothing and leaves the edge set byte-identical",
      async () => {
        const ws = "ws-5029-idempotent";
        const ep = await seedEpisode(ws, "idempotent");
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "founded in", object: "2019" },
          { ingestedAt: T0 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "founded in", object: "2020" },
          { ingestedAt: T1 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "founded in", object: "2021" },
          { ingestedAt: T2 },
        );
        await curate(ws, "founded in", "single");

        // Three live rows in one slot: newest→(2), middle→(1). Three edges, and
        // three is chosen over two so an off-by-one in the direction arm shows
        // up as a wrong number rather than as a coincidence.
        const first = await sweep(ws);
        expect(first).toEqual({ minted: 3, truncated: false });
        const after = await edgePairs(ws);

        const second = await sweep(ws);
        expect(
          second,
          "the second run minted again — the `NOT EXISTS` guard is not seeing the first run's edges",
        ).toEqual({ minted: 0, truncated: false });
        expect(await edgePairs(ws)).toEqual(after);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "an existing edge in the OPPOSITE direction suppresses the pair",
      async () => {
        // The region-import case, not a hypothetical: an imported row carries
        // its origin region's `ingested_at`, so `reconcile.ts` can have wired
        // older-on-the-clock → newer-on-the-clock, which is the reverse of the
        // order this statement generates. An ordered guard reads that edge as
        // absent and mints its reciprocal — and `loadTensionClusters` walks both
        // directions, so the reviewer sees one rival listed twice.
        const ws = "ws-5029-reciprocal";
        const ep = await seedEpisode(ws, "reciprocal");
        const older = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "ships on", object: "monday" },
          { ingestedAt: T0 },
        );
        const newer = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "ships on", object: "friday" },
          { ingestedAt: T1 },
        );
        // The reverse of what the sweep would write: older → newer.
        await pool.query(
          `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
           VALUES ($1, 'in-tension-with', $2, $3)`,
          [ws, older, newer],
        );
        await curate(ws, "ships on", "single");

        // A THIRD pair carrying a `derives-from` edge instead, which must NOT
        // suppress anything. Measured inert before this: replacing
        // `e.edge_type = 'in-tension-with'` with `e.edge_type IS NOT NULL` left
        // the whole suite green, because no fixture ever put a second edge type
        // in `brain_edges`. `derives-from` is fact→fact and is written by the
        // correction path, so it genuinely co-occurs with these rows.
        const derivedFrom = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "ships to", object: "berlin" },
          { ingestedAt: T0 },
        );
        const derivedTo = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "ships to", object: "lisbon" },
          { ingestedAt: T1 },
        );
        await pool.query(
          `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
           VALUES ($1, 'derives-from', $2, $3)`,
          [ws, derivedTo, derivedFrom],
        );
        await curate(ws, "ships to", "single");

        // ONE edge minted — the `derives-from` pair — and zero for the pair that
        // already has a reciprocal. A count of 0 would mean the `edge_type` arm
        // is gone (the `derives-from` edge suppressed a real tension); a count of
        // 2 would mean the existence guard is direction-ORDERED.
        expect(
          await sweep(ws),
          "expected exactly the `derives-from` pair to be minted: 0 means an unrelated edge type suppressed a real tension, 2 means the existence guard is direction-ORDERED and this pair now appears twice in every tension cluster",
        ).toEqual({ minted: 1, truncated: false });
        expect(await edgePairs(ws)).toEqual(
          [
            { from: older, to: newer },
            { from: derivedTo, to: derivedFrom },
          ].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
        );
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // Which rows are in scope
  // -------------------------------------------------------------------------

  describe("only LIVE rows are in tension", () => {
    it(
      "skips retracted and superseded rivals, and mints for the live one",
      async () => {
        // Three rivals to one newest claim, in three states. The counts are
        // deliberately asymmetric — one live, one retracted, one superseded —
        // so an arm dropped from either side produces 2 or 3 rather than 1.
        //
        // A superseded rival is not a tension: the arbitration already happened
        // at the publish gate and the `supersedes` edge records it. A retracted
        // one is a belief a human withdrew. Wiring either would tell a reviewer
        // a live claim is contested by something already settled.
        const ws = "ws-5029-live-only";
        const ep = await seedEpisode(ws, "live-only");
        const live = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "run by", object: "alice" },
          { ingestedAt: "2026-01-01T00:00:01Z" },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "run by", object: "bob" },
          { ingestedAt: "2026-01-01T00:00:02Z", invalidated: true },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "run by", object: "carol" },
          { ingestedAt: "2026-01-01T00:00:03Z", validTo: "2026-06-01T00:00:00Z" },
        );
        const newest = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "run by", object: "dave" },
          { ingestedAt: T2 },
        );
        await curate(ws, "run by", "single");

        expect(await sweep(ws)).toEqual({ minted: 1, truncated: false });
        expect(await edgePairs(ws)).toEqual([{ from: newest, to: live }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "pairs DRAFTS as readily as published rows — status is not a filter",
      async () => {
        // ⚠️ Measured inert before this test existed: adding
        // `AND a.status = 'published'` (or the `b` twin) left all 19 tests green,
        // because every fixture in this file was published and `seedFact`'s
        // `status` knob had no call site — a parameter documenting coverage that
        // did not exist.
        //
        // Drafts are not an edge case here, they are the PRIMARY audience: the
        // route's own description sends a reviewer to the queue with
        // `?tension=true`, which is the DRAFT queue. A future "safety" narrowing
        // to published rows would delete the feature's main population and
        // nothing would go red.
        //
        // ⚠️ BOTH ORDERINGS, and one is not enough — measured. A first cut had
        // only `published@T0` + `draft@T1`, i.e. the draft on the `a` side and
        // the published row on the `b` side. Narrowing `b.status = 'published'`
        // then changed nothing and the mutant survived: the rival it kept was
        // already published. A status arm can only be falsified from the side it
        // sits on, so each side needs a slot where the DRAFT is the row that arm
        // would drop.
        const ws = "ws-5029-drafts";
        const ep = await seedEpisode(ws, "drafts");
        // Slot 1 — draft is NEWER (the `a` side).
        const pubOld = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "rated at", object: "3" },
          { ingestedAt: T0, status: "published" },
        );
        const draftNew = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "rated at", object: "4" },
          { ingestedAt: T1, status: "draft" },
        );
        // Slot 2 — draft is OLDER (the `b` side, the rival).
        const draftOld = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "scored at", object: "7" },
          { ingestedAt: T0, status: "draft" },
        );
        const pubNew = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "scored at", object: "8" },
          { ingestedAt: T1, status: "published" },
        );
        await curate(ws, "rated at", "single");
        await curate(ws, "scored at", "single");

        expect(
          await sweep(ws),
          "a draft/published pair earned no edge — a status filter crept into the scan on one side or the other, and the draft queue is exactly where these edges are read",
        ).toEqual({ minted: 2, truncated: false });
        expect(await edgePairs(ws)).toEqual(
          [
            { from: draftNew, to: pubOld },
            { from: pubNew, to: draftOld },
          ].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0)),
        );
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "mints nothing between two claims that assert the SAME object",
      async () => {
        // Corroboration's territory, and the arm that keeps the two verdicts
        // disjoint. `objectNotSameSql` inverted — or replaced with the
        // `objectSameSql(…) IS NOT TRUE` spelling its docstring refuses — turns
        // every restatement in the corpus into a contradiction.
        //
        // `Alice` vs `alice`: the surfaces DIFFER and the slot keys do not, so
        // this fails against a build comparing surfaces as well as against one
        // that inverted the arm. A byte-identical fixture could not.
        const ws = "ws-5029-same-object";
        const ep = await seedEpisode(ws, "same-object");
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "chaired by", object: "Alice" },
          { ingestedAt: T0 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "chaired by", object: "alice" },
          { ingestedAt: T1 },
        );
        await curate(ws, "chaired by", "single");

        expect(
          await sweep(ws),
          "two claims asserting the same object earned a contradiction edge",
        ).toEqual({ minted: 0, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "mints nothing when the KEYS differ but the comparable values prove sameness",
      async () => {
        // ⚠️ THE VETO CORNER, and no fixture reached it: every other pair in this
        // file is either key-equal with both `object_cmp` NULL, or key-different
        // with the values also differing. So `objectNotSameSql` could be replaced
        // by the naive `b.object_key <> a.object_key` — the obvious
        // "simplification", and exactly the second-spelling drift the module
        // header calls the property to preserve — and all 21 tests passed.
        // Deleting the builder is caught; REPLACING it was not.
        //
        // `499 USD` and `USD 499` key differently (`499 usd` / `usd 499`) and
        // parse to the SAME `money:USD:499`. Two live claims spelled two ways are
        // not a contradiction, and this is the sweep's highest-volume exposure:
        // it runs corpus-wide over rows the ingest path already declined to look
        // at, so "the same number spelled differently" is precisely the
        // population it meets at scale — each false hit a permanent advisory
        // contradiction a reviewer has to dismiss.
        const ws = "ws-5029-veto";
        const ep = await seedEpisode(ws, "veto");
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "invoiced at", object: "499 USD" },
          { ingestedAt: T0 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "invoiced at", object: "USD 499" },
          { ingestedAt: T1 },
        );
        await curate(ws, "invoiced at", "single");

        // Non-vacuity: the corner only exists if the fixture really has
        // different keys and equal comparables. Asserted, because a change to
        // `lexicalNorm` or to the money parser would quietly collapse it into an
        // ordinary same-key pair and this test would keep passing for the wrong
        // reason.
        const { rows } = await pool.query<{ keys: string; cmps: string }>(
          `SELECT count(DISTINCT object_key)::text AS keys,
                  count(DISTINCT object_cmp)::text AS cmps
             FROM brain_facts WHERE workspace_id = $1`,
          [ws],
        );
        expect(
          { keys: rows[0]!.keys, cmps: rows[0]!.cmps },
          "the fixture is no longer different-key/same-comparable, so it does not reach the veto arm",
        ).toEqual({ keys: "2", cmps: "1" });

        expect(
          await sweep(ws),
          "two spellings of the same amount earned a contradiction edge — the object arm has been reduced to a key comparison, which the module header names as the drift to prevent",
        ).toEqual({ minted: 0, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "still pairs a rival whose subject the resolver answered for on ONE side only",
      async () => {
        // `subjectNotDifferentSql` is `comparableDifferentSql(...) IS NOT TRUE`,
        // so one side resolved and the other abstaining must be ADMITTED — a
        // partially-resolved corpus is the common state, not an edge case.
        //
        // Unreached before this: every fixture was both-NULL or both-non-null.
        // The natural mis-spelling — `(both NULL) OR a = b` — passes the whole
        // suite while silently deleting every mixed pair, in the under-match
        // direction that reports nothing.
        const ws = "ws-5029-subject-mixed";
        const ep = await seedEpisode(ws, "subject-mixed");
        const resolved = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "audited by", object: "firm a" },
          { ingestedAt: T0, subjectCmp: "entity:01J0000000000000000000ACME1" },
        );
        const abstained = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "audited by", object: "firm b" },
          { ingestedAt: T1, subjectCmp: null },
        );
        await curate(ws, "audited by", "single");

        expect(
          await sweep(ws),
          "a pair whose subject was resolved on one side and abstained on the other earned no edge — the suppression arm has become an equality test, and a partially-resolved corpus loses every mixed pair silently",
        ).toEqual({ minted: 1, truncated: false });
        expect(await edgePairs(ws)).toEqual([{ from: abstained, to: resolved }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "mints for the abstain band — a pair whose objects cannot be compared",
      async () => {
        // Where the whole `unknown` band lands (ADR-0037 §2): corroboration
        // fires on *same*, supersession on *different*, and everything in
        // between falls to the tension edge and nothing else. Two unparseable
        // objects have NULL `object_cmp` on both sides, so only the KEY arm can
        // separate them — and a build that required positive proof of
        // difference here would leave the band with no consumer at all.
        const ws = "ws-5029-abstain";
        const ep = await seedEpisode(ws, "abstain");
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "advised by", object: "the north office" },
          { ingestedAt: T0 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "advised by", object: "the south office" },
          { ingestedAt: T1 },
        );
        await curate(ws, "advised by", "single");

        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM brain_facts
            WHERE workspace_id = $1 AND object_cmp IS NOT NULL`,
          [ws],
        );
        expect(
          Number(rows[0]!.n),
          "the fixture's objects parsed to comparable values — this is no longer the abstain band and the assertion below proves nothing about it",
        ).toBe(0);

        expect(await sweep(ws)).toEqual({ minted: 1, truncated: false });
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "suppresses a rival the store has PROVEN is a different subject, and admits the one it has not",
      async () => {
        // ADR-0037 §5's named mistake, and the one arm in this statement that a
        // fixture leaving `subject_cmp` NULL cannot reach at all — measured
        // rather than assumed: dropping the arm changed nothing until this test
        // existed.
        //
        // `subject_cmp` does NOT split three ways the way `object_cmp` does. A
        // proven difference of SUBJECT removes the pair from the slot entirely
        // rather than moving it between verdicts, because minting here would
        // assert a permanent advisory contradiction between two claims about
        // demonstrably different entities — surfaced to every reviewer through
        // the tension cluster, with nothing to resolve.
        //
        // Both rivals share the SUBJECT SURFACE (`acme` — two companies of that
        // name, which is why the resolver was consulted) and therefore the same
        // `subject_key`, so only the `_cmp` arm can separate them. One rival is
        // proven-different and one is proven-SAME, and the expected count (1) is
        // not the number of rivals (2), so a dropped arm reads as 2.
        const ws = "ws-5029-subject-cmp";
        const ep = await seedEpisode(ws, "subject-cmp");
        const ACME_ONE = "entity:01J0000000000000000000ACME1";
        const ACME_TWO = "entity:01J0000000000000000000ACME2";

        const sameEntity = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "banked with", object: "first bank" },
          { ingestedAt: T0, subjectCmp: ACME_ONE },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "banked with", object: "second bank" },
          { ingestedAt: T1, subjectCmp: ACME_TWO },
        );
        const newest = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "banked with", object: "third bank" },
          { ingestedAt: T2, subjectCmp: ACME_ONE },
        );
        await curate(ws, "banked with", "single");

        expect(
          await sweep(ws),
          "a rival the store proved is a DIFFERENT subject earned a contradiction edge — `subjectNotDifferentSql` is gone, and ADR-0037 §5 names this exact mistake",
        ).toEqual({ minted: 1, truncated: false });
        // WHICH pair, not just how many: a build that suppressed the wrong
        // rival would also mint exactly one edge.
        expect(await edgePairs(ws)).toEqual([{ from: newest, to: sameEntity }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "still pairs two rivals that landed on the SAME `ingested_at`",
      async () => {
        // The id tiebreak in `(b.ingested_at, b.id) < (a.ingested_at, a.id)`,
        // and it is load-bearing rather than defensive: a bare
        // `b.ingested_at < a.ingested_at` is FALSE in both directions for a tie,
        // so the pair is generated by neither row and the edge is never minted.
        // Silent under-match — the direction that would never be noticed, since
        // nothing reports an edge that does not exist.
        //
        // Ties are ordinary, not exotic: a batch insert and a region import both
        // stamp one window's rows identically.
        const ws = "ws-5029-tie";
        const ep = await seedEpisode(ws, "tie");
        const TIED = "2026-04-01T00:00:00Z";
        const a = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "billed at", object: "77 USD" },
          { ingestedAt: TIED },
        );
        const b = await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "billed at", object: "88 USD" },
          { ingestedAt: TIED },
        );
        await curate(ws, "billed at", "single");

        expect(
          await sweep(ws),
          "two rivals sharing an `ingested_at` earned no edge — the id tiebreak is gone, so a tie is ordered in neither direction and the pair is invisible to the sweep",
        ).toEqual({ minted: 1, truncated: false });

        // ONE edge, and between these two facts — but the DIRECTION is decided
        // by the uuid tiebreak, which is deliberately not something this test
        // pins: asserting it would be asserting `gen_random_uuid()`.
        const pairs = await edgePairs(ws);
        expect(pairs).toHaveLength(1);
        expect([pairs[0]!.from, pairs[0]!.to].sort()).toEqual([a, b].sort());
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // The advisory lock, against a real one
  // -------------------------------------------------------------------------

  describe("the reconcile lock is real, and bounded", () => {
    it(
      "refuses — rather than hanging — while another session holds namespace 4771",
      async () => {
        // The one property `tension-sweep.test.ts` structurally cannot reach.
        // Its double throws a hand-made `{code: "55P03"}`, which proves the
        // HANDLING and assumes the two things underneath it:
        //
        //   1. that `lock_timeout` bounds an ADVISORY lock wait at all — its
        //      documentation says "a table, index, row, or other database
        //      object", and if an advisory lock were not one of those the bound
        //      would be decoration and this sweep would hang forever with no log
        //      line and no requestId, which is the outcome no error path reports;
        //   2. that returning from inside an aborted (`25P02`) transaction lets
        //      `withBrainTransaction`'s COMMIT succeed rather than throwing over
        //      the top of the refusal.
        //
        // ⚠️ A HANG is not a falsifier. If (1) were false this test would block
        // until the suite timeout and read as an infrastructure flake, so the
        // ELAPSED time is asserted: the refusal has to arrive on the timeout's
        // order, not the holder's.
        const ws = "ws-5029-contended";
        const holder = new Pool({
          connectionString: TEST_DB_URL,
          options: `-c search_path="${schemaName}",public`,
        });
        try {
          const held = await holder.connect();
          try {
            await held.query("BEGIN");
            await held.query(RECONCILE_LOCK_SQL, [RECONCILE_LOCK_NAMESPACE, ws]);

            // ⚠️ RACED against an explicit deadline, and that is the whole
            // reason this block is shaped the way it is. Measured: deleting
            // `SET LOCAL lock_timeout` makes `pg_advisory_xact_lock` wait
            // FOREVER, so a bare `await` here does not fail — it hangs until
            // bun's 60s suite timeout and reports "timed out", which reads as an
            // infrastructure flake on a shared Postgres and is the first thing
            // anyone would retry rather than investigate. A hang is not a
            // falsifier; a deadline is.
            //
            // 20s: comfortably above the shipped 5s bound (so a loaded CI box
            // does not flake) and comfortably below the 60s suite timeout (so an
            // UNBOUNDED wait loses the race and fails HERE, with a sentence).
            const DEADLINE_MS = 20_000;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<"deadline">((resolve) => {
              timer = setTimeout(() => resolve("deadline"), DEADLINE_MS);
            });
            const startedAt = Date.now();
            const raced = await Promise.race([sweepTensionEdges(ws), deadline]);
            const elapsedMs = Date.now() - startedAt;
            if (timer !== undefined) clearTimeout(timer);

            expect(
              raced,
              `the sweep did not return within ${DEADLINE_MS}ms while another session held namespace 4771 — \`pg_advisory_xact_lock\` waits forever, so the \`SET LOCAL lock_timeout\` that bounds it is missing or was reset before the acquisition. In production this is a request that hangs with no log line and no requestId`,
            ).not.toBe("deadline");
            if (raced === "deadline") throw new Error("unreachable");
            const outcome = raced;

            expect(
              outcome.kind,
              "the sweep ran while another session held namespace 4771 — either it takes a different lock, or the lock is not taken at all, and its `NOT EXISTS` dedupe is correct only by coincidence",
            ).toBe("contended");
            if (outcome.kind !== "contended") throw new Error("unreachable");
            expect(contentionMessage(outcome.reason)).toContain("Nothing was changed");

            // …and it waited at all, rather than the acquisition failing for
            // some reason that has nothing to do with contention. The shipped
            // bound is 5s, so a refusal arriving in ~0ms would mean the lock was
            // never actually contended and this whole block proves nothing.
            expect(
              elapsedMs,
              `the refusal arrived in ${elapsedMs}ms — faster than the 5s bound, so the sweep did not wait on the held lock at all`,
            ).toBeGreaterThan(1_000);

            // …and the INTERNAL pool — the one `sweepTensionEdges` borrowed from
            // and returned a `25P02` connection to — is still usable.
            //
            // ⚠️ This used to query `holder`, which is a different `Pool`
            // entirely and says nothing about the sweep's connection: it was an
            // assertion that could not fail, under a comment claiming it checked
            // the pool was not poisoned for the next caller. `pool` IS that pool
            // (`_resetPool(pool)` in `beforeAll`), so this is the claim the line
            // was making all along.
            await pool.query("SELECT 1");
          } finally {
            await held.query("ROLLBACK").catch((err: unknown) => {
              // intentionally ignored: the holder is torn down on the next line
              // regardless, and a failed ROLLBACK here would mask the assertion
              // that actually failed above.
              void err;
            });
            held.release();
          }

          // With the lock released, the SAME workspace sweeps normally — the
          // positive control. Without it, a build that answered `contended`
          // unconditionally would pass every assertion above.
          const ep = await seedEpisode(ws, "contended");
          await seedFact(
            ws,
            ep,
            { subject: "acme", predicate: "capped at", object: "5" },
            { ingestedAt: T0 },
          );
          await seedFact(
            ws,
            ep,
            { subject: "acme", predicate: "capped at", object: "9" },
            { ingestedAt: T1 },
          );
          await curate(ws, "capped at", "single");

          expect(await sweep(ws)).toEqual({ minted: 1, truncated: false });
        } finally {
          await holder.end();
        }
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // The run cap, and the ordering that makes truncation converge
  // -------------------------------------------------------------------------

  describe("the run cap is applied AFTER the already-exists filter", () => {
    it(
      "a truncated run resumes rather than repeating",
      async () => {
        // Driven through the exported STATEMENT with a tiny `$3` rather than
        // through `sweepTensionEdges`, because reaching TENSION_SWEEP_RUN_CAP
        // through the shipped entry point needs a thousand-edge fixture to
        // assert an ordering property that a cap of 1 shows exactly as well.
        //
        // The property: capping the CANDIDATE pairs instead of the FRESH ones
        // hands every later run the same already-minted prefix, so the second
        // run below mints 0 and the tail is never swept — while every other
        // test in this file still passes.
        const ws = "ws-5029-run-cap";
        const ep = await seedEpisode(ws, "run-cap");
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "sized at", object: "10" },
          { ingestedAt: T0 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "sized at", object: "20" },
          { ingestedAt: T1 },
        );
        await seedFact(
          ws,
          ep,
          { subject: "acme", predicate: "sized at", object: "30" },
          { ingestedAt: T2 },
        );
        await curate(ws, "sized at", "single");

        const runWithCap = async (cap: number) =>
          (await pool.query(TENSION_SWEEP_SQL, [ws, TENSION_EDGE_CAP, cap])).rows.length;

        // Three pairs available, one edge per run, three runs to converge — and
        // the fourth confirms it stopped rather than merely slowed.
        expect(await runWithCap(1)).toBe(1);
        expect(
          await runWithCap(1),
          "the second capped run minted nothing — the LIMIT is above the `NOT EXISTS` filter, so a truncated sweep re-picks the pairs it already wrote and the tail is never reached",
        ).toBe(1);
        expect(await runWithCap(1)).toBe(1);
        expect(await runWithCap(1)).toBe(0);
        expect(await edgePairs(ws)).toHaveLength(3);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "the statement's own LIMIT is what the flag reports — driven at a cap that BITES",
      async () => {
        // ⚠️ This test used to assert `{minted: 1, truncated: false}` on a
        // two-row fixture under a message claiming it pinned `$3`'s binding. It
        // could not: bind `$3` to 1, or to `TENSION_EDGE_CAP`, and `minted` is
        // still 1 while `1 >= 1000` is still `false`. The assertion passed for
        // every possible binding, which makes it a restatement of the motivating
        // case wearing a different name.
        //
        // What IS checkable here is the statement's LIMIT actually cutting a run
        // short, driven at a cap small enough to bite — three available pairs, a
        // cap of 2, so the run stops at 2 with one left. The shipped cap reaching
        // `$3` is `tension-sweep.test.ts`' bind-list assertion, and the flag's
        // arithmetic is its three-point boundary test; neither is restated here.
        expect(
          TENSION_SWEEP_RUN_CAP,
          "the run cap is not larger than the per-fact cap — one bound is shadowing the other",
        ).toBeGreaterThan(TENSION_EDGE_CAP);

        const ws = "ws-5029-truncated-flag";
        const ep = await seedEpisode(ws, "truncated-flag");
        for (const [i, headcount] of ["40", "50", "60"].entries()) {
          await seedFact(
            ws,
            ep,
            { subject: "acme", predicate: "staffed at", object: headcount },
            { ingestedAt: `2026-06-01T00:00:0${i}Z` },
          );
        }
        await curate(ws, "staffed at", "single");

        const runWithCap = async (cap: number) =>
          (await pool.query(TENSION_SWEEP_SQL, [ws, TENSION_EDGE_CAP, cap])).rows.length;

        // Three pairs available (newest→2, middle→1). A cap of 2 must cut it.
        expect(
          await runWithCap(2),
          "the statement minted a number other than its own LIMIT with more pairs available — `$3` is not the run bound",
        ).toBe(2);
        // …and the remaining pair is still reachable, which is the convergence
        // half stated at a different cap from the resume test above.
        expect(await runWithCap(2)).toBe(1);
        expect(await runWithCap(2)).toBe(0);
        expect(await edgePairs(ws)).toHaveLength(3);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });
});
