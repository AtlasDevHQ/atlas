/**
 * Real-Postgres coverage for the fused `searchBrain` read (#4773, ADR-0036).
 *
 * `search.test.ts` pins the SHAPE of every emitted statement against a literal
 * reader, but every SQL assertion there is a string match. Nothing in it proves
 * the statements parse, that migration 0181's generated columns exist, or that
 * the ACL predicate actually excludes a row — and "the predicate is in the
 * WHERE" is only worth asserting if the WHERE does what it says.
 *
 * The claims that need a live database:
 *
 *   1. **Do the FTS columns exist and match?** `f.fts` / `e.fts` are stored
 *      generated columns added by 0181; a typo in the expression, a
 *      non-immutable function, or a missing GIN index is invisible to a mock.
 *   2. **Does the ACL predicate actually filter — the NEGATIVE?** A reader
 *      outside a fact's audience must get a statement that RETURNS NOTHING,
 *      not one whose rows are dropped afterwards. Asserted by running the real
 *      query and checking both the rows AND that the restricted row is
 *      reachable by the entitled reader (so the fixture is not vacuous).
 *   3. **Is a retracted fact actually excluded?** THE trap. `brainFactStatusClause`
 *      admits it; only `invalidated_at IS NULL` removes it, and only a real row
 *      proves the composition is right.
 *   4. **Is an episode gated in its own right?** A reader entitled to the FACT
 *      but not to its evidence must see the claim and not the message.
 *   5. **Does an unextracted episode come back labelled?** The committed edge
 *      behavior, and the only thing a fresh deployment returns.
 *   6. **Does content mode actually hide a draft fact?**
 *
 * ## What the ACL assertions here do NOT prove
 *
 * The reader contexts below are HAND-BUILT: `audienceIds` is a literal, and
 * `searchBrainCore` consumes `ctx.audienceIds` as given — it never re-resolves
 * membership. So every ACL claim in this file is a statement about the SQL
 * PREDICATE given a context, not about how that context came to be. Seeding a
 * `fact_audience_member` row here would be inert; its absence is deliberate.
 *
 * The other half — that a real principal resolves to the audience ids assumed
 * here — is proven in `acl-visibility-pg.test.ts` and `wedge-loop-pg.test.ts`,
 * which build their contexts through `resolvePrincipalContext(pool, …)`. Read
 * this file as predicate coverage; do not read it as end-to-end ACL proof, and
 * if you add a case that turns on membership RESOLUTION, put it there instead.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { searchBrainCore } from "@atlas/api/lib/brain/search";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { BrainFactResult, BrainSearchResult } from "@useatlas/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-search-pg";

/** An ordinary member: `org`, `role:member`, `user:outsider`. No audiences. */
function outsider(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "outsider",
    role: "member",
    audienceIds: [],
  };
}

/** The same, plus membership of one private audience. */
function insider(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "insider",
    role: "member",
    audienceIds: ["private-channel"],
  };
}

function ids(results: readonly BrainSearchResult[]): string[] {
  return results.flatMap((r) => (r.tier === "document" ? [r.path] : [r.id]));
}

describeIfPg("searchBrain against the live schema", () => {
  let pool: Pool;
  const schemaName = `brain_search_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    extracted?: boolean;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'slack', $2, 'U1', $3, now(), $4::text[], $5)
       RETURNING id`,
      [
        WS,
        opts.sourceId,
        opts.body ?? "evidence",
        opts.visibleTo ?? ["org"],
        opts.extracted ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  }

  async function seedFact(opts: {
    subject: string;
    predicate?: string;
    object?: string;
    episodeId: string;
    visibleTo?: readonly string[];
    status?: "draft" | "published";
    invalidated?: boolean;
    /** Validity window (#4916) — `validTo` set simulates a supersession stamp. */
    validFrom?: Date;
    validTo?: Date;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          status, visible_to, invalidated_at, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11)
       RETURNING id`,
      [
        WS,
        opts.subject,
        opts.predicate ?? "owned_by",
        opts.object ?? "platform team",
        opts.episodeId,
        JSON.stringify({ source: "slack", actor: "U1" }),
        opts.status ?? "published",
        opts.visibleTo ?? ["org"],
        opts.invalidated ? new Date() : null,
        opts.validFrom ?? null,
        opts.validTo ?? null,
      ],
    );
    return rows[0]!.id;
  }

  function search(ctx: BrainPrincipalContext, overrides: Record<string, unknown> = {}) {
    return searchBrainCore(pool, {
      ctx,
      mode: "published",
      include: ["fact", "raw-episode"],
      limit: 50,
      expand: false,
      ...overrides,
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. The generated FTS columns exist and match
  // ══════════════════════════════════════════════════════════════════

  it(
    "lexical search matches through the stored generated columns and snippets the hit",
    async () => {
      const ep = await seedEpisode({
        sourceId: "fts-1",
        body: "the invoicing pipeline belongs to the payments crew",
      });
      const fact = await seedFact({
        subject: "invoicing pipeline",
        object: "payments crew",
        episodeId: ep,
      });

      const res = await search(outsider(), { query: "invoicing pipeline" });
      expect(ids(res.results)).toContain(fact);
      expect(ids(res.results)).toContain(ep);
      const hit = res.results.find((r) => r.tier === "fact") as BrainFactResult;
      // `ts_headline` ran, which is only possible if the tsquery bound and the
      // generated column parsed.
      expect(hit.snippet).toContain("**");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "matches a snake_case predicate by its spaced spelling, and ranks a subject hit above a predicate-only hit",
    async () => {
      // Two properties of 0181's expression, both easy to break silently.
      //
      // 1. Snake_case predicates are matchable as words. This works because the
      //    default parser emits `_` as a blank — NOT because of any special
      //    handling in the expression. Switching `text_search_config`, or
      //    "helpfully" pre-joining the predicate, breaks it.
      // 2. Subject/object are weight A and the predicate is weight B, so a
      //    claim ABOUT an entity outranks one that merely uses the same word as
      //    its relation. This is the assertion that would have caught the
      //    duplicated predicate term the first cut of 0181 shipped: indexing it
      //    twice doubled its position count and inflated `ts_rank` on exactly
      //    the hits this ordering is meant to demote.
      const ep = await seedEpisode({ sourceId: "fts-pred", body: "unrelated evidence" });
      // Seeded subject-first ON PURPOSE. Ties fall through to
      // `f.ingested_at DESC`, so if the A/B weighting ever collapsed, the
      // NEWER row would lead — and seeding the subject hit last would let this
      // test pass on recency alone. This order makes a weight collapse fail.
      const subjectHit = await seedFact({
        subject: "escalates",
        predicate: "documented_in",
        object: "the incident policy",
        episodeId: ep,
      });
      const predicateOnly = await seedFact({
        subject: "Zephyr",
        predicate: "escalates_to",
        object: "Quill",
        episodeId: ep,
      });

      const spaced = await search(outsider(), { query: "escalates to", include: ["fact"] });
      expect(ids(spaced.results)).toContain(predicateOnly);

      const ranked = await search(outsider(), { query: "escalates", include: ["fact"] });
      const order = ids(ranked.results);
      expect(order).toContain(subjectHit);
      expect(order).toContain(predicateOnly);
      expect(order.indexOf(subjectHit)).toBeLessThan(order.indexOf(predicateOnly));
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 2. The ACL predicate FILTERS — as a negative
  // ══════════════════════════════════════════════════════════════════

  it(
    "a reader outside the audience gets a statement that returns nothing, while the insider gets the row",
    async () => {
      const ep = await seedEpisode({ sourceId: "acl-1", visibleTo: ["audience:private-channel"] });
      const restricted = await seedFact({
        subject: "Merger codename",
        object: "Bluebird",
        episodeId: ep,
        visibleTo: ["audience:private-channel"],
      });

      const denied = await search(outsider(), { query: "Bluebird" });
      expect(ids(denied.results)).not.toContain(restricted);
      // Not a post-fetch drop: the store reports it never MATCHED the row, so
      // there is no count or latency signal that it exists.
      const deniedFacts = denied.stores.fact;
      expect(deniedFacts.queried).toBe(true);
      if (!deniedFacts.queried) throw new Error("unreachable");
      expect(deniedFacts.matched).toBe(0);

      // Non-vacuity — the fixture really is reachable, just not by that reader.
      const allowed = await search(insider(), { query: "Bluebird" });
      expect(ids(allowed.results)).toContain(restricted);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 3. THE trap — a retracted fact is excluded
  // ══════════════════════════════════════════════════════════════════

  it(
    "excludes a RETRACTED published fact, which the content-mode clause alone would admit",
    async () => {
      const ep = await seedEpisode({ sourceId: "tomb-1" });
      const live = await seedFact({ subject: "Kestrel deployment", episodeId: ep });
      const retracted = await seedFact({
        subject: "Kestrel deployment",
        object: "decommissioned crew",
        episodeId: ep,
        invalidated: true,
      });

      const res = await search(outsider(), { query: "Kestrel deployment", include: ["fact"] });
      expect(ids(res.results)).toContain(live);
      // Both rows are `status = 'published'`, so `brainFactStatusClause` admits
      // BOTH. Only the tombstone filter removes the withdrawn one — and as of
      // #4772 retraction is the review gate's reject verb, so this is routine.
      expect(ids(res.results)).not.toContain(retracted);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 4. The episode is gated in its own right
  // ══════════════════════════════════════════════════════════════════

  it(
    "serves a claim granted to the org while withholding the restricted evidence it came from",
    async () => {
      const ep = await seedEpisode({
        sourceId: "split-grant",
        body: "Falconry budget was approved in the private channel",
        visibleTo: ["audience:private-channel"],
      });
      const fact = await seedFact({
        subject: "Falconry budget",
        predicate: "approved_by",
        object: "finance",
        episodeId: ep,
        visibleTo: ["org"],
      });

      const res = await search(outsider(), { query: "Falconry budget" });
      // Entitled to the conclusion...
      expect(ids(res.results)).toContain(fact);
      // ...but NOT to the message it was drawn from. A join gated by the fact's
      // predicate would have handed over both.
      expect(ids(res.results)).not.toContain(ep);

      const both = await search(insider(), { query: "Falconry budget" });
      expect(ids(both.results)).toContain(ep);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 5. The unextracted episode is returned, labelled
  // ══════════════════════════════════════════════════════════════════

  it(
    "returns an unextracted episode tagged `pending` and an extracted one tagged `complete`",
    async () => {
      const pending = await seedEpisode({
        sourceId: "lag-pending",
        body: "Osprey migration slipped to Q4",
      });
      const complete = await seedEpisode({
        sourceId: "lag-complete",
        body: "Osprey migration kickoff notes",
        extracted: true,
      });

      const res = await search(outsider(), { query: "Osprey migration", include: ["raw-episode"] });
      const byId = new Map(
        res.results
          .filter((r): r is Extract<BrainSearchResult, { tier: "raw-episode" }> => r.tier === "raw-episode")
          .map((r) => [r.id, r]),
      );
      expect(byId.get(pending)?.extraction).toBe("pending");
      expect(byId.get(pending)?.sourceId).toBe("lag-pending");
      expect(byId.get(complete)?.extraction).toBe("complete");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 6. Content mode
  // ══════════════════════════════════════════════════════════════════

  it(
    "hides a draft fact in published mode and surfaces it in developer mode",
    async () => {
      const ep = await seedEpisode({ sourceId: "mode-1" });
      const draft = await seedFact({
        subject: "Nightjar rollout",
        episodeId: ep,
        status: "draft",
      });

      const published = await search(outsider(), {
        query: "Nightjar rollout",
        include: ["fact"],
      });
      expect(ids(published.results)).not.toContain(draft);

      const developer = await search(outsider(), {
        query: "Nightjar rollout",
        include: ["fact"],
        mode: "developer",
      });
      expect(ids(developer.results)).toContain(draft);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 7. Tensions resolve through their own predicate
  // ══════════════════════════════════════════════════════════════════

  it(
    "reports a conflicting claim the reader may not see as withheld rather than omitting it",
    async () => {
      const ep = await seedEpisode({ sourceId: "tension-open" });
      const secretEp = await seedEpisode({
        sourceId: "tension-secret",
        visibleTo: ["audience:private-channel"],
      });
      const open = await seedFact({
        subject: "Petrel owner",
        object: "team A",
        episodeId: ep,
        visibleTo: ["org"],
      });
      const secret = await seedFact({
        subject: "Petrel owner",
        object: "team B",
        episodeId: secretEp,
        visibleTo: ["audience:private-channel"],
      });
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
         VALUES ($1, 'in-tension-with', $2, $3)`,
        [WS, open, secret],
      );

      const res = await search(outsider(), { query: "Petrel owner", include: ["fact"] });
      const fact = res.results.find(
        (r): r is BrainFactResult => r.tier === "fact" && r.id === open,
      );
      expect(fact).toBeDefined();
      // Present, withheld, and counted — "there is a rival you cannot see" is
      // the signal; an omitted row would read as "nothing contradicts this".
      // The count is the WHOLE entry (#4913): `z.strictObject` semantics, so a
      // producer attaching the claim payload here is a shape change this
      // assertion refuses.
      expect(fact!.tensions).toEqual([{ visible: false, withheldCount: 1 }]);

      const forInsider = await search(insider(), { query: "Petrel owner", include: ["fact"] });
      const insiderFact = forInsider.results.find(
        (r): r is BrainFactResult => r.tier === "fact" && r.id === open,
      );
      const rival = insiderFact!.tensions[0];
      expect(rival).toMatchObject({ visible: true, factId: secret });
      if (rival?.visible !== true) throw new Error("expected a visible counterpart");
      // The counterpart arrives WITH its own provenance (#4913) — the T4
      // stance is surfaced-both-with-provenance, projected off the rival's own
      // row through the live SQL, not the owner's.
      expect(rival.provenance.source).toBe("slack");
      expect(rival.provenance.attribution).toMatchObject({ visible: true, actor: "U1" });
      expect(rival.status).toBe("published");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 7. asOf — the bi-temporal point read (#4916)
  // ══════════════════════════════════════════════════════════════════

  it(
    "answers a point read under each version's FROZEN grant — a widening between versions does not reach back",
    async () => {
      // The acceptance scenario: the grant CHANGED between versions. Monday's
      // version was private to `audience:private-channel`; Wednesday's
      // supersession republished the claim org-wide. "What did we believe
      // Monday" must use Monday's grant — the org reader gets NOTHING at
      // Monday even though the CURRENT version is public, because each row is
      // gated by its own immutable `visible_to`, not by the lineage's newest.
      const monday = new Date("2026-07-06T09:00:00Z");
      const tuesday = "2026-07-07T09:00:00Z";
      const wednesday = new Date("2026-07-08T09:00:00Z");
      const ep = await seedEpisode({
        sourceId: "asof-grant",
        visibleTo: ["audience:private-channel"],
      });
      const privateV1 = await seedFact({
        subject: "Osprey rollout",
        predicate: "led_by",
        object: "the skunkworks pod",
        episodeId: ep,
        visibleTo: ["audience:private-channel"],
        validFrom: monday,
        validTo: wednesday, // superseded at Wednesday's publish
      });
      const publicV2 = await seedFact({
        subject: "Osprey rollout",
        predicate: "led_by",
        object: "the platform team",
        episodeId: ep,
        visibleTo: ["org"],
        validFrom: wednesday,
      });

      // The insider at Tuesday: Monday's belief, through Monday's grant.
      const insiderAtTuesday = await search(insider(), {
        query: "Osprey rollout",
        include: ["fact"],
        asOf: tuesday,
      });
      expect(ids(insiderAtTuesday.results)).toContain(privateV1);
      // v2's window has not opened at Tuesday — a later belief must not
      // answer for an earlier instant.
      expect(ids(insiderAtTuesday.results)).not.toContain(publicV2);
      expect(insiderAtTuesday.asOf).toBe("2026-07-07T09:00:00.000Z");

      // The org reader at Tuesday: NOTHING. v1's frozen grant excludes them,
      // and v2 had not begun. The current version being org-visible earns no
      // historical access.
      const outsiderAtTuesday = await search(outsider(), {
        query: "Osprey rollout",
        include: ["fact"],
        asOf: tuesday,
      });
      expect(ids(outsiderAtTuesday.results)).not.toContain(privateV1);
      expect(ids(outsiderAtTuesday.results)).not.toContain(publicV2);

      // Default (as-of-now) reads are unchanged by any of the above: the
      // superseded v1 is hidden, the current v2 serves — for both readers.
      for (const reader of [insider(), outsider()]) {
        const nowRead = await search(reader, { query: "Osprey rollout", include: ["fact"] });
        expect(ids(nowRead.results)).toContain(publicV2);
        expect(ids(nowRead.results)).not.toContain(privateV1);
        expect("asOf" in nowRead).toBe(false);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a TOMBSTONED fact hidden at every instant, even one inside its validity window",
    async () => {
      // Retraction is the only way to hide history, and hiding is what it
      // does: a retracted fact whose window covers the asked-about instant
      // still never answers. Distinct from supersession, which the previous
      // test proves DOES answer inside its window.
      const ep = await seedEpisode({ sourceId: "asof-tomb" });
      const retracted = await seedFact({
        subject: "Heron pricing",
        object: "the old tier sheet",
        episodeId: ep,
        invalidated: true,
        validFrom: new Date("2026-07-06T00:00:00Z"),
        validTo: new Date("2026-07-20T00:00:00Z"),
      });

      const res = await search(outsider(), {
        query: "Heron pricing",
        include: ["fact"],
        asOf: "2026-07-10T00:00:00Z",
      });
      expect(ids(res.results)).not.toContain(retracted);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "admits a NULL valid_from at any instant — an unrecorded start is not a late one",
    async () => {
      // The default read serves NULL-valid_from rows as current belief (it has
      // no valid_from predicate at all), so the point read must admit them too
      // or `asOf ≈ now` would diverge from the default read.
      const ep = await seedEpisode({ sourceId: "asof-nullfrom" });
      const openStart = await seedFact({
        subject: "Puffin oncall",
        object: "the infra rotation",
        episodeId: ep,
      });

      const res = await search(outsider(), {
        query: "Puffin oncall",
        include: ["fact"],
        asOf: "2026-01-01T00:00:00Z",
      });
      expect(ids(res.results)).toContain(openStart);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
