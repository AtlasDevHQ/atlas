/**
 * The two surfaces must stay apart — real Postgres, one fixture, both
 * directions (#5403).
 *
 * `retirable.ts` exists because the review queue excludes published
 * warehouse-derived facts at every `?status=` including `all`, deliberately, so
 * nothing could produce the fact id `POST /{id}/retract` consumes. The fix was a
 * SECOND listing rather than a filter on the first.
 *
 * That shape has exactly one way to rot: the two listings drift back together.
 * Either the retirement listing stops serving the population it was built for
 * (and the operator is back where #5403 started), or the review queue starts
 * serving observations (and ADR-0042's exclusion is silently undone — the
 * failure the `candidates.ts` comment was written to prevent, arriving by a
 * route that comment cannot see).
 *
 * So both directions are asserted HERE, against ONE seeded row, in the same
 * test. Splitting them across the two modules' own test files is what would let
 * one be relaxed while the other stayed green.
 *
 * ## Why real Postgres and not a string assertion
 *
 * The complementarity is a claim about SQL semantics, not about SQL text.
 * `observationSql` and `notAnObservationSql` differ by an `IS NOT TRUE` fold
 * whose entire purpose is the NULL case, and no `toContain` can tell you that a
 * `source`-less row lands on exactly one side. The third fixture below is that
 * case, and it is the one a text assertion would have gotten wrong.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import { loadRetirableObservations } from "@atlas/api/lib/brain/retirable";
import { correctFact } from "@atlas/api/lib/brain/correction";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { BrainFactRetirableListResponseSchema } from "@useatlas/schemas";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-retirable";
const REQUEST_ID = "req-retirable-test";

function reviewer(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "reviewer",
    role: "admin",
    audienceIds: [],
  };
}

describeIfPg("retirement listing vs review queue (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_retire_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** The published warehouse-derived fact — the population ADR-0042 stranded. */
  let strandedId: string;
  /** A published NON-warehouse fact — the non-vacuous control on the source axis. */
  let ordinaryPublishedId: string;
  /** A warehouse-derived DRAFT — the control on the status axis. */
  let warehouseDraftId: string;
  /** A published fact with NO `provenance.source` at all — the NULL fold. */
  let sourcelessId: string;
  /** A published observation whose `valid_to` has already passed — inert, but still nameable. */
  let supersededId: string;

  beforeAll(async () => {
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

    const episodeId = await seedEpisode();
    strandedId = await seedFact({
      subject: "Atlas",
      predicate: "plan_tier",
      object: "trial",
      episodeId,
      status: "published",
      provenance: { source: WAREHOUSE_SOURCE, actor: "producer" },
    });
    ordinaryPublishedId = await seedFact({
      subject: "Atlas",
      predicate: "uses",
      object: "Postgres",
      episodeId,
      status: "published",
      provenance: { source: "slack", actor: "U1" },
    });
    warehouseDraftId = await seedFact({
      subject: "Atlas",
      predicate: "seat_count",
      object: "12",
      episodeId,
      status: "draft",
      provenance: { source: WAREHOUSE_SOURCE, actor: "producer" },
    });
    sourcelessId = await seedFact({
      subject: "Atlas",
      predicate: "founded",
      object: "2024",
      episodeId,
      status: "published",
      // Non-empty (a CHECK constraint forbids `{}`) but carrying NO `source` —
      // the shape of a row that predates the provenance discriminator, which is
      // exactly the population the NULL fold exists for.
      provenance: { actor: "U1" },
    });
    supersededId = await seedFact({
      subject: "Atlas",
      predicate: "headcount",
      object: "40",
      episodeId,
      status: "published",
      provenance: { source: WAREHOUSE_SOURCE, actor: "producer" },
    });
    await pool.query(`UPDATE brain_facts SET valid_to = now() - interval '1 day' WHERE id = $1`, [
      supersededId,
    ]);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  async function seedEpisode(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', 'ep-retire', 'U1', 'evidence', now(), ARRAY['org']::text[])
       RETURNING id`,
      [WS],
    );
    return rows[0]!.id;
  }

  async function seedFact(opts: {
    subject: string;
    predicate: string;
    object: string;
    episodeId: string;
    status: "draft" | "published";
    provenance: Record<string, unknown>;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          status, visible_to, subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, ARRAY['org']::text[], $8, $9, $10)
       RETURNING id`,
      [
        WS,
        opts.subject,
        opts.predicate,
        opts.object,
        opts.episodeId,
        JSON.stringify(opts.provenance),
        opts.status,
        opts.subject.toLowerCase(),
        opts.predicate.toLowerCase(),
        opts.object.toLowerCase(),
      ],
    );
    return rows[0]!.id;
  }

  /** One transaction on the test pool — the runner `correctFact` injects. */
  const poolTx: ReconcileTransactionRunner = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn({
        query: async (sql: string, params?: unknown[]) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as readonly unknown[] };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  /** Every fact id the review queue serves at `?status=all` — its widest setting. */
  async function reviewQueueIds(): Promise<string[]> {
    const page = await loadFactCandidates(pool, {
      ctx: reviewer(),
      status: "all",
      limit: 100,
      offset: 0,
      requestId: REQUEST_ID,
    });
    return page.candidates.map((c) => c.id);
  }

  async function retirableIds(): Promise<string[]> {
    const page = await loadRetirableObservations(pool, {
      ctx: reviewer(),
      limit: 100,
      offset: 0,
      requestId: REQUEST_ID,
    });
    return page.observations.map((o) => o.id);
  }

  it("serves the stranded row, with the id retract consumes", async () => {
    const page = await loadRetirableObservations(pool, {
      ctx: reviewer(),
      limit: 100,
      offset: 0,
      requestId: REQUEST_ID,
    });

    const stranded = page.observations.find((o) => o.id === strandedId);
    expect(stranded).toBeDefined();
    expect(stranded?.predicate).toBe("plan_tier");
    expect(stranded?.object).toBe("trial");
    // The echoed source is what tells the operator WHICH warehouse-shaped kind
    // put the row here, rather than trusting the filter meant what they assumed.
    expect(stranded?.source).toBe(WAREHOUSE_SOURCE);
    // The response the route parses. A coercion that violated it would be a 500.
    expect(() => BrainFactRetirableListResponseSchema.parse(page)).not.toThrow();
  });

  it("the review queue still excludes it at ?status=all — the exclusion is UNCHANGED", async () => {
    const ids = await reviewQueueIds();

    expect(ids).not.toContain(strandedId);
    // Non-vacuous: the queue is serving rows, just not that one. Without this
    // the assertion above passes on a broken query returning nothing at all.
    expect(ids).toContain(ordinaryPublishedId);
  });

  it("the two listings are disjoint, and neither is empty", async () => {
    const [review, retirable] = await Promise.all([reviewQueueIds(), retirableIds()]);

    expect(review.length).toBeGreaterThan(0);
    expect(retirable.length).toBeGreaterThan(0);
    expect(retirable.filter((id) => review.includes(id))).toEqual([]);
  });

  it("retirement is PUBLISHED-only — a warehouse-derived draft is neither listed nor reviewable", async () => {
    // Refused at the publish gate since #5342, so it needs no operator action.
    // It is excluded from the review queue too (the source exclusion holds at
    // every status), which is why this row is nobody's business and the correct
    // answer is that it appears on neither surface.
    const [review, retirable] = await Promise.all([reviewQueueIds(), retirableIds()]);

    expect(retirable).not.toContain(warehouseDraftId);
    expect(review).not.toContain(warehouseDraftId);
  });

  it("a source-less published fact belongs to REVIEW, not retirement (the NULL fold)", async () => {
    // `notAnObservationSql` folds NULL to TRUE so a fact predating the
    // provenance shape is still served; `observationSql` bare leaves it out.
    // Landing on exactly one side is the property, and it is the one no string
    // assertion on the SQL could establish.
    const [review, retirable] = await Promise.all([reviewQueueIds(), retirableIds()]);

    expect(review).toContain(sourcelessId);
    expect(retirable).not.toContain(sourcelessId);
  });

  it("a SUPERSEDED observation is still listed, and is visibly inert (no currency filter)", async () => {
    // The one predicate where this surface parts company with every sibling
    // reader, asserted rather than left to the header. Search excludes this row
    // twice (source AND currency) and review excludes it on source, so the
    // retirement listing is the ONLY path to its id — filtering on currency
    // here would strand it exactly as #5403 found the others stranded.
    const page = await loadRetirableObservations(pool, {
      ctx: reviewer(),
      limit: 100,
      offset: 0,
      requestId: REQUEST_ID,
    });

    const superseded = page.observations.find((o) => o.id === supersededId);
    expect(superseded).toBeDefined();
    // Visibly inert: the operator can tell this one apart without a second
    // call, which is what makes reporting the state better than filtering on it.
    expect(superseded?.validTo).not.toBeNull();

    // And the review queue still does not carry it — the exclusion there is on
    // the SOURCE, so currency changes nothing about that side.
    expect(await reviewQueueIds()).not.toContain(supersededId);
  });

  it("a retracted row leaves the listing — this is how #5331 AC5 reads the clearing back", async () => {
    const before = await retirableIds();
    expect(before).toContain(strandedId);

    // `retract` is the ONE correction verb admitted on a warehouse-derived
    // fact: it says the row should not have been blessed, and asserts nothing
    // about the warehouse. If this ever refuses, the retirement listing is
    // pointing an operator at rows they cannot act on.
    const outcome = await correctFact(
      {
        vocabulary: identityVocabulary,
        ctx: reviewer(),
        factId: strandedId,
        verb: "retract",
        reason: "ADR-0042 straggler — never should have been published",
        requestId: REQUEST_ID,
      },
      { withTransaction: poolTx },
    );
    // Asserted, not assumed: a refusal here would leave the listing pointing an
    // operator at rows they cannot act on, and the `not.toContain` below would
    // still fail — but for a reason that reads as a listing bug rather than the
    // tier-1 refusal having swallowed `retract`.
    expect(outcome.kind).toBe("corrected");

    expect(await retirableIds()).not.toContain(strandedId);
  });
});
