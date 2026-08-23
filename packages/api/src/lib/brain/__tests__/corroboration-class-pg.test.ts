/**
 * **Who may corroborate whom** — the class matrix behind `CORROBORATION_LOOKUP_SQL`
 * (#5332, [ADR-0042](../../../../../../docs/adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md)).
 *
 * ADR-0042's rule is *only a belief can be corroborated*, and the defect it
 * exposed is that the lookup had no source arm at all: a person agreeing with a
 * warehouse reading corroborated it and returned, so **no draft was minted and
 * nothing reached the review queue**. Their testimony became a `provenance` edge
 * on a machine-produced row that, under the same ADR, is never served — gone
 * from the corpus entirely.
 *
 * ## Why this is a MATRIX and not a single prohibition
 *
 * "Observations cannot be corroborated" is the obvious reading of the rule and
 * it is WRONG in a way that no test of the reported bug alone would catch. The
 * incumbent's class does not decide this on its own; the pair does:
 *
 * | incoming | incumbent | verdict | what breaks if it flips |
 * |---|---|---|---|
 * | belief | belief | corroborate | the whole strengthen path, incl. cross-class (`multi-source-pg`) |
 * | belief | **observation** | **mint a draft** | ⭐ #5332 — the swallowed testimony |
 * | observation | observation | corroborate | ⚠️ the producer's re-read (below) |
 * | observation | belief | corroborate | a warehouse reading stops citing a belief it confirms |
 *
 * ⚠️ **Row 3 is the one an unconditional exclusion silently destroys.** The
 * warehouse producer re-emits every enrolled row on EVERY run, and
 * `warehouseRowId`'s whole stated purpose is that a re-emission *"corroborates
 * its predecessor instead of contradicting it"*. Excluding observations from the
 * lookup outright would therefore mint a fresh duplicate observation per entity
 * per run — and worse, it would break `observation-reap.ts`, whose staleness
 * signal is *"the newest warehouse episode still hanging off this observation by
 * a provenance edge"*. With no edge ever written, `last_seen` collapses to the
 * creating episode and the reaper deletes the entire live comparison surface on
 * the third run. Two bugs, both silent, both in the irreversible direction.
 *
 * Row 4 is the shape `observation-reap.ts`'s `observationSql("f")` fence exists
 * to protect — *"a published human belief that a warehouse episode once
 * corroborated, which is a live shape today"*. It stays live.
 *
 * So the arm is **not** class-matching, and reading it as such is the mistake to
 * guard against: it is a restriction on the INCUMBENT, lifted when the incoming
 * claim is itself an observation. Rows 1 and 4 are what keep it from being read
 * as "corroboration works within a class", which is the exact cross-class
 * regression `multi-source-pg.test.ts` mutation-tested for.
 *
 * ## Why `-pg` and not the unit lane
 *
 * `reconcile.test.ts`'s fake dispatches on each SQL constant's string identity
 * and reads its binds positionally, so it *"cannot tell which COLUMNS a
 * statement names"* and answers no identity question at all (#5021). A new WHERE
 * arm is invisible to it by construction. Its lexical backstop greps the
 * statement text and is a tripwire, not a proof; this file is the proof.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { ORG_PRINCIPAL } from "@atlas/api/lib/brain/acl";
import {
  SLACK_SOURCE,
  WAREHOUSE_SOURCE,
  WAREHOUSE_SOURCES,
  episodeSourceArraySql,
} from "@atlas/api/lib/brain/sources";
import { isObservation, observationSql } from "@atlas/api/lib/brain/observation";
import { widenGrantFromEvidence } from "@atlas/api/lib/brain/promotion";
import { OBSERVATION_REAP_SQL } from "@atlas/api/lib/brain/observation-reap";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import {
  reconcileFacts,
  type ReconcileEpisodeRef,
  type ReconcileReport,
} from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/** The claim both classes make, byte-identical, so only the CLASS ever varies. */
const SUBJECT = "Dharma";
const PREDICATE = "plan_tier";
const OBJECT = "trial";
/** The value a DISAGREEING claim asserts — the tension control. */
const RIVAL_OBJECT = "business";

/** A private channel's grant, for the widening question. */
const PRIVATE_GRANT = "audience:C1";

describeIfPg("corroboration's class matrix (#5332)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5332_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `reconcileFacts` writes through the module-level pool when no runner is
    // injected, so `_resetPool(pool)` is the real guard; `DATABASE_URL` is set
    // because sibling brain helpers gate on `hasInternalDB()`, which reads the
    // env var rather than the pool. Inside the hook, never at module top level.
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
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
  });

  // ── landing a claim of a chosen CLASS ───────────────────────────────────

  let seq = 0;

  /**
   * One episode of the given source kind.
   *
   * `source` is bound as a parameter, and it is the ONLY thing that varies
   * between a belief and an observation here — `reconcile.ts` copies it
   * structurally into `provenance.source`, which is what {@link isObservation}
   * and the new lookup arm both read. Holding the claim itself byte-identical
   * across the matrix is what makes each cell's verdict attributable to the
   * class and to nothing else.
   */
  async function seedEpisode(
    workspaceId: string,
    source: string,
    grant: readonly string[] = [ORG_PRINCIPAL],
  ): Promise<ReconcileEpisodeRef> {
    const sourceId = `${source}:${++seq}`;
    const occurredAt = new Date("2026-08-19T09:00:00.000Z");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, $2, $3, 'U123', 'evidence', $4::timestamptz, $5::text[])
       RETURNING id`,
      [workspaceId, source, sourceId, occurredAt.toISOString(), [...grant]],
    );
    return {
      id: rows[0]!.id,
      workspaceId,
      source,
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: [...grant],
    };
  }

  interface LandOptions {
    readonly object?: string;
    readonly grant?: readonly string[];
  }

  /** Reconcile one claim of one class, through the real stage. */
  async function land(
    workspaceId: string,
    source: string,
    options: LandOptions = {},
  ): Promise<ReconcileReport> {
    const episode = await seedEpisode(workspaceId, source, options.grant);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [
        {
          subject: SUBJECT,
          predicate: PREDICATE,
          object: options.object ?? OBJECT,
          // `single` throughout: it is what ISSUES the rival scan, so the
          // disagreement control below can see a tension edge at all.
          predicateCardinality: "single",
        },
      ],
      producer: "corroboration-class",
      extractedAt: new Date("2026-08-19T10:00:00.000Z"),
    });
    // A PRECONDITION, asserted where every cell inherits it: `reconcileFacts`
    // returns domain refusals as counted outcomes and never throws, so a
    // candidate that tripped `MALFORMED_CLAIM` would land zero rows and every
    // prohibition below would pass against an empty table.
    expect(
      report.outcomes[0],
      `the ${source} claim was refused, not landed — every assertion downstream is vacuous`,
    ).not.toMatchObject({ kind: "blocked" });
    return report;
  }

  // ── reading back what landed ────────────────────────────────────────────

  interface StoredRow {
    readonly id: string;
    readonly object: string;
    readonly source: string | null;
    readonly provenance: Record<string, unknown>;
    readonly visibleTo: readonly string[];
  }

  async function factsOf(workspaceId: string): Promise<StoredRow[]> {
    const { rows } = await pool.query<{
      id: string;
      object: string;
      source: string | null;
      provenance: Record<string, unknown>;
      visible_to: string[];
    }>(
      `SELECT id::text AS id, object, provenance->>'source' AS source, provenance, visible_to
         FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, id`,
      [workspaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      object: r.object,
      source: r.source,
      provenance: r.provenance,
      visibleTo: r.visible_to,
    }));
  }

  /**
   * Every `provenance` edge, as `factId -> episode source` — the attribution.
   *
   * Ordered by the FACT's `ingested_at`, matching {@link factsOf}, so a cell can
   * assert the exact evidence set positionally. Ordering by `from_fact_id` reads
   * naturally and is wrong: it is a random uuid, so the row order would flip
   * between runs and the assertion would be flaky rather than false.
   */
  async function evidenceOf(workspaceId: string): Promise<{ factId: string; source: string }[]> {
    const { rows } = await pool.query<{ fact_id: string; source: string }>(
      `SELECT g.from_fact_id::text AS fact_id, e.source
         FROM brain_edges g
         JOIN brain_episodes e ON e.workspace_id = g.workspace_id AND e.id = g.to_episode_id
         JOIN brain_facts f ON f.workspace_id = g.workspace_id AND f.id = g.from_fact_id
        WHERE g.workspace_id = $1 AND g.edge_type = 'provenance'
        ORDER BY f.ingested_at, f.id, e.source`,
      [workspaceId],
    );
    return rows.map((r) => ({ factId: r.fact_id, source: r.source }));
  }

  async function tensionEdges(workspaceId: string): Promise<{ from: string; to: string }[]> {
    const { rows } = await pool.query<{ from: string; to: string }>(
      `SELECT from_fact_id::text AS "from", to_fact_id::text AS "to"
         FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [workspaceId],
    );
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════
  // The matrix
  // ══════════════════════════════════════════════════════════════════════

  describe("a belief may be corroborated by anything", () => {
    it(
      "belief → belief strengthens rather than forking",
      async () => {
        const ws = "ws-5332-belief-belief";
        await land(ws, SLACK_SOURCE);
        const second = await land(ws, SLACK_SOURCE);

        expect(second.corroborated).toBe(1);
        expect(second.created).toBe(0);
        // The row TOTAL is the control that keeps "corroborated" honest — it is
        // also true of a stage that wrote nothing at all.
        expect(await factsOf(ws)).toHaveLength(1);
        expect(await evidenceOf(ws)).toHaveLength(2);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "observation → belief still cites the belief it confirms",
      async () => {
        // Row 4. The shape `observation-reap.ts`'s `observationSql("f")` fence
        // exists to protect: a human belief a warehouse episode corroborated.
        // A fix that read the arm as class-MATCHING would break this cell, and
        // the reaper's fence would then be guarding a shape that cannot occur.
        const ws = "ws-5332-observation-belief";
        await land(ws, SLACK_SOURCE);
        const second = await land(ws, WAREHOUSE_SOURCE);

        expect(second.corroborated).toBe(1);
        expect(second.created).toBe(0);
        const [only, ...rest] = await factsOf(ws);
        expect(rest).toEqual([]);
        // The row is still the PERSON's claim. Corroboration changes nothing
        // about the fact, its provenance included.
        expect(only!.source).toBe(SLACK_SOURCE);
        expect(isObservation(only!.provenance)).toBe(false);
        expect((await evidenceOf(ws)).map((e) => e.source).sort()).toEqual([
          SLACK_SOURCE,
          WAREHOUSE_SOURCE,
        ]);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  describe("an observation may be corroborated only by another observation", () => {
    it(
      "⭐ belief → observation mints its own draft and leaves the observation untouched",
      async () => {
        // #5332 ITSELF, as the ticket states the sequence: a warehouse row
        // exists → a matching extractor claim arrives → a new draft exists, and
        // the observation gained NO provenance edge.
        const ws = "ws-5332-belief-observation";
        await land(ws, WAREHOUSE_SOURCE);
        const testimony = await land(ws, SLACK_SOURCE);

        expect(testimony.corroborated).toBe(0);
        expect(testimony.created).toBe(1);

        const rows = await factsOf(ws);
        expect(rows).toHaveLength(2);
        const [observation, draft] = rows;
        expect(isObservation(observation!.provenance)).toBe(true);
        // ⭐ The person's statement is a ROW a reviewer can read, attributed to
        // them — not an edge on a machine-produced row that is never served.
        expect(isObservation(draft!.provenance)).toBe(false);
        expect(draft!.source).toBe(SLACK_SOURCE);
        expect(draft!.object).toBe(OBJECT);

        // The observation gained NOTHING. Asserted as the exact evidence set
        // rather than as a count, so a run that moved the edge to the right row
        // for the wrong reason cannot pass.
        expect(await evidenceOf(ws)).toEqual([
          { factId: observation!.id, source: WAREHOUSE_SOURCE },
          { factId: draft!.id, source: SLACK_SOURCE },
        ]);

        // ⭐⭐ And the claim the whole ticket rests on: it REACHES THE REVIEW
        // QUEUE. Every assertion above is about rows and edges, and a fix that
        // minted a draft the queue then filtered out would satisfy all of them
        // while leaving the testimony exactly as swallowed as before. The queue
        // is the thing #5332 says nothing reached.
        //
        // Non-vacuous in the direction that matters: the observation is in the
        // same slot and does NOT appear, because `candidates.ts` composes
        // `notAnObservationSql` for #5341. So this asserts the two rows are
        // treated differently by the surface, not merely that the surface works.
        const queue = await loadFactCandidates(pool, {
          ctx: {
            origin: "authenticated",
            workspaceId: ws,
            userId: "reviewer",
            role: "admin",
            audienceIds: [],
          },
          limit: 50,
          offset: 0,
        });
        expect(queue.candidates.map((c) => c.id)).toEqual([draft!.id]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "⚠️ observation → observation still corroborates, so a re-read does not fork",
      async () => {
        // Row 3 — the cell an unconditional exclusion destroys silently. The
        // producer re-emits every enrolled row on every run; without this,
        // each run mints a duplicate observation AND `observation-reap.ts`
        // loses the `last_seen` edge its staleness rule is built on.
        const ws = "ws-5332-observation-observation";
        await land(ws, WAREHOUSE_SOURCE);
        const reread = await land(ws, WAREHOUSE_SOURCE);

        expect(reread.corroborated).toBe(1);
        expect(reread.created).toBe(0);
        expect(await factsOf(ws)).toHaveLength(1);
        // BOTH warehouse episodes cited — the second edge IS the reaper's
        // freshness signal, so its absence is what would strand the surface.
        expect((await evidenceOf(ws)).map((e) => e.source)).toEqual([
          WAREHOUSE_SOURCE,
          WAREHOUSE_SOURCE,
        ]);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  describe("the disagreement path is unaffected", () => {
    it(
      "a person CONTRADICTING an observation still earns the advisory tension edge",
      async () => {
        // AC3. The exclusion is on corroboration only; a claim that disagrees
        // with a reading never reached the lookup in the first place, and must
        // still be flagged against it for a reviewer.
        const ws = "ws-5332-disagreement";
        await land(ws, WAREHOUSE_SOURCE);
        const dissent = await land(ws, SLACK_SOURCE, { object: RIVAL_OBJECT });

        expect(dissent.created).toBe(1);
        const rows = await factsOf(ws);
        expect(rows).toHaveLength(2);
        const [observation, draft] = rows;
        // `newer → incumbent`, which is the direction `reconcile.ts` mints at
        // write time.
        expect(await tensionEdges(ws)).toEqual([{ from: draft!.id, to: observation!.id }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a person AGREEING with an observation earns no tension edge either",
      async () => {
        // The complement, and the control that keeps the test above from
        // passing against a stage that flags everything. ADR-0042 puts the
        // agreement comparison in the tension scan's complement — same slot,
        // same object — which is exactly this pair of rows.
        const ws = "ws-5332-agreement-no-tension";
        await land(ws, WAREHOUSE_SOURCE);
        await land(ws, SLACK_SOURCE);

        expect(await factsOf(ws)).toHaveLength(2);
        expect(await tensionEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  // AC5 — the pre-fix residue, and the query that enumerates it
  // ══════════════════════════════════════════════════════════════════════

  describe("the swallowed-testimony audit query", () => {
    // #5332 stopped MINTING these edges; it rewrote no history. The recorded
    // decision is to LEAVE them
    // (`docs/development/brain-swallowed-testimony.md`), which makes the
    // enumeration the deliverable rather than a migration — an operator has to
    // be able to answer "how much testimony did this swallow, and whose".
    //
    // Pinned here rather than left as a paste in that doc, because an audit
    // query nothing runs is a query nobody can trust when it matters. ⚠️ The
    // doc QUOTES this constant for reading; it is not a second source. Edit
    // here, then re-copy — the two cannot be kept in step by anything but that
    // habit, which is why the doc says so in as many words.
    //
    // ⚠️ COMPOSED from the same two builders production uses, never spelled as
    // `ARRAY['warehouse']::text[]` by hand. Hand-spelling it here would be the
    // exact shape #4938 caught — the producer and the predicate each owning a
    // literal — reintroduced in the one place that would go on passing after a
    // rename, since a stale audit silently returns ZERO rows and reads as
    // "nothing was swallowed". The fact side is `observationSql`, the episode
    // side is the warehouse vocabulary as an array, and both resolve from
    // `sources.ts`' spec map at module load.
    const SWALLOWED_TESTIMONY_AUDIT_SQL = `SELECT g.id AS edge_id,
       f.id AS observation_id, f.workspace_id, f.status,
       f.subject, f.predicate, f.object,
       e.id AS episode_id, e.source AS episode_source, e.source_id,
       e.source_actor, e.occurred_at
  FROM brain_edges g
  JOIN brain_facts f
    ON f.workspace_id = g.workspace_id AND f.id = g.from_fact_id
  JOIN brain_episodes e
    ON e.workspace_id = g.workspace_id AND e.id = g.to_episode_id
 WHERE g.edge_type = 'provenance'
   AND ${observationSql("f")}
   AND (e.source = ANY (${episodeSourceArraySql(WAREHOUSE_SOURCES)})) IS NOT TRUE
 ORDER BY f.workspace_id, e.occurred_at, g.id`;

    it(
      "returns the swallowed edges and NOTHING else",
      async () => {
        const ws = "ws-5332-audit";
        // 1. The residue: an observation carrying a CHAT episode as evidence.
        //    Seeded by hand because the stage can no longer produce it — which
        //    is the point of the fix and the reason this population is closed.
        await land(ws, WAREHOUSE_SOURCE);
        const [observation] = await factsOf(ws);
        const chat = await seedEpisode(ws, SLACK_SOURCE);
        await pool.query(
          `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
           VALUES ($1, 'provenance', $2, $3)`,
          [ws, observation!.id, chat.id],
        );

        // 2. The observation's OWN warehouse evidence — must NOT match, or the
        //    audit reports the entire comparison surface as swallowed.
        // 3. A belief with warehouse evidence (row 4) — the legitimate
        //    cross-class edge, in the other direction. Must not match either.
        await land(ws, SLACK_SOURCE, { object: "enterprise" });
        await land(ws, WAREHOUSE_SOURCE, { object: "enterprise" });

        const { rows } = await pool.query<{
          edge_id: string;
          observation_id: string;
          episode_source: string;
          status: string;
        }>(SWALLOWED_TESTIMONY_AUDIT_SQL);
        const mine = rows.filter((r) => r.observation_id === observation!.id);

        expect(rows).toHaveLength(1);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.episode_source).toBe(SLACK_SOURCE);
        // The status travels because the decision to LEAVE depends on it: a
        // `draft` observation is reapable and ages out on its own, and one that
        // somehow reached `published` is #5331's narrow `retract`, not this
        // query's business. ADR-0042 makes every observation structurally draft.
        expect(mine[0]!.status).toBe("draft");
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "the residue it finds is still REAPABLE, which is what the decision to leave rests on",
      async () => {
        // The load-bearing half of "leave them". A chat edge must not hold an
        // observation alive past the reaper's window — `observation-reap.ts`'s
        // warehouse-class evidence arm is what guarantees it, and its
        // behavioural falsifier is `observation-reap-pg.test.ts`'s "a chat
        // episode agreeing with an observation does not hold it alive". Named
        // here so the two halves of one decision are findable from each other;
        // if that test is ever deleted, the decision recorded in the doc loses
        // its grounds and the population stops being self-clearing.
        expect(OBSERVATION_REAP_SQL).toContain("pe.source = ANY (ARRAY['warehouse']::text[])");
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  // AC6 — `widenGrantFromEvidence` across the class boundary, MEASURED
  // ══════════════════════════════════════════════════════════════════════

  describe("widenGrantFromEvidence across the class boundary (#4823)", () => {
    it(
      "the swallowing edge that would have widened a private grant is never written",
      async () => {
        // The ticket asks for this to be CHECKED rather than assumed, "because
        // the direction of any surprise here is disclosure".
        //
        // Before the fix, a private Slack claim agreeing with a warehouse row
        // attached itself as evidence to that row. The producer grants
        // `ORG_PRINCIPAL`, so the union ran `org ∪ audience:C1` — a non-null
        // return, i.e. a widening, and `WIDEN_AND_PROMOTE_FACTS_SQL` rather
        // than the blanket promote. Inert on readers (`org` already admits
        // everyone) but NOT a no-op: it rewrites `visible_to` and stamps
        // `pre_widening_visible_to` on a row ADR-0042 says is never published.
        //
        // "No widening occurs" was the ticket's guess. It is wrong, and that is
        // why the arithmetic is run here rather than reasoned about — what
        // makes it moot is that the EDGE is gone, not that the union is empty.
        const ws = "ws-5332-widening";
        await land(ws, WAREHOUSE_SOURCE);
        await land(ws, SLACK_SOURCE, { grant: [PRIVATE_GRANT] });

        const rows = await factsOf(ws);
        expect(rows).toHaveLength(2);
        const [observation, draft] = rows;

        // The union the swallowing edge WOULD have produced, computed against
        // the real function so this stays true if its rules change.
        expect(widenGrantFromEvidence(observation!.visibleTo, [[PRIVATE_GRANT]])).toEqual({
          grant: [ORG_PRINCIPAL, PRIVATE_GRANT],
          added: [PRIVATE_GRANT],
        });

        // …and the reason it is unreachable: no cross-class evidence exists.
        // Each row cites its own episode and only its own.
        expect(await evidenceOf(ws)).toEqual([
          { factId: observation!.id, source: WAREHOUSE_SOURCE },
          { factId: draft!.id, source: SLACK_SOURCE },
        ]);
        // The private claim kept its private grant, as a row of its own.
        expect(draft!.visibleTo).toEqual([PRIVATE_GRANT]);
        expect(observation!.visibleTo).toEqual([ORG_PRINCIPAL]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "row 4's surviving cross-class edge DOES widen — `org` is added to a private grant",
      async () => {
        // The boundary crossing that my fix deliberately KEEPS (row 4): a
        // warehouse reading corroborating a private human belief. Here the
        // direction is reversed — the evidence is the `org`-granted warehouse
        // episode and the fact is the private claim — so the union is
        // `audience:C1 ∪ org`, which DOES widen, and at publish it would
        // disclose a private claim's body to the whole org.
        //
        // ⚠️ MEASURED, not fixed here: this is pre-existing and out of #5332's
        // scope, which is the corroboration lookup. It is recorded so the next
        // reader finds a number rather than an assumption. `loadWideningPreview`
        // fires the review-gate notice on exactly this, which is the guard that
        // makes it "a human is told" rather than "this cannot happen".
        const ws = "ws-5332-row4-widening";
        await land(ws, SLACK_SOURCE, { grant: [PRIVATE_GRANT] });
        await land(ws, WAREHOUSE_SOURCE);

        const rows = await factsOf(ws);
        expect(rows).toHaveLength(1);
        const belief = rows[0]!;
        expect(belief.visibleTo).toEqual([PRIVATE_GRANT]);
        // The warehouse episode IS evidence for it.
        expect((await evidenceOf(ws)).map((e) => e.source).sort()).toEqual([
          SLACK_SOURCE,
          WAREHOUSE_SOURCE,
        ]);
        // And this is what publish would do with that evidence.
        expect(widenGrantFromEvidence(belief.visibleTo, [[ORG_PRINCIPAL]])).toEqual({
          grant: [PRIVATE_GRANT, ORG_PRINCIPAL],
          added: [ORG_PRINCIPAL],
        });
      },
      PG_TEST_TIMEOUT_MS,
    );
  });
});
