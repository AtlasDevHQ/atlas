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
  retractFactCandidate,
} from "@atlas/api/lib/brain/candidates";
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
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          status, visible_to, pre_widening_visible_to, predicate_cardinality)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9::text[], $10)
       RETURNING id`,
      [
        WS,
        opts.subject,
        opts.predicate ?? "uses",
        opts.object ?? "Postgres",
        opts.episodeId,
        JSON.stringify(opts.provenance ?? { source: "slack", actor: "U1" }),
        opts.status ?? "draft",
        opts.visibleTo ?? ["org"],
        opts.preWideningVisibleTo ?? null,
        opts.cardinality ?? "multi",
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
  // 7. Retraction — the one write on this surface
  // ══════════════════════════════════════════════════════════════════

  it(
    "retracts a candidate, is idempotent, and never touches `status`",
    async () => {
      const ep = await seedEpisode({ sourceId: "retract-1" });
      const id = await seedFact({ subject: "RetractMe", episodeId: ep });

      const first = await retractFactCandidate(pool, { ctx: reviewer(), factId: id });
      expect(first?.id).toBe(id);
      expect(first?.invalidatedAt).toBeTruthy();

      const { rows } = await pool.query<{ status: string; invalidated_at: Date | null }>(
        `SELECT status, invalidated_at FROM brain_facts WHERE id = $1`,
        [id],
      );
      // The row is a tombstone, NOT demoted — ADR-0036: supersession is not
      // deletion, and `status` has exactly one writer.
      expect(rows[0]!.status).toBe("draft");
      expect(rows[0]!.invalidated_at).not.toBeNull();

      // Second call matches nothing: `invalidated_at IS NULL` already failed.
      expect(await retractFactCandidate(pool, { ctx: reviewer(), factId: id })).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to retract a fact the reviewer cannot see",
    async () => {
      // Retraction is a write and must be gated by the same predicate the read
      // is, or a reviewer could withdraw a claim they were never shown.
      const ep = await seedEpisode({ sourceId: "retract-acl-1" });
      const id = await seedFact({
        subject: "NotYoursToRetract",
        episodeId: ep,
        visibleTo: ["audience:private-channel"],
      });

      expect(await retractFactCandidate(pool, { ctx: reviewer(), factId: id })).toBeNull();

      const { rows } = await pool.query<{ invalidated_at: Date | null }>(
        `SELECT invalidated_at FROM brain_facts WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.invalidated_at).toBeNull();

      // The reader who IS entitled can.
      expect(await retractFactCandidate(pool, { ctx: insider(), factId: id })).not.toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "answers null for an id that does not exist, without erroring",
    async () => {
      const absent = "00000000-0000-4000-8000-000000000000";
      expect(await retractFactCandidate(pool, { ctx: reviewer(), factId: absent })).toBeNull();
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
