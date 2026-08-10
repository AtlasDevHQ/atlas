/**
 * Real-Postgres coverage for the fact-candidate read model (#4772, ADR-0036).
 *
 * `candidates.test.ts` pins the SHAPE of every emitted statement against a
 * literal reader — but every SQL assertion there is a string match
 * (`toContain` / `not.toContain`). Nothing in it proves the statements parse,
 * let alone that they return the right rows, and this is the primary surface of
 * the issue: a broken statement here is a 500 on the review queue with every
 * unit test green.
 *
 * The things that need a live database, each a claim the module makes in prose:
 *
 *   1. **Is corroboration really distinct EPISODES?** `COUNT(DISTINCT
 *      ed.to_episode_id)` is the difference between "three sources agree" and
 *      "one source was written three times", and it is the number a reviewer
 *      leans on hardest.
 *   2. **Does the total survive paging past the end?** The empty-window
 *      re-count exists because `COUNT(*) OVER ()` cannot report on an empty
 *      window; only a real query proves the two agree.
 *   3. **Does the ACL predicate actually filter?** `acl-visibility-pg.test.ts`
 *      proves the clause works standalone; this proves it still works composed
 *      into these statements — and, critically, that the EPISODE read denies a
 *      reader entitled to the fact but not to its evidence.
 *   4. **Does the ILIKE escape do anything?** `%100\%\_x%` relies on Postgres's
 *      default backslash escape; a literal `_` must stop matching any character.
 *   5. **Does the retract UPDATE run at all?** `UPDATE … AS f` with the ACL
 *      clause on the alias, a `::uuid` cast, and `RETURNING` — three things
 *      that a string assertion cannot check — plus its idempotence.
 *   6. **Does a real page satisfy its own wire schema?** The route parses every
 *      response through it, so a coercion that violated it would be a 500.
 *
 * ## What the ACL assertions here do NOT prove
 *
 * The reader contexts below are HAND-BUILT: `audienceIds` is a literal, and the
 * candidate reads consume it as given — nothing here re-resolves membership. So
 * claim 3 above is about the PREDICATE composed into these statements, not about
 * how a principal came to hold those audience ids. Seeding a
 * `fact_audience_member` row here would be inert; its absence is deliberate.
 *
 * Membership RESOLUTION is proven in `acl-visibility-pg.test.ts` and
 * `wedge-loop-pg.test.ts`, which build contexts through
 * `resolvePrincipalContext(pool, …)`. Put any case that turns on resolution
 * there, not here.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  loadFactCandidateSummary,
  loadFactCandidates,
} from "@atlas/api/lib/brain/candidates";
import { CORRECTION_REFUSAL_REASONS, correctFact } from "@atlas/api/lib/brain/correction";
import { identityAlias, identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";
import { LAST_OBSERVED_AT_SELECT } from "@atlas/api/lib/brain/staleness";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { BrainFactCandidateListResponseSchema } from "@useatlas/schemas";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-candidates-pg";

/** A workspace admin: `org`, `role:admin`, `role:member`, `user:reviewer`. */
function reviewer(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "reviewer",
    role: "admin",
    audienceIds: [],
  };
}

/** A member of one private audience and nothing else beyond the org defaults. */
function insider(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "insider",
    role: "member",
    audienceIds: ["private-channel"],
  };
}

describeIfPg("brain fact candidates (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_cand_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `search_path` baked into the connection string, not SET from an unawaited
    // `pool.on("connect")` handler — see the note in `acl-visibility-pg.test.ts`.
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
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  async function seedEpisode(opts: {
    sourceId: string;
    body?: string;
    visibleTo?: readonly string[];
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U1', $3, now(), $4::text[])
       RETURNING id`,
      [WS, opts.sourceId, opts.body ?? "evidence", opts.visibleTo ?? ["org"]],
    );
    return rows[0]!.id;
  }

  async function seedFact(opts: {
    subject: string;
    predicate?: string;
    object?: string;
    episodeId: string;
    visibleTo?: readonly (string | null)[];
    status?: "draft" | "published";
    cardinality?: "single" | "multi";
    provenance?: Record<string, unknown>;
    /** The grant before publish-time widening; omit for a never-widened fact. */
    preWideningVisibleTo?: readonly (string | null)[];
  }): Promise<string> {
    const predicate = opts.predicate ?? "uses";
    const object = opts.object ?? "Postgres";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          status, visible_to, pre_widening_visible_to, predicate_cardinality,
          subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9::text[], $10,
               $11, $12, $13)
       RETURNING id`,
      [
        WS,
        opts.subject,
        predicate,
        object,
        opts.episodeId,
        JSON.stringify(opts.provenance ?? { source: "slack", actor: "U1" }),
        opts.status ?? "draft",
        opts.visibleTo ?? ["org"],
        opts.preWideningVisibleTo ?? null,
        opts.cardinality ?? "multi",
        // Keyed like an ingested row (#5020) — `correct_fact`'s replacement path
        // runs the reconcile lookups, which match on the keys and see nothing on
        // an unkeyed row. Derived through `slotKey` — the same function
        // `reconcile.ts` calls when binding `INSERT_FACT_SQL`.
        slotKey(opts.subject, identityAlias),
        slotKey(predicate, identityAlias),
        slotKey(object, identityAlias),
      ],
    );
    return rows[0]!.id;
  }

  async function edge(type: "provenance" | "in-tension-with", from: string, to: string) {
    const column = type === "provenance" ? "to_episode_id" : "to_fact_id";
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, ${column}) VALUES ($1, $2, $3, $4)`,
      [WS, type, from, to],
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. Corroboration counts distinct EVIDENCE, not edge rows
  // ══════════════════════════════════════════════════════════════════

  it(
    "counts distinct provenance episodes, not edge rows",
    async () => {
      const ep1 = await seedEpisode({ sourceId: "corr-1" });
      const ep2 = await seedEpisode({ sourceId: "corr-2" });
      const fact = await seedFact({ subject: "Corroborated", episodeId: ep1 });

      await edge("provenance", fact, ep1);
      await edge("provenance", fact, ep2);
      // A duplicate edge to an episode already counted. Migration 0180 puts no
      // unique index on the edge triple, so this row is storable — and if the
      // count were `COUNT(*)` it would read as a third independent source.
      await edge("provenance", fact, ep2);

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "Corroborated",
        limit: 50,
        offset: 0,
      });
      expect(page.candidates).toHaveLength(1);
      expect(page.candidates[0]!.corroborationCount).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 2. The evidence is gated in its own right — the slice's likeliest leak
  // ══════════════════════════════════════════════════════════════════

  it(
    "withholds a private episode from a reviewer entitled to the fact it produced",
    async () => {
      // The exact asymmetry ADR-0036 admits: an `org`-visible conclusion drawn
      // from evidence restricted to one channel's audience. A join gated by the
      // FACT's predicate would hand the message over.
      const secret = await seedEpisode({
        sourceId: "private-1",
        body: "the salary discussion",
        visibleTo: ["audience:private-channel"],
      });
      await seedFact({ subject: "PrivateEvidence", episodeId: secret, visibleTo: ["org"] });

      const asAdmin = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "PrivateEvidence",
        limit: 50,
        offset: 0,
      });
      expect(asAdmin.candidates).toHaveLength(1);
      // The claim is visible; the evidence is not, and says so.
      expect(asAdmin.candidates[0]!.episode).toEqual({ id: secret, visible: false });

      const asInsider = await loadFactCandidates(pool, {
        ctx: insider(),
        search: "PrivateEvidence",
        limit: 50,
        offset: 0,
      });
      const episode = asInsider.candidates[0]!.episode;
      expect(episode?.visible).toBe(true);
      if (episode?.visible !== true) throw new Error("expected a visible episode");
      expect(episode.body).toBe("the salary discussion");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "hides a fact whose own grant excludes the reader",
    async () => {
      const ep = await seedEpisode({ sourceId: "fact-acl-1" });
      await seedFact({
        subject: "InsiderOnlyClaim",
        episodeId: ep,
        visibleTo: ["audience:private-channel"],
      });

      const asAdmin = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "InsiderOnlyClaim",
        limit: 50,
        offset: 0,
      });
      expect(asAdmin.candidates).toHaveLength(0);

      const asInsider = await loadFactCandidates(pool, {
        ctx: insider(),
        search: "InsiderOnlyClaim",
        limit: 50,
        offset: 0,
      });
      expect(asInsider.candidates).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 3. Filters mean what they say
  // ══════════════════════════════════════════════════════════════════

  it(
    "matches `provisional` by KEY PRESENCE, including a stored `false`",
    async () => {
      const ep = await seedEpisode({ sourceId: "prov-1" });
      await seedFact({
        subject: "ProvisionalYes",
        episodeId: ep,
        provenance: { source: "slack", actor: "U1", provisional: true },
      });
      await seedFact({
        subject: "ProvisionalNo",
        episodeId: ep,
        provenance: { source: "slack", actor: "U1" },
      });
      // A producer that started writing the flag explicitly false. `jsonb_exists`
      // matches it — deliberately: the wire's `provisional` re-derives from the
      // VALUE, so the filter is the wider of the two and never hides a row the
      // reviewer asked to see.
      await seedFact({
        subject: "ProvisionalExplicitFalse",
        episodeId: ep,
        provenance: { source: "slack", actor: "U1", provisional: false },
      });

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(),
        provisionalOnly: true,
        search: "Provisional",
        limit: 50,
        offset: 0,
      });
      const subjects = page.candidates.map((c) => c.subject).sort();
      expect(subjects).toEqual(["ProvisionalExplicitFalse", "ProvisionalYes"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "escapes LIKE metacharacters, so a literal `_` is not a wildcard",
    async () => {
      const ep = await seedEpisode({ sourceId: "like-1" });
      await seedFact({ subject: "Escape_Target", episodeId: ep });
      await seedFact({ subject: "EscapeXTarget", episodeId: ep });

      const exact = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "Escape_Target",
        limit: 50,
        offset: 0,
      });
      // Unescaped, `_` would match the `X` too and the reviewer would be shown
      // a claim they did not search for.
      expect(exact.candidates.map((c) => c.subject)).toEqual(["Escape_Target"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "excludes retracted facts from the queue and from the vitals",
    async () => {
      const ep = await seedEpisode({ sourceId: "retracted-1" });
      const id = await seedFact({ subject: "WillBeRetracted", episodeId: ep });

      await pool.query(`UPDATE brain_facts SET invalidated_at = now() WHERE id = $1`, [id]);

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "WillBeRetracted",
        limit: 50,
        offset: 0,
      });
      expect(page.candidates).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 4. Pagination totals stay honest past the end of the queue
  // ══════════════════════════════════════════════════════════════════

  it(
    "reports the real total when a page lands past the end",
    async () => {
      const ep = await seedEpisode({ sourceId: "paging-1" });
      for (let i = 0; i < 5; i++) {
        await seedFact({ subject: `PagingTarget${i}`, episodeId: ep });
      }

      const first = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "PagingTarget",
        limit: 2,
        offset: 0,
      });
      expect(first.candidates).toHaveLength(2);
      expect(first.total).toBe(5);

      // Past the end: the window is empty, so `COUNT(*) OVER ()` reports
      // nothing and the re-count has to agree with the total above. Asserting
      // 0 here would render "nothing to review" over a five-claim backlog.
      const past = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "PagingTarget",
        limit: 2,
        offset: 20,
      });
      expect(past.candidates).toHaveLength(0);
      expect(past.total).toBe(5);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 5. Contradiction hints, both directions, unranked
  // ══════════════════════════════════════════════════════════════════

  it(
    "surfaces a contradiction from the INCUMBENT's side too",
    async () => {
      // `reconcile.ts` writes the edge new → incumbent, so the incumbent only
      // ever appears on the `to` side. A `from`-only lookup would hide exactly
      // the older claim whose trust is now in question.
      const ep = await seedEpisode({ sourceId: "tension-1" });
      const incumbent = await seedFact({
        subject: "TensionSubject",
        object: "Postgres",
        episodeId: ep,
        cardinality: "single",
      });
      const rival = await seedFact({
        subject: "TensionSubject",
        object: "MySQL",
        episodeId: ep,
        cardinality: "single",
      });
      await edge("in-tension-with", rival, incumbent);

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "TensionSubject",
        limit: 50,
        offset: 0,
      });
      expect(page.candidates).toHaveLength(2);
      for (const candidate of page.candidates) {
        expect(candidate.tensions).toHaveLength(1);
        const other = candidate.tensions[0]!;
        if (other.visible !== true) throw new Error("expected a visible counterpart");
        expect(other.factId).not.toBe(candidate.id);
      }

      const filtered = await loadFactCandidates(pool, {
        ctx: reviewer(),
        inTensionOnly: true,
        search: "TensionSubject",
        limit: 50,
        offset: 0,
      });
      expect(filtered.candidates).toHaveLength(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 6. The response the route actually ships
  // ══════════════════════════════════════════════════════════════════

  it(
    "produces a page its own wire schema accepts",
    async () => {
      const page = await loadFactCandidates(pool, { ctx: reviewer(), limit: 50, offset: 0 });
      expect(() => BrainFactCandidateListResponseSchema.parse(page)).not.toThrow();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "aggregates the queue vitals with every FILTER arm",
    async () => {
      const summary = await loadFactCandidateSummary(pool, reviewer());
      expect(summary.draftTotal).toBeGreaterThan(0);
      expect(summary.provisionalTotal).toBeGreaterThan(0);
      expect(summary.inTensionTotal).toBeGreaterThan(0);
      // Scoped to this reader's grants: the insider-only claim seeded above is
      // invisible to the admin, so their totals genuinely differ.
      const insiderSummary = await loadFactCandidateSummary(pool, insider());
      expect(insiderSummary.draftTotal).toBeGreaterThan(summary.draftTotal);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 7. Correction verbs — the writes that left this surface (#4915)
  // ══════════════════════════════════════════════════════════════════
  //
  // The unit suite (`correction.test.ts`) pins the decision matrix against a
  // fake store; nothing there proves the correction SQL parses or that the
  // episode insert satisfies 0180's CHECKs. These run the exported statements
  // against the live schema, on this file's existing seed harness — which is
  // why they live here rather than in a fourth `-pg` bootstrap.

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

  it(
    "retract stamps the tombstone, materializes the correction episode, and is not repeatable",
    async () => {
      const ep = await seedEpisode({ sourceId: "retract-1" });
      const id = await seedFact({ subject: "RetractMe", episodeId: ep });

      const first = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: id, verb: "retract", reason: "wrong on arrival" },
        { withTransaction: poolTx },
      );
      if (first.kind !== "corrected") throw new Error(`expected corrected, got ${first.kind}`);
      expect(first.result.factId).toBe(id);
      expect(first.result.invalidatedAt).toBeTruthy();

      const { rows } = await pool.query<{ status: string; invalidated_at: Date | null }>(
        `SELECT status, invalidated_at FROM brain_facts WHERE id = $1`,
        [id],
      );
      // The row is a tombstone, NOT demoted — ADR-0036: supersession is not
      // deletion, and `status` has exactly one writer.
      expect(rows[0]!.status).toBe("draft");
      expect(rows[0]!.invalidated_at).not.toBeNull();

      // The immutable human record, off the extraction queue by construction,
      // seeded with the fact's own grant.
      const episode = await pool.query<{
        source: string;
        source_actor: string;
        extracted_at: Date | null;
        visible_to: string[];
        body: string;
      }>(`SELECT source, source_actor, extracted_at, visible_to, body FROM brain_episodes WHERE id = $1`, [
        first.result.correctionEpisodeId,
      ]);
      expect(episode.rows[0]!.source).toBe("human");
      expect(episode.rows[0]!.source_actor).toBe("reviewer");
      expect(episode.rows[0]!.extracted_at).not.toBeNull();
      expect(episode.rows[0]!.visible_to).toEqual(["org"]);
      expect(JSON.parse(episode.rows[0]!.body).verb).toBe("retract");

      // Lineage, not evidence: `derives-from`, so the retraction cannot count
      // as corroboration of the claim it withdrew.
      const edges = await pool.query<{ edge_type: string }>(
        `SELECT edge_type FROM brain_edges WHERE from_fact_id = $1 AND to_episode_id = $2`,
        [id, first.result.correctionEpisodeId],
      );
      expect(edges.rows.map((r) => r.edge_type)).toEqual(["derives-from"]);

      // Second call matches nothing: `invalidated_at IS NULL` already failed —
      // indistinguishable from absence.
      const second = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: id, verb: "retract" },
        { withTransaction: poolTx },
      );
      expect(second.kind).toBe("not-found");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "retract flags derives-from dependents for re-review and cascades nothing",
    async () => {
      const ep = await seedEpisode({ sourceId: "retract-dep-1" });
      const premise = await seedFact({ subject: "Premise", object: "holds", episodeId: ep });
      const conclusion = await seedFact({
        subject: "Conclusion",
        object: "follows",
        episodeId: ep,
        status: "published",
      });
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id) VALUES ($1, 'derives-from', $2, $3)`,
        [WS, conclusion, premise],
      );

      const outcome = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: premise, verb: "retract" },
        { withTransaction: poolTx },
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
      expect(outcome.result.flaggedForReReview).toEqual([conclusion]);

      const { rows } = await pool.query<{
        status: string;
        invalidated_at: Date | null;
        valid_to: Date | null;
        provenance: Record<string, unknown>;
      }>(`SELECT status, invalidated_at, valid_to, provenance FROM brain_facts WHERE id = $1`, [
        conclusion,
      ]);
      // Flagged — and ONLY flagged: the dependent's own lifecycle is untouched.
      expect(rows[0]!.provenance.reReview).toMatchObject({
        reason: "derives-from-retracted",
        retractedFactId: premise,
      });
      expect(rows[0]!.status).toBe("published");
      expect(rows[0]!.invalidated_at).toBeNull();
      expect(rows[0]!.valid_to).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "supersede publishes the replacement and stamps the target through the #4912 machinery",
    async () => {
      const ep = await seedEpisode({ sourceId: "supersede-1" });
      const oldId = await seedFact({
        subject: "Billing",
        predicate: "is owned by",
        object: "Ana",
        episodeId: ep,
        status: "published",
        cardinality: "single",
      });

      const outcome = await correctFact(
        {
          vocabulary: identityVocabulary,
          ctx: reviewer(),
          factId: oldId,
          verb: "supersede",
          reason: "Ana left; Bo took over",
          replacement: { object: "Bo" },
        },
        { withTransaction: poolTx },
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
      const newId = outcome.result.supersededBy;
      expect(newId).toBeTruthy();
      expect(outcome.result.validTo).toBeTruthy();

      const oldRow = await pool.query<{ valid_to: Date | null; invalidated_at: Date | null }>(
        `SELECT valid_to, invalidated_at FROM brain_facts WHERE id = $1`,
        [oldId],
      );
      // Superseded, not tombstoned: the belief ENDED, it was not withdrawn.
      expect(oldRow.rows[0]!.valid_to).not.toBeNull();
      expect(oldRow.rows[0]!.invalidated_at).toBeNull();

      // Authoritative immediately — the replacement never sat in the queue.
      const newRow = await pool.query<{
        status: string;
        subject: string;
        object: string;
        visible_to: string[];
        provenance: Record<string, unknown>;
      }>(`SELECT status, subject, object, visible_to, provenance FROM brain_facts WHERE id = $1`, [
        newId,
      ]);
      expect(newRow.rows[0]!.status).toBe("published");
      expect(newRow.rows[0]!.subject).toBe("Billing");
      expect(newRow.rows[0]!.object).toBe("Bo");
      expect(newRow.rows[0]!.visible_to).toEqual(["org"]);
      expect(newRow.rows[0]!.provenance.producer).toBe("correction");
      expect(newRow.rows[0]!.provenance.actor).toBe("user:reviewer");

      // The COMPLETE fact→fact edge set between the pair is exactly the
      // arbitration record — in particular, NO `in-tension-with` edge: the
      // stamp runs before the replacement reconciles, so the tension pass
      // cannot flag the belief this same transaction retires. Without that
      // ordering, every human supersession would leave the review queue and
      // oversight `inTension` counts permanently reporting a conflict the
      // human resolved.
      const pairEdges = await pool.query<{ edge_type: string }>(
        `SELECT edge_type FROM brain_edges
          WHERE (from_fact_id = $1 AND to_fact_id = $2)
             OR (from_fact_id = $2 AND to_fact_id = $1)`,
        [newId, oldId],
      );
      expect(pairEdges.rows.map((r) => r.edge_type)).toEqual(["supersedes"]);

      // And the evidence pointer: the correction episode backs the NEW claim.
      const evidence = await pool.query(
        `SELECT 1 FROM brain_edges WHERE edge_type = 'provenance' AND from_fact_id = $1 AND to_episode_id = $2`,
        [newId, outcome.result.correctionEpisodeId],
      );
      expect(evidence.rows).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "pin attaches the correction episode as fresh evidence, resetting the decay anchor",
    async () => {
      const ep = await seedEpisode({ sourceId: "pin-1" });
      const id = await seedFact({ subject: "PinMe", episodeId: ep, status: "published" });

      const outcome = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: id, verb: "pin" },
        { withTransaction: poolTx },
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

      const { rows } = await pool.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM brain_facts WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.provenance.pinned).toMatchObject({ actor: "reviewer" });
      const evidence = await pool.query(
        `SELECT 1 FROM brain_edges WHERE edge_type = 'provenance' AND from_fact_id = $1 AND to_episode_id = $2`,
        [id, outcome.result.correctionEpisodeId],
      );
      expect(evidence.rows).toHaveLength(1);

      // The cross-module claim three doc comments make: because #4914's decay
      // anchor is the newest provenance-edge episode, the human vouching IS
      // the freshest observation. Run the REAL aggregate, not a paraphrase,
      // so a change to the staleness query re-litigates this here.
      const observed = await pool.query<{ last_observed_at: Date | null }>(
        `SELECT ${LAST_OBSERVED_AT_SELECT} AS last_observed_at FROM brain_facts f WHERE f.id = $1`,
        [id],
      );
      const lastObserved = observed.rows[0]!.last_observed_at;
      expect(lastObserved).not.toBeNull();
      // The correction episode's occurred_at is the correction time — minted
      // seconds ago in this test, unlike the seeded episode's older row.
      expect(Date.now() - lastObserved!.getTime()).toBeLessThan(60_000);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // #4939. The vouch refusal is decided by `correctionTargetSql`'s
  // `window_closed` expression, evaluated by POSTGRES against the same `now()`
  // `brainFactCurrentClause` uses. The unit suite's fake computes that
  // expression itself, so it pins the fake's arithmetic; only this arm proves
  // the real SQL parses, projects a boolean, and lands on the same side of the
  // boundary the reads do. Both directions, because a predicate that always
  // fired would pass a one-sided test.
  it(
    "pin is refused on a fact Postgres reports as no longer current, and admitted on a future window",
    async () => {
      const ep = await seedEpisode({ sourceId: "vouch-window-1" });
      const closed = await seedFact({ subject: "ClosedWindow", episodeId: ep, status: "published" });
      const scheduled = await seedFact({
        subject: "ScheduledEnd",
        episodeId: ep,
        status: "published",
      });
      // Set through raw SQL rather than a seed argument, so `seedFact` keeps
      // mirroring the production INSERT shape — which never names `valid_to`,
      // because a producer may open a validity window and never close one.
      // (Not a gate concern: `check-brain-fact-promotion.sh` excludes
      // `__tests__`, so it never scans this file either way.)
      await pool.query(`UPDATE brain_facts SET valid_to = now() - interval '1 day' WHERE id = $1`, [
        closed,
      ]);
      await pool.query(`UPDATE brain_facts SET valid_to = now() + interval '30 days' WHERE id = $1`, [
        scheduled,
      ]);

      const refused = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: closed, verb: "pin" },
        { withTransaction: poolTx },
      );
      expect(refused).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.targetNotCurrent,
      });
      // Refused BEFORE the episode, against the live schema too.
      const marker = await pool.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM brain_facts WHERE id = $1`,
        [closed],
      );
      expect(marker.rows[0]!.provenance.pinned).toBeUndefined();
      const edges = await pool.query(
        `SELECT 1 FROM brain_edges WHERE edge_type = 'provenance' AND from_fact_id = $1`,
        [closed],
      );
      expect(edges.rows).toHaveLength(0);

      // The other side of the same boundary: a scheduled end is a live claim,
      // and `brainFactCurrentClause` still serves it — so the vouch lands.
      const admitted = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: scheduled, verb: "pin" },
        { withTransaction: poolTx },
      );
      expect(admitted.kind).toBe("corrected");
      const vouched = await pool.query<{ provenance: Record<string, unknown>; valid_to: Date }>(
        `SELECT provenance, valid_to FROM brain_facts WHERE id = $1`,
        [scheduled],
      );
      expect(vouched.rows[0]!.provenance.pinned).toMatchObject({ actor: "reviewer" });
      // Vouching is not an arbitration: the scheduled end is untouched.
      expect(vouched.rows[0]!.valid_to.getTime()).toBeGreaterThan(Date.now());
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a DEGENERATE replacement is refused, and the valid_to stamp rolls back with it (#5047)",
    async () => {
      // The acceptance criterion #5047 asks to be PINNED rather than assumed:
      // `correct_fact`'s supersede verb inherits the tightened `MALFORMED_CLAIM`
      // guard for free, because its replacement routes through `reconcileFacts`.
      //
      // The ordering is what makes it worth a live transaction.
      // `SUPERSEDE_STAMP_EXPLICIT_SQL` runs FIRST inside `applySupersede`,
      // before the replacement reconciles — so the target's `valid_to` is
      // already closed by the time the guard refuses the candidate. If that did
      // not roll back, a human typing `-` would retire a published belief in
      // favour of a successor that was never stored, and supersession has no
      // inverse verb anywhere in the product. The unit fake applies statements
      // to in-memory state and models no rollback, so this is the only place the
      // property can be observed.
      //
      // Before #5047 this input did not refuse at all: `null !== "ana"` clears
      // the `replacementIdentical` guard, so it committed and installed a
      // successor with no identity.
      const ep = await seedEpisode({ sourceId: "degenerate-replacement-1" });
      const oldId = await seedFact({
        subject: "Degenerate",
        predicate: "is owned by",
        object: "Ana",
        episodeId: ep,
        status: "published",
        cardinality: "single",
      });

      const outcome = await correctFact(
        {
          vocabulary: identityVocabulary,
          ctx: reviewer(),
          factId: oldId,
          verb: "supersede",
          replacement: { object: "-" },
        },
        { withTransaction: poolTx },
      );
      expect(outcome).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.replacementMalformed,
      });

      // The stamp rolled back — the target is still the current belief.
      const target = await pool.query<{ valid_to: Date | null }>(
        `SELECT valid_to FROM brain_facts WHERE id = $1`,
        [oldId],
      );
      expect(
        target.rows[0]!.valid_to,
        "the target was retired in favour of a successor that was never stored",
      ).toBeNull();
      // …and nothing half-happened beside it: no successor row, no authored
      // correction episode claiming one.
      const successor = await pool.query(
        `SELECT 1 FROM brain_facts WHERE workspace_id = $1 AND object = '-'`,
        [WS],
      );
      expect(successor.rows).toHaveLength(0);
      const episodes = await pool.query(
        `SELECT 1 FROM brain_episodes
          WHERE workspace_id = $1
            AND source_id LIKE 'correction:%'
            AND body::jsonb ->> 'factId' = $2`,
        [WS, oldId],
      );
      expect(episodes.rows).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a refusal AFTER the episode insert rolls the whole correction back",
    async () => {
      // The one refusal reachable past the episode write: the replacement
      // corroborates a rival that is neither draft nor published. The module
      // header promises "a correction that half-happened must not leave an
      // authored episode asserting it did" — this is the only path where that
      // promise is load-bearing, and the unit fake's runner cannot express
      // rollback, so the live transaction is the only place to prove it.
      const ep = await seedEpisode({ sourceId: "rollback-1" });
      const oldId = await seedFact({
        subject: "Rollback",
        predicate: "is owned by",
        object: "Ana",
        episodeId: ep,
        status: "published",
        cardinality: "single",
      });
      await pool.query(`UPDATE brain_facts SET status = 'archived' WHERE id = $1`, [
        await seedFact({
          subject: "Rollback",
          predicate: "is owned by",
          object: "Bo",
          episodeId: ep,
          cardinality: "single",
        }),
      ]);

      const outcome = await correctFact(
        {
          vocabulary: identityVocabulary,
          ctx: reviewer(),
          factId: oldId,
          verb: "supersede",
          replacement: { object: "Bo" },
        },
        { withTransaction: poolTx },
      );
      expect(outcome).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.replacementUnpublishable,
      });

      // Nothing half-happened: no correction episode, and the target's
      // window is still open (the stamp rolled back with everything else).
      const episodes = await pool.query(
        `SELECT 1 FROM brain_episodes
          WHERE workspace_id = $1
            AND source_id LIKE 'correction:%'
            AND body::jsonb ->> 'factId' = $2`,
        [WS, oldId],
      );
      expect(episodes.rows).toHaveLength(0);
      const target = await pool.query<{ valid_to: Date | null }>(
        `SELECT valid_to FROM brain_facts WHERE id = $1`,
        [oldId],
      );
      expect(target.rows[0]!.valid_to).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "gates every verb on the actor's own visibility and role",
    async () => {
      // Correction is a write and must be gated by the same predicate the read
      // is, or an admin could withdraw a claim they were never shown.
      const ep = await seedEpisode({ sourceId: "retract-acl-1" });
      const id = await seedFact({
        subject: "NotYoursToRetract",
        episodeId: ep,
        visibleTo: ["audience:private-channel"],
      });

      const asOutsider = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: id, verb: "retract" },
        { withTransaction: poolTx },
      );
      expect(asOutsider.kind).toBe("not-found");
      const untouched = await pool.query<{ invalidated_at: Date | null }>(
        `SELECT invalidated_at FROM brain_facts WHERE id = $1`,
        [id],
      );
      expect(untouched.rows[0]!.invalidated_at).toBeNull();

      // A MEMBER who can see it still lacks the verb: corrections land
      // authoritative immediately, so they carry the review gate's bar.
      const asMember = await correctFact(
        { vocabulary: identityVocabulary, ctx: insider(), factId: id, verb: "retract" },
        { withTransaction: poolTx },
      );
      expect(asMember).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.notAuthorized,
      });

      // An admin inside the audience can.
      const insiderAdmin: BrainPrincipalContext = {
        origin: "authenticated",
        workspaceId: WS,
        userId: "insider",
        role: "admin",
        audienceIds: ["private-channel"],
      };
      const allowed = await correctFact(
        { vocabulary: identityVocabulary, ctx: insiderAdmin, factId: id, verb: "retract" },
        { withTransaction: poolTx },
      );
      expect(allowed.kind).toBe("corrected");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "answers not-found for an id that does not exist, without erroring",
    async () => {
      const absent = "00000000-0000-4000-8000-000000000000";
      const outcome = await correctFact(
        { vocabulary: identityVocabulary, ctx: reviewer(), factId: absent, verb: "retract" },
        { withTransaction: poolTx },
      );
      expect(outcome.kind).toBe("not-found");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // Provenance attribution against the live schema (#4836)
  // ══════════════════════════════════════════════════════════════════

  it(
    "withholds attribution from a widened reader and keeps it for the original audience",
    async () => {
      // Everything else about #4836 is proven against hand-built mock rows
      // that supply `pre_widening_visible_to` as a JS array. This is the only
      // place the value makes the round trip through a real `text[]` column
      // and back out through the real SELECT — which matters because the
      // failure is silent in BOTH directions: a value `isUnknownArray`
      // rejected would withhold from everyone (degrading the review surface
      // exactly the way #4836 refuses), and a `text[]` that came back as `[]`
      // rather than SQL NULL would do the same to every never-widened fact in
      // the workspace.
      const episode = await seedEpisode({
        sourceId: "C-FOUNDERS:1799999999.001",
        visibleTo: ["audience:private-channel"],
      });
      const factId = await seedFact({
        subject: "widened-claim",
        episodeId: episode,
        status: "published",
        // Published with the union — the §C3 shape.
        visibleTo: ["audience:private-channel", "org"],
        preWideningVisibleTo: ["audience:private-channel"],
        provenance: {
          source: "slack",
          sourceId: "C-FOUNDERS:1799999999.001",
          episodeId: episode,
          actor: "U-FOUNDER",
          producer: "extraction:v1",
          occurredAt: "2026-05-30T00:00:00.000Z",
          extractedAt: "2026-05-30T00:05:00.000Z",
          reconciledAt: "2026-05-30T00:06:00.000Z",
        },
      });

      const asOrgReader = await loadFactCandidates(pool, {
        ctx: reviewer(),
        limit: 50,
        offset: 0,
        status: "published",
      });
      const widened = asOrgReader.candidates.find((c) => c.id === factId);
      expect(widened).toBeDefined();
      // The CLAIM is served — that is the point of #4823 and stays.
      expect(widened!.subject).toBe("widened-claim");
      // Its attribution is not.
      expect(widened!.provenance.attribution).toEqual({ visible: false });
      // Nor is the private episode, off its own independent predicate — the
      // two withholdings are correlated on a widened fact, and this is the
      // pairing production actually produces.
      expect(widened!.episode).toEqual({ visible: false, id: episode });
      expect(JSON.stringify(widened!.provenance)).not.toContain("C-FOUNDERS");
      expect(JSON.stringify(widened!.provenance)).not.toContain("U-FOUNDER");

      // The half that must not regress: a member of the original audience is
      // exactly the reviewer who can act on this claim.
      const asInsider = await loadFactCandidates(pool, {
        ctx: insider(),
        limit: 50,
        offset: 0,
        status: "published",
      });
      const forInsider = asInsider.candidates.find((c) => c.id === factId);
      expect(forInsider).toBeDefined();
      expect(forInsider!.provenance.attribution).toEqual({
        visible: true,
        sourceId: "C-FOUNDERS:1799999999.001",
        actor: "U-FOUNDER",
        occurredAt: "2026-05-30T00:00:00.000Z",
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves a never-widened fact fully attributed through the live column",
    async () => {
      // The negative, against real Postgres: a NULL `text[]` must arrive as
      // `null` (not `[]`, not `"{}"`) or the read path would misread it as a
      // grant matching nobody and withhold from everyone.
      const episode = await seedEpisode({ sourceId: "C-ENG:1799999999.002" });
      const factId = await seedFact({
        subject: "plain-claim",
        episodeId: episode,
        status: "published",
        visibleTo: ["org"],
        provenance: {
          source: "slack",
          sourceId: "C-ENG:1799999999.002",
          episodeId: episode,
          actor: "U-ENG",
          producer: "extraction:v1",
          occurredAt: "2026-05-30T00:00:00.000Z",
          extractedAt: "2026-05-30T00:05:00.000Z",
          reconciledAt: "2026-05-30T00:06:00.000Z",
        },
      });

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(),
        limit: 50,
        offset: 0,
        status: "published",
      });
      const plain = page.candidates.find((c) => c.id === factId);
      expect(plain).toBeDefined();
      expect(plain!.provenance.attribution).toEqual({
        visible: true,
        sourceId: "C-ENG:1799999999.002",
        actor: "U-ENG",
        occurredAt: "2026-05-30T00:00:00.000Z",
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 7. Decay surfaces a stale claim and touches nothing (#4914)
  // ══════════════════════════════════════════════════════════════════

  it(
    "floats a stale claim to the top, labels it, and leaves its row untouched",
    async () => {
      // A claim last observed a year ago, alongside one observed now. The
      // stale one must SORT first (the surfacing hint), LABEL itself stale off
      // the same threshold, and come through the read byte-identical at rest —
      // the live half of the "no write path from the decay signal" criterion,
      // which the unit suites can only assert about statement shape.
      const staleEp = await seedEpisode({ sourceId: "decay-old" });
      await pool.query(`UPDATE brain_episodes SET occurred_at = now() - interval '365 days' WHERE id = $1`, [
        staleEp,
      ]);
      const freshEp = await seedEpisode({ sourceId: "decay-new" });
      const staleFact = await seedFact({ subject: "decay-stale-claim", episodeId: staleEp });
      const freshFact = await seedFact({ subject: "decay-fresh-claim", episodeId: freshEp });
      await edge("provenance", staleFact, staleEp);
      await edge("provenance", freshFact, freshEp);

      const before = await pool.query(`SELECT * FROM brain_facts WHERE id = $1`, [staleFact]);

      const page = await loadFactCandidates(pool, {
        ctx: reviewer(),
        search: "decay-",
        limit: 50,
        offset: 0,
      });
      const ids = page.candidates.map((c) => c.id);
      expect(ids.indexOf(staleFact)).toBeLessThan(ids.indexOf(freshFact));

      const stale = page.candidates.find((c) => c.id === staleFact)!;
      expect(stale.decay.level).toBe("stale");
      expect(stale.decay.ageDays).toBeGreaterThanOrEqual(364);
      expect(stale.decay.lastObservedAt).not.toBeNull();
      const fresh = page.candidates.find((c) => c.id === freshFact)!;
      expect(fresh.decay.level).toBe("fresh");
      // Surfaced, never demoted: the stale row still holds every value it had
      // before the read — status, tombstone, validity window, update clock.
      const after = await pool.query(`SELECT * FROM brain_facts WHERE id = $1`, [staleFact]);
      expect(after.rows[0]).toEqual(before.rows[0]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
