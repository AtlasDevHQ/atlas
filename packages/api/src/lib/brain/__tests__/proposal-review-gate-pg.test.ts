/**
 * **The review gate `proposeFact` exits through** (#5483,
 * [ADR-0036](../../../../../../docs/adr/0036-atlas-as-company-brain.md) §T9
 * lock 1's exit half).
 *
 * #5482 built the entry: a proposal lands as an org-granted draft through
 * `reconcileFacts` and ships no publish path. This file pins that the EXISTING
 * gate — `/api/v1/admin/publish` → `promoteBrainFacts`, rejection via the
 * `retract` correction verb — actually carries the new class, which is the
 * whole claim of the issue: *a new class flowing through an existing gate, not
 * a new gate*. Nothing here adds machinery; every assertion is that machinery
 * built for connector-extracted drafts holds for agent-proposed ones.
 *
 * The four properties, one per test:
 *
 *   1. **Reviewable, and labelled.** An ordinary member's proposal reaches an
 *      admin reviewer's queue through `loadFactCandidates`, carrying the
 *      origin discriminator (`provenance.producer === BRAIN_PROPOSAL_PRODUCER`)
 *      the web badge branches on, and the distinct-source count §T9 lock 5
 *      says the reviewer must see.
 *   2. **Approval publishes.** The classifier has no arm that refuses the
 *      class; the bulk promote stamps it `published` like any other draft.
 *   3. **Rejection is an auditable record, never a silent delete.** `retract`
 *      tombstones `invalidated_at` and materializes a correction episode
 *      recording who rejected it and why. The row survives.
 *   4. **⭐ Widening is the reviewer's act at the gate, never the proposer's at
 *      propose time.** A proposal corroborating a narrowly-granted draft moves
 *      `visible_to` not one byte; the reviewer sees the coming widening in
 *      `loadWideningPreview`; publish performs it and reports it. Lock 3's
 *      "broadening the grant is the reviewer's act" as three assertions on one
 *      timeline.
 *
 * ## Why `-pg` and not the unit lane
 *
 * Every property above is a claim about what a REAL query returns after a real
 * transaction committed — the ACL predicate, the corroboration sub-SELECT, the
 * widening evidence join, and the tombstone are all evaluated by Postgres, and
 * `proposal.test.ts`'s fake executor cannot see any of them (#5021's finding,
 * one seam over).
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { BRAIN_PROPOSAL_PRODUCER } from "@useatlas/schemas";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { ORG_PRINCIPAL, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import { loadWideningPreview } from "@atlas/api/lib/brain/oversight";
import { correctFact } from "@atlas/api/lib/brain/correction";
import { proposeFact } from "@atlas/api/lib/brain/proposal";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { HUMAN_SOURCE, SLACK_SOURCE } from "@atlas/api/lib/brain/sources";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/** One claim, byte-identical wherever it appears, so corroboration is exact. */
const SUBJECT = "Ana";
const PREDICATE = "is the DRI for";
const OBJECT = "billing";

/** The private channel the widening cell starts from. */
const NARROW_GRANT = "audience:chat-channel:slack:C0PRIVATE";

describeIfPg("the review gate proposeFact exits through (#5483)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5483_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `proposeFact` and `correctFact` write through the module-level pool when
    // no runner is injected, so `_resetPool(pool)` is the real guard;
    // `DATABASE_URL` is set because sibling brain helpers gate on
    // `hasInternalDB()`, which reads the env var rather than the pool. Inside
    // the hook, never at module top level (testing.md).
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

  // ── principals ──────────────────────────────────────────────────────────

  /**
   * An ORDINARY member — the proposer. Deliberately not an admin: #5482's
   * authority decision is that the draft state is the safety, and a member's
   * proposal reaching an admin's queue is the loop this gate exists to close.
   */
  function proposer(workspaceId: string): BrainPrincipalContext {
    return {
      origin: "authenticated",
      workspaceId,
      userId: "U-proposer",
      role: "member",
      audienceIds: [],
    };
  }

  /** The reviewer. `audienceIds` matter only for the widening cell. */
  function reviewer(
    workspaceId: string,
    audienceIds: readonly string[] = [],
  ): BrainPrincipalContext {
    return {
      origin: "authenticated",
      workspaceId,
      userId: "U-reviewer",
      role: "admin",
      audienceIds,
    };
  }

  // ── acting ──────────────────────────────────────────────────────────────

  async function propose(workspaceId: string, reason?: string) {
    return proposeFact({
      ctx: proposer(workspaceId),
      claim: { subject: SUBJECT, predicate: PREDICATE, object: OBJECT, ...(reason ? { reason } : {}) },
      vocabulary: identityVocabulary,
    });
  }

  /** The gate itself, exactly as `runPublishPhases` drives it. */
  async function publish(workspaceId: string) {
    const client = await pool.connect();
    /** Set only when ROLLBACK itself failed — passing it to `release` destroys the client. */
    let destroyReason: Error | undefined;
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, workspaceId));
      await client.query("COMMIT");
      return report;
    } catch (err) {
      await client.query("ROLLBACK").catch((cause: unknown) => {
        destroyReason = cause instanceof Error ? cause : new Error(String(cause));
        console.warn(
          `publish(${workspaceId}): ROLLBACK failed after "${
            err instanceof Error ? err.message : String(err)
          }" — destroying the connection: ${destroyReason.message}`,
        );
      });
      throw err;
    } finally {
      client.release(destroyReason);
    }
  }

  /**
   * Land the SAME claim from a narrowly-granted Slack episode, through the
   * real seam — the incumbent the widening cell's proposal corroborates.
   * `reconcile.ts` inherits the fact's grant verbatim from the episode's
   * string tokens, and the precondition assertion is what keeps this cell from
   * silently testing an org-granted draft if that derivation ever changes.
   */
  async function landNarrowDraft(workspaceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, $2, 'slack:narrow-1', 'U-colleague', 'said in a private channel',
               '2026-08-20T09:00:00.000Z'::timestamptz, $3::text[])
       RETURNING id`,
      [workspaceId, SLACK_SOURCE, [NARROW_GRANT]],
    );
    const episode: ReconcileEpisodeRef = {
      id: rows[0]!.id,
      workspaceId,
      source: SLACK_SOURCE,
      sourceId: "slack:narrow-1",
      sourceActor: "U-colleague",
      occurredAt: new Date("2026-08-20T09:00:00.000Z"),
      visibleTo: [NARROW_GRANT],
    };
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [{ subject: SUBJECT, predicate: PREDICATE, object: OBJECT }],
      producer: "extraction:v1",
      extractedAt: new Date("2026-08-20T09:05:00.000Z"),
    });
    const outcome = report.outcomes[0];
    // A throw, not an expect-then-fallback: an empty-string factId would fail
    // every downstream assertion with messages pointing at the wrong seam.
    if (outcome?.kind !== "created") {
      throw new Error(
        `the incumbent draft was not created (got ${outcome?.kind ?? "no outcome"}) — every assertion downstream is vacuous`,
      );
    }
    const factId = outcome.factId;
    const grant = await grantOf(workspaceId, factId);
    expect(grant, "precondition: the incumbent's grant must be the NARROW audience alone").toEqual([
      NARROW_GRANT,
    ]);
    return factId;
  }

  // ── reading back ────────────────────────────────────────────────────────

  async function factRow(workspaceId: string, factId: string) {
    const { rows } = await pool.query<{
      status: string;
      invalidated_at: Date | null;
      visible_to: string[];
      pre_widening_visible_to: string[] | null;
    }>(
      `SELECT status, invalidated_at, visible_to, pre_widening_visible_to
         FROM brain_facts WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, factId],
    );
    expect(rows.length, "the fact row must still exist — a delete is the outcome this gate forbids").toBe(
      1,
    );
    return rows[0]!;
  }

  async function grantOf(workspaceId: string, factId: string): Promise<string[]> {
    return (await factRow(workspaceId, factId)).visible_to;
  }

  // ── the four properties ─────────────────────────────────────────────────

  it(
    "an ordinary member's proposal reaches the reviewer's queue, labelled with its origin, count shown",
    async () => {
      const ws = `ws-5483-queue-${Date.now()}`;
      const outcome = await propose(ws, "she took the pager on Monday");
      expect(outcome.kind).toBe("proposed");
      if (outcome.kind !== "proposed") return;
      expect(outcome.result.status).toBe("draft");

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(ws),
        limit: 10,
        offset: 0,
      });
      expect(page.candidates.length, "the org-granted draft must reach a reviewer who shares no audience").toBe(1);
      const candidate = page.candidates[0]!;

      expect(candidate.status).toBe("draft");
      // The origin discriminator the web badge branches on (#5483). `source`
      // alone cannot draw the line — a correction-authored replacement is
      // `human` too — so the producer is the label's whole basis.
      expect(candidate.provenance.producer).toBe(BRAIN_PROPOSAL_PRODUCER);
      expect(candidate.provenance.source).toBe(HUMAN_SOURCE);
      // The evidence really is the proposal episode, readable by the reviewer.
      expect(candidate.episode?.visible).toBe(true);
      if (candidate.episode?.visible === true) {
        expect(candidate.episode.source).toBe(HUMAN_SOURCE);
        expect(candidate.episode.sourceId?.startsWith("proposal:")).toBe(true);
      }
      // §T9 lock 5's display half: the distinct-source count, on the row the
      // reviewer reads. One proposer is one source.
      expect(candidate.corroborationCount).toBe(1);
      // The pre-flight verdict the queue shares with the transaction: nothing
      // about the class is refusable, so the reviewer is not being shown a row
      // publish will then bounce.
      expect(candidate.promotionBlock).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "approval publishes — the existing gate carries the new class",
    async () => {
      const ws = `ws-5483-publish-${Date.now()}`;
      const outcome = await propose(ws);
      expect(outcome.kind).toBe("proposed");
      if (outcome.kind !== "proposed") return;
      const factId = outcome.result.factId;

      const report = await publish(ws);
      expect(report.promoted).toBe(1);
      expect(report.refused).toEqual([]);

      const row = await factRow(ws, factId);
      expect(row.status).toBe("published");
      expect(row.invalidated_at).toBeNull();

      // And it has left the review queue the way every published draft does.
      const page = await loadFactCandidates(pool, { ctx: reviewer(ws), limit: 10, offset: 0 });
      expect(page.candidates).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "rejection is retract: a tombstone plus a correction episode, never a silent delete",
    async () => {
      const ws = `ws-5483-reject-${Date.now()}`;
      const outcome = await propose(ws);
      expect(outcome.kind).toBe("proposed");
      if (outcome.kind !== "proposed") return;
      const factId = outcome.result.factId;

      const rejection = await correctFact({
        ctx: reviewer(ws),
        factId,
        verb: "retract",
        intent: "admin-ui",
        reason: "not something we want on the record",
        vocabulary: identityVocabulary,
      });
      expect(rejection.kind).toBe("corrected");

      // The tombstone, not a status write and not a delete: the row survives
      // with its review state intact, so the rejection is auditable at rest.
      const row = await factRow(ws, factId);
      expect(row.invalidated_at).not.toBeNull();
      expect(row.status).toBe("draft");

      // The auditable half: a correction episode materialized, recording the
      // reviewer's reason verbatim.
      const { rows: episodes } = await pool.query<{ source_id: string; body: string }>(
        `SELECT source_id, body FROM brain_episodes
          WHERE workspace_id = $1 AND source_id LIKE 'correction:%'`,
        [ws],
      );
      expect(episodes.length).toBe(1);
      expect(episodes[0]!.body).toContain("not something we want on the record");

      // And the queue no longer offers the rejected draft for a trust call.
      const page = await loadFactCandidates(pool, { ctx: reviewer(ws), limit: 10, offset: 0 });
      expect(page.candidates).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⭐ widening is the reviewer's act at the gate — the proposer's corroboration moves no grant",
    async () => {
      const ws = `ws-5483-widen-${Date.now()}`;
      const factId = await landNarrowDraft(ws);

      // The proposal AGREES, so it corroborates — the org-granted proposal
      // episode becomes provenance evidence for the narrow draft.
      const outcome = await propose(ws);
      expect(outcome.kind).toBe("corroborated");
      if (outcome.kind !== "corroborated") return;
      expect(outcome.result.factId).toBe(factId);
      expect(outcome.result.evidenceAdded).toBe(true);

      // Lock 3's negative half: proposing widened NOTHING. The draft's grant
      // after the corroboration is byte-identical to before it.
      expect(await grantOf(ws, factId)).toEqual([NARROW_GRANT]);

      // Lock 5's display half, on a MULTI-source row: the reviewer's own queue
      // read now shows two distinct sources — the colleague who said it and
      // the proposer who vouched for it. The single-source case is pinned in
      // the first test; this is the count a reviewer actually weighs when
      // deciding whether corroborated testimony earns a wider audience.
      const queueBefore = await loadFactCandidates(pool, {
        ctx: reviewer(ws, ["chat-channel:slack:C0PRIVATE"]),
        limit: 10,
        offset: 0,
      });
      expect(queueBefore.candidates.length).toBe(1);
      expect(queueBefore.candidates[0]!.corroborationCount).toBe(2);

      // The reviewer is TOLD before they act: the widening preview names the
      // fact and the exact token the evidence will add. The reviewer must be
      // in the narrow audience to see the row at all — the preview is
      // reader-scoped, which is itself part of the disclosure design.
      const preview = await loadWideningPreview(
        pool,
        reviewer(ws, ["chat-channel:slack:C0PRIVATE"]),
      );
      const entry = preview.entries.find((e) => e.factId === factId);
      expect(entry, "the coming widening must be disclosed to the reviewer before publish").toBeDefined();
      expect(entry?.added).toEqual([ORG_PRINCIPAL]);

      // Lock 3's positive half: publish — the reviewer's act — performs the
      // widening, reports it, and records the pre-widening grant for #4836's
      // read-time attribution narrowing.
      const report = await publish(ws);
      expect(report.widened).toEqual([{ rowId: factId, added: [ORG_PRINCIPAL] }]);

      const row = await factRow(ws, factId);
      expect(row.status).toBe("published");
      expect(row.visible_to).toEqual([NARROW_GRANT, ORG_PRINCIPAL]);
      expect(row.pre_widening_visible_to).toEqual([NARROW_GRANT]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
