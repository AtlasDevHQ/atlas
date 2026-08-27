/**
 * **Corroboration weights distinct SOURCES, not distinct episodes** (#5487,
 * [ADR-0036](../../../../../../docs/adr/0036-atlas-as-company-brain.md) §T9
 * lock 5).
 *
 * Lock 5: *"re-proposal strengthens (adds a provenance edge, **weighting**
 * distinct sources so self-echo is idempotent), never duplicates; the
 * distinct-source count is surfaced to the reviewer."*
 *
 * The number that shipped was `COUNT(DISTINCT ed.to_episode_id)` — a count of
 * EPISODES — written out at three call sites and rendered to humans as
 * **"Sources"** in five, including the review queue's own column header. Two
 * messages from one person are two episodes and one source, so a reviewer read
 * *"2 corroborating sources"* over one voice.
 *
 * ## What this file pins, and what it deliberately does NOT
 *
 * ⚠️ **Every cell asserts the EDGE COUNT is unchanged.** Lock 5 says the edge is
 * added and the *weighting* is by source, and the edge set is load-bearing three
 * times over beyond the count — it is `staleness.ts`'s decay anchor, it is
 * `promotion.ts`'s grant-widening input, and it is the audit record of which
 * episodes back a claim. An earlier draft of this fix put the rule in
 * `INSERT_PROVENANCE_EDGE_SQL`'s guard instead; that would have made a second
 * `re-authority` vouch by one admin write no edge, move no anchor, and report
 * success — *"the verb would report an effect nobody can observe"*, which #4939
 * refuses by name. The edge assertions below are what keep this fix from
 * drifting back into that.
 *
 * ## The six cells
 *
 * | second episode | edges | sources | what breaks if the source count flips |
 * |---|---|---|---|
 * | same actor, same claim | 2 | **1** | ⭐ #5487 — the self-echo, inflated |
 * | two different actors | 2 | 2 | independent testimony erased — worse than the defect |
 * | one actor, two connectors | 2 | 2 | a merge Atlas cannot prove (`slack:U1` ≠ `zoom:U1`) |
 * | warehouse producer, twice | 2 | 2 | ⚠️ every warehouse reading ever taken reads as ONE (below) |
 * | no `source_actor`, twice | 2 | 2 | an unattributable episode suppressing a real one |
 * | the same episode, twice | 1 | 1 | the shipped idempotence, lost |
 *
 * ⚠️ **Row 4 is the cell a principal-keyed count destroys by default, and it is
 * not hypothetical.** `warehouse-producer.ts` stamps EVERY snapshot episode with
 * the same `source_actor` — the constant `WAREHOUSE_PRODUCER_PRINCIPAL` — so a
 * count keyed on the principal with no machine arm reports one corroboration for
 * a workspace's entire warehouse history, permanently and silently. That is why
 * `distinctSourceSql` exempts machines, and why the exemption has a cell here
 * rather than only a docstring.
 *
 * Row 3 is the one whose verdict surprises: the principal is `source:actor`, so
 * one vendor id under two connectors is two handles. Atlas cannot prove they are
 * one person, and abstaining OUT keeps evidence rather than merging it away.
 *
 * Row 6 is the shipped property, asserted because the change must be ADDITIVE:
 * a test that only proves the new behaviour cannot see that it stopped proving
 * the old one.
 *
 * ## Why `-pg` and not the unit lane
 *
 * `reconcile.test.ts`'s fake dispatches on each SQL constant's string identity
 * and reads its binds positionally, so it *"cannot tell which COLUMNS a
 * statement names"* (#5021) — and the count is a spliced sub-SELECT with no bind
 * at all, evaluated entirely by Postgres. A fake that never has a database
 * cannot see it. This file is the proof.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { ORG_PRINCIPAL } from "@atlas/api/lib/brain/acl";
import { SLACK_SOURCE, WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  WAREHOUSE_PRODUCER_PRINCIPAL,
} from "@atlas/api/lib/brain/warehouse-producer";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import { corroborationCountSql } from "@atlas/api/lib/brain/actor-identity";
import {
  reconcileFacts,
  type ReconcileEpisodeRef,
  type ReconcileReport,
} from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/** The claim every cell makes, byte-identical, so only the SOURCE ever varies. */
const SUBJECT = "Dharma";
const PREDICATE = "plan_tier";
const OBJECT = "trial";

describeIfPg("corroboration weights distinct sources (#5487)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5487_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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

  // ── seeding ─────────────────────────────────────────────────────────────

  let seq = 0;

  /**
   * One episode, with `source` and `source_actor` the ONLY things that vary.
   *
   * `sourceActor` is passed through to the returned {@link ReconcileEpisodeRef}
   * as well as written to the row, because `reconcile.ts` reads the ref for
   * `resolvedPrincipal` while the new guard reads the ROW — and a test whose
   * two copies disagreed would be asserting against a state production cannot
   * produce.
   */
  async function seedEpisode(
    workspaceId: string,
    source: string,
    sourceActor: string | null,
  ): Promise<ReconcileEpisodeRef> {
    const sourceId = `${source}:${++seq}`;
    const occurredAt = new Date(`2026-08-${10 + (seq % 15)}T09:00:00.000Z`);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, $2, $3, $4, 'evidence', $5::timestamptz, $6::text[])
       RETURNING id`,
      [workspaceId, source, sourceId, sourceActor, occurredAt.toISOString(), [ORG_PRINCIPAL]],
    );
    return {
      id: rows[0]!.id,
      workspaceId,
      source,
      sourceId,
      sourceActor,
      occurredAt,
      visibleTo: [ORG_PRINCIPAL],
    };
  }

  /**
   * Reconcile the ONE claim through the real stage.
   *
   * `sourcePrincipal` is passed only where a producer really passes one — the
   * warehouse cell — because that divergence between the attribution and the
   * dedupe key is the thing the machine cell exists to pin.
   */
  async function land(
    workspaceId: string,
    episode: ReconcileEpisodeRef,
    sourcePrincipal?: string,
  ): Promise<ReconcileReport> {
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      ...(sourcePrincipal === undefined ? {} : { sourcePrincipal }),
      candidates: [{ subject: SUBJECT, predicate: PREDICATE, object: OBJECT }],
      producer: "distinct-source",
      extractedAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    // A PRECONDITION, asserted where every cell inherits it: `reconcileFacts`
    // returns domain refusals as counted outcomes and never throws, so a
    // candidate that tripped a block would land zero rows and every count below
    // would pass against an empty table.
    expect(
      report.outcomes[0],
      `the ${episode.source} claim was refused, not landed — every assertion downstream is vacuous`,
    ).not.toMatchObject({ kind: "blocked" });
    return report;
  }

  // ── reading back ────────────────────────────────────────────────────────

  /** Raw `provenance` edges on the workspace's one fact. */
  async function edgeCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'provenance'`,
      [workspaceId],
    );
    return Number(rows[0]!.n);
  }

  /** Exactly one fact, always — corroboration must never duplicate the claim. */
  async function factCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM brain_facts WHERE workspace_id = $1`,
      [workspaceId],
    );
    return Number(rows[0]!.n);
  }

  /**
   * The number the REVIEWER reads, through the real review-queue loader.
   *
   * Not a hand-written `COUNT` over the same edges: the point of asserting it is
   * that `corroborationCountSql` is spliced into a query nobody edits with this
   * test in mind, and a re-derivation here would go on agreeing with itself
   * after the real one drifted.
   */
  async function reviewerCount(workspaceId: string): Promise<number> {
    const page = await loadFactCandidates(pool, {
      ctx: {
        origin: "authenticated",
        workspaceId,
        userId: "reviewer",
        role: "admin",
        audienceIds: [],
      },
      limit: 10,
      offset: 0,
    });
    expect(page.candidates.length, "expected exactly one candidate to review").toBe(1);
    return page.candidates[0]!.corroborationCount;
  }

  /**
   * The same number, read straight off {@link corroborationCountSql}.
   *
   * ⚠️ Needed because {@link reviewerCount} cannot reach an OBSERVATION: under
   * [ADR-0042](../../../../../../docs/adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md)
   * a warehouse-produced row is never queued, so `loadFactCandidates` returns an
   * empty page for the machine cell — and that cell is precisely the one where
   * the count and the guard most need pinning together, since it is the one the
   * machine exemption governs.
   *
   * Still not a re-derivation: it runs the EXPORTED builder the three call sites
   * splice, so an edit to the expression moves this assertion too.
   */
  async function countExpressionValue(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT ${corroborationCountSql("f")} AS n
         FROM brain_facts f
        WHERE f.workspace_id = $1`,
      [workspaceId],
    );
    expect(rows.length, "expected exactly one fact to count against").toBe(1);
    return rows[0]!.n;
  }

  // ── the six cells ───────────────────────────────────────────────────────

  it(
    "⭐ the SAME actor restating the same claim weighs ONCE, and both episodes stay on the record",
    async () => {
      const ws = `ws-self-echo-${Date.now()}`;
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, "U-alice"));
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, "U-alice"));

      expect(await factCount(ws), "corroboration must never duplicate the fact").toBe(1);
      expect(
        await edgeCount(ws),
        "BOTH episodes stay on the record — the edge is the decay anchor and the audit trail, " +
          "and #5487 changes the weighting, never the evidence",
      ).toBe(2);
      expect(
        await reviewerCount(ws),
        "two episodes from one actor are ONE source — this is the #5487 defect and it fails before the fix",
      ).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "TWO DIFFERENT actors each strengthen — the over-correction guard",
    async () => {
      const ws = `ws-two-actors-${Date.now()}`;
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, "U-alice"));
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, "U-bob"));

      expect(await factCount(ws)).toBe(1);
      expect(await edgeCount(ws)).toBe(2);
      expect(
        await reviewerCount(ws),
        "Alice and Bob are independent testimony — a fix that merges them is worse than the defect",
      ).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the SAME actor speaking through a DIFFERENT source still strengthens",
    async () => {
      const ws = `ws-cross-source-${Date.now()}`;
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, "U-alice"));
      await land(ws, await seedEpisode(ws, "zoom", "U-alice"));

      expect(await factCount(ws)).toBe(1);
      expect(await edgeCount(ws)).toBe(2);
      expect(
        await reviewerCount(ws),
        "the principal is `source:actor`, so one vendor id under two connectors is two handles — " +
          "Atlas cannot prove they are one person, and abstaining OUT keeps evidence rather than merging it away",
      ).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⚠️ the WAREHOUSE producer re-reading is a fresh reading, not self-echo",
    async () => {
      const ws = `ws-warehouse-${Date.now()}`;
      // Exactly what `warehouse-producer.ts` writes: the same constant actor on
      // every snapshot episode, and the same constant as the explicit
      // attribution principal.
      await land(
        ws,
        await seedEpisode(ws, WAREHOUSE_SOURCE, WAREHOUSE_PRODUCER_PRINCIPAL),
        WAREHOUSE_PRODUCER_PRINCIPAL,
      );
      await land(
        ws,
        await seedEpisode(ws, WAREHOUSE_SOURCE, WAREHOUSE_PRODUCER_PRINCIPAL),
        WAREHOUSE_PRODUCER_PRINCIPAL,
      );

      expect(await factCount(ws)).toBe(1);
      expect(await edgeCount(ws)).toBe(2);
      expect(
        await countExpressionValue(ws),
        "a machine re-reading the world is a fresh reading — merging these would report a " +
          "workspace's entire warehouse history as one corroboration",
      ).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an episode with NO actor abstains OUT — every such episode still strengthens",
    async () => {
      const ws = `ws-no-actor-${Date.now()}`;
      // A grant-bearing episode Atlas cannot attribute. `reconcileFacts` refuses
      // it without an explicit principal (`SOURCE_PRINCIPAL_UNRESOLVED`), so the
      // producer supplies one — which is precisely the case where the explicit
      // principal and the row disagree, and the row is what the guard reads.
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, null), "user:carol");
      await land(ws, await seedEpisode(ws, SLACK_SOURCE, null), "user:carol");

      expect(await factCount(ws)).toBe(1);
      expect(await edgeCount(ws)).toBe(2);
      expect(
        await reviewerCount(ws),
        "a source-less episode is keyed on ITSELF, so it never merges with another — and never " +
          "reports zero, which would read as unsupported",
      ).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the SAME episode reconciled twice is still one edge — the shipped idempotence, unchanged",
    async () => {
      const ws = `ws-same-episode-${Date.now()}`;
      const episode = await seedEpisode(ws, SLACK_SOURCE, "U-alice");
      await land(ws, episode);
      await land(ws, episode);

      expect(await factCount(ws)).toBe(1);
      expect(
        await edgeCount(ws),
        "`INSERT_PROVENANCE_EDGE_SQL` is untouched — a repeated PASS was already idempotent and stays so",
      ).toBe(1);
      expect(await reviewerCount(ws)).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
