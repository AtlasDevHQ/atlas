/**
 * Real-Postgres coverage for the admin oversight aggregate (#4825, ADR-0036).
 *
 * `oversight.test.ts` pins the POLICY against a literal reader — which token may
 * be named, which handle is emitted, what never reaches the wire. Every SQL
 * claim there is a string match, and none of it proves the statements parse,
 * let alone return the right rows. That gap is the primary risk here: the bucket
 * query is a `CROSS JOIN LATERAL` over `unnest` with five `FILTER` clauses, two
 * of which interpolate predicates borrowed from `candidates.ts` — nothing a
 * `toContain` can check.
 *
 * The claims that need a live database:
 *
 *   1. **Does a fact land in EVERY bucket its grant names, and only once each?**
 *      The `SELECT DISTINCT` inside the lateral is what stops `['org','org']`
 *      counting a fact twice, and the whole surface is a set of numbers an
 *      admin is being asked to trust.
 *   2. **Do the totals count per FACT while the buckets count per token?** The
 *      two disagree by design, and the reason the top-line disclosure survives a
 *      truncated breakdown is that they are separate statements.
 *   3. **Does the tombstone axis stay separate from the status axis?** A
 *      retracted draft must appear in `retracted` and in NEITHER
 *      `awaiting_review` nor `published`, or the same fact is counted twice.
 *   4. **Do the borrowed `provisional` / `in-tension` predicates still bind to
 *      `f` inside a `FILTER`?** They were written for a WHERE clause.
 *   5. **Is the 26 / 32 split real?** The one end-to-end claim: the unscoped
 *      count sees a private fact, the reader-scoped one does not, and the
 *      preview's label projection withholds its claim text. This is the
 *      2026-07-26 staging soak's reading, as a test — see
 *      `docs/development/brain-slack-history.md` § Publish scope.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  OVERSIGHT_BUCKETS_SQL,
  OVERSIGHT_DISTINCT_TOKENS_SQL,
  OVERSIGHT_TOTALS_SQL,
  OVERSIGHT_BUCKET_MAX,
  classifyToken,
  loadConfiguredChannels,
} from "@atlas/api/lib/brain/oversight";
import {
  brainFactPreviewSql,
  brainFactsCountSql,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { aclVisibilityClause, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { chatChannelAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
} from "@atlas/api/lib/brain/ingest/slack/config";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const PRIVATE_AUDIENCE = `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, "C0PRIVATE1")}`;

interface BucketRow {
  token: string;
  awaiting_review: number;
  published: number;
  retracted: number;
  provisional: number;
  in_tension: number;
}

describeIfPg("brain fact oversight aggregate (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_oversight_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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

  async function seedEpisode(workspaceId: string, sourceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', $2, 'evidence', ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId],
    );
    return rows[0]!.id;
  }

  async function seedFact(opts: {
    workspaceId: string;
    episodeId: string;
    subject: string;
    visibleTo?: readonly (string | null)[];
    status?: "draft" | "published";
    provenance?: string;
    retracted?: boolean;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status, visible_to,
          invalidated_at)
       VALUES ($1, $2, 'uses', 'Snowflake', $3, $4::jsonb, $5, $6::text[],
               CASE WHEN $7 THEN now() ELSE NULL END)
       RETURNING id`,
      [
        opts.workspaceId,
        opts.subject,
        opts.episodeId,
        opts.provenance ?? '{"actor":"test"}',
        opts.status ?? "draft",
        opts.visibleTo ?? ["org"],
        opts.retracted ?? false,
      ],
    );
    return rows[0]!.id;
  }

  async function buckets(workspaceId: string): Promise<BucketRow[]> {
    const { rows } = await pool.query<BucketRow>(OVERSIGHT_BUCKETS_SQL, [
      workspaceId,
      OVERSIGHT_BUCKET_MAX + 1,
    ]);
    return rows;
  }

  function ctxFor(workspaceId: string, audienceIds: string[]): BrainPrincipalContext {
    return {
      origin: "authenticated",
      workspaceId,
      userId: "u-admin",
      role: "admin",
      audienceIds,
    };
  }

  it(
    "counts a fact once per grant token, and once overall",
    async () => {
      const ws = "ws-oversight-multi";
      const ep = await seedEpisode(ws, "multi");
      // Two distinct tokens plus a DUPLICATE. Without the `SELECT DISTINCT`
      // inside the lateral the duplicate would count this fact twice in `org` —
      // silently inflating the number the whole surface asks an admin to trust.
      await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "shared",
        visibleTo: ["org", PRIVATE_AUDIENCE, "org"],
      });

      const rows = await buckets(ws);
      const byToken = new Map(rows.map((r) => [r.token, r]));
      expect(byToken.get("org")?.awaiting_review).toBe(1);
      expect(byToken.get(PRIVATE_AUDIENCE)?.awaiting_review).toBe(1);

      // The buckets sum to 2, the workspace holds 1 fact. That divergence is the
      // reason the totals are their own statement rather than a rollup — a
      // client adding the column would otherwise double-count.
      const { rows: totals } = await pool.query<{ awaiting_review: number }>(
        OVERSIGHT_TOTALS_SQL,
        [ws],
      );
      expect(totals[0]!.awaiting_review).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the tombstone axis separate from the status axis",
    async () => {
      const ws = "ws-oversight-tombstone";
      const ep = await seedEpisode(ws, "tombstone");
      await seedFact({ workspaceId: ws, episodeId: ep, subject: "live" });
      await seedFact({ workspaceId: ws, episodeId: ep, subject: "gone", retracted: true });
      await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "old-published",
        status: "published",
        retracted: true,
      });

      const org = (await buckets(ws)).find((r) => r.token === "org");
      // A retracted draft is retracted and NOT awaiting review; a retracted
      // PUBLISHED fact is retracted and not published. Counting either on both
      // axes would report one fact as two.
      expect(org?.awaiting_review).toBe(1);
      expect(org?.published).toBe(0);
      expect(org?.retracted).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "evaluates the borrowed provisional / in-tension predicates inside FILTER",
    async () => {
      const ws = "ws-oversight-quality";
      const ep = await seedEpisode(ws, "quality");
      await seedFact({ workspaceId: ws, episodeId: ep, subject: "plain" });
      await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "prov",
        provenance: '{"actor":"test","provisional":true,"unresolved":["subject"]}',
      });
      const a = await seedFact({ workspaceId: ws, episodeId: ep, subject: "rival-a" });
      const b = await seedFact({ workspaceId: ws, episodeId: ep, subject: "rival-b" });
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
         VALUES ($1, 'in-tension-with', $2, $3)`,
        [ws, a, b],
      );

      const org = (await buckets(ws)).find((r) => r.token === "org");
      expect(org?.awaiting_review).toBe(4);
      expect(org?.provisional).toBe(1);
      // Both ends of the edge: an incumbent that has since been contradicted
      // only ever appears on the `to` side, and hiding it is what the
      // bidirectional EXISTS exists to prevent.
      expect(org?.in_tension).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "reproduces the 26/32 split: the count sees the private fact, the reader does not",
    async () => {
      // The soak's §D2 check, as a test. Three surfaces, three answers, all
      // correct — and the ONE that used to disagree with its own doc is the
      // preview label projection, which now withholds the claim text.
      const ws = "ws-oversight-split";
      const ep = await seedEpisode(ws, "split");
      await seedFact({ workspaceId: ws, episodeId: ep, subject: "public-claim" });
      await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "private-claim",
        visibleTo: [PRIVATE_AUDIENCE],
      });

      // (1) unscoped — what publish will promote, and what `/api/v1/mode`
      //     `draftCounts.brainFacts` already reports.
      const { rows: counted } = await pool.query<{ n: number }>(brainFactsCountSql("$1"), [ws]);
      expect(counted[0]!.n).toBe(2);

      // (2) reader-scoped — an admin outside the audience.
      const outsider = aclVisibilityClause(ctxFor(ws, []), {
        table: "brain_facts",
        alias: "f",
        paramIndex: 1,
      });
      const { rows: shown } = await pool.query<{ label: string }>(
        brainFactPreviewSql(outsider.sql),
        [...outsider.params],
      );
      expect(shown).toHaveLength(1);
      expect(shown[0]!.label).toBe("public-claim uses Snowflake");
      // The claim text of the fact they cannot review never reaches them —
      // which is exactly what the preview used to hand over.
      expect(JSON.stringify(shown)).not.toContain("private-claim");

      // (3) a member of the audience sees both, so the gate is non-vacuous in
      //     the other direction too — a predicate that denied everyone would
      //     pass every assertion above.
      const member = aclVisibilityClause(
        ctxFor(ws, [chatChannelAudienceId(SLACK_HISTORY_SOURCE, "C0PRIVATE1")]),
        { table: "brain_facts", alias: "f", paramIndex: 1 },
      );
      const { rows: bothShown } = await pool.query(brainFactPreviewSql(member.sql), [
        ...member.params,
      ]);
      expect(bothShown).toHaveLength(2);

      // (4) and the oversight buckets report the gap as a number.
      const rows = await buckets(ws);
      expect(rows.find((r) => r.token === "org")?.awaiting_review).toBe(1);
      expect(rows.find((r) => r.token === PRIVATE_AUDIENCE)?.awaiting_review).toBe(1);

      // (5) THE no-content pin, one layer below the producer. The TS side is
      //     enforced by `z.strictObject`, but a `SELECT … f.subject AS sample`
      //     added to the aggregate passes every unit test until somebody also
      //     wires it through — and the SQL is where the claim text actually is.
      const { rows: totalRows } = await pool.query(OVERSIGHT_TOTALS_SQL, [ws]);
      for (const payload of [JSON.stringify(rows), JSON.stringify(totalRows)]) {
        expect(payload).not.toContain("private-claim");
        expect(payload).not.toContain("public-claim");
        expect(payload).not.toContain("Snowflake");
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "counts distinct tokens uncapped, so a clipped breakdown still reports its size",
    async () => {
      const ws = "ws-oversight-cardinality";
      const ep = await seedEpisode(ws, "cardinality");
      await seedFact({ workspaceId: ws, episodeId: ep, subject: "a", visibleTo: ["org"] });
      await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "b",
        visibleTo: [PRIVATE_AUDIENCE, "role:admin"],
      });

      const { rows } = await pool.query<{ n: number }>(OVERSIGHT_DISTINCT_TOKENS_SQL, [ws]);
      // Three distinct tokens across two facts — and this must agree with the
      // bucket query's own lateral, or the panel's audience count contradicts
      // its own table.
      expect(rows[0]!.n).toBe(3);
      expect((await buckets(ws)).length).toBe(3);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "reads a REAL install row through the whole configured-⇒-nameable chain",
    async () => {
      // Against an empty table this proves only that the columns exist. The
      // thing that actually breaks is the CONFIG SHAPE: if what the installer
      // persists differs from what `parseSlackHistoryConfig` expects, every
      // audience goes opaque — fail-closed, and per the module's own comment
      // undiagnosable from the UI. So insert the row and walk the whole chain.
      const ws = "ws-oversight-configs";
      await pool.query(
        `INSERT INTO plugin_catalog (id, slug, name, type, pillar)
         VALUES ($1, 'slack-history', 'Company Brain (Slack history)', 'context', 'knowledge')
         ON CONFLICT (id) DO NOTHING`,
        [SLACK_HISTORY_CATALOG_ID],
      );
      await pool.query(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config)
         VALUES ($1, $2, $3, $1, 'knowledge', $4::jsonb)`,
        [
          `wp-${ws}`,
          ws,
          SLACK_HISTORY_CATALOG_ID,
          JSON.stringify({ channels: ["C0PRIVATE1"] }),
        ],
      );

      const configured = await loadConfiguredChannels({ query: (sql, params) => pool.query(sql, params) }, ws);
      expect(configured.get(SLACK_HISTORY_SOURCE)).toEqual(new Set(["C0PRIVATE1"]));

      // …and the classification that hangs off it.
      expect(classifyToken(PRIVATE_AUDIENCE, configured).labelPolicy).toBe("configured");
      const otherWorkspace = await loadConfiguredChannels(
        { query: (sql, params) => pool.query(sql, params) },
        "ws-oversight-configs-other",
      );
      // Non-vacuity, and the tenant boundary: another workspace's install must
      // not name this one's channel.
      expect(classifyToken(PRIVATE_AUDIENCE, otherWorkspace).labelPolicy).toBe("discovered");
    },
    PG_TEST_TIMEOUT_MS,
  );
});
