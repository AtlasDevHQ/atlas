/**
 * Finish condition 2, against live Postgres (#5424).
 *
 * > **Every authoritative claim has a human name on it.** Pick any claim in the
 * > record at random. You can point at the person who made it authoritative,
 * > and the source it came from, and the date. There are no exceptions,
 * > including for claims that arrived by import, correction, or migration.
 *
 * The PRD snapshot (2026-08-07) rated this *Close — the gate and provenance
 * hold; import and correction paths are the open edges*. The three paths the
 * condition refuses to exempt are exactly the three the snapshot names as open,
 * so this file does not test the happy path and generalize. It tests each named
 * path SEPARATELY, and it asserts the fail-open where one exists rather than
 * fixing it silently — the condition permits no exceptions, so an exception
 * that survives is a finding about the condition and belongs in the record.
 *
 * ## What each section is an instrument for
 *
 * §1 IMPORT — the connector/producer lane, `reconcileFacts`. Both directions:
 *    an attributable episode produces an attributed fact, and an episode that
 *    names nobody produces NO fact (`SOURCE_PRINCIPAL_UNRESOLVED`). The second
 *    half is the load-bearing one: a gate that only ever passes is
 *    indistinguishable from no gate.
 *
 * §2 CORRECTION — `correctFact`'s `supersede`, the one verb that MINTS a claim.
 *    Prod exercises `retract` only (four rows, 2026-08-03 and 2026-08-24), and
 *    a retract writes no fact — so the arm where a correction becomes a claim
 *    is unexercised in prod and a test is the only instrument for it.
 *
 * §3 MIGRATION — `admin-migrate.ts`'s region import. No region migration has
 *    ever run in us prod (`admin_action_log` holds no migration action type and
 *    no fact carries an imported producer), so a test is likewise the only
 *    instrument. Two cases: a bundle that carries attribution keeps it
 *    verbatim, and — the finding — a bundle that carries NONE is accepted.
 *
 * ## The lane §3b names
 *
 * `lib/brain/sources.ts` argues a deliberate fail-open for `brain_episodes.source`:
 * the import restores an out-of-vocabulary value verbatim rather than refusing
 * the bundle, because refusing one episode strands the whole workspace at
 * cutover, and it LOGS the value so the lane is visible. #5424 asked whether
 * the ATTRIBUTION fields have an analogous lane. They do, and it is wider: the
 * bundle validator's only test on `provenance` is `Object.keys(...).length > 0`
 * (`admin-migrate.ts`), the payload is then bound verbatim, and no log fires.
 * `{"note":"x"}` is a legal bundle provenance.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { withRequestContext } from "@atlas/api/lib/logger";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { correctFact } from "@atlas/api/lib/brain/correction";
import {
  RECONCILE_BLOCK_REASONS,
  reconcileFacts,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import {
  importBundle as importBundleWithCorrelationId,
  validateBundle,
} from "@atlas/api/api/routes/admin-migrate";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-condition-2";
const IMPORT_WS = "ws-condition-2-import";
const ACTOR_ID = "user-admin-c2";
const ACTOR_EMAIL = "admin@condition-2.test";

/** The attribution triple the condition names, read off one stored fact. */
interface AttributionRead {
  readonly id: string;
  readonly status: string;
  /** `provenance.actor` — who asserted the claim. */
  readonly actor: string | null;
  /** `provenance.source` + `provenance.sourceId` — where it came from. */
  readonly prov_source: string | null;
  readonly prov_source_id: string | null;
  /** `provenance.occurredAt` — when it was said at the source. */
  readonly occurred_at: string | null;
  /** The episode row the fact points at, which is the evidence itself. */
  readonly episode_source: string;
  readonly episode_source_actor: string | null;
}

type ImportBundleArgs = Parameters<typeof importBundleWithCorrelationId>;
const importBundle = (
  client: ImportBundleArgs[0],
  bundle: ImportBundleArgs[1],
  orgId: ImportBundleArgs[2],
  correlationId: ImportBundleArgs[3] = "req-condition-2",
) => importBundleWithCorrelationId(client, bundle, orgId, correlationId);

describeIfPg("finish condition 2 — a human name on every claim (#5424)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `condition_2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // §2 asserts the correction's `admin_action_log` row, and
    // `logAdminActionAwait` short-circuits on `hasInternalDB()`, which reads
    // DATABASE_URL rather than the pool. Set in the hook, restored in afterAll.
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

  /**
   * One transaction on the test pool. Same shape as production's
   * `withBrainTransaction`, down to the `.catch` on ROLLBACK and the
   * `client.release(rollbackErr)` — see `correction-audit-pg.test.ts`, which
   * states why a naive rollback would swap the assertion's cause.
   */
  const poolTx: ReconcileTransactionRunner = async <T,>(
    fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
    }) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    let rollbackErr: Error | undefined;
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
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        console.warn(`condition-2-pg: ROLLBACK failed — ${rollbackErr.message}`);
      });
      throw err;
    } finally {
      client.release(rollbackErr);
    }
  };

  /**
   * The one read every section makes — the condition's own question, asked of
   * the database rather than of a code path. Spelled once so no section can
   * quietly ask an easier version of it.
   */
  async function attributionOf(workspaceId: string, factId: string): Promise<AttributionRead> {
    const { rows } = await pool.query<AttributionRead>(
      `SELECT f.id::text AS id,
              f.status,
              f.provenance->>'actor'      AS actor,
              f.provenance->>'source'     AS prov_source,
              f.provenance->>'sourceId'   AS prov_source_id,
              f.provenance->>'occurredAt' AS occurred_at,
              e.source                    AS episode_source,
              e.source_actor              AS episode_source_actor
         FROM brain_facts f
         JOIN brain_episodes e
           ON e.workspace_id = f.workspace_id AND e.id = f.source_episode_id
        WHERE f.workspace_id = $1 AND f.id = $2::uuid`,
      [workspaceId, factId],
    );
    const row = rows[0];
    // Named throw, not `rows[0]?.x`: an optional-chained assertion against a
    // missing row compares undefined to undefined and passes.
    if (row === undefined) throw new Error(`no fact ${factId} in ${workspaceId}`);
    return row;
  }

  async function seedEpisode(opts: {
    workspaceId: string;
    source: string;
    sourceId: string;
    sourceActor: string | null;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, $2, $3, $4, 'evidence body', now(), ARRAY['org'])
       RETURNING id`,
      [opts.workspaceId, opts.source, opts.sourceId, opts.sourceActor],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("seed: episode insert returned no id");
    return id;
  }

  function reviewer(): BrainPrincipalContext {
    return {
      origin: "authenticated",
      workspaceId: WS,
      userId: ACTOR_ID,
      role: "admin",
      audienceIds: [],
    };
  }

  function asRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    return withRequestContext(
      {
        requestId,
        user: {
          id: ACTOR_ID,
          mode: "managed",
          label: ACTOR_EMAIL,
          role: "admin",
          activeOrganizationId: WS,
        },
      },
      fn,
    );
  }

  // ── §1 IMPORT — the connector/producer lane ─────────────────────────────

  it(
    "§1a import: a claim from an attributable episode carries actor, source and date",
    async () => {
      const episodeId = await seedEpisode({
        workspaceId: WS,
        source: "slack",
        sourceId: "C-cond2/1785768510.625229",
        sourceActor: "U0AQW6KF2EM",
      });
      const occurredAt = new Date("2026-08-03T14:48:30.625Z");
      const extractedAt = new Date("2026-08-03T14:49:52.763Z");

      const report = await reconcileFacts(
        {
          episode: {
            id: episodeId,
            workspaceId: WS,
            source: "slack",
            sourceId: "C-cond2/1785768510.625229",
            sourceActor: "U0AQW6KF2EM",
            occurredAt,
            visibleTo: ["org"],
          },
          candidates: [
            { subject: "prod branch", predicate: "is advanced only by", object: "/release" },
          ],
          producer: "extraction:v1",
          extractedAt,
          vocabulary: identityVocabulary,
        },
        { withTransaction: poolTx },
      );
      expect(report.episodeBlocked).toBeUndefined();
      expect(report.created).toBe(1);

      const { rows } = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM brain_facts
          WHERE workspace_id = $1 AND source_episode_id = $2::uuid`,
        [WS, episodeId],
      );
      const factId = rows[0]?.id;
      if (factId === undefined) throw new Error("§1a: reconcile created no fact row");

      const attribution = await attributionOf(WS, factId);
      // A PERSON. Derived from the episode by `resolvedPrincipal`, which
      // prefixes the source kind so the id is interpretable in one read.
      expect(attribution.actor).toBe("slack:U0AQW6KF2EM");
      // A SOURCE — the kind, the source's own stable id, and the episode row
      // the fact's NOT NULL `source_episode_id` guarantees is there.
      expect(attribution.prov_source).toBe("slack");
      expect(attribution.prov_source_id).toBe("C-cond2/1785768510.625229");
      expect(attribution.episode_source).toBe("slack");
      expect(attribution.episode_source_actor).toBe("U0AQW6KF2EM");
      // A DATE — the source's own event time, not merely the ingest stamp.
      expect(attribution.occurred_at).toBe(occurredAt.toISOString());
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§1b import: an episode naming nobody produces NO claim, not an unattributed one",
    async () => {
      const episodeId = await seedEpisode({
        workspaceId: WS,
        source: "slack",
        sourceId: "C-cond2/anonymous",
        sourceActor: null,
      });

      const report = await reconcileFacts(
        {
          episode: {
            id: episodeId,
            workspaceId: WS,
            source: "slack",
            sourceId: "C-cond2/anonymous",
            sourceActor: null,
            occurredAt: new Date("2026-08-03T14:48:30.625Z"),
            visibleTo: ["org"],
          },
          candidates: [{ subject: "Pricing", predicate: "is", object: "49" }],
          producer: "extraction:v1",
          extractedAt: new Date("2026-08-03T14:49:52.763Z"),
          vocabulary: identityVocabulary,
        },
        { withTransaction: poolTx },
      );

      expect(report.episodeBlocked).toBe(RECONCILE_BLOCK_REASONS.sourcePrincipalUnresolved);
      expect(report.created).toBe(0);
      // The gate is only worth anything if the refusal reaches the DATABASE —
      // a report that says "blocked" over a row that landed is the shape this
      // condition is about.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_facts
          WHERE workspace_id = $1 AND source_episode_id = $2::uuid`,
        [WS, episodeId],
      );
      expect(rows[0]?.n).toBe("0");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── §2 CORRECTION — the verb that mints a claim ─────────────────────────

  it(
    "§2 correction: a supersede's replacement claim names the Atlas user who made it",
    async () => {
      const episodeId = await seedEpisode({
        workspaceId: WS,
        source: "slack",
        sourceId: "C-cond2/supersede-target",
        sourceActor: "U-alice",
      });
      const { rows: seeded } = await pool.query<{ id: string }>(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance,
            status, visible_to, subject_key, predicate_key, object_key)
         VALUES ($1, 'Billing', 'is owned by', 'Ana', $2, $3::jsonb, 'published', ARRAY['org'],
                 'billing', 'is owned by', 'ana')
         RETURNING id::text AS id`,
        [
          WS,
          episodeId,
          JSON.stringify({
            source: "slack",
            sourceId: "C-cond2/supersede-target",
            episodeId,
            actor: "slack:U-alice",
            producer: "extraction:v1",
            occurredAt: "2026-08-03T14:48:30.625Z",
          }),
        ],
      );
      const targetId = seeded[0]?.id;
      if (targetId === undefined) throw new Error("§2: seed fact insert returned no id");

      const outcome = await asRequest("req-cond2-supersede", () =>
        correctFact(
          {
            vocabulary: identityVocabulary,
            ctx: reviewer(),
            factId: targetId,
            verb: "supersede",
            reason: "Ana left; Bo took over",
            replacement: { object: "Bo" },
          },
          { withTransaction: poolTx },
        ),
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
      const replacementId = outcome.result.supersededBy;
      if (typeof replacementId !== "string") {
        throw new Error("§2: supersede returned no replacement id");
      }

      const attribution = await attributionOf(WS, replacementId);
      // A PERSON, and an ATLAS one — `user:<id>` rather than a vendor handle,
      // because the correction path knows the authenticated user and
      // `correctFact` passes it as `sourcePrincipal` rather than letting it
      // fall back to the episode.
      expect(attribution.actor).toBe(`user:${ACTOR_ID}`);
      // A SOURCE — the correction episode, which is a `human` episode whose
      // body holds the verb payload verbatim.
      expect(attribution.prov_source).toBe("human");
      expect(attribution.episode_source).toBe("human");
      expect(attribution.episode_source_actor).toBe(ACTOR_ID);
      expect(attribution.prov_source_id).toContain("correction:supersede:");
      // A DATE.
      expect(attribution.occurred_at).toBeTruthy();

      // The second, independent record of the same person — the forensic row.
      // It carries the EMAIL, which is the only place in the whole path a
      // human-readable name appears: `provenance.actor` holds an opaque id.
      const { rows: audit } = await pool.query<{
        actor_id: string;
        actor_email: string;
        action_type: string;
        timestamp: string;
      }>(
        `SELECT actor_id, actor_email, action_type, timestamp::text
           FROM admin_action_log WHERE target_id = $1 ORDER BY timestamp`,
        [targetId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_id).toBe(ACTOR_ID);
      expect(audit[0]?.actor_email).toBe(ACTOR_EMAIL);
      expect(audit[0]?.action_type).toBe("brain_fact.correct");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── §3 MIGRATION — the region-import lane ───────────────────────────────

  /**
   * A v3 bundle carrying exactly one episode and one fact. `provenance` and
   * `sourceActor` are the parameters, because they are the only two things
   * these two cases differ in.
   */
  function bundleWith(opts: {
    episodeId: string;
    factId: string;
    sourceActor: string | null;
    provenance: unknown;
  }): unknown {
    return {
      manifest: {
        version: 3 as const,
        exportedAt: "2026-08-01T00:00:00Z",
        source: { label: "condition-2-test" },
        counts: {
          conversations: 0,
          messages: 0,
          semanticEntities: 0,
          learnedPatterns: 0,
          settings: 0,
          dashboards: 0,
          dashboardCards: 0,
          dashboardUserDrafts: 0,
          knowledgeDocuments: 0,
          knowledgeLinks: 0,
          scheduledTasks: 0,
          agentSessionMemory: 0,
          brainEpisodes: 1,
          brainFacts: 1,
        },
      },
      conversations: [],
      semanticEntities: [],
      learnedPatterns: [],
      settings: [],
      dashboards: [],
      knowledgeDocuments: [],
      scheduledTasks: [],
      agentSessionMemory: [],
      brainEpisodes: [
        {
          id: opts.episodeId,
          source: "slack",
          sourceId: `C-imported/${opts.factId}`,
          sourceActor: opts.sourceActor,
          body: "Imported evidence.",
          locator: null,
          occurredAt: "2026-08-01T00:00:00Z",
          ingestedAt: "2026-08-01T00:00:00Z",
          extractedAt: "2026-08-01T00:05:00Z",
          visibleTo: ["org"],
          createdAt: "2026-08-01T00:00:00Z",
          facts: [
            {
              id: opts.factId,
              subject: "Imported claim",
              predicate: "holds",
              object: "yes",
              subjectKey: "imported claim",
              predicateKey: "holds",
              objectKey: "yes",
              subjectCmp: null,
              objectCmp: null,
              validFrom: "2026-08-01T00:00:00Z",
              validTo: null,
              ingestedAt: "2026-08-01T00:05:00Z",
              invalidatedAt: null,
              extractedAt: "2026-08-01T00:05:00Z",
              provenance: opts.provenance,
              status: "published" as const,
              visibleTo: ["org"],
              preWideningVisibleTo: null,
              createdAt: "2026-08-01T00:05:00Z",
              updatedAt: "2026-08-01T00:05:00Z",
            },
          ],
        },
      ],
      brainEdges: [],
      factAudienceMembers: [],
      brainVocabularyEdges: [],
    };
  }

  async function runImport(bundle: unknown, orgId: string): Promise<void> {
    const validation = validateBundle(bundle);
    if (!validation.ok) throw new Error(`bundle rejected: ${validation.error}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await importBundle(
        client as unknown as ImportBundleArgs[0],
        validation.bundle,
        orgId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // intentionally ignored: the original error is the one to surface, and
        // the client is destroyed on release below.
      });
      throw err;
    } finally {
      client.release();
    }
  }

  it(
    "§3a migration: attribution on a well-formed bundle survives the import verbatim",
    async () => {
      const episodeId = "c2000000-0000-4000-8000-00000000a001";
      const factId = "c2000000-0000-4000-8000-00000000f001";
      await runImport(
        bundleWith({
          episodeId,
          factId,
          sourceActor: "U-imported",
          provenance: {
            source: "slack",
            sourceId: "C-imported/1785768510.625229",
            episodeId,
            actor: "slack:U-imported",
            producer: "extraction:v1",
            occurredAt: "2026-08-01T00:00:00Z",
            extractedAt: "2026-08-01T00:05:00Z",
            reconciledAt: "2026-08-01T00:05:00Z",
          },
        }),
        IMPORT_WS,
      );

      const attribution = await attributionOf(IMPORT_WS, factId);
      expect(attribution.status).toBe("published");
      expect(attribution.actor).toBe("slack:U-imported");
      expect(attribution.prov_source).toBe("slack");
      expect(attribution.prov_source_id).toBe("C-imported/1785768510.625229");
      expect(attribution.occurred_at).toBe("2026-08-01T00:00:00Z");
      expect(attribution.episode_source_actor).toBe("U-imported");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§3b migration: a bundle carrying NO attribution is accepted — the named exception",
    async () => {
      const episodeId = "c2000000-0000-4000-8000-00000000a002";
      const factId = "c2000000-0000-4000-8000-00000000f002";

      // Non-empty, so it clears `chk_brain_facts_provenance_nonempty` and the
      // validator's `Object.keys(...).length > 0`. Attribution-free, so it
      // clears nothing else — because nothing else is checked.
      const opaque = { note: "restored from an archive; original actor unknown" };

      const bundle = bundleWith({
        episodeId,
        factId,
        sourceActor: null,
        provenance: opaque,
      });

      // The validator's own verdict, asserted separately from the import: this
      // is where a refusal WOULD live, and it is the line #5424 asked about.
      const validation = validateBundle(bundle);
      expect(validation.ok).toBe(true);

      await runImport(bundle, IMPORT_WS);

      const attribution = await attributionOf(IMPORT_WS, factId);
      // ⚠️ This is the finding, asserted rather than fixed. The claim is
      // `status = 'published'` — AUTHORITATIVE, by the condition's own word —
      // and every field the condition names is null. There is no person, no
      // source kind in the payload, and no date.
      expect(attribution.status).toBe("published");
      expect(attribution.actor).toBeNull();
      expect(attribution.prov_source).toBeNull();
      expect(attribution.prov_source_id).toBeNull();
      expect(attribution.occurred_at).toBeNull();
      // Nor does the episode rescue it: `sourceActor` imports as `?? null`, so
      // the fallback `reconcile.ts` would have used at ingest is empty too.
      expect(attribution.episode_source_actor).toBeNull();

      // Stated so the boundary of the finding is not overstated: the import
      // does NOT lose the pointer to the evidence. `source_episode_id` is NOT
      // NULL and its FK is composite-with-workspace, so an unattributed
      // imported claim still names the episode it came from — you can point at
      // the EVIDENCE. What you cannot point at is the PERSON or the DATE.
      expect(attribution.episode_source).toBe("slack");
    },
    PG_TEST_TIMEOUT_MS,
  );
});
